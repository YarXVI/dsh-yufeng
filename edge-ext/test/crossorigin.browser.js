/* 跨域图片翻译测试。
   这是用户报的 bug 的回归测试：nhentai 的图在 i4.nhentai.net，跟页面跨域。
   之前 canvas 被 taint → 「Alt+点击无效」；现在走 background fetch。
   node test/crossorigin.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const CDP_PORT = 9390 + Math.floor(Math.random() * 40);
const PAGE_PORT = 9000 + Math.floor(Math.random() * 40);
const IMG_PORT = 9040 + Math.floor(Math.random() * 40);

// 页面上画的图（用 canvas 生成 PNG 再 base64 通过另一个端口提供）
const PIC_SCRIPT = [
  'var c = document.createElement("canvas"); c.width = 700; c.height = 400;',
  'var g = c.getContext("2d");',
  'g.fillStyle = "#fff"; g.fillRect(0, 0, 700, 400);',
  'g.fillStyle = "#000"; g.font = "32px sans-serif";',
  'g.fillText("おはよう、今日は何する？", 30, 70);',
  'g.fillText("これは本当にすごいね！", 30, 140);',
  'g.fillText("ありがとうございます", 30, 210);',
  'return c.toDataURL("image/png");'
].join('\n');

const server = http.createServer(function (q, s) {
  var u = (q.url || '/').split('?')[0];
  if (u === '/pic.png') {
    // 图通过**另一个端口**提供 → 对页面来说是跨域
    s.writeHead(302, { Location: 'http://127.0.0.1:' + IMG_PORT + '/pic.png' });
    s.end();
    return;
  }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  s.end(PAGE);
});

let PIC_DATAURL = '';
const imgServer = http.createServer(function (q, s) {
  var m = PIC_DATAURL.match(/^data:image\/png;base64,(.+)$/);
  if (!m) { s.writeHead(500); s.end('no pic'); return; }
  s.writeHead(200, { 'Content-Type': 'image/png' });
  s.end(Buffer.from(m[1], 'base64'));
});

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cross origin img</title>' +
  '<style>body{margin:0;padding:20px;background:#1b1b1b;color:#eee;font:14px/1.6 system-ui}img{display:block;border:1px solid #444}</style></head><body>' +
  '<h1>Cross-origin image test</h1>' +
  '<p>图来自另一个端口（跨域）。Alt + 点击应该能翻译。</p>' +
  '<img id="target" src="http://127.0.0.1:' + IMG_PORT + '/pic.png" />' +
  '<script>' + PIC_SCRIPT + '</' + 'script>' +
  '</body></html>';

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

(async function () {
  let pass = 0, fail = 0;
  function t(name, cond, detail) {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
  }

  let child = null, pc = null;
  try {
    await new Promise(function (r) { imgServer.listen(IMG_PORT, '127.0.0.1', r); });
    await new Promise(function (r) { server.listen(PAGE_PORT, '127.0.0.1', r); });

    const profile = path.join(os.tmpdir(), 'dsh-xo-' + Date.now());
    child = spawn(EDGE, [
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
      '--no-first-run', '--no-default-browser-check',
      'http://127.0.0.1:' + PAGE_PORT + '/'
    ], { stdio: 'ignore' });
    await new Promise(function (r) { setTimeout(r, 8000); });

    const list = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list').then(function (r) { return r.json(); });
    const page = list.find(function (x) { return x.type === 'page' && x.url.indexOf(String(PAGE_PORT)) >= 0; });
    if (!page) throw new Error('页面没打开');
    pc = await connect(page.webSocketDebuggerUrl);
    await pc.raw('Runtime.enable');
    await pc.raw('Input.enable');
    await new Promise(function (r) { setTimeout(r, 1800); });

    let iso = null;
    for (const c of pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; })) {
      if ((await pc.ev('typeof globalThis.__DSH_IMG__', c.id)) === 'object') { iso = c; break; }
    }
    const main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso || !main) throw new Error('context 缺失');
    await pc.ev('new Promise(function(r){ setTimeout(r, 700); })', iso.id);

    // 记录页面上画出的图（供 IMG_PORT 提供）
    PIC_DATAURL = await pc.ev('(function(){' + PIC_SCRIPT + '})()', main.id);
    t('测试页能生成图', !!(PIC_DATAURL && PIC_DATAURL.indexOf('data:image/png') === 0));

    /**
     * 图服务器刚才有内容 —— 页面打开时 PIC_DATAURL 还是空的，
     * 所以 img 的第一次请求拿到了 500。
     * 让浏览器重新取一次（加个时间戳绕过缓存）。
     */
    await pc.ev('(function(){ var i = document.getElementById("target");' +
      ' i.src = "http://127.0.0.1:' + IMG_PORT + '/pic.png?t=" + Date.now(); return 1; })()', main.id);
    await pc.ev('(async function(){ var i = document.getElementById("target");' +
      ' if (i.complete && i.naturalWidth) return i.naturalWidth;' +
      ' await new Promise(function(r){ i.onload = r; i.onerror = r; setTimeout(r, 5000); });' +
      ' return i.naturalWidth; })()', main.id);

    // 确认图是跨域的
    // 等图真正 decode 完（测试里 setTimeout 太早，nw 还是 0）
    await pc.ev('(async function(){ var i = document.getElementById("target");' +
      ' if (i.complete && i.naturalWidth) return 1;' +
      ' await new Promise(function(r){ i.onload = r; i.onerror = r; setTimeout(r, 5000); });' +
      ' return i.naturalWidth; })()', main.id);
    const info = await pc.ev('(function(){ var i = document.getElementById("target");' +
      ' return JSON.stringify({ src: i.src, loaded: i.complete && i.naturalWidth > 0, nw: i.naturalWidth }); })()', main.id);
    const inf = JSON.parse(info);
    t('跨域图已加载', inf.loaded && inf.nw > 0, 'nw=' + inf.nw);
    t('图确实在另一个端口', inf.src.indexOf(':' + IMG_PORT) >= 0, inf.src);

    // 确认直接读像素会失败（tainted）
    const taintTest = await pc.ev('(function(){' +
      ' try { var i = document.getElementById("target");' +
      '   var c = document.createElement("canvas"); c.width = 1; c.height = 1;' +
      '   var g = c.getContext("2d"); g.drawImage(i, 0, 0, 1, 1);' +
      '   g.getImageData(0, 0, 1, 1); return "no-taint"; }' +
      ' catch(e) { return "tainted"; } })()', main.id);
    t('直接读像素会 tainted（确认测试有效）', taintTest === 'tainted', taintTest);

    // ★ 核心：detect 应该能通过 background 抓图成功
    const detRaw = await pc.ev(
      '(async function(){ var img = document.getElementById("target");' +
      ' var det = await globalThis.__DSH_IMG__.detect(img);' +
      ' if (!det.ok) return "FAIL:" + det.error;' +
      ' return JSON.stringify({ ms: det.ms, n: det.boxes.length, nw: det.naturalW, nh: det.naturalH }); })()', iso.id);
    t('跨域图检测成功（走 background 抓图）', typeof detRaw === 'string' && detRaw.charAt(0) === '{', String(detRaw).slice(0, 100));
    if (typeof detRaw === 'string' && detRaw.charAt(0) === '{') {
      const det = JSON.parse(detRaw);
      /**
       * 注意：测试图的三行是**连续同段落**（行距 70px、行高 32px），
       * 两级聚类的第二级会把它们合成一个文字块 —— 这是**期望行为**：
       * 整段送模型，模型给的是多行译文，读起来连贯。
       *
       * 如果拆成 3 块，每块单独送，模型看不到上下文，会翻成 3 个孤立短句。
       */
      t('连续段落合并成 1 块（避免逐句瞎猜）', det.n === 1, '实际 ' + det.n);
      t('拿到原始尺寸', det.nw === 700 && det.nh === 400, det.nw + '×' + det.nh);
    }

    // 完整翻译
    const transRaw = await pc.ev(
      '(async function(){ var img = document.getElementById("target");' +
      ' var res = await globalThis.__DSH_IMG__.translate(img, { mode: "overlay" });' +
      ' if (!res.ok) return "FAIL:" + res.error;' +
      ' return JSON.stringify({ n: res.boxes.length, texts: res.results.map(function(x){ return (x.text || "").slice(0, 50); }) }); })()', iso.id);
    t('跨域图完整翻译成功', typeof transRaw === 'string' && transRaw.charAt(0) === '{', String(transRaw).slice(0, 120));
    if (typeof transRaw === 'string' && transRaw.charAt(0) === '{') {
      const tr = JSON.parse(transRaw);
      const allHan = tr.texts.every(function (x) { return new RegExp('[\\u4e00-\\u9fff]').test(x); });
      t('译文都是中文', allHan, tr.texts.join(' | '));
      console.log('    译文: ' + JSON.stringify(tr.texts));
    }

    console.log('');
    console.log(pass + ' 通过 / ' + fail + ' 失败');
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail += 1;
  } finally {
    try { if (pc) pc.close(); } catch (e) {}
    try { if (child) child.kill(); } catch (e) {}
    server.close();
    imgServer.close();
  }
  console.log(fail ? ('X 失败 ' + fail + ' 项') : 'OK 跨域图片翻译测试通过');
  process.exit(fail ? 1 : 0);
})();