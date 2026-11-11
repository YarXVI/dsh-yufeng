/* 图标不消失回归测试。
   Discord 的服务器图标栏是 <a><img><裸文字></a>（文字给屏幕阅读器/搜索用）。
   曾经因为「带媒体的链接也下沉」+「窄元素 replace」两个 bug，
   图标被 .dsh-orig 一起藏掉 → 整栏图标消失。
   node test/icons.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9392;
const HTTP_PORT = 8822;

const NAMES = ['OpenDesign', 'Cherry Blossom', 'Explorer Patcher', 'Anime Avatar'];

const RAIL = NAMES.map(function (n, i) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="hsl(' + (i * 60) + ',60%,50%)"/><text x="24" y="30" font-size="10" fill="#fff" text-anchor="middle">' + i + '</text></svg>';
  return '<a href="#x" class="srv" title="' + n + '"><img src="data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '">' + n + '</a>';
}).join('');

const SIDEBAR = '<div class="sidebar">' +
  '<div class="cat"><span>INFORMATION</span></div>' +
  '<a href="#x" class="ch"><span class="ico">A</span><span class="nm">announcements</span></a>' +
  '<a href="#x" class="ch"><span class="ico">B</span><span class="nm">rules</span></a>' +
  '<div class="cat"><span>CHAT &amp; SHARE</span></div>' +
  '<a href="#x" class="ch active"><span class="ico">#</span><span class="nm">general</span></a>' +
  '<a href="#x" class="ch"><span class="ico">#</span><span class="nm">中文区</span></a>' +
  '<a href="#x" class="ch"><span class="ico">#</span><span class="nm">model-arena</span></a>' +
  '</div>';

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>icons</title>' +
  '<style>*{box-sizing:border-box}body{margin:0;background:#1e1f22;display:flex}' +
  '.rail{width:72px;padding:8px 0;display:flex;flex-direction:column;align-items:center;gap:8px}' +
  '.srv{width:48px;height:48px;border-radius:50%;overflow:hidden;display:block;background:#313338}' +
  '.srv img{width:100%;height:100%;display:block;object-fit:cover}' +
  '.sidebar{width:200px;background:#2b2d31;padding:8px;overflow:hidden}' +
  '.cat{padding:4px 8px;font-size:12px;font-weight:700;color:#949ba4;white-space:nowrap;overflow:hidden}' +
  '.ch{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:4px;color:#949ba4;overflow:hidden;height:32px}' +
  '.ch .ico{flex:0 0 auto;width:16px}' +
  '.ch .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;flex:1 1 auto;min-width:0}' +
  '</style></head><body><div class="rail">' + RAIL + '</div>' + SIDEBAR + '</body></html>';

const server = http.createServer(function (q, s) { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE); });

function connect(url) {
  var ws = new WebSocket(url);
  var id = 0, pending = new Map(), contexts = [];
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { var p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  return new Promise(function (res, rej) {
    ws.addEventListener('open', function () { res({
      send: function (me, pa) { return new Promise(function (resolve, reject) { var mid = ++id; pending.set(mid, { resolve: resolve, reject: reject }); ws.send(JSON.stringify({ id: mid, method: me, params: pa || {} })); }); },
      inCtx: async function (expr, cid) {
        var r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
        if (r.exceptionDetails) return { __error: ((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400) };
        return r.result.value;
      },
      get contexts() { return contexts; }, close: function () { ws.close(); }
    }); }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async function () {
  var fail = 0;
  var profile = path.join(os.tmpdir(), 'dsh-icons-' + Date.now());
  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
  var child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-component-extensions-with-background-pages',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { stdio: 'ignore' });
  await new Promise(function (r) { setTimeout(r, 8000); });

  try {
    var list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(function (r) { return r.json(); });
    var page = list.find(function (t) { return t.type === 'page' && t.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('no page');
    var pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1000); });
    var iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    var main = pc.contexts.find(function (c) { return c.auxData && c.auxData.type === 'default'; });
    if (!iso) throw new Error('no content script');

    var before = await pc.inCtx('document.querySelectorAll(".srv img").length', main.id);
    console.log('· 翻译前图标数 ' + before);
    if (before !== NAMES.length) { console.log('x 测试页图标数不对'); fail++; }

    await pc.inCtx('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    var st = {};
    for (var i = 0; i < 120; i++) {
      await new Promise(function (r) { setTimeout(r, 300); });
      st = JSON.parse(await pc.inCtx('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id) || '{}');
      if (st.total > 0 && st.done >= st.total) break;
    }
    console.log('· 翻译完成 ' + st.done + '/' + st.total);

    var after = await pc.inCtx('document.querySelectorAll(".srv img").length', main.id);
    var bodyH = await pc.inCtx('Math.round(document.querySelector(".rail").getBoundingClientRect().height)', main.id);
    console.log('· 翻译后图标数 ' + after + '，rail 高度 ' + bodyH);
    if (after !== before) { console.log('x 图标丢失！ ' + before + ' → ' + after); fail++; }

    // 图标栏里不应有译文（那是无障碍标签，翻了会被裁掉）
    var trInRail = await pc.inCtx('document.querySelectorAll(".rail .dsh-tr").length', main.id);
    console.log('· 图标栏里的译文 ' + trInRail + ' 个（应为 0）');
    if (trInRail !== 0) { console.log('x 图标栏被翻译了'); fail++; }

    // 侧栏应正常翻译且高度不变
    var chHeights = await pc.inCtx('"JSONSTR:" + JSON.stringify(Array.from(document.querySelectorAll(".ch")).map(function(c){return Math.round(c.getBoundingClientRect().height);}))', main.id);
    var heights = JSON.parse(chHeights.slice(8));
    var bad = heights.filter(function (h) { return h !== 32; }).length;
    console.log('· 侧栏各行高度 ' + JSON.stringify(heights) + '（应全部 32）');
    if (bad) { console.log('x ' + bad + ' 行高度异常（被撑破）'); fail++; }

    var clipped = await pc.inCtx('"JSONSTR:" + JSON.stringify(Array.from(document.querySelectorAll(".nm")).map(function(n){var t=n.querySelector(".dsh-tr"); return {chars: t? t.textContent.length : 0, w: t? Math.round(t.getBoundingClientRect().width) : 0};}))', main.id);
    console.log('· 侧栏译文宽度 ' + clipped.slice(0, 200));

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK 图标与侧栏回归测试通过'));
  process.exit(fail ? 1 : 0);
})();
