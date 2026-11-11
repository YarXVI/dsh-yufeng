
const path = require('path');
const fs = require('fs');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);
const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

const CASES = [
  ['c1', '气泡', 'おはよう / 今日は何する？'],
  ['c2', '插画', '（应该无文字）'],
  ['c3', '大对话', 'ありがとうございます / これ、本当にうれしいです'],
];

(async () => {
  console.log('=== 真实感漫画页实测 ===');
  for (const [id, name, expect] of CASES) {
    const fp = String.raw`C:\\Users\\123\\Downloads\\_` + id + '.png';
    if (!fs.existsSync(fp)) { console.log('  缺文件 ' + fp); continue; }
    const b64 = fs.readFileSync(fp).toString('base64');
    const t0 = Date.now();
    const r = await DSH.visionTranslateBlock(base, cfg, 'data:image/png;base64,' + b64, { targetLang: '简体中文', model: 'translate' });
    console.log('  [' + name + '] ' + (Date.now()-t0) + 'ms  skipped=' + r.skipped);
    console.log('      期望: ' + expect);
    console.log('      译文: ' + JSON.stringify((r.text || '(空)').slice(0, 55)));
    if (r.raw) console.log('      丢弃: ' + JSON.stringify(r.raw.slice(0, 65)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
