/* 缓存卫生测试：
   1. identity 映射（译文 === 原文）不进持久缓存 —— 那是失败，不是结果
   2. 缓存键带版本前缀，旧版本条目自动失效
   3. diskLoad 时清理无当前版本前缀的条目
   node test/cachehygiene.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const code = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 1. 源码里必须存在 identity 检查
t('cacheSet 拒绝 identity 映射', /String\(val\)\.trim\(\) === String\(text\)\.trim\(\)/.test(code) || code.indexOf('译文和原文一模一样') >= 0);

// 2. 缓存键必须带版本前缀
const mKey = code.match(/return (CACHE_VER \+ '[^']*' \+ lang)/);
t('cacheKey 带版本前缀', !!mKey || code.indexOf("CACHE_VER + '\\u0000' + lang") >= 0, String(mKey && mKey[1]));

// 3. 必须有 CACHE_VER 常量
t('存在 CACHE_VER 常量', /var CACHE_VER = '/.test(code));

// 4. diskLoad 必须清理旧版本条目
t('diskLoad 清理旧版本条目', code.indexOf("k.indexOf(CACHE_VER") >= 0);

// 5. 实际验证：cacheKey 不同版本不同键
const mBody = code.match(/function cacheKey\(lang, text\) \{([\s\S]*?)\n\}/);
const mVer = code.match(/var CACHE_VER = '([^']*)'/);
const CACHE_VER = mVer ? mVer[1] : 'none';
function cacheKey(lang, text) { return eval('(function(CACHE_VER){' + mBody[1] + '})')(CACHE_VER); }
t('同文本同语言同版本 → 同键', cacheKey('zh', 'doujinshi') === cacheKey('zh', 'doujinshi'));
t('键里含版本标记', cacheKey('zh', 'x').indexOf(CACHE_VER) >= 0, cacheKey('zh', 'x'));
t('不同文本不同键', cacheKey('zh', 'doujinshi') !== cacheKey('zh', 'manga'));

// 5b. cacheGet 里必须有 identity 兜底（命中脏条目时当未命中处理）
t('cacheGet 丢弃 identity 命中', code.indexOf('String(hit).trim() === String(item.text).trim()') >= 0);

// 6. 术语表命中时不依赖缓存（doujinshi 有固定译名）
const DSH = require(path.join(SRC, 'dsh.js'));
t('doujinshi 走术语表', DSH.glossaryLookup('doujinshi') === '同人志', String(DSH.glossaryLookup('doujinshi')));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
