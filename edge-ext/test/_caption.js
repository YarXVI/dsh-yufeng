
const path = require('path');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);

const cases = [
  "画面中：山崎说到：你吃了吗？吃了吗？旁边写着山崎说到和女面商会画面里一个穿传统服饰的人正吃着好吃的食物",
  "画面中有一处细节：一个带有标签的容器旁边写着「かっ？」（日语），后面跟着一条斜线阴影和粗黑线条。",
  "这位角色的上半身画面中可以看到她穿着带有花纹的日式和服式上衣，胸部有花叶图案装饰。她的台词是：「只是……」所以只能这样了。旁边还有另一个对话框写着「那么之类的」字样。",
  "图片中的文本无法显示或无效。",
  "图片中的文本已全部翻译成简体中文；图像中没有任何可见的文本内容。",
  "你好，今天做什么？",
  "这真的太好了！",
  "谢谢 您辛苦了",
  "明天吧",
  "早上好，今天要做什么？",
  "这真是太厉害了",
  "他说他今天很忙，所以可能没办法过来了。",
  "这是一段很长的说明文字，但它确实是正常的译文而不是图像描述。",
  "我需要你帮我看看这个文件里写的到底是什么内容，因为我看不太清楚。"
];

console.log('=== looksLikeCaption 判定 ===');
let pass = 0, fail = 0;
const expectCaption = [true, true, true, true, true, false, false, false, false, false, false, false, false, false];
cases.forEach((c, i) => {
  const got = DSH.looksLikeCaption(c);
  const want = expectCaption[i];
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? '✓' : '✗') + ' ' + (got ? '描述' : '译文') + '  ' + JSON.stringify(c.slice(0, 34)));
});

console.log('');
console.log('=== extractUsableImageText 端到端 ===');
const e2e = [
  ['用户截图第 3 条', cases[2], ''],
  ['混合（译文+描述）', '你好！\n画面中可以看到她穿着和服。\n谢谢', '你好！\n谢谢'],
  ['纯译文', '你好，今天做什么？', '你好，今天做什么？'],
];
for (const [name, input, expect] of e2e) {
  const got = DSH.extractUsableImageText(input);
  const ok = got === expect;
  if (ok) pass++; else fail++;
  console.log((ok ? '✓' : '✗') + ' ' + name + ' → ' + JSON.stringify(got.slice(0, 40)) + (ok ? '' : '  (期望 ' + JSON.stringify(expect) + ')'));
}

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
