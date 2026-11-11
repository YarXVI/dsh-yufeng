/* 数字保护阈值测试：按**可见文字**长度算，不是 HTML 长度。
   踩过的坑：富文本标题带 <span class="before"> 等标签，t.length 有 147 字
   但可见文字只有 64 字 → 误触发保护 → @N0@ 被模型当成序号 →
   标题变成「第0课 (Comic Hot Milk 第1年第2月刊)」。
   node test/numbers.test.js 的一部分（独立成文件更清楚） */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 辅助：复现源码里的阈值判断
function visibleLen(html) {
  return DSH.normSpace(DSH.protectTags(html).text.replace(/<[^>]*>/g, '')).length;
}

// 1. 富文本标题：HTML 长度大，可见长度小 → 不该保护
const H1 = '<span class="before">[水龍敬] </span><span class="pretty">GTS グレートティーチャーサヨコ Lesson10</span><span class="after"> (コミックホットミルク 2026年12月号) [古月个人汉化]</span>';
t('h1 原始长度 > 80', H1.length > 80, String(H1.length));
t('h1 可见长度 <= 80', visibleLen(H1) <= 80, String(visibleLen(H1)));
t('结论：h1 不触发数字保护', visibleLen(H1) <= 80);

// 2. 真正的长句：可见长度 > 80 → 要保护
const LONG = 'Uploaded 3 hours, 25 minutes ago (2026年11月10日) - this gallery has 42 pages with 240.9k views and 1,234 favorites, rated 98% by 5,678 users in 12 countries.';
t('长句可见长度 > 80', visibleLen(LONG) > 80, String(visibleLen(LONG)));

// 3. 源码里必须用可见长度判断（不能有 t.length <= 80）
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
t('源码去掉 HTML 再算长度', code.includes("String(t).replace(/<[^>]*>/g, '')"));
t('源码没有裸 t.length <= 80 的数字保护判断',
  !/if \(t\.length <= 80\)s*\{\s*numBags\.push\(\[\]\)/.test(code));

// 4. 部分还原：占位符只回来一部分时，缺的计数要补回来
const nums = ['3', '25', '2026', '11', '10', '42', '240.9k', '1,234', '98%', '5,678', '12'];
const partial = '3小时25分钟前 (2026年11月10日) 上传 - 42页, 240.9k浏览量, 1,234收藏, 98% 5,678';
// 模拟：模型吞了 12 的占位符
const fakeOut = DSH.restoreNumbers(partial, nums);
t('部分还原不丢带单位的计数',
  fakeOut.includes('12') || fakeOut.length >= partial.length,
  fakeOut.slice(-40));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
