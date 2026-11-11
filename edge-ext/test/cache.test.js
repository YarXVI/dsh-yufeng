/* 缓存键测试：归一化只能做「不改变语义」的部分。
   最重要的一条：不同数字绝不能共用一个缓存条目 ——
   曾经把数字统一换成 '#'，"Pages: 51" 和 "Pages: 26" 撞成同一个键，
   导致 A 画廊的「页数：26」被套到 B 画廊上。
   node test/cache.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const code = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');

const m = code.match(/function cacheKey\(lang, text\) \{([\s\S]*?)\n\}/);
if (!m) { console.log('x 找不到 cacheKey'); process.exit(1); }
const body = m[1];

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const mVer = code.match(/var CACHE_VER = '([^']*)'/);
const CACHE_VER = mVer ? mVer[1] : 'none';
function cacheKey(lang, text) { return eval('(function(CACHE_VER){' + body + '})')(CACHE_VER); }
const norm = (s) => cacheKey('zh', s);

// === 关键：不同数字必须不同键 ===
t('不同页数不同键', norm('Pages: 51') !== norm('Pages: 26'),
  norm('Pages: 51') + ' vs ' + norm('Pages: 26'));
t('不同计数不同键', norm('big breasts 240.9k') !== norm('big breasts 240.8k'));
t('不同日期不同键', norm('Uploaded: 15 hours ago (11/9/2026)') !== norm('Uploaded: 41 minutes ago (11/10/2026)'));
t('不同时间不同键', norm('15 hours, 57 minutes ago') !== norm('41 minutes, 39 seconds ago'));

// === 安全的归一化 ===
t('大小写不敏感', norm('Tags:') === norm('tags:'), norm('Tags:') + ' vs ' + norm('tags:'));
t('尾部冒号不影响', norm('Tags:') === norm('Tags'));
t('多余空白不影响', norm('big  breasts') === norm('big breasts'));
t('首尾空格不影响', norm('  anal  ') === norm('anal'));

// === 不同内容必须不同键 ===
t('不同词不同键', norm('big breasts') !== norm('anal'));
t('不同语言不同键', cacheKey('zh', 'tags') !== cacheKey('ja', 'tags'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
