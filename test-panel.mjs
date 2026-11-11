import http from 'node:http';
import { loadConfig, saveConfig, publicConfig } from './lib/config.mjs';
import { createWinTranslate } from './lib/service.mjs';
import { createPanelApi, PANEL_PREFIX } from './lib/panel-api.mjs';
// ⚠ 测试会写配置 —— 先备份真实的，跑完恢复
const __cfgFile = 'D:/DSHQK/YuFeng/config.json';
const __fs = await import('node:fs');
let __origCfg = null;
try { if (__fs.existsSync(__cfgFile)) __origCfg = __fs.readFileSync(__cfgFile, 'utf8'); } catch {}
process.on('exit', () => {
  try {
    if (__origCfg != null) __fs.writeFileSync(__cfgFile, __origCfg, 'utf8');
  } catch {}
});

let cfg = loadConfig();
const logs = [];
const log = m => { logs.push(m); console.log('[log] ' + m); };

const svc = createWinTranslate({ log, getCfg: () => cfg, onResult: r => log('result ' + JSON.stringify(r).slice(0,120)) });
const panel = createPanelApi({ log, getCfg: () => cfg, setCfg: p => { cfg = saveConfig(p); return cfg; }, publicConfig, svc });

const PORT = 49000;
const server = http.createServer((req, res) => panel.handler(req, res));
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
console.log('测试服务已起: http://127.0.0.1:' + PORT + PANEL_PREFIX);

let bad = 0;
function t(name, ok, detail) {
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail != null ? '  [' + detail + ']' : ''));
  if (!ok) bad++;
}

const base = 'http://127.0.0.1:' + PORT + PANEL_PREFIX;

// 1. GET state
const st = await fetch(base + '/state').then(r => r.json());
t('GET /state', st.ok === true, 'ffi=' + (st.service && st.service.ffi) + ' running=' + (st.service && st.service.running));
t('返回语言表', Array.isArray(st.langs) && st.langs.length === 10);
t('返回配置', !!st.config && typeof st.config.hotkey === 'string', st.config && st.config.hotkey);

// 2. GET 面板 HTML
const html = await fetch(base).then(r => r.text());
t('GET 面板页', html.length > 500 && html.indexOf('Windows 划词转译') >= 0, html.length + ' 字节');

// 3. POST config
const c1 = await fetch(base + '/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hotkey: 'Ctrl+Shift+F2', lang: 'ja', mode: 'replace' }) }).then(r=>r.json());
t('POST /config', c1.ok === true, 'hotkey=' + (c1.config && c1.config.hotkey) + ' lang=' + (c1.config && c1.config.lang));
t('配置已持久化', loadConfig().hotkey === 'Ctrl+Shift+F2', loadConfig().hotkey);

// 4. POST toggle
const tg = await fetch(base + '/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: true }) }).then(r=>r.json());
t('POST /toggle 启动', tg.ok === true && tg.running === true, JSON.stringify(tg));

// 5. POST run（无选中，应失败但接口正常）
const run = await fetch(base + '/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' }).then(r=>r.json());
t('POST /run 返回结构正确', typeof run.ok === 'boolean', JSON.stringify(run).slice(0, 120));

// 6. POST run（带文本，应成功）
const run2 = await fetch(base + '/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: '这个功能很好用。', lang: 'ja' }) }).then(r=>r.json());
t('POST /run 带文本成功', run2.ok === true, run2.ok ? (run2.ms + 'ms: ' + run2.text) : run2.error);

// 7. 404
const nf = await fetch(base + '/nonexistent').then(r => r.json());
t('未知路由 404', nf.ok === false);

svc.stop();
server.close();

// 恢复原配置
saveConfig({ hotkey: 'Ctrl+Shift+T', lang: 'en', mode: 'replace' });

console.log('');
console.log(bad === 0 ? 'PANEL OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);