import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as clip from './lib/clipboard.mjs';
import { grabSelection, attachToForeground, detach, keyCombo, parseHotkey, VKx } from './lib/input.mjs';
import { translate } from './lib/translate.mjs';
import { spawn } from 'node:child_process';

const loaded = loadKoffi();
const api = bind(loaded.koffi);
const u32 = loaded.koffi.load('user32.dll');

const SetForegroundWindow = u32.func('bool SetForegroundWindow(void *h)');
const GetForegroundWindow = u32.func('void *GetForegroundWindow()');
const ShowWindow = u32.func('bool ShowWindow(void *h, int n)');
const BringWindowToTop = u32.func('bool BringWindowToTop(void *h)');
const IsWindowVisible = u32.func('bool IsWindowVisible(void *h)');
const GetWindowTextW = u32.func('int GetWindowTextW(void *h, uint16 *s, int n)');
const EnumWindows = u32.func('bool EnumWindows(void *cb, void *p)');

function findNotepad() {
  let found = null;
  const cb = loaded.koffi.register((h, p) => {
    if (!IsWindowVisible(h)) return true;
    const buf = new Uint16Array(512);
    GetWindowTextW(h, buf, 256);
    let s = '';
    for (let i = 0; i < 256; i++) { if (buf[i] === 0) break; s += String.fromCharCode(buf[i]); }
    if (s.indexOf('记事本') >= 0 || s.indexOf('Notepad') >= 0) { found = h; return false; }
    return true;
  }, loaded.koffi.pointer(loaded.koffi.proto('bool __stdcall E(void *h, void *p)')));
  EnumWindows(cb, null);
  loaded.koffi.unregister(cb);
  return found;
}

let bad = 0;
function t(n, ok, d) { console.log((ok?'OK   ':'FAIL ')+n+(d!=null?'  ['+d+']':'')); if(!ok)bad++; }

console.log('=== Ctrl+Shift+F 真机测试 ===');
console.log('  解析:', JSON.stringify(parseHotkey('Ctrl+Shift+F')));

spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 3500));
let h = null;
for (let i = 0; i < 30 && !h; i++) { await new Promise(r => setTimeout(r, 150)); h = findNotepad(); }
if (!h) { console.log('没找到记事本'); process.exit(1); }

ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
await new Promise(r => setTimeout(r, 900));
// 再试一次（Windows 前台锁定可能拒绝第一次）
if (GetForegroundWindow() !== h) {
  ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
  await new Promise(r => setTimeout(r, 900));
}
t('前台', GetForegroundWindow() === h);

// 打字
const SRC = '明天上午十点开会，记得带上笔记本。';
await clip.writeText(api, SRC);
await new Promise(r => setTimeout(r, 100));
const tid0 = attachToForeground(api);
await keyCombo(api, [VKx.CONTROL, VKx.V]);
detach(api, tid0);
await new Promise(r => setTimeout(r, 600));

// 全选 + 抓取
const tid1 = attachToForeground(api);
await keyCombo(api, [VKx.CONTROL, VKx.A]);
detach(api, tid1);
await new Promise(r => setTimeout(r, 350));

const bk = await clip.backup(api);
const g = await grabSelection(api, clip, { timeoutMs: 900 });
t('抓取成功', g.ok, g.ok ? (g.text.slice(0,30) + ' (' + g.ms + 'ms)') : g.error);

if (g.ok) {
  const tr = await translate({ baseUrl: 'http://127.0.0.1:47300', model: 'translate', text: g.text, langId: 'ja' });
  t('翻译成功', tr.ok, tr.ok ? (tr.ms + 'ms: ' + tr.text.slice(0,40)) : tr.error);
  if (tr.ok) {
    await clip.writeText(api, tr.text);
    await new Promise(r => setTimeout(r, 80));
    const tid2 = attachToForeground(api);
    await keyCombo(api, [VKx.CONTROL, VKx.A]);
    await keyCombo(api, [VKx.CONTROL, VKx.V]);
    detach(api, tid2);
    await new Promise(r => setTimeout(r, 600));
    const tid3 = attachToForeground(api);
    await keyCombo(api, [VKx.CONTROL, VKx.A]);
    await keyCombo(api, [VKx.CONTROL, VKx.C]);
    detach(api, tid3);
    await new Promise(r => setTimeout(r, 350));
    const back = await clip.readText(api);
    t('粘贴生效', back && back.indexOf('明日') >= 0, back && back.slice(0,40));
  }
}
if (bk) await clip.restore(api, bk);

try { spawn('taskkill', ['/F','/IM','notepad.exe'], { stdio: 'ignore' }); } catch {}
console.log('');
console.log(bad === 0 ? 'LIVE OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);