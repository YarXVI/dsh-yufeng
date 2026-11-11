'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9362;
const HTTP_PORT = 8782;

const CASES = [
  ['b', '<p>This is <b>bold text</b> and normal text.</p>'],
  ['i', '<p>This is <i>italic text</i> here.</p>'],
  ['u', '<p>This is <u>underlined</u> text.</p>'],
  ['s', '<p>This is <s>strikethrough</s> text.</p>'],
  ['a', '<p>Click <a href="/docs">this link</a> to continue.</p>'],
  ['code', '<p>Run <code>npm install</code> in the terminal.</p>'],
  ['mark', '<p>Please <mark>note this</mark> carefully.</p>'],
  ['sub', '<p>Water is H<sub>2</sub>O.</p>'],
  ['sup', '<p>Energy equals mc<sup>2</sup>.</p>'],
  ['kbd', '<p>Press <kbd>Ctrl</kbd> plus <kbd>C</kbd>.</p>'],
  ['cite', '<p>According to <cite>the manual</cite>.</p>'],
  ['q', '<p>The answer is <q>forty two</q>.</p>'],
  ['small', '<p><small>Legal disclaimer here.</small></p>'],
  ['MIX', '<p>Here is <b>bold with <a href="/x">a link</a></b> and <i>italic <code>code</i></code>.</p>']
];

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rich</title>' +
  '<style>body{font:16px/1.7 system-ui;max-width:800px;margin:40px auto}code,kbd{background:#eee;padding:1px 4px}</style>' +
  '</head><body>' + CASES.map(function (c) { return c[1]; }).join('\n') + '</body></html>';

const server = http.createServer(function (q, s) { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE); });

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); let contexts = [];
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  return new Promise(function (res, rej) {
    ws.addEventListener('open', function () {
      res({
        send: function (me, p) { return new Promise(function (resolve, reject) { const mid = ++id; pending.set(mid, { resolve: resolve, reject: reject }); ws.send(JSON.stringify({ id: mid, method: me, params: p || {} })); }); },
        inCtx: async function (expr, cid) {
          const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
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
  let fail = 0;
  const profile = path.join(os.tmpdir(), 'dsh-rich-' + Date.now());
  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });

  const child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-component-extensions-with-background-pages',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { stdio: 'ignore' });
  await new Promise(function (r) { setTimeout(r, 8000); });

  try {
    const list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(function (r) { return r.json(); });
    const page = list.find(function (t) { return t.type === 'page' && t.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('no test page');
    const pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1000); });
    const iso = pc.contexts.find(function (c) { return c.auxData && c.auxData.type === 'isolated'; });
    const main = pc.contexts.find(function (c) { return c.auxData && c.auxData.type === 'default'; });
    if (!iso) throw new Error('content script not injected');

    const richInfo = await pc.inCtx('JSON.stringify(globalThis.__DSH_INTERNALS__.collect(document.body).map(function(u){return u.rich ? u.els.map(function(e){return e.tag;}).join("+") : "PLAIN"; }))', iso.id);
    const arr = JSON.parse(richInfo || '[]');
    console.log('· 收集到 ' + arr.length + ' 个单元，其中富文本 ' + arr.filter(function (x) { return x !== 'PLAIN'; }).length + ' 个');
    arr.forEach(function (x) { console.log('    ' + x); });

    await pc.inCtx('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    let done = 0, total = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise(function (r) { setTimeout(r, 400); });
      const st = JSON.parse(await pc.inCtx('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id) || '{}');
      done = st.done || 0; total = st.total || 0;
      if (total > 0 && done >= total) break;
    }
    console.log('· 翻译完成 ' + done + '/' + total);

    console.log('\n=== 逐段核对 ===');
    for (const c of CASES) {
      const label = c[0];
      const expr = label === 'MIX'
        ? 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector("b") && t.querySelector("a") && t.querySelector("i");}).length'
        : 'Array.from(document.querySelectorAll(".dsh-tr")).filter(function(t){return t.querySelector("' + label + '");}).length';
      const n = await pc.inCtx(expr, main.id);
      const ok = (typeof n === 'number' && n > 0);
      console.log((ok ? '✓' : '✗') + ' <' + label + '> 保留格式的译文 ' + n + ' 个');
      if (!ok) fail++;
    }

    console.log('\n=== 译文样本 ===');
    const html = JSON.parse(await pc.inCtx('JSON.stringify(Array.from(document.querySelectorAll(".dsh-tr")).slice(0,8).map(function(t){return t.innerHTML;}))', main.id));
    html.forEach(function (h) { console.log('  ' + h.slice(0, 120)); });

    const unbalanced = await pc.inCtx('(function(){var bad=0; document.querySelectorAll(".dsh-tr").forEach(function(t){ if(!t.querySelector("*")) return; }); return bad;})()', main.id);
    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK 富文本测试通过'));
  process.exit(fail ? 1 : 0);
})();
