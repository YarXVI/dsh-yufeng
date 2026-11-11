/* 图片翻译 · 真实浏览器测试。
   验证 CV 检测正确性 / 逐块翻译 / overlay 定位 / 字号自适应 / 还原。
   node test/image.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const CDP_PORT = 9350 + Math.floor(Math.random() * 40);
const HTTP_PORT = 8990 + Math.floor(Math.random() * 40);

const BUBBLES = [
  { x: 50,  y: 60,  w: 370, h: 160, lines: ['おはよう、', '今日は何する？'] },
  { x: 500, y: 300, w: 360, h: 180, lines: ['これは本当に', 'すごいね！'] },
  { x: 100, y: 620, w: 400, h: 180, lines: ['ありがとう', 'ございます'] },
];

const CANVAS_SCRIPT = [
  'var img = document.getElementById("target");',
  'var c = document.createElement("canvas"); c.width = 900; c.height = 1100;',
  'var g = c.getContext("2d");',
  'g.fillStyle = "#fafaf8"; g.fillRect(0, 0, 900, 1100);',
  'var bubbles = ' + JSON.stringify(BUBBLES) + ';',
  'bubbles.forEach(function (b) {',
  '  g.beginPath();',
  '  g.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);',
  '  g.fillStyle = "#fff"; g.fill();',
  '  g.strokeStyle = "#1e1e1e"; g.lineWidth = 3; g.stroke();',
  '  g.fillStyle = "#0f0f0f"; g.font = "28px sans-serif";',
  '  b.lines.forEach(function (ln, i) { g.fillText(ln, b.x + 48, b.y + 70 + i * 42); });',
  '});',
  'g.strokeStyle = "#000"; g.lineWidth = 4; g.strokeRect(8, 8, 884, 1084);',
  'img.src = c.toDataURL("image/png");'
].join('\n');

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>image browser test</title>' +
  '<style>body{margin:0;padding:20px;background:#1b1b1b;color:#eee;font:14px/1.6 system-ui}' +
  'img{display:block;border:1px solid #444}</style></head><body>' +
  '<h1>Image translation test</h1><p>测试图由 canvas 现场生成（3 个日文气泡）</p>' +
  '<img id="target" width="900" height="1100" />' +
  '<script>' + CANVAS_SCRIPT + '</' + 'script>' +
  '</body></html>';

const server = http.createServer(function (q, s) {
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
  const ev = async (expr, cid) => {
    const r = await raw('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, ...(cid ? { contextId: cid } : {}) });
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

  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
  const profile = path.join(os.tmpdir(), 'dsh-img-' + Date.now());
  const child = spawn(EDGE, [
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { stdio: 'ignore' });

  let pc = null;
  try {
    await new Promise(function (r) { setTimeout(r, 8000); });
    const list = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list').then(function (r) { return r.json(); });
    const page = list.find(function (x) { return x.type === 'page' && x.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('页面没打开');
    pc = await connect(page.webSocketDebuggerUrl);
    await pc.raw('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1500); });

    let iso = null;
    for (const c of pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; })) {
      if ((await pc.ev('typeof globalThis.__DSH_IMG__', c.id)) === 'object') { iso = c; break; }
    }
    const main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso) throw new Error('imgtranslate 模块未加载');
    if (!main) throw new Error('主 context 缺失');
    await pc.ev('new Promise(function(r){ setTimeout(r, 800); })', iso.id);

    // ---- 1. 检测 ----
    const detRaw = await pc.ev(
      '(async function(){ var img = document.getElementById("target");' +
      ' await new Promise(function(r){ if (img.complete && img.naturalWidth) r(); else img.onload = r; });' +
      ' var det = await globalThis.__DSH_IMG__.detect(img);' +
      ' if (!det.ok) return "FAIL:" + det.error;' +
      ' return JSON.stringify({ ms: det.ms, n: det.boxes.length, boxes: det.boxes.map(function(b){ return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }; }) });' +
      '})()', iso.id);
    t('检测返回结果', typeof detRaw === 'string' && detRaw.charAt(0) === '{', String(detRaw).slice(0, 80));
    if (typeof detRaw === 'string' && detRaw.charAt(0) === '{') {
      const det = JSON.parse(detRaw);
      t('检测速度快（< 100ms）', det.ms < 100, det.ms + 'ms');
      t('检测到 3 个气泡', det.n === 3, '实际 ' + det.n);
      let hit = 0;
      for (let i = 0; i < det.boxes.length && i < BUBBLES.length; i++) {
        const b = BUBBLES[i], g = det.boxes[i];
        const inside = g.x >= b.x - 12 && g.y >= b.y - 12 && g.x + g.w <= b.x + b.w + 12 && g.y + g.h <= b.y + b.h + 12;
        if (inside) hit++;
      }
      t('检测框落在气泡内', hit === Math.min(3, det.boxes.length), hit + '/' + det.boxes.length);
    }

    // ---- 2. 完整翻译 ----
    const transRaw = await pc.ev(
      '(async function(){ var img = document.getElementById("target");' +
      ' var res = await globalThis.__DSH_IMG__.translate(img, { mode: "overlay" });' +
      ' if (!res.ok) return "FAIL:" + res.error;' +
      ' return JSON.stringify({ detectMs: res.detectMs, translateMs: res.translateMs, n: res.boxes.length, texts: res.results.map(function(x){ return (x.text || "").slice(0, 60); }) });' +
      '})()', iso.id);
    t('完整翻译成功', typeof transRaw === 'string' && transRaw.charAt(0) === '{', String(transRaw).slice(0, 100));
    if (typeof transRaw === 'string' && transRaw.charAt(0) === '{') {
      const tr = JSON.parse(transRaw);
      t('译文数量匹配', tr.texts.length === tr.n, tr.texts.length + '/' + tr.n);
      t('译文都是中文', tr.texts.every(function (x) { return new RegExp('[\\u4e00-\\u9fff]').test(x); }), tr.texts.join(' | '));
      t('没有日文残留', tr.texts.every(function (x) { return !/[\u3040-\u30ff]/.test(x); }), tr.texts.join(' | '));
      t('译文没有重复', tr.texts.every(function (x) { return !/(.{3,})\s*\1/.test(x); }), tr.texts.join(' | '));
      console.log('    译文: ' + JSON.stringify(tr.texts));
      console.log('    耗时: 检测 ' + tr.detectMs + 'ms + 翻译 ' + tr.translateMs + 'ms');
    }

    // ---- 3. overlay 定位 ----
    const posRaw = await pc.ev(
      '(function(){ var img = document.getElementById("target");' +
      ' var layer = document.querySelector(".dsh-imglayer");' +
      ' if (!layer) return "FAIL:no layer";' +
      ' var ir = img.getBoundingClientRect(), lr = layer.getBoundingClientRect();' +
      ' return JSON.stringify({ dx: Math.round(lr.x - ir.x), dy: Math.round(lr.y - ir.y), iw: Math.round(ir.width), lw: Math.round(lr.width), cells: layer.querySelectorAll(".dsh-imgcell").length });' +
      '})()', main.id);
    if (typeof posRaw === 'string' && posRaw.charAt(0) === '{') {
      const pos = JSON.parse(posRaw);
      t('overlay 与图对齐（≤2px）', Math.abs(pos.dx) <= 2 && Math.abs(pos.dy) <= 2, 'dx=' + pos.dx + ' dy=' + pos.dy);
      t('overlay 宽度匹配', Math.abs(pos.iw - pos.lw) <= 4, pos.iw + ' vs ' + pos.lw);
      t('格子数 = 检测块数', pos.cells === 3, '实际 ' + pos.cells);
    } else t('overlay 层存在', false, String(posRaw).slice(0, 80));

    // ---- 4. 字号不溢出 ----
    const fitRaw = await pc.ev(
      '(function(){ var cells = document.querySelectorAll(".dsh-imgcell"); var bad = [];' +
      ' for (var i = 0; i < cells.length; i++) { var c = cells[i];' +
      '   if (c.scrollWidth > c.clientWidth + 3 || c.scrollHeight > c.clientHeight + 3) bad.push(i); }' +
      ' return JSON.stringify({ n: cells.length, bad: bad }); })()', main.id);
    if (typeof fitRaw === 'string' && fitRaw.charAt(0) === '{') {
      const fit = JSON.parse(fitRaw);
      t('没有文字溢出', fit.bad.length === 0, JSON.stringify(fit.bad));
    }

    // ---- 5. 还原 ----
    await pc.ev('globalThis.__DSH_IMG__.restore()', iso.id);
    await new Promise(function (r) { setTimeout(r, 400); });
    t('还原清掉 overlay', (await pc.ev('document.querySelectorAll(".dsh-imglayer").length', main.id)) === 0);

    // ---- 6. 普通点击不触发 ----
    await pc.ev(
      '(function(){ var img = document.getElementById("target"); var r = img.getBoundingClientRect();' +
      ' img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.x + 50, clientY: r.y + 50 })); return 1; })()', main.id);
    await new Promise(function (r) { setTimeout(r, 700); });
    t('普通点击不触发翻译', (await pc.ev('document.querySelectorAll(".dsh-imglayer").length', main.id)) === 0);

    console.log('');
    console.log(pass + ' 通过 / ' + fail + ' 失败');
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail += 1;
  } finally {
    try { if (pc) pc.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    server.close();
  }
  console.log(fail ? ('X 失败 ' + fail + ' 项') : 'OK 图片翻译浏览器测试通过');
  process.exit(fail ? 1 : 0);
})();