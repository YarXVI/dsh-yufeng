/* 真实浏览器端到端测试：启动隔离的 Edge，加载扩展，翻译测试页，验证结果。
   node test/e2e.browser.js
   需要本地 8770 端口有测试页服务（脚本会自己起一个）。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.join(__dirname, '..');
const PORT = 9355;
const HTTP_PORT = 8771;

const MSGS = [];
for (let i = 0; i < 100; i++) {
  const k = i % 4;
  if (k === 0) MSGS.push('<div class="msg"><div class="mc"><span>Hi </span><span class="mention">@someone</span><span> I keep getting this error on DeepSeek. </span><span class="inline-code">run_code</span><span>: Unexpected non-whitespace character after JSON at position 567.</span></div></div>');
  else if (k === 1) MSGS.push('<div class="msg"><div class="mc">It looks like the model is outputting two tool-call JSONs stuck together. <span class="mention">@team</span> can someone check?</div></div>');
  else if (k === 2) MSGS.push('<div class="msg"><div class="mc">all needed is 100$ plan with 20000$ usage</div></div>');
  else MSGS.push('<div class="msg"><div class="mc">tps used to be 200+, but lately I have been getting 120-130</div></div>');
}
const PAGE = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E2E</title>',
'<style>body{margin:0;background:#313338;color:#dbdee1;font:15px/1.6 system-ui}',
'.main{padding:12px}.msg{margin:0 0 12px}.mc{white-space:pre-wrap}',
'.mention{background:rgba(107,140,255,.16);color:#a9bcff;border-radius:3px}',
'.inline-code{background:#2b2d31;font-family:monospace}</style></head><body><div class="main">',
MSGS.join(''), '</div></body></html>'].join('');

const server = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE); });

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map(); let contexts = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
    else if (m.method === 'Runtime.executionContextsCleared') contexts = [];
  });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res({
      send: (me, p) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method: me, params: p || {} })); }),
      async inCtx(expr, cid) {
        const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, contextId: cid });
        if (r.exceptionDetails) return { __error: ((r.exceptionDetails.exception || {}).description || 'err').slice(0, 400) };
        return r.result.value;
      },
      get contexts() { return contexts; }, close: () => ws.close()
    }), { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}

(async () => {
  let fail = 0;
  const profile = path.join(require('node:os').tmpdir(), 'dsh-e2e-' + Date.now());
  await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));
  console.log('· 测试页 http://127.0.0.1:' + HTTP_PORT);

  const child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--no-first-run', '--no-default-browser-check', '--disable-component-extensions-with-background-pages',
    'http://127.0.0.1:' + HTTP_PORT + '/'
  ], { detached: false, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 8000));

  try {
    const list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(r => r.json());
    const page = list.find(t => t.type === 'page' && t.url.indexOf('8771') >= 0);
    if (!page) { console.log('x 没找到测试页'); fail++; throw new Error('no page'); }
    const pc = await connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await new Promise(r => setTimeout(r, 1000));
    const iso = pc.contexts.find(c => c.auxData && c.auxData.type === 'isolated');
    const main = pc.contexts.find(c => c.auxData && c.auxData.type === 'default');
    if (!iso) { console.log('x content script 没注入'); fail++; throw new Error('no content script'); }

    const collected = await pc.inCtx('globalThis.__DSH_INTERNALS__.collect(document.body).length', iso.id);
    console.log('· 收集到 ' + collected + ' 个可翻单元');
    if (!collected) { console.log('x 一个都没收集到'); fail++; }

    const t0 = Date.now();
    await pc.inCtx('globalThis.__DSH_INTERNALS__.start("bilingual")', iso.id);
    let done = 0, total = 0;
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 300));
      const st = JSON.parse(await pc.inCtx('JSON.stringify(globalThis.__DSH_INTERNALS__.state())', iso.id) || '{}');
      done = st.done || 0; total = st.total || 0;
      if (total > 0 && done >= total) break;
    }
    const ms = Date.now() - t0;
    const dom = await pc.inCtx('document.querySelectorAll(".dsh-tr").length', main.id);
    console.log('· 翻译完成 ' + done + '/' + total + ' 段，' + ms + 'ms，页面译文块 ' + dom);
    if (total === 0 || done < total) { console.log('x 没翻完'); fail++; }

    // 抽样检查译文确实是中文
    const samples = JSON.parse(await pc.inCtx('(() => { const t = document.querySelectorAll(".dsh-tr"); return JSON.stringify(Array.from(t).slice(0, 8).map(x => x.textContent.slice(0, 50))); })()', main.id));
    console.log('· 译文样本: ' + JSON.stringify(samples.slice(0, 3)));
    const anyEn = samples.filter(s => /^(Hi|all needed|tps|It looks)/.test(s)).length;
    if (anyEn) { console.log('x 有段落没翻'); fail++; }

    // 仅译文模式
    await pc.inCtx('globalThis.__DSH_INTERNALS__.setMode("only")', iso.id);
    await new Promise(r => setTimeout(r, 300));
    const onlyCount = await pc.inCtx('document.querySelectorAll(".dsh-elm-only").length', main.id);
    console.log('· 仅译文模式标记 ' + onlyCount + ' 个元素');
    if (!onlyCount) { console.log('x 仅译文没生效'); fail++; }

    await pc.inCtx('globalThis.__DSH_INTERNALS__.setMode("bilingual")', iso.id);
    await new Promise(r => setTimeout(r, 200));
    const backCount = await pc.inCtx('document.querySelectorAll(".dsh-elm-only").length', main.id);
    if (backCount !== 0) { console.log('x 切回双语没清干净'); fail++; }

    // 还原
    await pc.inCtx('globalThis.__DSH_INTERNALS__.stop()', iso.id);
    await new Promise(r => setTimeout(r, 300));
    const afterStop = await pc.inCtx('document.querySelectorAll(".dsh-tr").length', main.id);
    if (afterStop !== 0) { console.log('x 还原后还有译文残留: ' + afterStop); fail++; }
    console.log('· 还原干净');

    pc.close();
  } catch (e) {
    console.log('ERR ' + (e && e.message));
    fail++;
  } finally {
    try { child.kill(); } catch (e) {}
    server.close();
  }

  console.log(fail ? ('x 失败 ' + fail + ' 项') : 'OK 浏览器端到端测试通过');
  process.exit(fail ? 1 : 0);
})();
