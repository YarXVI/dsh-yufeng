/* Discord 结构回归测试：
     · 图标栏（nav[aria-label=服务器侧栏] / data-list-id=guildsnav）整体不碰
     · 频道列表（data-list-id=channels）整体不碰
     · 消息正文照常翻译（这是上一版最大的回归点）
     · 应用外壳带 translate="no" 也不能整页失翻
   node test/discord.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9440;
const HTTP_PORT = 8860;

const GUILD = (i, name) =>
  '<div class="listItem_rwEpil"><div class="listItem_rwEpil">' +
  '<div class="wrapper__08_Xq overlay__08_Xq" aria-hidden="true"></div>' +
  '<span><div class="blobContainer_IapWk5"><div class="wrapper_qhZPSU" style="width:40px;height:40px">' +
  '<svg width="48" height="48" viewBox="-4 -4 48 48" class="svg_qhZPSU">' +
  '<mask id="_r_mp_' + i + '" fill="black"><rect width="40" height="40"></rect></mask>' +
  '<foreignObject mask="url(#_r_mp_' + i + ')" x="0" y="0" width="40" height="40">' +
  '<div class="wrapper_qhZPSU" style="width:40px;height:40px">' +
  '<div data-dnd-name="' + name + '" draggable="true">' +
  '<div class="wrapper_JJ-hqG" role="treeitem" data-list-item-id="guildsnav___' + (1000 + i) + '">' +
  '<svg width="40" height="40"><rect width="40" height="40" rx="20" fill="hsl(' + (i * 55) + ',58%,50%)"/></svg>' +
  '</div></div></div></foreignObject></svg></div></div></span>' +
  '<span class="hiddenVisually_F8xKac">' + name + '</span>' +
  '<div class="wrapper_nI08_y" aria-hidden="true"></div>' +
  '</div></div>';

const CHANNELS = ['announcements', 'rules', 'general', 'help', 'plugin']
  .map((n, i) => '<a href="#x" role="treeitem" data-list-item-id="channels___' + n + '" class="ch' + (i === 2 ? ' active' : '') + '"><span>#</span><span class="nm">' + n + '</span></a>')
  .join('');

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Discord</title>' +
  '<style>*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:#313338;color:#dbdee1;font:14px/1.4 system-ui}' +
  '#app-mount{display:flex;height:100vh}' +
  '.guilds{width:72px;background:#1e1f22;padding:8px 0}' +
  '.tree{display:flex;flex-direction:column;align-items:center;gap:8px}' +
  '.blobContainer_IapWk5{width:48px;height:48px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center}' +
  '.wrapper_qhZPSU{display:flex;align-items:center;justify-content:center}' +
  '.hiddenVisually_F8xKac{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}' +
  '.listItem_rwEpil{display:flex;justify-content:center}' +
  '.sidebar{width:200px;background:#2b2d31;padding:8px}' +
  '.ch{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:4px;color:#949ba4;text-decoration:none}' +
  '.ch.active{background:#35373c;color:#f2f3f5}' +
  '.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.main{flex:1;padding:14px}' +
  '.msg{margin-bottom:14px}.author{font-weight:600;color:#f2f3f5}.text{white-space:pre-wrap;margin-top:2px}' +
  '</style></head><body>' +
  '<div id="app-mount" translate="no">' +
  '<nav class="guilds" aria-label="服务器侧栏"><div role="tree" data-list-id="guildsnav" class="tree">' +
  [0, 1, 2, 3, 4].map((i) => GUILD(i, ['OpenDesign', 'Compass', 'Cherry Blossom', 'Anime Avatar', 'Explorer Patcher'][i])).join('') +
  '</div></nav>' +
  '<div class="sidebar">' + CHANNELS + '</div>' +
  '<div class="main">' +
  '<div class="msg"><div class="author">someone</div><div class="text">Hey, I keep getting this error on DeepSeek V4.1 Flash Eco.</div></div>' +
  '<div class="msg"><div class="author">another</div><div class="text">It looks like the model is outputting two tool-call JSONs stuck together.</div></div>' +
  '<div class="msg"><div class="author">third</div><div class="text">Regular DeepSeek works fine. Only the Eco variant is broken.</div></div>' +
  '</div></div></body></html>';

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
  var profile = path.join(os.tmpdir(), 'dsh-dc-' + Date.now());
  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
  var child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-component-extensions-with-background-pages',
    'http://127.0.0.1:' + HTTP_PORT + '/?dshSite=discord.com'
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

    console.log('· 站点规则: ' + await pc.ev('globalThis.__DSH_INTERNALS__.siteRule()', iso.id));
    var units = await pc.ev('globalThis.__DSH_INTERNALS__.collect(document.body).length', iso.id);
    console.log('· 收集单元 ' + units + ' 个');
    if (!units) { console.log('x 一个都没收集到'); fail++; }

    var t0 = Date.now();
    await pc.ev('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    for (var i = 0; i < 120; i++) {
      await new Promise(function (r) { setTimeout(r, 250); });
      var st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id));
      if (st.total > 0 && st.done >= st.total) break;
    }
    console.log('· 翻译完成 ' + (Date.now() - t0) + 'ms');

    var checks = [
      ['图标栏 SVG 还在', 'document.querySelectorAll("nav.guilds svg").length >= 8', await pc.ev('document.querySelectorAll("nav.guilds svg").length', main.id) + ' 个'],
      ['图标栏没译文', 'document.querySelectorAll("nav.guilds .dsh-tr").length === 0', await pc.ev('document.querySelectorAll("nav.guilds .dsh-tr").length', main.id) + ' 个'],
      ['频道列表没译文', 'document.querySelectorAll(".sidebar .dsh-tr").length === 0', await pc.ev('document.querySelectorAll(".sidebar .dsh-tr").length', main.id) + ' 个'],
      ['消息区有译文', 'document.querySelectorAll(".main .dsh-tr").length >= 3', await pc.ev('document.querySelectorAll(".main .dsh-tr").length', main.id) + ' 个'],
      ['translate=no 外壳下仍翻译', 'document.getElementById("app-mount").getAttribute("translate") === "no"', '外壳属性 ' + await pc.ev('document.getElementById("app-mount").getAttribute("translate")', main.id)]
    ];
    console.log('');
    for (var c of checks) {
      var n = await pc.ev(c[1], main.id);
      if (n) { console.log('✓ ' + c[0] + ' → ' + c[2]); }
      else { console.log('✗ ' + c[0] + ' → ' + c[2]); fail++; }
    }

    // 译文确实是中文
    var sample = await pc.ev('(function(){var t=document.querySelector(".main .text .dsh-tr"); return t? t.textContent.slice(0,60):"";})()', main.id);
    var hasHan = /\p{Script=Han}/u.test(String(sample || ''));
    console.log('');
    if (hasHan) { console.log('✓ 消息译文是中文 → ' + sample); }
    else { console.log('✗ 消息译文不是中文 → ' + sample); fail++; }

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log('\n' + (fail ? ('x 失败 ' + fail + ' 项') : 'OK Discord 结构测试通过'));
  process.exit(fail ? 1 : 0);
})();
