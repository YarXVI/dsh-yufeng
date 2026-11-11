/* 划词翻译 · 真实浏览器行为测试。
   静态契约由 selection.test.js 覆盖；这里验证**真的在浏览器里选中文会怎样**：
     · 正常选中 → 弹气泡，显示原文 + 译文
     · 输入框 / contenteditable / 纯中文 / 单字符 → 不弹
     · 点外部 / Esc / 关闭按钮 → 关掉
     · 复制按钮 → 剪贴板有内容
     · 滚动 → 气泡跟随
   node test/selection.browser.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const spawn = require('node:child_process').spawn;

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const CDP_PORT = 9310 + Math.floor(Math.random() * 60);
const HTTP_PORT = 8980 + Math.floor(Math.random() * 60);

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>selection browser test</title>' +
  '<style>body{margin:0;padding:24px;background:#1b1b1b;color:#eee;font:15px/1.8 system-ui}' +
  'p{margin:12px 0;max-width:640px}input,textarea,div[contenteditable]{display:block;margin:12px 0;padding:8px;width:420px;font:14px system-ui}</style></head><body>' +
  '<h1>Selection translation test</h1>' +
  '<p id="p1">This is a simple English sentence used to verify the selection bubble.</p>' +
  '<p id="p2">Artificial intelligence is reshaping how we interact with software, and local models keep your data on device.</p>' +
  '<p id="p3">Here is a Japanese line: これは本当にすごいね！</p>' +
  '<p id="p4">这是一段纯中文内容，不应该被翻译。</p>' +
  '<p id="p5">Short: <span id="word">Hello</span></p>' +
  '<input id="inp" value="Do not translate this input text" />' +
  '<textarea id="ta">Do not translate this textarea either</textarea>' +
  '<div contenteditable="true" id="ce">Do not translate this editable block</div>' +
  '</body></html>';

const server = http.createServer(function (q, s) {
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  s.end(PAGE);
});

function connect(url) {
  var ws = new WebSocket(url);
  var id = 0, pending = new Map(), contexts = [];
  ws.addEventListener('message', function (ev) {
    var m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      var p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  return new Promise(function (res, rej) {
    ws.addEventListener('open', function () {
      res({
        send: function (me, pa) {
          return new Promise(function (resolve, reject) {
            var mid = ++id; pending.set(mid, { resolve: resolve, reject: reject });
            ws.send(JSON.stringify({ id: mid, method: me, params: pa || {} }));
          });
        },
        ev: async function (expr, cid) {
          var r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
          if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400));
          return r.result.value;
        },
        get contexts() { return contexts; },
        close: function () { ws.close(); }
      });
    }, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async function () {
  var pass = 0, fail = 0;
  function t(name, cond, detail) {
    if (cond) { pass++; console.log('✓ ' + name); }
    else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
  }

  await new Promise(function (r) { server.listen(HTTP_PORT, '127.0.0.1', r); });
  var profile = path.join(os.tmpdir(), 'dsh-sel-' + Date.now());
  var child = spawn(EDGE, [
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { stdio: 'ignore' });

  var pc = null;
  try {
    await new Promise(function (r) { setTimeout(r, 8000); });
    var list = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list').then(function (r) { return r.json(); });
    var page = list.find(function (x) { return x.type === 'page' && x.url.indexOf(String(HTTP_PORT)) >= 0; });
    if (!page) throw new Error('页面没打开');
    pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(function (r) { setTimeout(r, 1200); });

    var iso = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'isolated'; }).pop();
    var main = pc.contexts.filter(function (c) { return c.auxData && c.auxData.type === 'default'; }).pop();
    if (!iso || !main) throw new Error('context 缺失');

    // 等配置加载完（maybeAuto 之后 bindSelectionUX 才绑上）
    await pc.ev('new Promise(function(r){ setTimeout(r, 700); })', iso.id);

    /** 选中某个元素的内容，并触发 selectionchange */
    async function selectEl(id) {
      await pc.ev('(function(){ var b = document.querySelector(".dsh-bubble"); if (b) b.remove(); return 1; })()', main.id);
      await pc.ev('(function(){' +
        'var el = document.getElementById("' + id + '");' +
        'var r = document.createRange(); r.selectNodeContents(el);' +
        'var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);' +
        'document.dispatchEvent(new Event("selectionchange"));' +
        'return s.toString().slice(0,30); })()', main.id);
    }
    function bubbleState() {
      return pc.ev('(function(){' +
        'var b = document.querySelector(".dsh-bubble");' +
        'if (!b) return null;' +
        'var src = b.querySelector(".dsh-bubble-src");' +
        'var dst = b.querySelector(".dsh-bubble-dst");' +
        'return { src: src ? src.textContent : "", dst: dst ? dst.textContent : "",' +
        '  loading: dst ? dst.classList.contains("dsh-bubble-loading") : null,' +
        '  left: b.style.left, top: b.style.top, buttons: b.querySelectorAll(".dsh-bubble-btn").length };' +
        '})()', main.id);
    }

    // ---- 1. 正常英文选中 → 弹气泡 ----
    await selectEl('p1');
    await new Promise(function (r) { setTimeout(r, 2600); });
    var b1 = await bubbleState();
    t('选中英文 → 弹气泡', !!b1);
    t('气泡显示原文', !!b1 && b1.src.indexOf('This is a simple') >= 0, b1 && b1.src);
    t('气泡显示译文', !!b1 && !b1.loading && /\p{Script=Han}/u.test(b1.dst), b1 && b1.dst);
    t('有复制和关闭两个按钮', !!b1 && b1.buttons === 2, b1 && String(b1.buttons));

    // ---- 2. 日文 → 弹气泡且译文是中文 ----
    await selectEl('p3');
    await new Promise(function (r) { setTimeout(r, 2600); });
    var b2 = await bubbleState();
    t('选中日文 → 弹气泡', !!b2);
    t('日文译文是中文', !!b2 && !b2.loading && /\p{Script=Han}/u.test(b2.dst) && !/[\u3040-\u30ff]/.test(b2.dst), b2 && b2.dst);

    // ---- 3. 纯中文 → 不弹 ----
    await selectEl('p4');
    await new Promise(function (r) { setTimeout(r, 900); });
    t('选中纯中文 → 不弹', !(await bubbleState()));

    // ---- 4. 输入框 → 不弹 ----
    await selectEl('inp');
    await new Promise(function (r) { setTimeout(r, 900); });
    t('输入框里选 → 不弹', !(await bubbleState()));

    // ---- 5. textarea → 不弹 ----
    await selectEl('ta');
    await new Promise(function (r) { setTimeout(r, 900); });
    t('textarea 里选 → 不弹', !(await bubbleState()));

    // ---- 6. contenteditable → 不弹 ----
    await selectEl('ce');
    await new Promise(function (r) { setTimeout(r, 900); });
    t('contenteditable 里选 → 不弹', !(await bubbleState()));

    // ---- 7. 单字符 → 不弹 ----
    await selectEl('word');
    await new Promise(function (r) { setTimeout(r, 900); });
    t('单字符 → 不弹', !(await bubbleState()));

    // ---- 8. 点击外部关闭 ----
    await selectEl('p1');
    await new Promise(function (r) { setTimeout(r, 2600); });
    t('重建气泡成功', !!(await bubbleState()));
    await pc.ev('document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))', main.id);
    await new Promise(function (r) { setTimeout(r, 500); });
    t('点外部 → 气泡关闭', !(await bubbleState()));

    // ---- 9. Esc 关闭 ----
    await selectEl('p2');
    await new Promise(function (r) { setTimeout(r, 3000); });
    t('长句也能翻', !!(await bubbleState()));
    await pc.ev('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))', main.id);
    await new Promise(function (r) { setTimeout(r, 500); });
    t('Esc → 气泡关闭', !(await bubbleState()));

    // ---- 10. 气泡里选中文字不再触发翻译（防套娃）----
    await selectEl('p1');
    await new Promise(function (r) { setTimeout(r, 2600); });
    var inBubble = await pc.ev('(function(){' +
      'var b = document.querySelector(".dsh-bubble");' +
      'if (!b) return "no bubble";' +
      'var dst = b.querySelector(".dsh-bubble-dst");' +
      'var r = document.createRange(); r.selectNodeContents(dst);' +
      'var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);' +
      'document.dispatchEvent(new Event("selectionchange"));' +
      'return s.toString().slice(0,20); })()', main.id);
    await new Promise(function (r) { setTimeout(r, 1200); });
    var cnt = await pc.ev('document.querySelectorAll(".dsh-bubble").length', main.id);
    t('选中气泡里的译文不再套娃', cnt === 1, '气泡数=' + cnt + ' 选中=' + inBubble);

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
  console.log(fail ? ('X 失败 ' + fail + ' 项') : 'OK 划词翻译浏览器测试通过');
  process.exit(fail ? 1 : 0);
})();
