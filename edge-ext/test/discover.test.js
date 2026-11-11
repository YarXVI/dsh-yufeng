const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src`;
const store = { local: {}, session: {} };
const chrome = {
  storage: { local: { get: k => { const o = {}; (typeof k==='string'?[k]:(k||[])).forEach(x=>{ if(store.local[x]!==undefined) o[x]=store.local[x]; }); return Promise.resolve(o); },
                        set: o => { Object.assign(store.local, o); return Promise.resolve(); }, remove: () => Promise.resolve() },
             session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: { addListener(f){ chrome.__ch=f; } } },
  runtime: { onConnect: { addListener(f){ chrome.__conn=f; } }, onMessage: { addListener(f){ chrome.__msg=f; } }, onInstalled: { addListener(f){ chrome.__inst=f; } }, onStartup: { addListener(f){ chrome.__startup=f; } }, lastError: null, openOptionsPage(){} },
  tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() },
  action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
  commands: { onCommand: { addListener(){} } },
  contextMenus: { create(spec, cb){ if (cb) cb(); }, removeAll(cb){ if (cb) cb(); }, onClicked: { addListener(){} } },
  // 关键：模拟 Edge 里 system.network 不可用
  system: undefined,
  permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) } };
const sb = { console, chrome, fetch, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, AbortController, AbortSignal, URL, JSON, Math, Date, Object, Array, String, Number, isFinite, Map, Set, WeakMap, Promise };
sb.self = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
sb.importScripts = function () { for (const f of arguments) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }); };
vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
const call = m => new Promise(r => chrome.__msg(m, null, r));
(async () => {
  const t0 = Date.now();
  const c = await call({ t: 'connect' });
  console.log('结果:', c.ok ? 'OK' : 'FAIL', '| 耗时', Date.now()-t0, 'ms');
  console.log('  base:', c.base, '| model:', c.model, '| 首字:', c.ttft + 'ms', '| speed:', c.speed);
  console.log('  网卡枚举:', c.ifaceError || '正常', '| IP:', JSON.stringify(c.ifaceIps));
  console.log('  扫过网段:', JSON.stringify(c.prefixes), '| 扫描地址数:', c.scanned);
  console.log('  首轮候选:', JSON.stringify((c.tried||[]).map(t => t.base + ' → ' + t.reason)));
  let bad = 0;
  if (!c.ok) { console.log('x 没连上'); bad++; }
  // 本机插件监听在 127.0.0.1 也能连（SuiXin 默认同时绑局域网和回环），
  // 所以「连上就算对」，只要求是 http 且是已知的 DSH 地址形态。
  if (!/^http:\/\/(192\.168\.|127\.0\.0\.1|localhost)/.test(c.base || '')) { console.log('x 连接的地址不对: ' + c.base); bad++; }
  if (c.model !== 'translate') { console.log('x 角色不对: ' + c.model); bad++; }
  // 网卡枚举不可用时也必须扫过至少一个候选（回环）
  if (!c.scanned && !(c.tried || []).length) { console.log('x 没有做任何扫描'); bad++; }
  console.log(bad ? ('x 失败 ' + bad + ' 项') : 'OK 自动发现（网卡不可用）测试通过');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });