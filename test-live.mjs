import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as clip from './lib/clipboard.mjs';
import { grabSelection, attachToForeground, detach, keyCombo, VKx } from './lib/input.mjs';
import { translate } from './lib/translate.mjs';
import { spawn } from 'node:child_process';

const loaded = loadKoffi();
const api = bind(loaded.koffi);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const u32 = loaded.koffi.load('user32.dll');
const SetForegroundWindow = u32.func('bool SetForegroundWindow(void *h)');
const GetForegroundWindow = u32.func('void *GetForegroundWindow()');
const ShowWindow = u32.func('bool ShowWindow(void *h, int n)');
const BringWindowToTop = u32.func('bool BringWindowToTop(void *h)');
const IsWindowVisible = u32.func('bool IsWindowVisible(void *h)');
const GetWindowTextW = u32.func('int GetWindowTextW(void *h, uint16 *s, int n)');
const EnumWindows = u32.func('bool EnumWindows(void *cb, void *p)');

let bad = 0;
function t(name, ok, detail) {
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail != null ? '  [' + detail + ']' : ''));
  if (!ok) bad++;
}

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

console.log('=== 真机测试：记事本 ===');
const np = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2000));

let h = null;
for (let i = 0; i < 30 && !h; i++) { await new Promise(r => setTimeout(r, 150)); h = findNotepad(); }
console.log('  记事本句柄:', h);
if (!h) { console.log('没找到'); process.exit(1); }

ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
await new Promise(r => setTimeout(r, 700));
t('记事本已前台', GetForegroundWindow() === h);

// 打字
const text = 'Meeting at 10am tomorrow, bring a laptop.';
clip.writeText(api, text);
await new Promise(r => setTimeout(r, 100));
const tid = attachToForeground(api);
keyCombo(api, [VKx.CONTROL, VKx.V]);
detach(api, tid);
await new Promise(r => setTimeout(r, 700));

// 全选
keyCombo(api, [VKx.CONTROL, VKx.A]);
await new Promise(r => setTimeout(r, 400));

// 抓取
const bk = clip.backup(api);
const g = grabSelection(api, clip, { timeoutMs: 900 });
t('抓到了', g.ok, g.ok ? (g.text + ' (' + g.ms + 'ms 轮' + g.round + ')') : g.error);

if (g.ok) {
  // 翻译
  const tr = await translate({ baseUrl: 'http://127.0.0.1:47300', model: 'translate', text: g.text, langId: 'ja' });
  t('翻译成日语', tr.ok, tr.ok ? (tr.ms + 'ms: ' + tr.text) : tr.error);

  if (tr.ok) {
    // 写回 + 粘贴
    clip.writeText(api, tr.text);
    await new Promise(r => setTimeout(r, 80));
    const tid2 = attachToForeground(api);
    keyCombo(api, [VKx.CONTROL, VKx.V]);
    detach(api, tid2);
    await new Promise(r => setTimeout(r, 700));

    // 验证：全选 + 复制 + 读回
    keyCombo(api, [VKx.CONTROL, VKx.A]);
    await new Promise(r => setTimeout(r, 250));
    keyCombo(api, [VKx.CONTROL, VKx.C]);
    await new Promise(r => setTimeout(r, 400));
    const back = clip.readText(api);
    t('粘贴生效', back && back.indexOf('明日') >= 0, back);
  }
}

// 恢复剪贴板
if (bk) clip.restore(api, bk);
t('剪贴板已恢复', clip.readText(api) === (bk && bk.text), clip.readText(api) && clip.readText(api).slice(0, 30));

try { spawn('taskkill', ['/F','/IM','notepad.exe'], { stdio: 'ignore' }); } catch {}
console.log('');
console.log(bad === 0 ? 'LIVE OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);