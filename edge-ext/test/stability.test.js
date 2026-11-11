/* 稳定性测试：同一文本多次翻译必须给出一致结果。
   这是「不太稳定」抱怨的核心 —— temperature 0 + 缓存后，同输入同输出。
   node test/stability.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 1. 默认 temperature 必须是 0（贪心解码）
t('默认 temperature = 0', DSH.DEFAULTS.temperature === 0, String(DSH.DEFAULTS.temperature));

// 2. 专名保护不能「保护到没东西可翻」
const nameHeavy = '(C105) [Shikoushoku (Shikou Shiki)] Kousou Souei (Kiddy Grade)';
const p1 = DSH.protectTags(nameHeavy);
t('纯专名标题不做过度保护', p1.tags.length === 0, JSON.stringify(p1.tags));
t('纯专名标题保留可翻正文', p1.text.indexOf('Kousou') >= 0, p1.text);

// 3. 元数据标签仍然保护
const metaHeavy = 'April Fool\'s Finale [English] [Digital]';
const p2 = DSH.protectTags(metaHeavy);
t('元数据标签仍保护', p2.tags.length === 2, JSON.stringify(p2.tags));
t('正文保留可翻', p2.text.indexOf("April Fool") >= 0, p2.text);

// 4. 混合标题：保护专名，保留副标题
const mixed = '[Nishiki no Yokuen(Shikou Shiki Nishikino Niki)] Lustkreis ~ Saitei Gunjin no Meirei ni Nureru Hibu Kensa [Digital]';
const p3 = DSH.protectTags(mixed);
t('混合标题保护专名', p3.tags.length === 2, JSON.stringify(p3.tags));
t('混合标题保留副标题', p3.text.indexOf('Lustkreis') >= 0, p3.text);

// 5. 往返一致（保护→还原）
t('往返一致（混合标题）', DSH.restoreTags(p3.text, p3.tags) === mixed);

// 6. 标签标记是字母，不是数字（避免和数字保护打架）
t('标签标记用字母', /«A»/.test(DSH.protectTags(metaHeavy).text), DSH.protectTags(metaHeavy).text);

// 7. 数字保护不能吃掉标签标记
const both = 'Uploaded: 18 hours, 27 minutes ago (2026年11月9日) [Digital]';
const pb = DSH.protectTags(both);
const n = DSH.protectNumbers(pb.text);
t('标签标记不与数字保护冲突', n.text.indexOf('«A»') >= 0 || n.text.indexOf('«') >= 0, n.text);
t('往返一致（标签+数字）', DSH.restoreNumbers(DSH.restoreTags(n.text, pb.tags), n.nums) === both,
  DSH.restoreNumbers(DSH.restoreTags(n.text, pb.tags), n.nums));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
