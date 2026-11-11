const fs = require('fs');
const DSH = require('C:\\\\Users\\\\123\\\\Downloads\\\\edge本地扩展\\\\dsh-translate\\\\src\\\\dsh.js');
const BASE = 'http://192.168.1.3:47300';
const IMG = 'C:\\\\Users\\\\123\\\\OneDrive\\\\图片\\\\test.png';

async function ask(model, prompt, dataUrl, maxTok) {
  const body = { model, messages: [{ role: 'user', content: [
    { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }
  ]}], temperature: 0, max_tokens: maxTok, repeat_penalty: 1.05,
    chat_template_kwargs: { enable_thinking: false } };
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000) });
  const j = await r.json();
  return { c: (j.choices?.[0]?.message?.content) || '', ms: Date.now() - t0, usage: j.usage };
}

// 关键：让模型按**阅读顺序**输出，每段一行，不要 JSON（省 token 且不会语法坏）
const PROMPT = `按阅读顺序（从上到下、从右到左）逐段输出图中所有文字。
每段占一行，不要编号，不要翻译，不要描述画面。只输出文字本身。`;

(async () => {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');
  console.log('=== 整页 OCR（按阅读顺序，无 JSON）===');
  for (let i = 0; i < 2; i++) {
    const r = await ask('vision', PROMPT, dataUrl, 600);
    console.log('--- 第 ' + (i+1) + ' 次: ' + r.ms + 'ms / ' + (r.usage?.completion_tokens || '?') + ' tok ---');
    console.log(r.c);
    console.log('');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });