/* 翻页清场测试。
   用户报：「切换第二张图片，文字没有清空、重新读取翻译」。
   根因：overlay 挂在 img 父节点上，src 变了 overlay 不会自己消失；
         面板列表也留着上一张的。
   node test/pageflip.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');

console.log('=== 统一清场：beginTranslate ===');
t('beginTranslate 存在', img.includes('function beginTranslate(firstStat)'));
t('① 中断上一次翻译（S.seq++）', img.includes('S.seq++'));
t('② 清所有 overlay 层', img.includes("document.querySelectorAll('.dsh-imglayer')"));
t('③ 重置 curLayer/curImg/lastImg', img.includes('S.curLayer = null') && img.includes('S.curImg = null') && img.includes('S.lastImg = null'));
t('④ 清面板 body', img.includes("panel.querySelector('.dsh-ip-body')"));
t('返回 seq', img.includes('return S.seq;'));

console.log('');
console.log('=== 三个入口都调它 ===');
for (const fn of ['translateLayout', 'translatePage', 'translateImage']) {
  const i = img.indexOf('async function ' + fn + '(img, opts)');
  const seg = img.slice(i, i + 400);
  t(fn + ' 用 beginTranslate', seg.includes('beginTranslate'));
  t(fn + ' 不再手写 innerHTML 清理', !seg.includes("innerHTML = ''"));
}

console.log('');
console.log('=== ★ 隐藏 bug：重复 seq 自中断 ===');
// 合法的 S.seq++ 有 4 处：注释里 1、beginTranslate、restoreAll、clearForImage
t('S.seq++ 只在 3 个清场点（+1 处注释）', (img.match(/S\.seq\+\+/g) || []).length === 4, '实际 ' + (img.match(/S\.seq\+\+/g) || []).length);
t('translateImage 里没有重复 var seq = ++S.seq', !img.includes('var seq = ++S.seq;\n    var results'));

console.log('');
console.log('=== ★ 根本修复：监听图片变化 ===');
t('bindImageChangeCleanup 存在', img.includes('function bindImageChangeCleanup'));
t('监听 load 事件（捕获）', img.includes("addEventListener('load'"));
t('监听 error 事件', img.includes("addEventListener('error'"));
t('MutationObserver 监听 src', img.includes('attributeFilter: [\'src\', \'srcset\']'));
t('cleanForImage 存在', img.includes('function clearForImage(img)'));
t('清 overlay', img.includes("host.querySelectorAll('.dsh-imglayer')"));
t('清面板列表', img.includes("body.innerHTML = ''"));
t('中断翻译', img.includes('S.seq++'));
t('面板提示「图片已切换」', img.includes('图片已切换，请重新翻译'));
t('只在当前图被清时才清面板', img.includes('if (S.curImg === img)'));
t('bind() 里调用', img.includes('bindImageChangeCleanup();'));
t('有 imgWatchBound 防重入', img.includes('imgWatchBound'));

console.log('');
console.log('=== 浏览器验证契约 ===');
t('load 监听在捕获阶段（true）', /addEventListener\('load'[\s\S]{0,200}?\}\s*,\s*true\)/.test(img));
t('error 监听在捕获阶段（true）', /addEventListener\('error'[\s\S]{0,200}?\}\s*,\s*true\)/.test(img));
t('MutationObserver 观察 subtree', img.includes('subtree: true'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);