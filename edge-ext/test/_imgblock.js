
const path = require('path');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);
const fs = require('fs');

const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

// 造一张带日文的小图（用 canvas 造不了，用 PIL 提前做好）
const imgPath = String.raw`C:\\Users\\123\\Downloads\\_crop_test.png`;
if (!fs.existsSync(imgPath)) { console.log('测试图不存在，先造', imgPath); process.exit(1); }
const b64 = fs.readFileSync(imgPath).toString('base64');
const dataUrl = 'data:image/png;base64,' + b64;

console.log('图片大小:', Math.round(b64.length/1024), 'KB');
console.log('');
(async () => {
  for (const lang of ['简体中文', 'English']) {
    const r = await DSH.visionTranslateBlock(base, cfg, dataUrl, { targetLang: lang, model: 'translate' });
    console.log('[' + lang + '] ' + r.ms + 'ms');
    console.log('  译文: ' + JSON.stringify(r.text));
    console.log('  usage: ' + JSON.stringify(r.usage));
    console.log('');
  }
  // 测 pickTranslationOnly
  console.log('=== pickTranslationOnly 测试 ===');
  const cases = [
    '你好，世界。',
    '原文：こんにちは\n译文：你好',
    'JP: こんにちは\nZH: 你好',
    'おはよう\n你好\n谢谢',
  ];
  for (const c of cases) {
    console.log('  输入 ' + JSON.stringify(c) + ' → ' + JSON.stringify(DSH.pickTranslationOnly(c)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
