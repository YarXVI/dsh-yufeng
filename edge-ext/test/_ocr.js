const fs = require('fs');
const path = require('path');
const DSH = require(path.join(String.raw`C:\Users\123\Downloads\edge本地扩展\dsh-translate`, 'src', 'dsh.js'));
const base = 'http://192.168.1.3:47300';
const cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: base });

async function chat(model, prompt, dataUrl, maxTok) {
  const body = {
    model: model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUrl } }
    ]}],
    temperature: 0,
    max_tokens: maxTok || 200,
    repeat_penalty: 1.22,
    chat_template_kwargs: { enable_thinking: false }
  };
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

const OCR_PROMPT = '读取图片中的所有文字，逐字照抄原文，不要翻译，不要解释，不要描述画面。只输出你看到的字符。';

(async () => {
  const cases = [['v1', '整块三列竖排'], ['col1', '单列'], ['v3', '短竖排']];
  for (const [id, name] of cases) {
    const fp = 'C:\\Users\\123\\Downloads\\_' + id + '.png';
    if (!fs.existsSync(fp)) { console.log('缺 ' + id); continue; }
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(fp).toString('base64');
    console.log('=== ' + name + ' ===');
    for (const model of ['translate', 'vision', 'chat']) {
      try {
        const t0 = Date.now();
        const out = await chat(model, OCR_PROMPT, dataUrl, 300);
        console.log('  [' + model.padEnd(10) + '] ' + (Date.now()-t0) + 'ms  ' + JSON.stringify(out.slice(0, 90)));
      } catch (e) {
        console.log('  [' + model + '] ERR ' + e.message.slice(0, 60));
      }
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });