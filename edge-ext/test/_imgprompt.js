
const path = require('path');
const fs = require('fs');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);

const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

// 用之前造的真实感漫画页（有插画 + 文字）
const imgPath = String.raw`C:\\Users\\123\\Downloads\\_repro_manga.png`;
const b64 = fs.readFileSync(imgPath).toString('base64');
const dataUrl = 'data:image/png;base64,' + b64;

async function testCrop(x0, y0, x1, y1, label) {
  // 用 canvas 裁剪（Node 里没有 canvas，用 Python 预先裁好）
  const cropPath = String.raw`C:\\Users\\123\\Downloads\\_crop_` + label + '.png';
  if (!fs.existsSync(cropPath)) return null;
  const cb = fs.readFileSync(cropPath).toString('base64');
  const cd = 'data:image/png;base64,' + cb;
  const t0 = Date.now();
  const r = await DSH.visionTranslateBlock(base, cfg, cd, { targetLang: '简体中文', model: 'translate' });
  const ms = Date.now() - t0;
  return { label, ms, text: r.text, skipped: r.skipped, raw: r.raw };
}

(async () => {
  console.log('=== 新 prompt 实测（真实漫画页的两个区域）===');
  for (const label of ['text', 'pic', 'danmaku']) {
    const r = await testCrop(0,0,0,0, label);
    if (!r) { console.log('  ' + label + ': 没有预裁文件'); continue; }
    console.log('  [' + label + '] ' + r.ms + 'ms | skipped=' + r.skipped);
    console.log('      译文: ' + JSON.stringify((r.text || '').slice(0, 60)));
    if (r.raw) console.log('      原始(被丢): ' + JSON.stringify(r.raw.slice(0, 80)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
