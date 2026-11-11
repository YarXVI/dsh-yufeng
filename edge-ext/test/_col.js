
const fs = require('fs');
const DSH = require(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate\\src\\dsh.js`);
const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

(async () => {
  console.log('=== 单列竖排单独翻译 ===');
  for (const id of ['col1', 'col2', 'col3']) {
    const fp = String.raw`C:\\Users\\123\\Downloads\\_` + id + '.png';
    if (!fs.existsSync(fp)) { console.log('缺 ' + id); continue; }
    const b64 = fs.readFileSync(fp).toString('base64');
    const t0 = Date.now();
    const r = await DSH.visionTranslateBlock(base, cfg, 'data:image/png;base64,' + b64, { targetLang: '简体中文', model: 'translate', maxTokens: 200 });
    console.log('[' + id + '] ' + (Date.now()-t0) + 'ms skipped=' + (r.skipped?'Y':'N') + ' → ' + JSON.stringify((r.text||'(空)').slice(0,50)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
