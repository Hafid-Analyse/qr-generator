/**
 * مولّد كود QR — خادم التراخيص (Google Apps Script)
 *
 * يُلصق هذا الملف في: الشيت ← الإضافات ← Apps Script
 * ثم: تشغيل setup مرة واحدة، ثم نشر كتطبيق ويب (Execute as: Me / Who has access: Anyone).
 *
 * كل الطلبات تصل عبر POST بنص JSON: {action, ...}
 * أوامر التطبيق: config, activate, check
 * أوامر لوحة التحكم (تحتاج كلمة السر): admin_login, admin_list, admin_create, admin_reset, admin_status
 */

var SHEET_CUSTOMERS = 'الزبائن';
var SHEET_LOG = 'السجل';
var SHEET_SETTINGS = 'الإعدادات';

// أعمدة ورقة الزبائن (تبدأ من 1)
var C = {
  KEY: 1, NAME: 2, PHONE: 3, ORG: 4, ALLOWED: 5, USED: 6, STATUS: 7,
  CREATED: 8, ACTIVATED: 9, LAST_SEEN: 10, ALERT: 11, NOTES: 12, DEVICES: 13
};
var NCOLS = 13;
var ACTIVE = 'نشط', SUSPENDED = 'موقوف';
var KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا 0/O و1/I

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return json_({ ok: true, service: 'qr-licenses' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, reason: 'bad_request' }); }

  try {
    switch (req.action) {
      case 'config':        return json_(publicConfig_());
      case 'activate':      return json_(withLock_(function () { return activate_(req); }));
      case 'check':         return json_(withLock_(function () { return check_(req); }));
      case 'admin_login':   return json_(admin_(req, function () { return { ok: true }; }));
      case 'admin_list':    return json_(admin_(req, function () { return adminList_(); }));
      case 'admin_create':  return json_(admin_(req, function () { return withLock_(function () { return adminCreate_(req); }); }));
      case 'admin_reset':   return json_(admin_(req, function () { return withLock_(function () { return adminReset_(req); }); }));
      case 'admin_status':  return json_(admin_(req, function () { return withLock_(function () { return adminStatus_(req); }); }));
      default:              return json_({ ok: false, reason: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, reason: 'server_error', message: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------- app actions

function publicConfig_() {
  var s = settings_();
  return { ok: true, whatsapp: s.whatsapp, offlineDays: s.offlineDays };
}

/** أول فتح أو جهاز جديد: يربط الجهاز إن بقي مكان */
function activate_(req) {
  var key = normKey_(req.key), dev = String(req.device || '').slice(0, 64);
  if (!key || !dev) return { ok: false, reason: 'invalid' };
  var found = findByKey_(key);
  if (!found) { log_(key, '', 'تفعيل', 'رمز غير صالح', req); return { ok: false, reason: 'invalid' }; }

  var row = found.values, sh = found.sheet, r = found.row;
  var s = settings_();
  if (row[C.STATUS - 1] === SUSPENDED) { log_(key, row[C.NAME - 1], 'تفعيل', 'موقوف', req); return { ok: false, reason: 'suspended', whatsapp: s.whatsapp }; }

  var devices = parseDevices_(row[C.DEVICES - 1]);
  var allowed = Number(row[C.ALLOWED - 1]) || s.defaultDevices;
  var now = new Date();
  var mine = devices.filter(function (d) { return d.id === dev; })[0];

  if (!mine) {
    if (devices.length >= allowed) {
      log_(key, row[C.NAME - 1], 'تفعيل', 'مرفوض: مستعمل على أجهزة أخرى', req);
      return { ok: false, reason: 'used', whatsapp: s.whatsapp };
    }
    var fp0 = String(req.fp || '');
    mine = { id: dev, fps: fp0 ? [fp0] : [], last: fp0, ua: shortUa_(req.ua), at: now.toISOString() };
    devices.push(mine);
    if (!row[C.ACTIVATED - 1]) sh.getRange(r, C.ACTIVATED).setValue(now);
    log_(key, row[C.NAME - 1], 'تفعيل', 'جهاز جديد (' + devices.length + '/' + allowed + ')', req);
  } else {
    flagIfFingerprintChanged_(sh, r, row, mine, req);
    log_(key, row[C.NAME - 1], 'تفعيل', 'نفس الجهاز', req);
  }
  saveDevices_(sh, r, devices, allowed);
  sh.getRange(r, C.LAST_SEEN).setValue(now);
  return { ok: true, name: row[C.NAME - 1], offlineDays: s.offlineDays, whatsapp: s.whatsapp };
}

/** تحقق خفيف في الخلفية: لا يضيف أجهزة */
function check_(req) {
  var key = normKey_(req.key), dev = String(req.device || '').slice(0, 64);
  var s = settings_();
  var found = key && findByKey_(key);
  if (!found) return { ok: false, reason: 'invalid', whatsapp: s.whatsapp };
  var row = found.values, sh = found.sheet, r = found.row;

  if (row[C.STATUS - 1] === SUSPENDED) { log_(key, row[C.NAME - 1], 'تحقق', 'موقوف', req); return { ok: false, reason: 'suspended', whatsapp: s.whatsapp }; }
  var devices = parseDevices_(row[C.DEVICES - 1]);
  var mine = devices.filter(function (d) { return d.id === dev; })[0];
  if (!mine) { log_(key, row[C.NAME - 1], 'تحقق', 'جهاز غير مسجّل (أُعيد الضبط؟)', req); return { ok: false, reason: 'revoked', whatsapp: s.whatsapp }; }

  flagIfFingerprintChanged_(sh, r, row, mine, req);
  saveDevices_(sh, r, devices, Number(row[C.ALLOWED - 1]) || s.defaultDevices);
  sh.getRange(r, C.LAST_SEEN).setValue(new Date());
  log_(key, row[C.NAME - 1], 'تحقق', 'سليم', req);
  return { ok: true, name: row[C.NAME - 1], offlineDays: s.offlineDays, whatsapp: s.whatsapp };
}

/**
 * نفس معرّف الجهاز يظهر ببصمتين تتناوبان (أ ثم ب ثم أ) = نُسخ غالباً إلى جهاز آخر.
 * بصمة جديدة مرة واحدة (تحديث متصفح مثلاً) لا تُنبّه. تنبيه فقط، دون إقفال.
 */
function flagIfFingerprintChanged_(sh, r, row, mine, req) {
  var fp = String(req.fp || '');
  if (!fp) return;
  mine.fps = mine.fps || (mine.fp ? [mine.fp] : []);
  if (!mine.last) mine.last = mine.fp || fp;
  if (fp !== mine.last) {
    if (mine.fps.indexOf(fp) > -1) {
      var msg = '⚠ الرمز يُستعمل على جهازين بالتناوب — تحقّق';
      if (row[C.ALERT - 1] !== msg) sh.getRange(r, C.ALERT).setValue(msg);
    } else {
      mine.fps.push(fp);
      if (mine.fps.length > 6) mine.fps = mine.fps.slice(-6);
    }
    mine.last = fp;
  }
  if (mine.fps.indexOf(fp) === -1) mine.fps.push(fp);
  delete mine.fp;
}

// ---------------------------------------------------------------- admin actions

function admin_(req, fn) {
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('ADMIN_HASH');
  if (!hash) return { ok: false, reason: 'no_password' };

  // حماية من التخمين: 10 محاولات خاطئة تقفل الدخول ساعة
  var fails = Number(props.getProperty('ADMIN_FAILS') || 0);
  var until = Number(props.getProperty('ADMIN_LOCK_UNTIL') || 0);
  if (until && Date.now() < until) return { ok: false, reason: 'locked' };

  if (sha256_(String(req.password || '')) !== hash) {
    fails += 1;
    props.setProperty('ADMIN_FAILS', String(fails));
    if (fails >= 10) { props.setProperty('ADMIN_LOCK_UNTIL', String(Date.now() + 3600 * 1000)); props.setProperty('ADMIN_FAILS', '0'); }
    return { ok: false, reason: 'wrong_password' };
  }
  if (fails) props.setProperty('ADMIN_FAILS', '0');
  return fn();
}

function adminList_() {
  var sh = sheet_(SHEET_CUSTOMERS), last = sh.getLastRow();
  var s = settings_();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, NCOLS).getValues();
  var list = rows.filter(function (v) { return v[C.KEY - 1]; }).map(function (v) {
    return {
      key: String(v[C.KEY - 1]), name: v[C.NAME - 1], phone: String(v[C.PHONE - 1] || ''), org: v[C.ORG - 1],
      allowed: Number(v[C.ALLOWED - 1]) || s.defaultDevices, used: parseDevices_(v[C.DEVICES - 1]).length,
      status: v[C.STATUS - 1] || ACTIVE, created: iso_(v[C.CREATED - 1]), activated: iso_(v[C.ACTIVATED - 1]),
      lastSeen: iso_(v[C.LAST_SEEN - 1]), alert: v[C.ALERT - 1] || '', notes: v[C.NOTES - 1] || ''
    };
  }).reverse();
  return { ok: true, customers: list, settings: { appUrl: s.appUrl, message: s.message, defaultDevices: s.defaultDevices } };
}

function adminCreate_(req) {
  var name = String(req.name || '').trim();
  if (!name) return { ok: false, reason: 'name_required' };
  var s = settings_();
  var allowed = Math.max(1, Math.min(20, Number(req.allowed) || s.defaultDevices));
  var key = newKey_();
  var now = new Date();
  var row = [];
  row[C.KEY - 1] = key; row[C.NAME - 1] = name; row[C.PHONE - 1] = String(req.phone || '').trim();
  row[C.ORG - 1] = String(req.org || '').trim(); row[C.ALLOWED - 1] = allowed; row[C.USED - 1] = 0;
  row[C.STATUS - 1] = ACTIVE; row[C.CREATED - 1] = now; row[C.ACTIVATED - 1] = ''; row[C.LAST_SEEN - 1] = '';
  row[C.ALERT - 1] = ''; row[C.NOTES - 1] = String(req.notes || '').trim(); row[C.DEVICES - 1] = '[]';
  var sh = sheet_(SHEET_CUSTOMERS);
  sh.appendRow(row);
  sh.getRange(sh.getLastRow(), C.PHONE).setNumberFormat('@').setValue(row[C.PHONE - 1]);
  log_(key, name, 'إنشاء', 'زبون جديد (' + allowed + ' أجهزة)', {});
  return { ok: true, key: key, link: linkFor_(s.appUrl, key), message: fillMessage_(s, name, key) };
}

function adminReset_(req) {
  var found = findByKey_(normKey_(req.key));
  if (!found) return { ok: false, reason: 'invalid' };
  saveDevices_(found.sheet, found.row, [], Number(found.values[C.ALLOWED - 1]) || settings_().defaultDevices);
  found.sheet.getRange(found.row, C.ALERT).setValue('');
  log_(found.values[C.KEY - 1], found.values[C.NAME - 1], 'إعادة ضبط', 'مُسحت الأجهزة', {});
  return { ok: true };
}

function adminStatus_(req) {
  var found = findByKey_(normKey_(req.key));
  if (!found) return { ok: false, reason: 'invalid' };
  var st = req.status === SUSPENDED ? SUSPENDED : ACTIVE;
  found.sheet.getRange(found.row, C.STATUS).setValue(st);
  log_(found.values[C.KEY - 1], found.values[C.NAME - 1], st === SUSPENDED ? 'إيقاف' : 'تفعيل الحساب', st, {});
  return { ok: true, status: st };
}

// ---------------------------------------------------------------- setup + sheet menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('مولّد QR')
    .addItem('تعيين كلمة سر لوحة التحكم', 'setup')
    .addSeparator()
    .addItem('إعادة ضبط أجهزة الزبون المحدد', 'menuReset')
    .addItem('إيقاف / تفعيل الزبون المحدد', 'menuToggle')
    .addToUi();
}

/** يُشغَّل مرة واحدة: يحفظ معرّف الشيت ويطلب كلمة سر لوحة التحكم */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('كلمة سر لوحة التحكم', 'اكتب كلمة سر قوية (8 أحرف على الأقل):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var pass = res.getResponseText();
  if (!pass || pass.length < 8) { ui.alert('كلمة السر قصيرة. أعد المحاولة.'); return; }
  PropertiesService.getScriptProperties().setProperty('ADMIN_HASH', sha256_(pass));
  ui.alert('تم حفظ كلمة السر. الآن انشر السكريبت كتطبيق ويب.');
}

function menuReset() {
  var r = selectedRow_(); if (!r) return;
  adminReset_({ key: r.key });
  SpreadsheetApp.getUi().alert('تمت إعادة ضبط أجهزة ' + r.name + '. يستطيع الآن التفعيل من جديد.');
}

function menuToggle() {
  var r = selectedRow_(); if (!r) return;
  var next = r.status === SUSPENDED ? ACTIVE : SUSPENDED;
  adminStatus_({ key: r.key, status: next });
  SpreadsheetApp.getUi().alert(r.name + ': ' + next);
}

function selectedRow_() {
  var sh = SpreadsheetApp.getActiveSheet();
  var r = sh.getActiveRange().getRow();
  if (sh.getName() !== SHEET_CUSTOMERS || r < 2) { SpreadsheetApp.getUi().alert('اختر سطر الزبون في ورقة «الزبائن» أولاً.'); return null; }
  var v = sh.getRange(r, 1, 1, NCOLS).getValues()[0];
  return { key: v[C.KEY - 1], name: v[C.NAME - 1], status: v[C.STATUS - 1] };
}

// ---------------------------------------------------------------- helpers

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name) { return ss_().getSheetByName(name); }

function settings_() {
  var sh = sheet_(SHEET_SETTINGS);
  var vals = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).getValues();
  var m = {};
  vals.forEach(function (v) { m[String(v[0]).trim()] = v[1]; });
  return {
    whatsapp: waNumber_(m['رقم واتساب الطلبات']),
    defaultDevices: Number(m['الأجهزة المسموحة افتراضياً']) || 2,
    offlineDays: Number(m['أيام العمل دون إنترنت']) || 7,
    appUrl: String(m['رابط التطبيق'] || '').trim(),
    message: String(m['نص رسالة الواتساب'] || '{الاسم}\n{الرابط}\n{الرمز}')
  };
}

function findByKey_(key) {
  if (!key) return null;
  var sh = sheet_(SHEET_CUSTOMERS), last = sh.getLastRow();
  if (last < 2) return null;
  var keys = sh.getRange(2, C.KEY, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (normKey_(keys[i][0]) === key) {
      return { sheet: sh, row: i + 2, values: sh.getRange(i + 2, 1, 1, NCOLS).getValues()[0] };
    }
  }
  return null;
}

function parseDevices_(s) { try { var a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveDevices_(sh, r, devices, allowed) {
  sh.getRange(r, C.DEVICES).setValue(JSON.stringify(devices));
  sh.getRange(r, C.USED).setValue(devices.length);
}

function newKey_() {
  var sh = sheet_(SHEET_CUSTOMERS), last = sh.getLastRow();
  var existing = {};
  if (last >= 2) sh.getRange(2, C.KEY, last - 1, 1).getValues().forEach(function (v) { existing[normKey_(v[0])] = 1; });
  for (var tries = 0; tries < 50; tries++) {
    var k = '';
    for (var i = 0; i < 8; i++) k += KEY_ALPHABET.charAt(Math.floor(Math.random() * KEY_ALPHABET.length));
    if (!existing[k]) return k.slice(0, 4) + '-' + k.slice(4);
  }
  throw new Error('could not generate key');
}
function normKey_(k) { return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function linkFor_(appUrl, key) {
  var base = appUrl || '';
  return base + (base.indexOf('?') > -1 ? '&' : '?') + 'k=' + normKey_(key);
}
function fillMessage_(s, name, key) {
  return s.message.split('{الاسم}').join(name).split('{الرابط}').join(linkFor_(s.appUrl, key)).split('{الرمز}').join(key);
}

/** 0555123456 ← 213555123456 */
function waNumber_(p) {
  var d = String(p || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.charAt(0) === '0') d = '213' + d.slice(1);
  return d;
}

function log_(key, name, op, result, req) {
  try {
    sheet_(SHEET_LOG).appendRow([new Date(), String(key || ''), name || '', op, result,
      String(req.device || '').slice(0, 8), String(req.fp || ''), shortUa_(req.ua)]);
  } catch (e) {}
}

function shortUa_(ua) {
  ua = String(ua || '');
  var os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : '';
  var br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, br].filter(String).join(' · ') || ua.slice(0, 40);
}

function sha256_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = (b & 0xff).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}
function iso_(d) { return d instanceof Date ? d.toISOString() : (d ? String(d) : ''); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
