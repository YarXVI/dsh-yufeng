/* 图像描述（caption）过滤测试。
   真实 bug：用户拿 nhentai 漫画页测，7 个块全部返回「画面中：山崎说到…」
   这类图像描述，被当成译文盖到图上，完全污染。
   node test/caption.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

/* ===== 用户截图里逐字抄下来的 7 条真实输出 ===== */
const REAL_CAPTIONS = [
  '画面中：山崎说到：你吃了吗？吃了吗？旁边写着山崎说到和女面商会画面里一个穿传统服饰的人正吃着好吃的食物',
  '画面中有一处细节：一个带有标签的容器旁边写着「かっ？」（日语），后面跟着一条斜线阴影和粗黑线条。',
  '这位角色的上半身画面中可以看到她穿着带有花纹的日式和服式上衣，胸部有花叶图案装饰。她的台词是：「只是……」所以只能这样了。',
  '图片中的文本无法显示或无效。',
  '图片中的文本已全部翻译成简体中文；图像中没有任何可见的文本内容。',
  '画面里有一个穿传统服饰的人正吃着好吃的食物，盘子里有几块弯弧状的食物碗小心地摆放着。',
  '图像中没有任何可见的文本内容。'
];

/* ===== 正常译文（不能被误判） ===== */
const REAL_TRANSLATIONS = [
  '你好，今天做什么？',
  '这真的太好了！',
  '谢谢 您辛苦了',
  '明天吧',
  '早上好，今天要做什么？',
  '这真是太厉害了',
  '他说他今天很忙，所以可能没办法过来了。',
  '这是一段很长的说明文字，但它确实是正常的译文而不是图像描述。',
  '我需要你帮我看看这个文件里写的到底是什么内容，因为我看不太清楚。',
  '我们明天在车站见面吧，时间是下午三点。'
];

console.log('=== 图像描述识别 ===');
REAL_CAPTIONS.forEach(function (c, i) {
  t('描述 #' + (i + 1) + ' ' + JSON.stringify(c.slice(0, 22)), DSH.looksLikeCaption(c) === true, '未识别为描述');
});

console.log('');
console.log('=== 正常译文不误判 ===');
REAL_TRANSLATIONS.forEach(function (c, i) {
  t('译文 #' + (i + 1) + ' ' + JSON.stringify(c.slice(0, 22)), DSH.looksLikeCaption(c) === false, '被误判为描述');
});

console.log('');
console.log('=== extractUsableImageText 端到端 ===');
const e2e = [
  ['纯描述 → 空', REAL_CAPTIONS[2], ''],
  ['自我否定 → 空', REAL_CAPTIONS[3], ''],
  ['自我宣告 → 空', REAL_CAPTIONS[4], ''],
  ['（无文字）占位 → 空', '（无文字）', ''],
  ['(no text) 占位 → 空', '(no text)', ''],
  ['混合保留译文行', '你好！\n画面中可以看到她穿着和服。\n谢谢', '你好！\n谢谢'],
  ['纯译文原样返回', '你好，今天做什么？', '你好，今天做什么？'],
  ['多行译文保留', 'ありがとう\nございます'.replace('ありがとう','谢谢').replace('ございます','非常感谢'), '谢谢\n非常感谢']
];
e2e.forEach(function (c) {
  const got = DSH.extractUsableImageText(c[1]);
  t(c[0], got === c[2], JSON.stringify(got) + ' 期望 ' + JSON.stringify(c[2]));
});

console.log('');
console.log('=== 组合：剥双段落 + 去重复 + 剔描述 ===');
const combo = [
  ['原文/译文两段 + 无描述', '原文：おはよう\n译文：你好', '你好'],
  ['重复行 + 无描述', '明天吧 明天吧', '明天吧'],
  ['译文 + 重复 + 描述', '你好\n你好\n画面中可以看到她穿着和服。', '你好']
];
combo.forEach(function (c) {
  const got = DSH.extractUsableImageText(c[1]);
  t(c[0], got === c[2], JSON.stringify(got) + ' 期望 ' + JSON.stringify(c[2]));
});

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);