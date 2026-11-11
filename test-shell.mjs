import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as edgeExt from './lib/edge-ext.mjs';

const loaded = loadKoffi();
const api = bind(loaded.koffi);
console.log('=== ShellExecute 测试 ===');
console.log('ShellExecuteW 可用:', typeof api.ShellExecuteW);

const ok = edgeExt.openExternal(api, 'edge://extensions/');
console.log('打开 edge://extensions/ :', ok);

// 再测一个普通 URL（应能打开浏览器）
const ok2 = edgeExt.openExternal(api, 'https://example.com');
console.log('打开 https://example.com :', ok2);

console.log('');
console.log(ok && ok2 ? 'SHELL OK' : 'SHELL 有问题');
process.exit(ok ? 0 : 1);