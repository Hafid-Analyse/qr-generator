/* بوابة التفعيل: تربط نسخة الزبون بجهازه عبر خادم التراخيص (Google Apps Script). */
(function () {
  var API = window.QR_LICENSE_API;
  if (!API) return; // لا خادم = التطبيق مفتوح

  var LS_LIC = 'qrgen.license', LS_DEV = 'qrgen.device', LS_ADMIN = 'qrgen.admin', LS_OWNER_OK = 'qrgen.ownerOk';
  var DAY = 86400000;

  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function normKey(k) { return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function prettyKey(k) { k = normKey(k); return k.length === 8 ? k.slice(0, 4) + '-' + k.slice(4) : k; }

  // معرّف عشوائي يُصنع مرة واحدة لهذا الجهاز/المتصفح
  function deviceId() {
    var d = load(LS_DEV);
    if (d) return d;
    d = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    save(LS_DEV, d);
    return d;
  }
  // بصمة خفيفة من خصائص الجهاز (لكشف النسخ إلى جهاز آخر، لا للإقفال)
  function fingerprint() {
    var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    var s = [navigator.platform, screen.width + 'x' + screen.height, window.devicePixelRatio,
      tz, navigator.language, navigator.hardwareConcurrency || '', navigator.maxTouchPoints || 0].join('|');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }

  function api(action, data) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl && setTimeout(function () { ctrl.abort(); }, 20000);
    var body = Object.assign({ action: action, device: deviceId(), fp: fingerprint(), ua: navigator.userAgent }, data || {});
    return fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctrl && ctrl.signal, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .finally(function () { if (t) clearTimeout(t); });
  }

  // ------------------------------------------------------------ UI
  var css = document.createElement('style');
  css.textContent = [
    '.lic{position:fixed;inset:0;z-index:100;background:var(--bg,#f4f1ea);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}',
    '.lic .box{width:100%;max-width:400px;background:var(--card,#fffdf8);border:1px solid var(--line,#e3ddcf);border-radius:20px;padding:26px 22px;box-shadow:0 8px 32px rgba(0,0,0,.08);text-align:center}',
    '.lic img{width:64px;height:64px;border-radius:16px}',
    '.lic h2{margin:12px 0 6px;font-size:21px;font-weight:800}',
    '.lic p{margin:0 0 16px;color:var(--muted,#6b665b);font-size:15px;line-height:1.6}',
    '.lic .msg{border-radius:12px;padding:10px 12px;font-size:14px;margin-bottom:14px;text-align:right}',
    '.lic .msg.bad{background:#fde8e6;color:#b42318}.lic .msg.warn{background:#fdf0e3;color:#b4570a}.lic .msg.ok{background:#e8f4ec;color:#1f7a3f}',
    '.lic input{width:100%;font:inherit;font-size:20px;letter-spacing:3px;text-align:center;direction:ltr;padding:12px;border:1.5px solid var(--line,#e3ddcf);border-radius:12px;background:#fff;text-transform:uppercase}',
    '.lic input:focus{outline:2px solid var(--accent,#0f5c4d);border-color:transparent}',
    '.lic .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font:inherit;font-weight:700;font-size:16px;padding:13px;border-radius:12px;border:1px solid var(--accent,#0f5c4d);cursor:pointer;margin-top:10px;text-decoration:none}',
    '.lic .primary{background:var(--accent,#0f5c4d);color:#fff}',
    '.lic .wa{background:#fff;color:#128c4a;border-color:#25d366}',
    '.lic .btn:disabled{opacity:.5;cursor:wait}',
    '.lic .or{display:flex;align-items:center;gap:10px;color:var(--muted,#6b665b);font-size:13px;margin:16px 0 6px}',
    '.lic .or:before,.lic .or:after{content:"";flex:1;height:1px;background:var(--line,#e3ddcf)}',
    '.lic .spin{width:34px;height:34px;border:3px solid var(--line,#e3ddcf);border-top-color:var(--accent,#0f5c4d);border-radius:50%;margin:8px auto 4px;animation:licspin .8s linear infinite}',
    '@keyframes licspin{to{transform:rotate(360deg)}}',
    '.lic-toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:120;background:#1f7a3f;color:#fff;padding:10px 18px;border-radius:999px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.2);animation:licin .3s ease-out}',
    '@keyframes licin{from{opacity:0;transform:translate(-50%,-10px)}}'
  ].join('\n');
  document.head.appendChild(css);

  var overlay = null, cfg = { whatsapp: '' };

  var MESSAGES = {
    none:      { t: 'أدخل رمز التفعيل', p: 'هذا التطبيق يعمل بنسخة خاصة لكل مستعمل. افتح الرابط الذي وصلك، أو اكتب رمز التفعيل.' },
    used:      { cls: 'bad', m: 'هذه النسخة مستعملة على جهاز آخر. كل نسخة مرتبطة بجهاز صاحبها.' },
    invalid:   { cls: 'bad', m: 'رمز التفعيل غير صحيح. تأكد منه وأعد المحاولة.' },
    suspended: { cls: 'bad', m: 'تم إيقاف هذه النسخة. تواصل مع صاحب التطبيق.' },
    revoked:   { cls: 'warn', m: 'أُعيد ضبط نسختك. أدخل رمز التفعيل من جديد لربط هذا الجهاز.' },
    offline:   { cls: 'warn', m: 'مضى وقت طويل دون تحقق. اتصل بالإنترنت مرة واحدة ثم اضغط «تفعيل».' },
    network:   { cls: 'warn', m: 'تعذّر الاتصال. تأكد من الإنترنت وأعد المحاولة.' }
  };

  function waLink(extra) {
    if (!cfg.whatsapp) return '';
    var txt = 'السلام عليكم، أريد نسخة من «مولّد كود QR».' + (extra ? '\n' + extra : '');
    return 'https://wa.me/' + cfg.whatsapp + '?text=' + encodeURIComponent(txt);
  }

  function showGate(reason, keyPrefill) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'lic';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      document.body.appendChild(overlay);
    }
    document.documentElement.style.overflow = 'hidden';
    var m = MESSAGES[reason] || {};
    var extra = reason === 'used' ? 'رابطي يظهر أنه مستعمل على جهاز آخر.' : '';
    var wa = waLink(extra);
    overlay.innerHTML =
      '<div class="box">' +
        '<img src="icons/icon-192.png" alt="">' +
        '<h2>مولّد كود QR</h2>' +
        '<p>' + MESSAGES.none.p + '</p>' +
        (m.m ? '<div class="msg ' + m.cls + '">' + m.m + '</div>' : '') +
        '<form id="licForm"><input id="licKey" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12" aria-label="رمز التفعيل">' +
        '<button class="btn primary" id="licGo" type="submit">تفعيل</button></form>' +
        '<div class="or">ليست لديك نسخة؟</div>' +
        (wa ? '<a class="btn wa" href="' + wa + '" target="_blank" rel="noopener">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.4z"/></svg>' +
              'اطلب نسختك عبر واتساب</a>'
            : '<p style="margin:6px 0 0">اطلب نسختك من صاحب التطبيق.</p>') +
        '<a href="admin.html" style="display:inline-block;margin-top:16px;font-size:13px;color:var(--muted,#6b665b)">دخول المالك</a>' +
      '</div>';
    var input = overlay.querySelector('#licKey');
    if (keyPrefill) input.value = prettyKey(keyPrefill);
    overlay.querySelector('#licForm').onsubmit = function (e) {
      e.preventDefault();
      var k = normKey(input.value);
      if (k.length < 8) { input.focus(); return; }
      doActivate(k);
    };
  }

  function showBusy(text) {
    showGate('');
    overlay.querySelector('.box').innerHTML =
      '<img src="icons/icon-192.png" alt=""><h2>مولّد كود QR</h2><div class="spin"></div><p>' + text + '</p>';
  }

  function hideGate() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.documentElement.style.overflow = '';
  }

  function toast(text) {
    var t = document.createElement('div'); t.className = 'lic-toast'; t.textContent = text;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3500);
  }

  function applyServer(res, key) {
    if (res.whatsapp != null) cfg.whatsapp = res.whatsapp;
    var lic = load(LS_LIC) || {};
    lic.key = key; lic.whatsapp = cfg.whatsapp;
    if (res.ok) {
      lic.name = res.name; lic.lastOk = Date.now(); lic.offlineDays = res.offlineDays || 7; lic.blocked = null;
    } else {
      lic.blocked = res.reason || 'invalid';
    }
    save(LS_LIC, lic);
    return lic;
  }

  function doActivate(key) {
    showBusy('جارٍ التفعيل…');
    api('activate', { key: key }).then(function (res) {
      var lic = applyServer(res, key);
      if (res.ok) { hideGate(); toast('مرحباً ' + (res.name || '') + '، تم تفعيل نسختك ✓'); }
      else {
        if (res.reason === 'invalid') { lic.key = null; save(LS_LIC, lic); }
        showGate(res.reason || 'invalid', res.reason === 'invalid' ? '' : key);
      }
    }).catch(function () { showGate('network', key); });
  }

  function loadConfig() {
    return api('config').then(function (r) { if (r && r.ok) cfg.whatsapp = r.whatsapp || ''; }).catch(function () {});
  }

  // ------------------------------------------------------------ start
  // وضع المالك: من سجّل دخوله في لوحة التحكم مع «تذكّرني» على هذا الجهاز لا يحتاج نسخة
  function ownerPass() { try { return localStorage.getItem(LS_ADMIN); } catch (e) { return null; } }
  function ownerMode() {
    var pass = ownerPass();
    if (!pass) return false;
    var last = Number(load(LS_OWNER_OK) || 0);
    if (Date.now() - last > DAY) {
      api('admin_login', { password: pass }).then(function (res) {
        if (res && res.ok) save(LS_OWNER_OK, Date.now());
        else if (res && (res.reason === 'wrong_password' || res.reason === 'no_password')) {
          try { localStorage.removeItem(LS_ADMIN); localStorage.removeItem(LS_OWNER_OK); } catch (e) {}
        }
      }).catch(function () {});
    }
    return true;
  }

  function start() {
    if (ownerMode()) {
      var b = document.createElement('a');
      b.href = 'admin.html'; b.textContent = 'المالك · لوحة التحكم';
      b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:20;background:var(--accent,#0f5c4d);color:#fff;font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.15)';
      document.body.appendChild(b);
      var pr = new URLSearchParams(location.search);
      if (pr.has('k')) { pr.delete('k'); var qq = pr.toString(); history.replaceState(null, '', location.pathname + (qq ? '?' + qq : '') + location.hash); }
      return;
    }
    var params = new URLSearchParams(location.search);
    var urlKey = normKey(params.get('k'));
    if (params.has('k')) {
      params.delete('k');
      var q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
    var lic = load(LS_LIC);
    if (lic && lic.whatsapp) cfg.whatsapp = lic.whatsapp;

    // 1) جاء من رابط خاص
    if (urlKey && (!lic || normKey(lic.key) !== urlKey || lic.blocked || !lic.lastOk)) { doActivate(urlKey); return; }

    // 2) لا نسخة على هذا الجهاز
    if (!lic || !lic.key || !lic.lastOk) { showGate('none'); loadConfig().then(function () { if (overlay && !overlay.querySelector('.spin')) showGate('none'); }); return; }

    // 3) نسخة موقوفة أو أُعيد ضبطها (اكتُشف في تحقق سابق)
    if (lic.blocked) { showGate(lic.blocked, lic.key); return; }

    // 4) نسخة سليمة: يفتح التطبيق فوراً، والتحقق في الخلفية مرة في اليوم
    var age = Date.now() - lic.lastOk;
    var limit = (lic.offlineDays || 7) * DAY;
    if (age < DAY) return;
    api('check', { key: lic.key }).then(function (res) {
      applyServer(res, lic.key); // إن كان موقوفاً يُقفل في الفتح التالي
    }).catch(function () {
      if (age > limit) showGate('offline', lic.key);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
