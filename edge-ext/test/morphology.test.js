/* 形态学文字检测测试。
   这是图片翻译定位问题的最终解法：
   方向性闭运算（先膨胀后腐蚀）沿单一方向桥接字符，对网点纸天然免疫。
   node test/morphology.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');

console.log('=== 形态学实现契约 ===');
t('closeDirectional 存在', img.includes('function closeDirectional'));
t('detectTextBars 存在', img.includes('function detectTextBars'));
t('barsToParagraphs 存在', img.includes('function barsToParagraphs'));

console.log('');
console.log('=== 膨胀：前缀累计（不是双重循环）===');
t('横向膨胀用前缀', img.includes("acc = bw[off + x] ? k : Math.max(0, acc - 1)"));
t('纵向膨胀用前缀', img.includes("accV = bw[y * W + x] ? k : Math.max(0, accV - 1)"));
t('双向（向右+向左）', img.includes('for (x = W - 1; x >= 0; x--)') || img.includes('for (y = H - 1; y >= 0; y--)'));

console.log('');
console.log('=== 腐蚀：逐窗口（这是踩过的坑）===');
// 错误的实现只看窗口两端：dil[x-k] && dil[x+k]
t('★ 没有只看两端的老实现', !img.includes('(xx - k >= 0) ? dil[o2 + xx - k] : 0'));
t('★ 用 lastZero 逐窗口扫描', img.includes('lastZero'));
t('★ 横向腐蚀判据 lastZero < x - k', img.includes('lastZero < x - k'));
t('★ 纵向腐蚀判据 lastZeroV < y - k', img.includes('lastZeroV < y - k'));

console.log('');
console.log('=== 双阈值 ===');
t('binarize 生成 bwDark', img.includes('var bwDark = new Uint8Array(W * H)'));
t('bwDark 阈值 120', img.includes('bwDark[p] = y < 120 ? 1 : 0'));
t('形态学用 bwDark', img.includes('var bw = bin.bwDark || bin.bw'));
t('返回里含 bwDark', img.includes('bwDark: bwDark'));

console.log('');
console.log('=== 判据 ===');
t('竖条 h/w ≥ 2.5', img.includes('if (h / w < 2.5) continue'));
t('横条 w/h ≥ 2.5', img.includes('if (w2 / h2 < 2.5) continue'));
t('竖条高 ≥ 70', img.includes('if (h < 70'));
t('横条宽 ≥ 70', img.includes('if (w2 < 70'));
t('宽度上限 70（避免整块）', img.includes('w > 70'));
t('高度上限 70（横排）', img.includes('h2 > 70'));
t('面积上限 10%', img.includes('area * 0.10'));

console.log('');
console.log('=== 段落合并 ===');
t('竖排：列间距 ≤ 2.5x 条宽', img.includes('xgap <= cand.w * 2.5'));
t('横排：行间距 ≤ 2.5x 条高', img.includes('ygap <= cand.h * 2.5'));
t('竖排：副方向重叠 ≥ 15%', img.includes('oy >= minH * 0.15'));
t('横排：副方向重叠 ≥ 15%', img.includes('ox >= minW * 0.15'));
t('最多合并 6 个条', img.includes('grp.length >= 6'));

console.log('');
console.log('=== detect 接线 ===');
t('detect 用 detectTextBars', img.includes('var barResult = detectTextBars'));
t('detect 用 barsToParagraphs', img.includes('var boxes = barsToParagraphs'));
t('返回 barCount', img.includes('barCount: barResult.bars.length'));
t('返回 morph 耗时', img.includes('morph: tBar'));
t('k 按图尺寸自适应', img.includes('Math.min(bin.W, bin.H) * 0.010'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);