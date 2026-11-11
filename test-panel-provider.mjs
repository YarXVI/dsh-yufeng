import http from 'node:http';
import { loadConfig, saveConfig, publicConfig, activeProvider } from './lib/config.mjs';
import { createWinTranslate } from './lib/service.mjs';
import { createPanelApi, PANEL_PREFIX } from './lib/panel-api.mjs';

// 备份真实配置
const fs = await import('node:fs');
const CF = 'D:/DSHQK/YuFeng/config.json';
const orig = fs.existsSync(CF) ? fs.readFileSync(CF, 'utf8') : null;
process.on('exit', () => { try { if (orig != null) fs.writeFileSync(CF, orig, 'utf8'); } catch {} });

let cfg = loadConfig();
const svc = createWinTranslate({ log: () => {}, getCfg: () => cfg, onResult: () => {} });
const panel = createPanelApi({ log: () => {}, getCfg: () => cfg, setCfg: p => { cfg = saveConfig(p); return cfg; }, publicConfig, svc, getWin32: () => svc.getApi() });

const PORT = 49100;
const server = http.createServer((req, res) => panel.handler(req, res));
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + PORT + PANEL_PREFIX;

let bad = 0;
function t(n, ok, d) { console.log((ok?'OK   ':'FAIL ')+n+(d!=null?'  ['+d+']':'')); if(!ok)bad++; }

console.log('=== 1. GET state 带 providers ===');
const st = await fetch(BASE + '/state').then(r => r.json());
t('providers 数组', Array.isArray(st.config.providers) && st.config.providers.length > 0, st.config.providers.length + ' 个');
t('activeProvider', st.config.activeProvider === 'suxin', st.config.activeProvider);
t('provider 不含明文 key', st.config.providers.every(p => !('apiKey' in p) && 'hasKey' in p));

console.log('');
console.log('=== 2. POST provider/test（燧心）===');
const test1 = await fetch(BASE + '/provider/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: 'suxin' }) }).then(r=>r.json());
t('测试燧心连通', test1.ok === true, 'via=' + test1.via + ' ms=' + test1.ms + ' models=' + test1.models);

console.log('');
console.log('=== 3. POST config 加云端 provider ===');
const addRes = await fetch(BASE + '/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
  providers: [
    { id:'suxin', kind:'local', name:'燧心 · 本机 NPU', baseUrl:'http://127.0.0.1:47300', model:'translate' },
    { id:'cloud1', kind:'cloud', name:'DeepSeek', baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', hasKey:false },
  ],
  providerKeys: { cloud1: 'sk-test-abc' },
}) }).then(r=>r.json());
t('加了云端', addRes.ok === true && addRes.config.providers.length === 2, addRes.config.providers.map(p=>p.id).join(','));
t('cloud1 hasKey=true', addRes.config.providers.find(p=>p.id==='cloud1').hasKey === true);

console.log('');
console.log('=== 4. 落盘的 key 对不对 ===');
const diskCfg = loadConfig();
t('cloud1 的 key 已存', diskCfg.providers.find(p=>p.id==='cloud1').apiKey === 'sk-test-abc', diskCfg.providers.find(p=>p.id==='cloud1').apiKey);

console.log('');
console.log('=== 5. POST provider/activate 切到云端 ===');
const act = await fetch(BASE + '/provider/activate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: 'cloud1' }) }).then(r=>r.json());
t('切到 cloud1', act.ok === true && act.activeProvider === 'cloud1', act.activeProvider);

console.log('');
console.log('=== 6. 再保存 providers（不带 key）→ key 要保留 ===');
const save2 = await fetch(BASE + '/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
  providers: [
    { id:'suxin', kind:'local', name:'燧心 · 本机 NPU', baseUrl:'http://127.0.0.1:47300', model:'translate' },
    { id:'cloud1', kind:'cloud', name:'DeepSeek', baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', hasKey:true },
  ],
  // 注意：没传 providerKeys
}) }).then(r=>r.json());
const kept = loadConfig().providers.find(p=>p.id==='cloud1');
t('★ 不传 key 时原 key 保留', kept.apiKey === 'sk-test-abc', kept.apiKey || '(空)');

console.log('');
console.log('=== 7. 切回燧心 + 真翻译 ===');
await fetch(BASE + '/provider/activate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: 'suxin' }) });
const run = await fetch(BASE + '/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: '你好世界', lang: 'ja' }) }).then(r=>r.json());
if (run.ok) t('切回燧心后能翻译', true, run.ms + 'ms: ' + run.text);
else if (/GPU|422|CUDA/.test(String(run.error))) console.log('SKIP 切回燧心翻译（模型后端不可用）');
else t('切回燧心后能翻译', false, run.error);

svc.stop();
server.close();

console.log('');
console.log(bad === 0 ? 'PANEL PROVIDER OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);