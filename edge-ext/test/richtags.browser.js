/* Discord 风格富文本测试：@提及、行内代码、@频道、链接、粗体、行内 code 全部要保住样式。
   这类节点的特点是「带 class 的 span」——不是标准 HTML 语义标签，但绝不能丢。
   node test/richtags.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9372;
const HTTP_PORT = 8792;

const MSG = '<div class="mc">Hi <span class="mention">@someone</span>, I keep getting ' +
  '<span class="inline-code">run_code</span> errors on <b>DeepSeek V4.1</b>, ' +
  'position <code>567</code>. See <a href="/issue">the issue</a>.</div>';

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Discord rich</title>' +
  '<style>body{margin:0;background:#313338;color:#dbdee1;font:15px/1.6 system-ui}' +
  '.main{padding:12px}.mc{margin:0 0 12px;white-space:pre-wrap}' +
  '.mention{background:rgba(107,140,255,.16);color:#a9bcff;border-radius:3px}' +
  '.inline-code{background:#2b2d31;border-radius:3px;font-family:monospace}' +
  'code{background:#2b2d31;font-family:monospace}</style></head><body><div class="main">' +
  Array(30).fill(MSG).join('') + '</div></body></html>';

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
    ws.addEventListener('open', function () {
      res({
        send: function (me, pa) { return new Promise(function (resolve, reject) { var mid = ++id; pending.set(mid, { resolve: resolve, reject: reject }); ws.send(JSON.stringify({ id: mid, method: me, params: pa || {} })); }); },
        inCtx: async function (expr, cid) {
          var r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
          if (r.exceptionDetails) return { __error: ((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400) };
          return r.result.value;
        },
        get contexts() { return contexts; }, close: function () { ws.close(); }
      });
    }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async function () {
  var fail = 0;
  var profile = path.join(os.tmpdir(), 'dsh-richtags-' + Date.now());
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
    var iso = pc.contexts.find(function (c) { return c.auxData && c.auxData.type === 'isolated'; });
    var main = pc.contexts.find(function (c) { return c.auxData && c.auxData.type === 'default'; });
    if (!iso) throw new Error('no content script');

    var units = await pc.inCtx('globalThis.__DSH_INTERNALS__.collect(document.body).length', iso.id);
    console.log('· 收集 ' + units + ' 个单元');
    if (!units) { console.log('x 一个都没收集到'); fail++; }

    await pc.inCtx('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    var st = {};
    for (var i = 0; i < 120; i++) {
      await new Promise(function (r) { setTimeout(r, 400); });
      st = JSON.parse(await pc.inCtx('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id) || '{}');
      if (st.total > 0 && st.done >= st.total) break;
    }
    console.log('· 完成 ' + st.done + '/' + st.total);

    var checks = [
      ['@提及 <span class="mention">', 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector(".mention");}).length', 30],
      ['行内代码 <span class="inline-code">', 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector(".inline-code");}).length', 30],
      ['粗体 <b>', 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector("b");}).length', 30],
      ['行内 <code>', 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector("code");}).length', 30],
      ['链接 <a>（带 href）', 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){var a=t.querySelector("a");return a && a.getAttribute("href")==="/issue";}).length', 30]
    ];
    console.log('\n=== 逐项核对 ===');
    for (var c of checks) {
      var n = await pc.inCtx(c[1], main.id);
      var ok = (typeof n === 'number' && n >= c[2]);
      console.log((ok ? '✓' : '✗') + ' ' + c[0] + ' → ' + n + '/' + c[2]);
      if (!ok) fail++;
    }

    console.log('\n=== 译文样本 ===');
    var s1 = await pc.inCtx('String(document.querySelector(".dsh-tr").innerHTML).slice(0,200)', main.id);
    console.log('  ' + s1);

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK Discord 富文本测试通过'));
  process.exit(fail ? 1 : 0);
})();
