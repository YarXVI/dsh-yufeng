/* 数字保护测试：计数、金额、百分比、日期里的数字必须原样保住。
   node test/numbers.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const CASES = [
  'Uploaded: 18 hours, 27 minutes ago (2026年11月9日)',
  'big breasts 240.8k',
  'school gym uniform 1.8k',
  'Pages: 71',
  'Price is $0.0016 per call',
  'Privacy 42% better than last release',
  '1,234 views',
  'doujinshi 519.4k'
];

// 1. 保护 - 还原必须完全一致
CASES.forEach(function (c) {
  const p = DSH.protectNumbers(c);
  const back = DSH.restoreNumbers(p.text, p.nums);
  t('往返一致 ' + JSON.stringify(c), back === c, JSON.stringify(back));
});

// 2. 单位不能被误切："27 minutes" 里的 m 不是千单位
const p27 = DSH.protectNumbers('27 minutes');
t('27 minutes 不被切成 27 m', p27.nums[0] === '27', JSON.stringify(p27.nums));
t('27 minutes 只保护一个数字', p27.nums.length === 1, JSON.stringify(p27.nums));

// 3. 模型吞掉占位符时，关键数字要补回来
const p2 = DSH.protectNumbers('big breasts 240.8k');
const swallowed = '大胸部'; // 模型没抄占位符
const restored = DSH.restoreNumbers(swallowed, p2.nums);
t('吞掉占位符后补回计数', restored.indexOf('240.8k') >= 0, restored);

// 4. 纯序号数字不该硬塞（位置对不上）
const p3 = DSH.protectNumbers('Pages: 71');
t('Pages: 71 保护 71', p3.nums.length === 1 && p3.nums[0] === '71', JSON.stringify(p3.nums));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
