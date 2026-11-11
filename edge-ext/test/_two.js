const fs = require('fs');
const path = require('path');
const DSH = require(path.join("C:\\Users\\123\\Downloads\\edge本地扩展\\dsh-translate", 'src', 'dsh.js'));
const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base, twoStage: true });

const CASES = [
  'v1',     // どうですか？私の料理は／採れたてのものを用意しました
  'v2',     // 山海経 玄武商会
  'v3',     // あぁ、そうさせ／もうおうかな／そうだ！
  'col1',   // 装れててのもの
];

(async () => {
  console.log('=== 两阶段流水线（vision OCR + translate 翻译）===');
  for (const id of CASES) {
    const fp = 'C:\\Users\\123\\Downloads\\_' + id + '.png';
    if (!fs.existsSync(fp)) { continue; }
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(fp).toString('base64');
    try {
      const t0 = Date.now();
      const r = await DSH.visionTwoStage(base, cfg, dataUrl, { targetLang: '简体中文' });
      console.log('[' + id.padEnd(5) + '] ' + String(Date.now()-t0).padStart(5) + 'ms | OCR ' + r.ocrMs + 'ms + 翻译 ' + r.transMs + 'ms | skipped=' + (r.skipped?'Y':'N'));
      console.log('    原文: ' + JSON.stringify((r.src || '(无)').slice(0, 50)));
      console.log('    译文: ' + JSON.stringify((r.text || '(空)').slice(0, 50)));
    } catch (e) {
      console.log('[' + id + '] ERR ' + e.message.slice(0, 70));
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });