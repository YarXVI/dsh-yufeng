const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src`;
const html = fs.readFileSync(path.join(SRC, 'options.html'), 'utf8');
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));
function el(id) { return { id, hidden: false, dataset: {}, style: {}, value: '', textContent: '', className: '', checked: false, type: 'text', disabled: false, options: [], children: [],
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, appendChild(){}, querySelector(){ return null; }, querySelectorAll(){ return []; }, insertAdjacentHTML(){}, closest(){ return null; }, setAttribute(){}, getAttribute(){ return null; } }; }
const nodes = new Map();
const document = { querySelector: sel => { const m = /#([\w-]+)/.exec(sel); if (!m || !ids.has(m[1])) return null; if (!nodes.has(m[1])) nodes.set(m[1], el(m[1])); return nodes.get(m[1]); },
  querySelectorAll: () => [], createElement: () => el(''), addEventListener(){}, documentElement: el('html'), body: el('body') };
const sb = { console, document, setTimeout, clearTimeout, Promise, JSON, Object, Array, String, Number, Math, isFinite, RegExp, URL, Error, Date };
sb.globalThis = sb; sb.window = { close(){}, addEventListener(){} };
sb.chrome = { runtime: { sendMessage: (m, cb) => { const r = { ok: true, cfg: {}, connected: false }; if (cb) cb(r); return Promise.resolve(r); }, getManifest: () => ({ version: '1.0.0' }) } };
const ctx = vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'dsh.js'), 'utf8'), ctx, { filename: 'dsh.js' });
try { vm.runInContext(fs.readFileSync(path.join(SRC, 'options.js'), 'utf8'), ctx, { filename: 'options.js' }); console.log('options.js 加载成功（' + ids.size + ' 个 id）');
  const js = fs.readFileSync(path.join(SRC, 'options.js'), 'utf8');
  let bad = 0;
  for (const m of js.matchAll(/\$\('#([\w-]+)'\)/g)) { if (!ids.has(m[1])) { console.log('x 引用了不存在的 #' + m[1]); bad++; } }
  if (bad) { console.log('x 失败'); process.exit(1); }
  console.log('OK 设置页冒烟通过');
  process.exit(0); }
catch (e) { console.log('x options.js 加载失败:', e.stack || e.message); process.exit(1); }