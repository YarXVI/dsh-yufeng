/* 全特殊文本格式回归测试：属性 / option / SVG text / shadow DOM / ruby / details / figcaption。
   node test/formats.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9410;
const HTTP_PORT = 8832;

const SVG = function (w, h, fill) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><rect width="' + w + '" height="' + h + '" fill="' + fill + '"/></svg>');
};

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>formats</title>' +
  '<style>body{margin:0;padding:20px;font:15px/1.7 system-ui;max-width:800px}' +
  '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}' +
  'code{background:#f2f4f7;padding:1px 4px}pre{background:#f6f8fa;padding:8px}</style></head><body>' +

  '<h1>Format coverage</h1>' +

  // 属性
  '<img src="' + SVG(40, 40, '#66a') + '" alt="Company logo, blue square" title="Logo details">' +
  '<input type="text" placeholder="Search the documentation" aria-label="Search box">' +
  '<textarea placeholder="Write your message here"></textarea>' +
  '<select aria-label="Language picker"><option>English</option><option>Japanese</option><option>German</option></select>' +
  '<input type="submit" value="Submit the form"><input type="button" value="Reset everything">' +

  // Ruby
  '<p><ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby><ruby>字<rp>(</rp><rt>ji</rt><rp>)</rp></ruby> reading</p>' +

  // Details / summary
  '<details open><summary>How do I reset my password?</summary><p>Click the forgot password link.</p></details>' +

  // Figure
  '<figure><img src="' + SVG(60, 40, '#a66') + '" alt="Sample chart"><figcaption>Figure 1: monthly revenue</figcaption></figure>' +

  // SVG text
  '<svg width="200" height="50"><rect width="200" height="50" fill="#eef"/><text x="8" y="30" font-size="13" fill="#333">Revenue trend</text></svg>' +

  // 表格
  '<table border="1"><tr><th>Product name</th><th>Unit price</th></tr>' +
  '<tr><td>Widget 3000</td><td>$0.0016</td></tr></table>' +

  // 代码（不翻）
  '<pre><code>const x = run_code({ text: "hello" });</code></pre>' +

  // 隐藏
  '<span class="sr">Skip to main content</span>' +

  // Shadow DOM
  '<my-card id="s1"></my-card>' +

  '<script>customElements.define("my-card", class extends HTMLElement { connectedCallback() {' +
  'const sr = this.attachShadow({mode:"open"});' +
  'sr.innerHTML = "<div style=\'padding:8px\'><h3>Shadow DOM heading</h3><p>Paragraph in shadow root.</p><input placeholder=\'Shadow placeholder\'></div>";' +
  '}});<\/script></body></html>';

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
      ev: async function (expr, cid) {
        var r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
        if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400));
        return r.result.value;
      },
      get contexts() { return contexts; }, close: function () { ws.close(); }
    }); }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async function () {
  var fail = 0;
  var profile = path.join(os.tmpdir(), 'dsh-fmt-' + Date.now());
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

    var n0 = await pc.ev('globalThis.__DSH_INTERNALS__.collect(document.body).length', iso.id);
    console.log('· 收集单元 ' + n0);
    if (!n0) { console.log('x 一个都没收集到'); fail++; }

    await pc.ev('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    for (var i = 0; i < 120; i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      var st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id));
      if (st.total > 0 && st.done >= st.total) break;
    }

    var chk = await pc.ev('(function(){' +
      'var q=function(s){return document.querySelector(s);};' +
      'var o={};' +
      'o.alt=(q("img")||{}).alt||"";' +
      'o.ph=(q("input[type=text]")||{}).placeholder||"";' +
      'o.taPh=(q("textarea")||{}).placeholder||"";' +
      'o.submitVal=(q("input[type=submit]")||{}).value||"";' +
      'o.selAria=q("select")?q("select").getAttribute("aria-label"):"";' +
      'o.opts=Array.from(document.querySelectorAll("option")).map(function(x){return x.textContent;});' +
      'o.svgText=q("svg text")?q("svg text").textContent:"";' +
      'var c=document.getElementById("s1");' +
      'o.shadowH3=(c&&c.shadowRoot)?c.shadowRoot.querySelector("h3").textContent:"";' +
      'o.shadowPh=(c&&c.shadowRoot&&c.shadowRoot.querySelector("input"))?c.shadowRoot.querySelector("input").placeholder:"";' +
      'o.rubyRt=Array.from(document.querySelectorAll("rt")).map(function(r){return r.textContent;});' +
      'o.code=(q("pre code")||{}).textContent||"";' +
      'o.sr=(q(".sr")||{}).textContent||"";' +
      'return o;' +
      '})()', main.id);

    function hasHan(s) { return /\p{Script=Han}/u.test(String(s || '')); }
    var checks = [
      ['img alt 被翻', hasHan(chk.alt), chk.alt],
      ['input placeholder 被翻', hasHan(chk.ph), chk.ph],
      ['textarea placeholder 被翻', hasHan(chk.taPh), chk.taPh],
      ['submit value 被翻', hasHan(chk.submitVal), chk.submitVal],
      ['select aria-label 被翻', hasHan(chk.selAria), chk.selAria],
      ['option 文字被翻', hasHan(chk.opts.join('')), chk.opts.join('/')],
      ['SVG <text> 被翻', hasHan(chk.svgText), chk.svgText],
      ['shadow h3 被翻', hasHan(chk.shadowH3), chk.shadowH3],
      ['shadow placeholder 被翻', hasHan(chk.shadowPh), chk.shadowPh],
      ['ruby 注音保留', chk.rubyRt.length === 2 && chk.rubyRt[0] === 'kan', chk.rubyRt.join('/')],
      ['code 未被翻', !hasHan(chk.code), chk.code.slice(0, 30)],
      ['隐藏标签未被翻', !hasHan(chk.sr), chk.sr.slice(0, 24)]
    ];
    console.log('');
    checks.forEach(function (c) {
      if (c[1]) { console.log('✓ ' + c[0] + ' → ' + String(c[2]).slice(0, 40)); }
      else { console.log('✗ ' + c[0] + ' → ' + String(c[2]).slice(0, 40)); fail++; }
    });
    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK 特殊文本格式测试通过'));
  process.exit(fail ? 1 : 0);
})();
