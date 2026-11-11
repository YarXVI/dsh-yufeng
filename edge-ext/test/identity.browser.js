/* 缓存护栏浏览器测试：即使持久缓存里已有 identity 脏条目，
   页面也必须翻出正确结果（护栏 2 会把它删掉并重新翻译）。
   node test/identity.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9520;
const HTTP_PORT = 8950;

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>identity</title>' +
  '<style>body{margin:0;background:#1b1b1b;color:#eee;font:14px/1.5 system-ui}' +
  '.container{max-width:860px;margin:0 auto;padding:16px}' +
  '#gdd td{padding:4px 0;vertical-align:top}' +
  '#gdd .tc{width:100px;text-align:right;font-weight:700;white-space:nowrap}' +
  '.tags{display:flex;flex-wrap:wrap;gap:5px}' +
  '.gt{background:#3a3a3a;border:1px solid #555;border-radius:3px;padding:1px 5px;font-size:12px}' +
  '.gt a{color:#7fd3ff;text-decoration:none}' +
  '</style></head><body><div class="container">' +
  '<table id="gdd">' +
  '<tr><td class="tc"><a href="#x">Tags:</a></td><td><div class="tags">' +
  '<span class="gt"><a href="#x"><span class="gtl">doujinshi</span><span class="gtc">519.5k</span></a></span>' +
  '</div></td></tr>' +
  '<tr><td class="tc"><a href="#x">Categories:</a></td><td><div class="tags">' +
  '<span class="gt"><a href="#x"><span class="gtl">manga</span><span class="gtc">531</span></a></span>' +
  '</div></td></tr>' +
  '</table></div></body></html>';

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
  var profile = path.join(os.tmpdir(), 'dsh-id-' + Date.now());
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
    await pc.send('Page.enable');
    await new Promise(function (r) { setTimeout(r, 1000); });
    var iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    var main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso) throw new Error('no content script');

    // 故意塞入 identity 脏条目（模拟老版本留下的坏数据）
    await pc.ev('new Promise(function(res){' +
      'var v="v2";' +
      'chrome.storage.local.get(["tc0","tc1","tc2","tc3","tc4","tc5","tc6","tc7"], function(got){' +
      '  var bad={};' +
      '  bad[v+"\\u0000简体中文\\u0000tags:"]={text:"Tags:",at:1,last:1,hits:9,src:"Tags:"};' +
      '  bad[v+"\\u0000简体中文\\u0000doujinshi"]={text:"doujinshi",at:1,last:1,hits:9,src:"doujinshi"};' +
      '  got.tc0=Object.assign(got.tc0||{}, bad);' +
      '  chrome.storage.local.set(got, function(){res(1);});' +
      '});})', iso.id);
    console.log('· 已塞入 identity 脏缓存');

    await pc.send('Page.reload');
    await new Promise(function (r) { setTimeout(r, 2800); });
    await pc.send('Runtime.disable'); await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 800); });
    iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();

    var t0 = Date.now();
    await pc.ev('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    for (var i = 0; i < 150; i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      var st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id));
      if (st.total > 0 && st.done >= st.total) break;
    }
    console.log('· 翻译完成 ' + (Date.now() - t0) + 'ms');

    var r = await pc.ev('(function(){' +
      'var o={};' +
      'var t0=document.querySelectorAll("#gdd tr")[0].querySelector(".tc .dsh-tr");' +
      'o.tagsKey=t0?t0.textContent:"(未翻)";' +
      'var v=document.querySelector("#gdd tr td .gtl .dsh-tr");' +
      'o.doujinshi=v?v.textContent:"(未翻)";' +
      'var m=document.querySelectorAll("#gdd tr")[1].querySelector(".gtl .dsh-tr");' +
      'o.manga=m?m.textContent:"(未翻)";' +
      'return o;' +
      '})()', main.id);

    var hasHan = function (s) { return /\p{Script=Han}/u.test(String(s || '')); };
    var checks = [
      ['Tags: 键名被翻译（脏条目被丢弃）', hasHan(r.tagsKey) && r.tagsKey.indexOf('Tags') < 0, r.tagsKey],
      ['doujinshi 被翻译（不是 identity）', hasHan(r.doujinshi), r.doujinshi],
      ['manga 被翻译', hasHan(r.manga), r.manga]
    ];
    console.log('');
    for (var c of checks) {
      if (c[1]) { console.log('✓ ' + c[0] + ' → ' + c[2]); }
      else { console.log('✗ ' + c[0] + ' → ' + c[2]); fail++; }
    }

    // 再确认脏条目已被清掉
    var stats = JSON.parse(await pc.ev('new Promise(function(res){chrome.runtime.sendMessage({t:"cacheStats"}, function(x){res(JSON.stringify(x));});})', iso.id));
    console.log('· 缓存统计: ' + JSON.stringify(stats));

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK 缓存护栏测试通过'));
  process.exit(fail ? 1 : 0);
})();
