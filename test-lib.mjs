import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as clip from './lib/clipboard.mjs';
import { grabSelection, parseHotkey, createHotkeyPoller, VKx } from './lib/input.mjs';
import { translate, buildPrompt, REVERSE_LANGS, findLang } from './lib/translate.mjs';

let bad = 0;
function t(name, ok, detail) {
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail != null ? '  [' + detail + ']' : ''));
  if (!ok) bad++;
}

console.log('=== 1. koffi 加载 ===');
const loaded = loadKoffi();
t('koffi 可用', !!loaded, loaded ? loaded.from : 'not found');

console.log('');
console.log('=== 2. Win32 绑定 ===');
let api = null;
try { api = bind(loaded.koffi); } catch (e) { console.log('bind 异常:', e.message); }
t('绑定成功', !!api);
t('INPUT_SIZE = 40', api && api.INPUT_SIZE === 40, api && api.INPUT_SIZE);

console.log('');
console.log('=== 3. 剪贴板读写 ===');
t('写中文', await clip.writeText(api, 'toolbox 测试 中文 123'));
const read1 = await clip.readText(api);
t('读回来一致', read1 === 'toolbox 测试 中文 123', read1);

console.log('');
console.log('=== 4. 剪贴板备份恢复 ===');
await clip.writeText(api, 'ORIGINAL-SENTINEL');
const bk = await clip.backup(api);
t('备份抓到文本', !!bk && bk.hadText === true, bk && ('text=' + (bk.text || '').slice(0,20)));
await clip.writeText(api, 'TEMPORARY-XYZ');
await clip.restore(api, bk);
const read2 = await clip.readText(api);
t('恢复成原文', read2 === 'ORIGINAL-SENTINEL', read2);

console.log('');
console.log('=== 5. 快捷键解析 ===');
const k1 = parseHotkey('Ctrl+Shift+T');
t('Ctrl+Shift+T → 3 键', k1.length === 3, JSON.stringify(k1));
t('含 CONTROL/SHIFT/T', k1[0] === VKx.CONTROL && k1[1] === VKx.SHIFT && k1[2] === VKx.T);
const k2 = parseHotkey('Alt+F1');
t('Alt+F1 解析', k2.length >= 2, JSON.stringify(k2));
const k3 = parseHotkey('乱写');
t('非法串回退默认', k3.length === 3, JSON.stringify(k3));

console.log('');
console.log('=== 6. 热键轮询器 ===');
const poller = createHotkeyPoller(api, { keys: k1, intervalMs: 30 });
let fired = 0;
poller.start(() => { fired++; });
t('启动成功', poller.running);
await new Promise(r => setTimeout(r, 300));
t('无人按键时不触发', fired === 0, 'fired=' + fired);
poller.stop();
t('停止成功', !poller.running);

console.log('');
console.log('=== 7. 语言表与提示词 ===');
t('10 种语言', REVERSE_LANGS.length === 10);
t('findLang(ja)', findLang('ja').native === '日本語', findLang('ja').native);
t('findLang 未知回退英语', findLang('xx').id === 'en');
const p = buildPrompt('明天开会', 'ja');
t('提示词含日本語', p.includes('日本語'));
t('提示词禁止注音', p.includes('不要加注音'));
t('提示词保留占位符', p.includes('{占位符}'));

console.log('');
console.log('=== 8. 翻译（走 HTTP）===');
for (const id of ['en', 'ja', 'ko', 'pt']) {
  const r = await translate({ baseUrl: 'http://127.0.0.1:47300', model: 'translate', text: '这个功能很好用。', langId: id });
  t('→ ' + findLang(id).zh, r.ok, r.ok ? (r.ms + 'ms: ' + r.text) : r.error);
}

console.log('');
console.log('=== 9. 抓取自测（前台是终端，无选中 → 应失败）===');
const g = await grabSelection(api, clip, { timeoutMs: 600 });
t('无选中时正确失败', !g.ok, g.error + ' (' + g.ms + 'ms)');

console.log('');
console.log(bad === 0 ? 'ALL OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);