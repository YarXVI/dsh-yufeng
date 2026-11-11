/* 页面结构分析器：直接分析保存下来的 HTML 文件。
   用法：node test/analyze.js <页面.html> [--translate]

   输出：
     1. 页面环境（站点规则、元素数、正文字数）
     2. 会翻译的单元（含 mode 和 DOM 路径）
     3. 被跳过的元素（含原因）
     4. --translate 时的实际译文
     5. 截图
   */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = String.raw`C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe`;
const EXT = path.join(__dirname, '..');
const PORT = 9600 + Math.floor(Math.random() * 200);
const HTTP_PORT = 9100 + Math.floor(Math.random() * 200);

const fileArg = process.argv[2];
if (!fileArg) {
  console.log('用法: node test/analyze.js <页面.html> [--translate]');
  process.exit(1);
}
const filePath = path.resolve(fileArg);
if (!fs.existsSync(filePath)) {
  console.log('文件不存在: ' + filePath);
  process.exit(1);
}
const DO_TRANSLATE = process.argv.includes('--translate');
const HTML = fs.readFileSync(filePath, 'utf8');
console.log('· 分析文件: ' + filePath + ' (' + Math.round(HTML.length / 1024) + ' KB)');

// 页面里要跑的探测脚本全部放在独立文件里，避免嵌套字符串转义问题
function probeSource(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

const server = http.createServer(function (q, s) {
  const urlPath = (q.url || '/').split('?')[0];
  if (urlPath === '/') {
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    s.end(HTML);
    return;
  }
  s.writeHead(404); s.end();
});

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

/** 把页面里跑出来的 "X" + JSON 解析回来 */
function parseJsonX(s) {
  if (typeof s !== 'string') return null;
  if (s.indexOf('X') !== 0) return null;
  try { return JSON.parse(s.slice(1)); } catch (e) { return null; }
}

(async function () {
  var profile = path.join(os.tmpdir(), 'dsh-an-' + Date.now());
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
    if (!page) throw new Error('页面没打开');
    var pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1500); });
    var iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    var main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso) throw new Error('content script 没注入');

    // ---- 1. 页面环境 ----
    var env = parseJsonX(await pc.ev('"X" + JSON.stringify((' + probeSource('_page_env.js') + '))', iso.id));
    console.log('');
    console.log('=== 页面环境 ===');
    if (env) {
      console.log('  元素总数: ' + env.elements);
      console.log('  正文字数: ' + env.bodyText);
      console.log('  站点规则: ' + (env.siteRule || '(无)'));
    }

    // ---- 2. 会翻译的单元 ----
    var units = parseJsonX(await pc.ev('"X" + JSON.stringify((' + probeSource('_page_units.js') + '))', iso.id)) || [];
    console.log('');
    console.log('=== 会翻译的单元（' + units.length + ' 个）===');
    var byMode = {};
    units.forEach(function (u) { byMode[u.mode] = (byMode[u.mode] || 0) + 1; });
    console.log('  mode 分布: ' + JSON.stringify(byMode));
    units.forEach(function (u, i) {
      console.log('  ' + String(i + 1).padStart(2) + '. [' + String(u.mode).padEnd(7) + '] ' + JSON.stringify(String(u.text).slice(0, 46)));
      console.log('      ' + u.path);
    });

    // ---- 3. 被跳过的元素 ----
    var skips = parseJsonX(await pc.ev('"X" + JSON.stringify((' + probeSource('_page_skips.js') + '))', iso.id)) || { skipped: [], totalTextLeaves: 0 };
    console.log('');
    console.log('=== 被跳过的元素（' + skips.totalTextLeaves + ' 个含直接文字的元素中，' + skips.skipped.length + ' 个被跳过）===');
    if (!skips.skipped.length) {
      console.log('  (无)');
    } else {
      skips.skipped.slice(0, 40).forEach(function (s, i) {
        console.log('  ' + String(i + 1).padStart(2) + '. <' + s.tags + '> ' + JSON.stringify(String(s.text).slice(0, 44)));
        console.log('      原因: ' + s.reason + '  |  ' + s.path);
      });
      if (skips.skipped.length > 40) console.log('  … 还有 ' + (skips.skipped.length - 40) + ' 个');
    }

    // ---- 4. 翻译 ----
    if (DO_TRANSLATE && units.length) {
      console.log('');
      console.log('=== 实际翻译 ===');
      var t0 = Date.now();
      await pc.ev('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
      for (var k = 0; k < 400; k++) {
        await new Promise(function (r) { setTimeout(r, 250); });
        var st = JSON.parse(await pc.ev('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id));
        if (st.total > 0 && st.done >= st.total) break;
      }
      console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      var trs = parseJsonX(await pc.ev('"X" + JSON.stringify((' + probeSource('_page_results.js') + '))', main.id)) || [];
      trs.forEach(function (t, i) {
        console.log('  ' + String(i + 1).padStart(2) + '. ' + JSON.stringify(String(t.src).slice(0, 44)));
        console.log('      → ' + JSON.stringify(String(t.dst).slice(0, 60)) + (t.cls ? '  [' + t.cls + ']' : ''));
      });
    }

    // ---- 5. 截图 ----
    var shot = await pc.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 900, height: 900, scale: 1 } });
    var outPng = filePath.replace(/\.[^.]+$/, '') + '_analyzed.png';
    fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    console.log('');
    console.log('· 截图: ' + outPng);

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }
  process.exit(0);
})();
