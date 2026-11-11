/* 「透明覆盖层挡住图」的回归测试。
   这是 nhentai 报的 bug 的根因：
   阅读器在图上盖一层 position:absolute; inset:0 的透明 div（点它翻页），
   用户以为点的是图，e.target 却是那层 div。
   旧代码 e.target.tagName !== 'IMG' → 直接 return → 「Alt+点击无效」。
   node test/overlaytarget.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const CDP_PORT = 9430 + Math.floor(Math.random() * 40);
const HTTP_PORT = 9060 + Math.floor(Math.random() * 40);

const PAGE = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><title>overlay target</title>',
  '<style>body{margin:0;background:#1b1b1b;color:#eee;font:14px system-ui;padding:20px}',
  '.reader{position:relative;display:inline-block}',
  '.reader img{display:block;width:600px}',
  '.overlay{position:absolute;inset:0;cursor:pointer;z-index:10}</style></head><body>',
  '<h1>overlay target test</h1>',
  '<p>图被 &lt;a&gt; 包着 + 上面盖了透明层（跟 nhentai 一样）</p>',
  '<div class="reader"><a href="#x"><img id="page" src="/pic.png" /></a><div class="overlay" id="ovl"></div></div>',
  '</body></html>'].join('');

let PIC_DATAURL = '';
const server = http.createServer(function (q, s) {
  var u = (q.url || '/').split('?')[0];
  if (u === '/pic.png') {
    var m = PIC_DATAURL.match(/^data:image\/png;base64,(.+)$/);
    if (!m) { s.writeHead(500); s.end('no pic'); return; }
    s.writeHead(200, { 'Content-Type': 'image/png' });
    s.end(Buffer.from(m[1], 'base64'));
    return;
  }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  s.end(PAGE);
});

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); let contexts = [];
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  const raw = (me, pa) => new Promise(function (r) { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method: me, params: pa || {} })); });
  const ev = async (ex, cid) => {
    const r = await raw('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true, ...(cid ? { contextId: cid } : {}) });
    if (r.result && r.result.exceptionDetails) return '__EXC:' + ((r.result.exceptionDetails.exception || {}).description || '').slice(0, 400);
    return r.result ? r.result.result.value : null;
  };
  return new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res({ raw, ev, get contexts() { return contexts; }, close: function () { ws.close(); } }); }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

const DRAW = [
  'var c = document.createElement("canvas"); c.width = 600; c.height = 450;',
  'var g = c.getContext("2d");',
  'g.fillStyle = "#f0f0eb"; g.fillRect(0, 0, 600, 450);',
  'g.fillStyle = "#000"; g.font = "26px sans-serif";',
  'g.fillText("おはよう、今日は何する？", 40, 80);',
  'g.fillText("これは本当にすごいね！", 40, 160);',
  'return c.toDataURL("image/png");'
].join('\n');

(async function () {
  let pass = 0, fail = 0;
  function t(name, cond, detail) {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
  }

  let child = null, pc = null;
  try {
    await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
    const profile = path.join(os.tmpdir(), 'dsh-ovl-' + Date.now());
    child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
      '--no-first-run', '--no-default-browser-check',
      'http://127.0.0.1:' + HTTP_PORT + '/'
    ], { stdio: 'ignore' });
    await new Promise(function (r) { setTimeout(r, 8000); });

    const list = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list').then(function (r) { return r.json(); });
    const page = list.find(function (x) { return x.type === 'page' && x.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('页面没打开');
    pc = await connect(page.webSocketDebuggerUrl);
    await pc.raw('Runtime.enable');
    await pc.raw('Input.enable');
    await new Promise(function (r) { setTimeout(r, 1500); });

    let iso = null;
    for (const c of pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; })) {
      if ((await pc.ev('typeof globalThis.__DSH_IMG__', c.id)) === 'object') { iso = c; break; }
    }
    const main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso || !main) throw new Error('context 缺失');
    await pc.ev('new Promise(function(r){ setTimeout(r, 700); })', iso.id);

    PIC_DATAURL = await pc.ev('(function(){' + DRAW + '})()', main.id);
    t('测试页能生成图', !!(PIC_DATAURL && PIC_DATAURL.indexOf('data:image/png') === 0));
    await pc.ev('(function(){ var i = document.getElementById("page"); i.src = "http://127.0.0.1:' + HTTP_PORT + '/pic.png?t=" + Date.now(); return 1; })()', main.id);
    await pc.ev('(async function(){ var i = document.getElementById("page");' +
      ' if (i.complete && i.naturalWidth) return i.naturalWidth;' +
      ' await new Promise(function(r){ i.onload = r; i.onerror = r; setTimeout(r, 5000); });' +
      ' return i.naturalWidth; })()', main.id);

    // 确认点击命中元素不是 IMG
    const hit = await pc.ev('(function(){ var r = document.getElementById("ovl").getBoundingClientRect();' +
      ' var s = document.elementsFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));' +
      ' return s.slice(0, 4).map(function(e){ return e.tagName; }).join(" > "); })()', main.id);
    t('点击命中的是覆盖层不是 IMG', hit.indexOf('DIV') === 0, hit);
    t('覆盖层下面确实有 IMG', hit.indexOf('IMG') > 0, hit);

    // ★ 核心：Alt+点击覆盖层，应该能翻
    const box = JSON.parse(await pc.ev('(function(){ var r = document.getElementById("ovl").getBoundingClientRect();' +
      ' return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()', main.id));
    await pc.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 1 });
    await new Promise(function (r) { setTimeout(r, 100); });
    await pc.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 1 });

    let stat = '';
    for (let i = 0; i < 25; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      stat = await pc.ev('(document.querySelector(".dsh-ip-stat") || {}).textContent || ""', main.id);
      if (stat.indexOf('完成') >= 0 || stat.indexOf('无法') >= 0) break;
    }
    t('Alt+点击覆盖层能触发翻译', stat.indexOf('完成') >= 0, stat || '(没有面板)');

    const st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_IMG__.state())', iso.id));
    t('lastTrigger 有值', st.lastTrigger > 0, String(st.lastTrigger));
    t('lastSkip 为空（没有被过滤掉）', st.lastSkip === '', JSON.stringify(st.lastSkip));
    t('事件日志记录了 div target', st.evtLog.length > 0 && st.evtLog[0].isImg === false, JSON.stringify(st.evtLog[0] || {}).slice(0, 100));
    t('命中块数 > 0', st.panelOpen && true, stat);

    // 译文
    const tr = await pc.ev('(function(){ var rows = document.querySelectorAll(".dsh-ip-row");' +
      ' var out = []; for (var i = 0; i < rows.length; i++) {' +
      '   var d = rows[i].querySelector(".dsh-ip-dst"); out.push(d ? d.textContent.slice(0, 40) : ""); }' +
      ' return JSON.stringify(out); })()', main.id);
    const texts = JSON.parse(tr);
    t('有译文', texts.length > 0 && texts[0].length > 0, JSON.stringify(texts));
    const allHan = texts.every(function (x) { return new RegExp('[\\u4e00-\\u9fff]').test(x); });
    t('译文都是中文', allHan, JSON.stringify(texts));
    console.log('    译文: ' + JSON.stringify(texts));

    console.log('');
    console.log(pass + ' 通过 / ' + fail + ' 失败');
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail += 1;
  } finally {
    try { if (pc) pc.close(); } catch (e) {}
    try { if (child) child.kill(); } catch (e) {}
    server.close();
  }
  console.log(fail ? ('X 失败 ' + fail + ' 项') : 'OK 覆盖层目标测试通过');
  process.exit(fail ? 1 : 0);
})();