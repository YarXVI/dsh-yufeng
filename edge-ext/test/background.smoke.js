const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src`;
const store = { local: { cfg: {} }, session: {} };
const chrome = {
  storage: { local: { get: k => { const o = {}; (typeof k === 'string' ? [k] : (k||[])).forEach(x => { if (store.local[x] !== undefined) o[x] = store.local[x]; }); return Promise.resolve(o); },
                        set: o => { Object.assign(store.local, o); return Promise.resolve(); },
                        remove: k => { delete store.local[k]; return Promise.resolve(); } },
             session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: { addListener(f){ chrome.__ch = f; } } },
  runtime: { onConnect: { addListener(f){ chrome.__conn = f; } }, onMessage: { addListener(f){ chrome.__msg = f; } }, onInstalled: { addListener(f){ chrome.__inst = f; } }, lastError: null, openOptionsPage(){} },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
  action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
  commands: { onCommand: { addListener(){} } }, contextMenus: { create(){}, onClicked: { addListener(){} } },
  system: { network: { getNetworkInterfaces: () => Promise.resolve([{ address: '192.168.1.3' }, { address: '127.0.0.1' }]) } },
  permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) }
};
const sb = { console, chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, AbortController, AbortSignal, URL, JSON, Math, Date, Object, Array, String, Number, isFinite, Map, Set, WeakMap, Promise };
sb.self = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
sb.importScripts = function () { for (const f of arguments) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }); };
vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
console.log('background.js 加载成功');
const call = m => new Promise(r => chrome.__msg(m, null, r));
(async () => {
  const c = await call({ t: 'connect' });
  console.log('一键连接:', c.ok ? 'OK' : 'FAIL', '| base:', c.base, '| model:', c.model, '| 首字:', c.ttft + 'ms', '| speed:', c.speed);
  if (!c.ok) { console.log('  x ' + c.error); process.exit(1); }

  // 伪造内容脚本的 port，走一遍翻译
  const port = { name: 'dsh', sender: { tab: { id: 7 } }, postMessage: m => recv.push(m),
                 onMessage: { addListener(f) { port.__on = f; } }, onDisconnect: { addListener(){} } };
  const recv = [];
  chrome.__conn(port);
  const segs = ['Welcome back!', 'Your plan renews in 2 days.', 'Open the settings page to change it.'];
  const t0 = Date.now();
  port.__on({ t: 'translate', reqId: 1, gen: 1, lang: '简体中文', texts: segs.map((s, i) => ({ key: 'k' + i, text: s })) });
  await new Promise(res => {
    const tick = setInterval(() => {
      const finals = recv.filter(m => m.t === 'seg' && m.final).length;
      if (finals >= segs.length) { clearInterval(tick); res(); }
    }, 50);
    setTimeout(() => { clearInterval(tick); res(); }, 30000);
  });
  const finals = recv.filter(m => m.t === 'seg' && m.final);
  console.log('队列完成 ' + (Date.now()-t0) + 'ms，收到 ' + finals.length + '/' + segs.length + ' 段');
  finals.forEach(m => console.log('  ' + m.key + ': ' + JSON.stringify(m.text)));
  if (finals.length < segs.length) { console.log('x 有段落没出来'); process.exit(1); }

  // 第二轮应该全部命中缓存
  recv.length = 0;
  port.__on({ t: 'translate', reqId: 2, gen: 2, lang: '简体中文', texts: segs.map((s, i) => ({ key: 'k' + i, text: s })) });
  await new Promise(r => setTimeout(r, 400));
  const cached = recv.filter(m => m.t === 'seg' && m.cached).length;
  console.log('第二轮缓存命中 ' + cached + '/' + segs.length);
  if (cached < segs.length) { console.log('x 缓存没命中'); process.exit(1); }
  console.log('OK 后台冒烟通过');
  process.exit(0);
})().catch(e => { console.error('ERR', e && (e.stack || e.message)); process.exit(1); });