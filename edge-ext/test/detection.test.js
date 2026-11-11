/* 翻译判定测试：日文→中文 的判定必须正确。
   踩过的坑：日文标题假名换成汉字后，「汉字增长比例」只有 0.03，
   被判成「没翻」→ 译文被丢弃 → 页面显示原文。
   node test/detection.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const JA_TITLE_SRC = '<span>[水龍敬] </span><span>GTS グレートティーチャーサヨコ Lesson10</span><span> (コミックホットミルク 2026年12月号) [古月个人汉化]</span>';
const JA_TITLE_DST = '<span>[水龍敬] </span><span>GTS 大師サヨコ Lesson10</span><span> (漫畫熱牛奶 2026年12月号) [古月个人汉化]</span>';

// 1. 日文→中文：假名减少，必须判成「已翻」
t('日文标题翻成中文 → 已翻', DSH.looksUntranslated(JA_TITLE_SRC, JA_TITLE_DST, '简体中文') === false);

// 2. 原样返回：必须判成「没翻」
t('原样返回 → 没翻', DSH.looksUntranslated(JA_TITLE_SRC, JA_TITLE_SRC, '简体中文') === true);

// 3. 纯英文原样返回
t('英文原样返回 → 没翻', DSH.looksUntranslated('This is a test.', 'This is a test.', '简体中文') === true);

// 4. 英文正常翻译
t('英文翻成中文 → 已翻', DSH.looksUntranslated('This is a test.', '这是一个测试。', '简体中文') === false);

// 5. 已经是中文
t('中文原文 → 没翻', DSH.looksUntranslated('这是一段中文。', '这是一段中文。', '简体中文') === true);

// 6. 韩文→中文
t('韩文翻成中文 → 已翻', DSH.looksUntranslated('안녕하세요 반갑습니다', '你好，很高兴见到你', '简体中文') === false);

// 7. 假名只掉一点点（模型偷懒只改几个字）→ 应判成没翻
t('假名几乎没变 → 没翻', DSH.looksUntranslated('グレートティーチャーサヨコ', 'グレートティーチャーサヨコ', '简体中文') === true);

// 8. 日文标题实网抓的真数据
const REAL_SRC = '[水龍敬] GTS グレートティーチャーサヨコ Lesson10 (コミックホットミルク 2026年12月号) [古月个人汉化]';
const REAL_DST = '[水龍敬] GTS 大師サヨコ Lesson10 (漫画热牛奶 2026年12月号) [古月个人汉化]';
t('真实日文标题 → 已翻', DSH.looksUntranslated(REAL_SRC, REAL_DST, '简体中文') === false);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
