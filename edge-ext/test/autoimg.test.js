/* 自动翻译 + CV 互补检测测试。
   用户报的两个问题：
   1. 翻页（鼠标/方向键）无法自动翻译
   2. 版面翻译会漏，整页识别能全检测到
   node test/autoimg.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');
const dsh = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const oh = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');
const ph = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');

console.log('=== 自动翻译：配置 ===');
t('DEFAULTS 有 imageAutoTranslate', dsh.includes('imageAutoTranslate: false'));
t('设置页有开关', oh.includes('id="imageAutoTranslate"'));
t('popup 有开关', ph.includes('id="autoImg"'));
t('content 同步配置给模块', ct.includes('M.setAutoTranslate'));

console.log('');
console.log('=== 自动翻译：触发逻辑 ===');
t('maybeAutoTranslate 存在', img.includes('function maybeAutoTranslate(img)'));
t('★ 开关判据用 S.autoImgEnabled（不是 cfg 字段）', img.includes('if (S.autoImgEnabled !== true) return;'));
t('setAutoTranslate 同步两者', img.includes('S.cfg.imageAutoTranslate = !!on'));
t('320ms 防抖', img.includes('var AUTO_DELAY = 320'));
t('只翻主图（findMainImage）', img.includes('function findMainImage()'));
t('主图判据：面积 > 200x200', img.includes('if (w < 200 || h < 200) continue;'));
t('busy 时排队重试', img.includes('S.busyRetry'));
t('重试上限 30 次', img.includes('S.busyRetry < 30'));
t('用 translateLayout（最准）', img.includes('translateLayout(img).finally'));

console.log('');
console.log('=== 自动翻译：接入点 ===');
t('在 clearForImage 里调用', img.includes('try { maybeAutoTranslate(img); }'));
t('导出 setAutoTranslate', img.includes('setAutoTranslate: setAutoTranslate'));
t('导出 autoTranslateNow', img.includes('autoTranslateNow'));

console.log('');
console.log('=== CV 互补检测 ===');
t('parseSuryaImageBlocks 存在', dsh.includes('function parseSuryaImageBlocks'));
t('suryaLayout 返回 imageBlocks', dsh.includes('imageBlocks: parseSuryaImageBlocks(raw)'));
t('只收 Image/Table/Figure', dsh.includes('/^(Image|Table|Figure)$/i'));
t('translateLayout 有互补逻辑', img.includes('opts.complement !== false'));
t('大 Image 块判据 > 15%', img.includes('if (frac < 0.15) return false'));
t('排除整页框 > 95%', img.includes('if (frac > 0.95) return false'));
t('跑 CV detect', img.includes('var det = await detect(img, {'));
t('只保留落在 Image 块内的 CV 框', img.includes('cx >= ib.x && cx <= ib.x + ib.w'));
t('去重（中心点 5%）', img.includes('Math.abs((b.x + b.w / 2) - cx) < 0.05'));
t('合并后重新排序', img.includes('layout.boxes.sort(function (a, b) { return a.y - b.y || a.x - b.x; })'));
t('content 透传 imageBlocks', ct.includes('imageBlocks: r.imageBlocks || []'));

console.log('');
console.log('=== 页面里也要能读 ===');
t('导出 detect（供互补用）', img.includes('detect: detect'));

console.log('');
console.log('=== 废块过滤 ===');
t('translateLayout 有废块过滤', img.includes('skip junk block'));
t('实义字符 < 2 丢弃', img.includes('meaningful.length < 2'));
t('剥标点/符号', img.includes('\\p{P}\\p{S}'));

console.log('');
console.log('=== 默认模式 = layout（Surya+CV 互补）===');
t('默认走 translateLayout', img.includes('else job = translateLayout(img)'));
t('Ctrl+Shift 走 fast', img.includes('if (wantPage && e.ctrlKey) job = translateFast(img)'));
t('Shift 走 page', img.includes('else if (wantPage) job = translatePage(img)'));
t('Ctrl 走 CV', img.includes('else if (e.ctrlKey) job = translateImage'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);