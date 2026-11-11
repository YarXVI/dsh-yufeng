import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as clip from './lib/clipboard.mjs';
import { grabSelection, attachToForeground, detach, keyCombo, VKx } from './lib/input.mjs';
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

console.log('=== 稳定性：连跑 10 次 ===');
spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2200));
let h = null;
for (let i = 0; i < 30 && !h; i++) { await new Promise(r => setTimeout(r, 150)); h = findNotepad(); }
if (!h) { console.log('没找到记事本'); process.exit(1); }

ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
await new Promise(r => setTimeout(r, 700));

const SRC = '明天上午十点开会，记得带上笔记本。';
let okN = 0, sum = 0;
for (let r = 1; r <= 10; r++) {
  // 重置内容
  await clip.writeText(api, SRC);
  await new Promise(rr => setTimeout(rr, 100));
  const tid0 = attachToForeground(api);
  await keyCombo(api, [VKx.CONTROL, VKx.A]);
  await keyCombo(api, [VKx.CONTROL, VKx.V]);
  detach(api, tid0);
  await new Promise(rr => setTimeout(rr, 500));

  // ★ grab 前必须重新全选 —— 上一次粘贴把选区弄没了
  const tidSel = attachToForeground(api);
  await keyCombo(api, [VKx.CONTROL, VKx.A]);
  detach(api, tidSel);
  await new Promise(rr => setTimeout(rr, 350));

  const bk = await clip.backup(api);
  const g = await grabSelection(api, clip, { timeoutMs: 900 });
  if (!g.ok) { console.log('  第 ' + r + ' 次抓取失败: ' + g.error); continue; }
  const tr = await translate({ baseUrl: 'http://127.0.0.1:47300', model: 'translate', text: g.text, langId: 'ja' });
  if (!tr.ok) { console.log('  第 ' + r + ' 次翻译失败: ' + tr.error); continue; }

  await clip.writeText(api, tr.text);
  await new Promise(rr => setTimeout(rr, 80));
  const tid1 = attachToForeground(api);
  await keyCombo(api, [VKx.CONTROL, VKx.A]);
  await keyCombo(api, [VKx.CONTROL, VKx.V]);
  detach(api, tid1);
  await new Promise(rr => setTimeout(rr, 600));

  // 验证
  const tid2 = attachToForeground(api);
  await keyCombo(api, [VKx.CONTROL, VKx.A]);
  await keyCombo(api, [VKx.CONTROL, VKx.C]);
  detach(api, tid2);
  await new Promise(rr => setTimeout(rr, 350));
  const back = await clip.readText(api);
  const good = back && back.indexOf('明日') >= 0;
  if (good) { okN++; sum += g.ms + tr.ms; }
  console.log('  第 ' + r + ' 次: ' + (good ? 'OK' : 'FAIL') + ' 抓' + g.ms + 'ms 翻' + tr.ms + 'ms 轮' + g.round);
  if (bk) await clip.restore(api, bk);
}

try { spawn('taskkill', ['/F','/IM','notepad.exe'], { stdio: 'ignore' }); } catch {}
console.log('');
console.log(okN + '/10 成功' + (okN ? ('，平均 ' + Math.round(sum / okN) + 'ms') : ''));
process.exit(okN === 10 ? 0 : 1);