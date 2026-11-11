/* 站点术语表测试：成人向标签、元数据键必须翻对。
   node test/glossary.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(input, want) {
  const got = DSH.glossaryLookup(input);
  if (got === want) { pass++; console.log('✓ ' + JSON.stringify(input) + ' → ' + got); }
  else { fail++; console.log('✗ ' + JSON.stringify(input) + ' 期望 ' + JSON.stringify(want) + ' 实际 ' + JSON.stringify(got)); }
}
function tOk(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 成人向标签（之前翻错成「分析」「DILF」「网络」的）
t('anal', '肛交');
t('dilf', '猛男');
t('netorare', 'NTR');
t('big breasts', '大胸');
t('blowjob', '口交');
t('schoolgirl uniform', '女学生制服');
t('stockings', '长袜');
t('full color', '全彩');
t('x-ray', '透视');
t('dark skin', '深色皮肤');
t('transparent clothing', '透明衣物');
t('butt plug', '肛塞');

// 元数据键（带冒号要保留冒号）
t('Tags:', '标签:');
t('Parodies:', '恶搞作品:');
t('Artists:', '艺术家:');
t('Languages:', '语言:');
t('Categories:', '类别:');
t('Pages:', '页数:');
t('Uploaded:', '上传时间:');

// 大小写与下划线归一
t('BIG BREASTS', '大胸');
t('big_breasts', '大胸');
t('anal-intercourse', '肛交');

// 不该命中术语表的（要交给模型）
// 这些是「普通句子」，必须交给模型
const notTa = [
  'This is a regular sentence that should go to the model.',
  'The quick brown fox jumps over the lazy dog.',
  'Click here to download the latest version of the software.'
];

// 这些是 nhentai 的固定文案，术语表里有，应直接命中
t('See a tag missing?', '发现标签缺失了吗？');
t("suggest one, it'll surface once others agree", '建议添加一个，其他用户同意后就会显示');
const leftovers = notTa.filter(x => DSH.glossaryLookup(x) != null);
tOk('普通句子不命中术语表', leftovers.length === 0, 'leftovers=' + JSON.stringify(leftovers));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
