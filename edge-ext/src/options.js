/* 设置页 */
(function () {
  'use strict';

  var DSH = globalThis.DSH || {};
  var DEFAULTS = DSH.DEFAULTS || {};
  var $ = function (s) { return document.querySelector(s); };

  var cfg = Object.assign({}, DEFAULTS);
  var toastEl = $('#toast');

  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  function sendBg(msg) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(msg, function (r) { resolve(r || { ok: false }); }); }
      catch (e) { resolve({ ok: false }); }
    });
  }

  function fields() { return document.querySelectorAll('[data-key]'); }

  function fill(c) {
    Array.prototype.forEach.call(fields(), function (el) {
      var k = el.dataset.key;
      var v = c[k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (Array.isArray(v)) el.value = v.join('\n');
      else el.value = v == null ? '' : v;
    });
    paintMode(c.mode);
    paintConn(c.endpoint, null);
  }

  function collect() {
    var out = Object.assign({}, cfg);
    Array.prototype.forEach.call(fields(), function (el) {
      var k = el.dataset.key;
      if (el.type === 'checkbox') out[k] = el.checked;
      else if (el.dataset.type === 'number') {
        var n = Number(el.value);
        out[k] = isFinite(n) ? n : DEFAULTS[k];
      } else if (el.dataset.type === 'lines') {
        out[k] = el.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      } else out[k] = el.value;
    });
    return out;
  }

  /* ---------------------------------------------------------------- 缓存 */

  function paintCache(st) {
    var el = $('#cacheStat');
    if (!el) return;
    if (!st || !st.ok) { el.textContent = '读取失败'; return; }
    var kb = Math.round((st.approxBytes || 0) / 1024);
    el.textContent = (st.entries || 0) + ' 条 · 约 ' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB')
      + (st.hits ? (' · 本次命中 ' + st.hits + ' 次') : '');
  }

  function refreshCache() {
    sendBg({ t: 'cacheStats' }).then(paintCache);
  }

  function wireCache() {
    var btn = $('#clearCacheBtn');
    if (btn) btn.addEventListener('click', function () {
      btn.disabled = true;
      sendBg({ t: 'clearCache' }).then(function () {
        btn.disabled = false;
        refreshCache();
        toast('缓存已清空');
      });
    });
    refreshCache();
  }

  /* ---------------------------------------------------------------- 连接 */

  function paintConn(endpoint, info) {
    var title = $('#connTitle');
    var sub = $('#connSub');
    if (!title) return;
    if (info && info.ok) {
      title.textContent = '已连接 · ' + (info.model || 'translate');
      sub.textContent = info.base + (info.speed ? (' · ' + info.speed + ' tok/s') : '');
    } else if (endpoint) {
      title.textContent = '已配置';
      sub.textContent = endpoint;
    } else {
      title.textContent = '未连接';
      sub.textContent = '点右边自动搜索';
    }
  }

  async function connect() {
    var btn = $('#connectBtn');
    btn.disabled = true;
    btn.textContent = '连接中…';
    var out = $('#testOut');
    out.className = 'show';
    out.textContent = '正在寻找 DSH 的 NPU 插件…';
    try {
      var draft = collect();
      var r = await sendBg({ t: 'connect', endpoint: draft.endpoint || '' });
      if (r && r.ok) {
        cfg = Object.assign({}, cfg, { endpoint: r.base, model: r.model });
        fill(cfg);
        paintConn(r.base, r);
        out.className = 'show ok';
        out.textContent = (r.steps || []).map(function (s) {
          return (s.ok ? '✓ ' : '✗ ') + s.name + '   ' + s.ms + 'ms' + (s.detail ? ('\n    ' + s.detail) : '');
        }).join('\n') + ('\n\n地址 ' + r.base + ' · 角色 ' + r.model + (r.ttft ? (' · 首字 ' + r.ttft + 'ms') : ''));
        toast('已连接 DSH');
      } else {
        paintConn(draft.endpoint, null);
        out.className = 'show err';
        var lines = [];
        lines.push('✗ ' + ((r && r.error) || '没找到 DSH'));
        lines.push('');
        if (r && r.tried && r.tried.length) {
          lines.push('试过这些地址：');
          r.tried.forEach(function (t) {
            lines.push('  · ' + t.base + ' — ' + (t.reason || '连不上'));
          });
        }
        if (r && r.ifaceError) {
          lines.push('');
          lines.push('浏览器没给出本机网卡：' + r.ifaceError);
        }
        if (r && r.prefixes && r.prefixes.length) {
          lines.push('');
          lines.push('已扫网段（' + (r.scanned || 0) + ' 个地址，端口 ' + DSH.DSH_PORT + '）：' + r.prefixes.join(' , '));
        }
        lines.push('');
        lines.push('下一步：');
        lines.push('1. 确认 DSH 面板里 NPU 插件是开着的');
        lines.push('2. 把面板上显示的地址（形如 http://192.168.x.x:47300）粘到上面「DSH 地址」里');
        lines.push('3. 如果面板换过网段，把你的网段填进「扫描的网段」再点一次');
        out.textContent = lines.join('\n');
      }
    } catch (e) {
      out.className = 'show err';
      out.textContent = '连接失败：' + (e && e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '一键连接';
    }
  }

  async function test() {
    var btn = $('#testBtn');
    var out = $('#testOut');
    var meta = $('#testMeta');
    btn.disabled = true;
    btn.textContent = '测试中…';
    out.className = 'show';
    out.textContent = '正在测试…';
    try {
      var r = await sendBg({ t: 'connect', endpoint: collect().endpoint || '' });
      if (r && r.ok) {
        out.className = 'show ok';
        out.textContent = '✓ 一切正常\n\n' +
          '地址：' + r.base + '\n角色：' + r.model + '\n' +
          (r.ttft ? ('流式首字：' + r.ttft + 'ms\n') : '') +
          (r.speed ? ('解码速度：' + r.speed + ' tok/s\n') : '') +
          (r.sample ? ('\n试译：' + r.sample) : '');
        if (meta) meta.textContent = '正常';
        paintConn(r.base, r);
      } else {
        out.className = 'show err';
        out.textContent = '✗ ' + ((r && r.error) || '失败') +
          (r && r.steps ? '\n\n' + r.steps.map(function (s) { return (s.ok ? '✓ ' : '✗ ') + s.name + ' ' + s.ms + 'ms' + (s.detail ? (' — ' + s.detail) : ''); }).join('\n') : '');
        if (meta) meta.textContent = '';
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '测试一下';
    }
  }

  /* ---------------------------------------------------------------- 分段 */

  function paintMode(mode) {
    var seg = $('#modeSeg');
    if (!seg) return;
    var m = mode === 'only' ? 'only' : 'bilingual';
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.mode === m);
    });
    var hidden = $('#mode');
    if (hidden) hidden.value = m;
  }

  if ($('#modeSeg')) {
    $('#modeSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (!b) return;
      paintMode(b.dataset.mode);
    });
  }

  /* ---------------------------------------------------------------- 保存 */

  async function save() {
    var next = collect();
    var r = await sendBg({ t: 'saveConfig', cfg: next });
    if (r && r.ok) {
      cfg = Object.assign({}, DEFAULTS, r.cfg || next);
      fill(cfg);
      var meta = $('#saveMeta');
      if (meta) meta.textContent = '已保存 · ' + new Date().toLocaleTimeString();
      toast('设置已保存');
      paintConn(cfg.endpoint, null);
    } else toast('保存失败');
  }

  /* ---------------------------------------------------------------- 启动 */

  on('#connectBtn', 'click', connect);
  on('#testBtn', 'click', test);
  on('#saveBtn', 'click', save);
  on('#resetBtn', 'click', function () {
    cfg = Object.assign({}, DEFAULTS);
    fill(cfg);
    toast('已填入默认值，记得保存');
  });

  function on(sel, ev, fn) {
    var el = $(sel);
    if (!el) return;
    el.addEventListener(ev, fn);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  var verEl = $('#ver');
  if (verEl) { try { verEl.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {} }

  (async function load() {
    var r = await sendBg({ t: 'getConfig' });
    cfg = Object.assign({}, DEFAULTS, (r && r.cfg) || {});
    fill(cfg);
    var st = await sendBg({ t: 'status' });
    if (st && st.connected) paintConn(st.base, st.conn && st.conn.ok ? { ok: true, base: st.base, model: st.conn.model } : null);
    // 缓存卡片：绑定按钮 + 首次读取。
    // 踩过的坑：wireCache() 定义了但从来没调用，
    // 结果缓存区一直显示「读取中…」，清空按钮点了也没反应。
    wireCache();
  })();
})();
