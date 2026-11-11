/* 反向翻译（中 → 外）测试。
   用户需求：输入框里划词 → 右键 → 转译成英/日/韩/葡等外语。
   node test/reverse.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const SRC = path.join(__dirname, '..', 'src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

const dsh = read('dsh.js');
const bg  = read('background.js');
const ct  = read('content.js');
const css = read('content.css');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('=== 语言表 ===');
t('REVERSE_LANGS 存在', dsh.includes('var REVERSE_LANGS = ['));
['en','ja','ko','pt','fr','de','es','ru','it','zh-tw'].forEach(function(id){
  t('含 ' + id, dsh.includes("id: '" + id + "'"));
});
t('reverseLang 按 id 查', dsh.includes('function reverseLang(id)'));
t('找不到退回英语', dsh.includes('return REVERSE_LANGS[0];'));
t('导出 REVERSE_LANGS', dsh.includes('REVERSE_LANGS: REVERSE_LANGS'));

console.log('');
console.log('=== 反向提示词 ===');
t('buildReversePrompt 存在', dsh.includes('function buildReversePrompt(sourceText, langId)'));
t('★ 用语言自称（English/日本語）', dsh.includes('L.native') && dsh.includes('表达出来'));
t('★ 不要加注音', dsh.includes('不要加注音'));
t('★ 保留占位符/URL', dsh.includes('保留原文里的 {占位符}'));
t('不输出中文原文', dsh.includes('不要输出中文原文'));

console.log('');
console.log('=== 右键菜单 ===');
t('dsh-reverse 父菜单', bg.includes("id: 'dsh-reverse'"));
t('10 种语言子菜单', /dsh-rv-(en|ja|ko|pt|fr|de|es|ru|it|tw)/.test(bg));
t('用 parentId 挂子菜单', bg.includes("parentId: 'dsh-reverse'"));
t('contexts 是 selection', bg.includes("contexts: ['selection']"));
t('处理 dsh-rv- 前缀', bg.includes("indexOf('dsh-rv-')"));
t('传 text + lang + editable', bg.includes('editable: !!info.editable'));

console.log('');
console.log('=== 反向翻译后台 ===');
t('translateReverse 处理', bg.includes("msg.t === 'translateReverse'"));
t('走 buildReversePrompt', bg.includes('DSH.buildReversePrompt(text, L.id)'));
t('去掉模型套的引号', bg.indexOf('out.replace(') > 0);

console.log('');
console.log('=== 目标元素捕获 ===');
t('grabReverseTarget 存在', ct.includes('function grabReverseTarget(fallbackText)'));
t('识别 textarea', ct.includes("kind: 'textarea'"));
t('识别 input', ct.includes("kind: 'input'"));
t('识别 contenteditable', ct.includes("kind: 'contenteditable'"));
t('识别 plain（不能替换）', ct.includes("kind: 'plain'"));
t('排除 checkbox/radio/file', ct.includes("type === 'checkbox'"));
t('★ 处理 activeElement 失效', ct.includes('activeElement 有时会变成 body'));
t('用 indexOf 反查位置', ct.includes('full.indexOf(fb)'));

console.log('');
console.log('=== 替换原文 ===');
t('replaceSelection 存在', ct.includes('function replaceSelection(payload, newText)'));
t('★ 用 execCommand insertText', ct.includes("document.execCommand('insertText', false, newText)"));
t('兜底 setRangeText', ct.includes('setRangeText('));
t('手动派发 input 事件', ct.includes("new Event('input', { bubbles: true })"));
t('contenteditable 用 Range', ct.includes('range.deleteContents()'));
t('contenteditable 派发 InputEvent', ct.includes('new InputEvent('));

console.log('');
console.log('=== 面板 ===');
t('buildReversePanel 存在', ct.includes('function buildReversePanel(payload, langLabel)'));
t('有复制按钮', ct.includes("btnCopy.textContent = '复制'"));
t('有替换按钮', ct.includes("btnReplace.textContent = payload.kind === 'plain'"));
t('plain 时禁用替换', ct.includes("'替换（不可用）'"));
t('复制走 clipboard', ct.includes('navigator.clipboard.writeText'));
t('剪贴板失败时选中译文', ct.includes("btnCopy.textContent = '请按 Ctrl+C'"));
t('CSS 有 .dsh-revpanel', css.includes('.dsh-revpanel {'));
t('CSS 是 fixed 定位', css.includes('position: fixed;'));
t('CSS 有主按钮样式', css.includes('.dsh-rv-primary'));

console.log('');
console.log('=== 接入 ===');
t('case dsh-reverse 处理', ct.includes("case 'dsh-reverse':"));
t('导出到 __DSH_INTERNALS__', ct.includes('grabReverseTarget: grabReverseTarget'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);