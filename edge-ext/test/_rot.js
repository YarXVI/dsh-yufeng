
const fs = require('fs');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);
const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

const CASES = [
  ['v1',     'どうですか？私の料理は／採れたてのものを用意しました'],
  ['v1_rot', '同上，旋转 90°'],
  ['v2',     '山海経 玄武商会'],
  ['v2_rot', '同上，旋转 90°'],
  ['v3',     'あぁ、そうさせ／もうおうかな／そうだ！'],
  ['v3_rot', '同上，旋转 90°'],
];

(async () => {
  for (const [id, expect] of CASES) {
    const fp = String.raw`C:\\Users\\123\\Downloads\\_` + id + '.png';
    if (!fs.existsSync(fp)) { console.log('缺 ' + id); continue; }
    const b64 = fs.readFileSync(fp).toString('base64');
    const t0 = Date.now();
    const r = await DSH.visionTranslateBlock(base, cfg, 'data:image/png;base64,' + b64, { targetLang: '简体中文', model: 'translate', maxTokens: 300 });
    console.log('[' + id.padEnd(7) + '] ' + String(Date.now()-t0).padStart(4) + 'ms  skipped=' + (r.skipped?'Y':'N'));
    console.log('    期望: ' + expect);
    console.log('    实际: ' + JSON.stringify((r.text || '(空)').slice(0, 60)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
