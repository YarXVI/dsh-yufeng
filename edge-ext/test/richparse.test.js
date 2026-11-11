/* 富文本解析容错测试（不需要浏览器）：
   验证模型输出「改标签名 / 多写 / 少写 / 写错嵌套 / 自闭合」时，
   parseRich 要么正确还原、要么安全退回纯文本，绝不错位 DOM。
   node test/richparse.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

function el(tag, attrs) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), _attrs: attrs || {}, className: '', childNodes: [],
    cloneNode: function () { var x = el(tag, this._attrs); x.className = this.className; return x; },
    appendChild: function (n) { this.childNodes.push(n); return n; },
    getAttribute: function (k) { return this._attrs[k]; },
    querySelector: function () { return null; }
  };
}
const doc = {
  createElement: function (t) { return el(t); },
  createDocumentFragment: function () { return el('frag'); },
  createTextNode: function (v) { return { nodeType: 3, nodeValue: v }; }
};
const sb = {
  console: console, document: doc, setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  window: { innerHeight: 800, innerWidth: 1200, getSelection: function () { return null; }, addEventListener: function () {} },
  location: { origin: 'https://x' },
  getComputedStyle: function () { return { display: 'inline' }; },
  MutationObserver: class { observe() {} disconnect() {} },
  chrome: {
    runtime: { onMessage: { addListener: function () {} }, connect: function () { return { onMessage: { addListener: function () {} }, onDisconnect: { addListener: function () {} }, postMessage: function () {} }; }, lastError: null },
    storage: { local: { get: function (k, cb) { cb({ cfg: {} }); } } }
  },
  Set: Set, Map: Map, WeakMap: WeakMap, Promise: Promise, JSON: JSON, Math: Math, Date: Date,
  Object: Object, Array: Array, String: String, Number: Number, isFinite: isFinite, RegExp: RegExp,
  Error: Error, URL: URL, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }
};
sb.self = sb; sb.globalThis = sb;
const ctx = vm.createContext(sb);
function load(f) { vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }); }
load('dsh.js');
load('content.js');

const I = sb.__DSH_INTERNALS__;
if (!I || !I.parseRich) { console.log('x 内部句柄不可用'); process.exit(1); }

function pool(tags) { return tags.map(function (t) { return { tag: t, el: el(t) }; }); }
function ser(frag) {
  if (!frag) return null;
  return frag.childNodes.map(function (n) {
    if (n.nodeType === 3) return n.nodeValue;
    var t = n.tagName.toLowerCase();
    return '<' + t + '>' + ser(n) + '</' + t + '>';
  }).join('');
}

var pass = 0, fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ('  → ' + detail) : '')); }
}

// 1. 模型改标签名：语义等价应被接受
var r1 = I.parseRich('<strong>粗体</strong>', pool(['B']));
expect('b → strong 应还原成 <b>', !!r1 && ser(r1) === '<b>粗体</b>', ser(r1));

var r2 = I.parseRich('<em>斜体</em>', pool(['I']));
expect('i → em 应还原成 <i>', !!r2 && ser(r2) === '<i>斜体</i>', ser(r2));

// 2. 多写标签：按同名造标签，观感不变
var r3 = I.parseRich('<b>粗 <i>多写</i></b>', pool(['B']));
expect('多写 <i> 应保留结构', !!r3 && ser(r3) === '<b>粗 <i>多写</i></b>', ser(r3));

// 3. 少写标签：只保留实际存在的
var r4 = I.parseRich('<b>只有一段</b>', pool(['B', 'B']));
expect('少写 <b> 应正常输出', !!r4 && ser(r4) === '<b>只有一段</b>', ser(r4));

// 4. 嵌套正确
var r5 = I.parseRich('<b>粗 <a>链接</a></b>', pool(['B', 'A']));
expect('正确嵌套应原样还原', !!r5 && ser(r5) === '<b>粗 <a>链接</a></b>', ser(r5));

// 5. 嵌套写错：必须拒绝（退回纯文本），绝不能拼出错位 DOM
var r6 = I.parseRich('<b>粗 <a>链接</b></a>', pool(['B', 'A']));
expect('嵌套错位必须拒绝', r6 === null, r6 ? ser(r6) : null);

// 6. 自闭合 br
var r7 = I.parseRich('line1<br/>line2', pool(['BR']));
expect('自闭合 br 应保留', !!r7 && ser(r7).indexOf('<br>') >= 0, ser(r7));

// 7. 少写结束标签：自动补齐，而不是整段丢弃
var r8 = I.parseRich('<b>没有闭合', pool(['B']));
expect('少写结束标签应自动补齐', !!r8 && ser(r8) === '<b>没有闭合</b>', ser(r8));

// 8. 陌生标签：只丢标签、保留文字
var r9 = I.parseRich('<b>粗体</b> <foo>bar</foo>', pool(['B']));
expect('陌生标签应只丢标记', !!r9 && ser(r9) === '<b>粗体</b> bar', ser(r9));

// 9. 大小写混用
var r10 = I.parseRich('<B>粗体</B>', pool(['B']));
expect('大小写混用应正常', !!r10 && ser(r10) === '<b>粗体</b>', ser(r10));

// 10. 纯文本（无标签）
var r11 = I.parseRich('纯文本内容', []);
expect('无色标应返回 null（走纯文本路径）', r11 === null);

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
console.log('OK 富文本解析容错测试通过');
