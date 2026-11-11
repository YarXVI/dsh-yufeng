import { loadKoffi } from './lib/koffi-loader.mjs';
import { bind } from './lib/win32.mjs';
import * as edgeExt from './lib/edge-ext.mjs';

const loaded = loadKoffi();
const api = bind(loaded.koffi);

console.log('=== 查找 Edge 可执行文件 ===');
const exe = edgeExt.findEdgePath(api);
console.log('  Edge 路径:', exe);

console.log('');
console.log('=== 打开 edge://extensions/ ===');
const r1 = edgeExt.openExternal(api, 'edge://extensions/');
console.log('  ok=', r1.ok, 'via=', r1.via, 'detail=', r1.detail);

await new Promise(r => setTimeout(r, 1500));
console.log('');
console.log('=== 打开普通 URL ===');
const r2 = edgeExt.openExternal(api, 'https://example.com');
console.log('  ok=', r2.ok, 'via=', r2.via);

console.log('');
console.log(r1.ok ? 'PROTOCOL OK' : 'PROTOCOL FAIL');
process.exit(r1.ok ? 0 : 1);