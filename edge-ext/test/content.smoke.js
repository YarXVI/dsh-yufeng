const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src`;
function relink(par) { for (let i = 0; i < par.childNodes.length; i++) { par.childNodes[i].nextSibling = par.childNodes[i+1] || null; par.childNodes[i].parentNode = par; } }
function mkEl(tag) {
  const e = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], parentNode: null, nextSibling: null, classSet: new Set(), dataset: {}, style: {}, isConnected: true,
    get classList() { const s = this.classSet; return { add: (...c) => c.forEach(x=>s.add(x)), remove: (...c) => c.forEach(x=>s.delete(x)), contains: (c) => s.has(c), toggle: (c, on) => { if (on === undefined) { s.has(c)?s.delete(c):s.add(c); } else if (on) s.add(c); else s.delete(c); } }; },
    get children() { return this.childNodes.filter(n => n.nodeType === 1); },
    get firstChild() { return this.childNodes[0] || null; },
    get firstElementChild() { return this.children[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length-1] || null; },
    get parentElement() { return this.parentNode; },
    appendChild(n) { this.childNodes.push(n); relink(this); return n; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : this.childNodes.length; this.childNodes.splice(i, 0, n); relink(this); return n; },
    removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); relink(this); return n; },
    _desc() { const out = []; (function w(n){ for (const c of n.childNodes) { if (c.nodeType === 1) { out.push(c); w(c); } } })(this); return out; },
    querySelectorAll(sel) { const tags = sel.split(',').map(s => s.trim().toUpperCase()); return this._desc().filter(e => tags.some(t => t.indexOf('[') < 0 && t.indexOf('.') < 0 && t.split(' ').pop() === e.tagName)); },
    querySelector(sel) { const r = this.querySelectorAll(sel); return r[0] || null; },
    matches(sel) { const tags = sel.split(',').map(s => s.trim()); return tags.some(t => { if (t.indexOf('[') >= 0 && t.indexOf('href') >= 0) return this.tagName === 'A' && !!this.getAttribute('href'); if (t.indexOf('[') >= 0) return false; return t.toUpperCase() === this.tagName; }); },
    matches() { return false; }, closest() { return null; }, cloneNode() { return mkEl(tag); },
    setAttribute(k,v) { this['a_'+k] = v; }, getAttribute(k) { return this['a_'+k] || null; },
    get textContent() { return this.childNodes.map(n => n.nodeType===3 ? n.nodeValue : n.textContent).join(''); },
    set textContent(v) { this.childNodes = []; },
    getBoundingClientRect() { return { top: 100, left: 0, bottom: 120, right: 300, width: 300, height: 20 }; } };
  return e;
}
function mkText(v) { return { nodeType: 3, nodeValue: v, parentNode: null, nextSibling: null }; }
const doc = { documentElement: mkEl('html'), body: mkEl('body'), createElement: t => mkEl(t), createTextNode: v => mkText(v), createDocumentFragment: () => mkEl('frag'), addEventListener(){}, querySelector(){ return null; } };
const sb = { console, document: doc, setTimeout, clearTimeout, setInterval, clearInterval,
  window: { innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollX: 0, getSelection: () => ({ isCollapsed: true, rangeCount: 0 }), addEventListener(){} },
  location: { origin: 'https://example.com' }, getComputedStyle: () => ({ display: 'block' }),
  MutationObserver: class { observe(){} disconnect(){} },
  chrome: { runtime: { onMessage: { addListener(f){ sb.__onMsg = f; } }, connect: () => ({ onMessage:{addListener(){}}, onDisconnect:{addListener(){}}, postMessage(){} }), sendMessage: () => Promise.resolve({ ok: true, text: 'x' }), lastError: null },
            storage: { local: { get: (k, cb) => cb({ cfg: {} }) } } },
  Set, Map, WeakMap, Promise, JSON, Math, Date, Object, Array, String, Number, isFinite, RegExp, Error, URL, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 } };
sb.self = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
function load(f) { vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }); }
load('dsh.js'); load('content.js');
console.log('content.js 加载成功；DSH 导出', Object.keys(sb.DSH).length, '项');
const I = sb.__DSH_INTERNALS__;
console.log('内部句柄:', !!I);
// 造三种典型结构
const p1 = mkEl('p'); p1.appendChild(mkText('Welcome back! Your subscription expires in 3 days.'));
const div = mkEl('div');
const a = mkEl('a'); a.setAttribute('href', '/x'); a.appendChild(mkEl('img')); const sp = mkEl('span'); sp.appendChild(mkText('[Aoi Hoshi] L-Cup no Wolf Cut 2 [中文]')); a.appendChild(sp);
div.appendChild(a);
const h2 = mkEl('h2'); h2.appendChild(mkText('April Fool')); h2.appendChild(mkText(' Finale'));
for (const [name, node] of [['p 纯文本', p1], ['卡片链接里的标题', div], ['h2 混排', h2]]) {
  const units = I.collect(node);
  console.log(name + ' → ' + units.length + ' 个单元');
  units.forEach(u => console.log('   ' + JSON.stringify(u.text.slice(0, 60)) + '  mode=' + u.mode));
}
let bad = 0;
const units1 = I.collect(p1);
if (!units1.length) { console.log('x 纯文本没收集到'); bad++; }
const units2 = I.collect(div);
if (!units2.length) { console.log('x 卡片标题没收集到'); bad++; }
if (units2.some(u => u.text.indexOf('<a>') >= 0)) { console.log('x 卡片被整块吞了（会挤走图片）'); bad++; }
const units3 = I.collect(h2);
if (!units3.length) { console.log('x 混排标题没收集到'); bad++; }
// 只有译文、没有原文的情形不应收集
const skip = mkEl('pre'); skip.appendChild(mkText('npm install --save'));
if (I.collect(skip).length) { console.log('x 代码块不该被翻'); bad++; }
console.log(bad ? ('x 失败 ' + bad + ' 项') : 'OK 内容脚本冒烟通过');
process.exit(bad ? 1 : 0);