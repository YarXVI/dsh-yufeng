/* 语言判定测试：短中文漏判、纯符号、编号这些边界情况。
   node test/langdetect.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function expect(text, want, note) {
  const got = DSH.isTranslatable(text, '简体中文');
  if (got === want) { pass++; console.log('✓ ' + JSON.stringify(text) + (note ? ' (' + note + ')' : '')); }
  else { fail++; console.log('✗ ' + JSON.stringify(text) + ' 期望 ' + want + ' 实际 ' + got + (note ? ' (' + note + ')' : '')); }
}

// 中文（不该翻）
['中文区', '帮助', '模型竞技场', '通用', '设置', '账号安全', '退出登录', '你好'].forEach((t) => expect(t, false, '已是中文'));

// 外语（该翻）
['support hours', 'warranty', 'INFORMATION', 'CHAT & SHARE', 'hello 世界', 'Getting started', 'Sign in'].forEach((t) => expect(t, true, '外语'));

// 短词 / 编号 / 符号（不该翻）
['ok', 'FAQ', 'npm', 'R18', '#102', '1,234', '42%', '238.5k'].forEach((t) => expect(t, false, '短词或编号'));

// 日文（带假名必须翻）
['こんにちは', 'やれんかった', 'ありがとうございます'].forEach((t) => expect(t, true, '日文'));

// 中日混排（有假名就翻）
['漢字の読み方', '日本語のテキスト'].forEach((t) => expect(t, true, '混排'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
console.log('OK 语言判定测试通过');
