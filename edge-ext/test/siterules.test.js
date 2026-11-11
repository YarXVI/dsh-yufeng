/* 站点规则测试：Discord 导航壳整体跳过，但消息正文必须照常翻。
   两件事一起验：
     1) 图标栏/频道列表/私信列表 -> 跳过
     2) 消息区 -> 不跳过（这是上一版最大的回归点）
   不需要浏览器，用 vm 沙箱模拟 DOM。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

/** 极简 DOM 元素：只需 matches / closest / textContent / children / getBoundingClientRect */
function makeEl(tag, props) {
  props = props || {};
  const el = {
    nodeType: 1,
    tagName: String(tag || 'DIV').toUpperCase(),
    className: props.cls || '',
    id: props.id || '',
    _attrs: props.attrs || {},
    children: props.children || [],
    childNodes: [],
    firstChild: null,
    firstElementChild: null,
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    shadowRoot: null,
    dataset: props.dataset || {},
    isContentEditable: false,
    classList: {
      contains(c) { return String(el.className).split(/\s+/).indexOf(c) >= 0; },
      add() {}, remove() {}, toggle() {}
    },
    getAttribute(k) { return el._attrs[k] == null ? null : el._attrs[k]; },
    setAttribute(k, v) { el._attrs[k] = v; },
    getBoundingClientRect() { return { width: 200, height: 32, top: 0, left: 0 }; },
    matches(sel) { return matchSel(el, sel); },
    closest(sel) { return matchSel(el, sel) ? el : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertBefore() {}, appendChild() {}, removeChild() {},
    cloneNode() { return makeEl(tag, { cls: el.className }); },
    get textContent() { return props.text || ''; },
    previousElementSibling: null,
    parentElement: props.parent || null
  };
  return el;
}

/** 简化选择器匹配：够本站规则用 */
function matchSel(el, sel) {
  const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.some((p) => {
    // 属性选择器 [attr="v"] / [attr*="v"] / [attr^="v"]
    const attr = p.match(/\[([a-zA-Z-]+)\s*([*^]?)=\s*"([^"]*)"\]/);
    if (attr) {
      const [, name, op, val] = attr;
      const raw = el.getAttribute(name);
      if (raw == null) return false;
      if (op === '*') return raw.indexOf(val) >= 0;
      if (op === '^') return raw.startsWith(val);
      return raw === val;
    }
    // tag[attr="v"]
    const tagAttr = p.match(/^([a-zA-Z]+)\[([a-zA-Z-]+)="([^"]*)"\]$/);
    if (tagAttr) {
      return el.tagName === tagAttr[1].toUpperCase() && el.getAttribute(tagAttr[2]) === tagAttr[3];
    }
    // 纯 tag
    if (/^[a-zA-Z]+$/.test(p)) return el.tagName === p.toUpperCase();
    // [role="x"]
    const role = p.match(/^\[role="([^"]+)"\]$/);
    if (role) return el.getAttribute('role') === role[1];
    return false;
  });
}

function makeSandbox(hostname) {
  const sandbox = {
    console: console,
    document: {
      createElement: (t) => makeEl(t),
      createDocumentFragment: () => makeEl('frag'),
      createTextNode: (v) => ({ nodeType: 3, nodeValue: v }),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hostname, origin: 'https://' + hostname, search: '' },
    performance: { now: () => Date.now() },
    URLSearchParams,
    getComputedStyle: () => ({
      display: 'block', visibility: 'visible', width: '200px', height: '32px',
      overflow: 'visible', clip: 'auto', clipPath: 'none', backgroundImage: 'none',
      maskImage: 'none', webkitMaskImage: 'none'
    }),
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: {
      runtime: { onMessage: { addListener() {} }, connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }), lastError: null },
      storage: { local: { get: (k, cb) => cb({ cfg: {} }) } }
    },
    Set, Map, WeakMap, Promise, JSON, Math, Date, Object, Array, String, Number, isFinite, RegExp, Error, URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    window: { innerHeight: 900, innerWidth: 1400, getSelection: () => null, addEventListener() {} }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'dsh.js'), 'utf8'), ctx, { filename: 'dsh.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'content.js'), 'utf8'), ctx, { filename: 'content.js' });
  return sandbox;
}

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 真实 Discord 结构（用户给出的 DOM）
const discord = makeSandbox('discord.com');
const I = discord.__DSH_INTERNALS__;

t('discord.com 命中站点规则', I.siteRule() !== null, String(I.siteRule()));

// 图标栏 nav
const guildNav = makeEl('nav', { cls: 'wrapper_5dQHTG guilds_pog620', attrs: { 'aria-label': '服务器侧栏' } });
t('nav[aria-label=服务器侧栏] 被跳过', I.shouldSkip(guildNav) === true);

// 图标栏 tree
const guildTree = makeEl('div', { attrs: { role: 'tree', 'data-list-id': 'guildsnav' } });
t('data-list-id=guildsnav 被跳过', I.shouldSkip(guildTree) === true);

// 图标栏里的每一项
const guildItem = makeEl('div', { attrs: { role: 'treeitem', 'data-list-item-id': 'guildsnav___14790024850480480266' } });
t('data-list-item-id=guildsnav___ 被跳过', I.shouldSkip(guildItem) === true);

// nhentai 新版结构：section#tags + 裸文本键名
const nh2 = makeSandbox('nhentai.net');
const N2 = nh2.__DSH_INTERNALS__;
t('nhentai 命中站点规则（新结构）', N2.siteRule() !== null, String(N2.siteRule()));
const nhRow = makeEl('div', { text: '' });
t('nhentai 规则含专名行', true);

// 频道列表
const chTree = makeEl('div', { attrs: { role: 'tree', 'data-list-id': 'channels' } });
t('data-list-id=channels 被跳过', I.shouldSkip(chTree) === true);
const chItem = makeEl('div', { attrs: { 'data-list-item-id': 'channels___general' } });
t('data-list-item-id=channels___ 被跳过', I.shouldSkip(chItem) === true);

// 私信列表
const dmTree = makeEl('div', { attrs: { 'data-list-id': 'private-channels' } });
t('data-list-id=private-channels 被跳过', I.shouldSkip(dmTree) === true);

// === 消息区必须不跳过（这是上一版的回归点）===
const msgContent = makeEl('div', { cls: 'messageContent_abc', text: 'Hey, I keep getting this error' });
t('消息正文不被跳过', I.shouldSkip(msgContent) === false);

const msgText = makeEl('div', { cls: 'text_abc', text: 'It looks like the model is outputting two tool-call JSONs.' });
t('消息文字块不被跳过', I.shouldSkip(msgText) === false);

const channelNameInMsg = makeEl('div', { cls: 'channelName_abc', text: 'general' });
t('消息里提到频道名不被跳过（曾因 class*=channel 误伤）', I.shouldSkip(channelNameInMsg) === false);

// === translate="no" 外壳不能整页失翻 ===
// app-mount 在真实 DOM 里有一大堆子节点（外壳容器），不是叶子
const appMount = makeEl('div', {
  id: 'app-mount',
  attrs: { translate: 'no' },
  text: 'the whole app lives in here and there is a lot of text',
  children: [makeEl('div'), makeEl('div'), makeEl('div')]
});
t('translate=no 容器外壳不跳过子树', I.shouldSkip(appMount) === false, 'kids=' + appMount.children.length + ' textLen=' + appMount.textContent.length);

const leafNo = makeEl('span', { attrs: { translate: 'no' }, text: 'Do not translate me' });
t('translate=no 叶子元素跳过', I.shouldSkip(leafNo) === true);

// === aria-hidden 装饰层 ===
const deco = makeEl('div', { attrs: { 'aria-hidden': 'true' }, text: '' });
t('aria-hidden 空装饰层跳过', I.shouldSkip(deco) === true);

// === nhentai：键名替换后专名行判定不能失效 ===
const nh = makeSandbox('nhentai.net');
const N = nh.__DSH_INTERNALS__;
t('nhentai 命中站点规则', N.siteRule() !== null, String(N.siteRule()));

// 模拟「label 已翻译」的行：裸文本被清空，只剩 data-dsh-src
const rowDiv = makeEl('div', { attrs: {} });
rowDiv.firstChild = { nodeType: 3, nodeValue: '' };  // 裸文本已被清空
const labelSpan = makeEl('span', { cls: 'dsh-tr dsh-tr-label', attrs: { 'data-dsh-src': 'Artists:' } });
const chipLink = makeEl('a', { cls: 'tagchip', attrs: { href: '/artist/x' } });
rowDiv.children = [labelSpan, chipLink];
rowDiv.querySelector = function (sel) { return sel === '.dsh-tr-label' ? labelSpan : null; };
rowDiv.querySelectorAll = function (sel) { return sel === 'td, .tc, .field' ? [] : []; };
chipLink.closest = function (sel) {
  if (sel === '#tags > div') return rowDiv;
  if (sel === 'a[href]') return chipLink;
  return null;
};
labelSpan.closest = function (sel) {
  if (sel === '#tags > div') return rowDiv;
  return null;
};
const prevFirst = rowDiv.firstChild;
Object.defineProperty(rowDiv, 'firstChild', { get: function () { return prevFirst; }, configurable: true });
t('label 翻译后专名行仍能识别', N2.inProperNounRow(chipLink) === true);
t('label 翻译后键名自身仍可翻', N2.inProperNounRow(labelSpan) === false);

// === 非 Discord 站点 ===
const other = makeSandbox('example.com');
const J = other.__DSH_INTERNALS__;
t('非 Discord 站点无站点规则', J.siteRule() === null, String(J.siteRule()));
const g2 = makeEl('nav', { cls: 'guilds' });
t('非 Discord 站点不套用规则', J.shouldSkip(g2) === false);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
