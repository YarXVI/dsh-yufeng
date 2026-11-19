#!/usr/bin/env node
/**
 * test-env.mjs — 预提交本机信息（env-probe / env-tool）冒烟测试
 *
 * 只验证「探测能跑通、渲染出关键行、指纹与时间戳可用」，
 * 不校验具体数值（每台机器不同）。
 *
 * 跑法：node test-env.mjs
 */
import { createEnvProbe } from './lib/env-probe.mjs';

let pass = 0, fail = 0;
const ok = (m, extra = '') => { pass++; console.log('OK   ' + m + (extra ? '  [' + extra + ']' : '')); };
const bad = (m, extra = '') => { fail++; console.log('FAIL ' + m + (extra ? '  [' + extra + ']' : '')); };

// loadKoffi 传空函数：没有 koffi 时注册表那一路会降级，其余探测不受影响
const probe = createEnvProbe({ loadKoffi: () => null, log: () => {} });

console.log('=== 1. 完整探测 ===');
const t0 = Date.now();
let snap;
try {
  snap = await probe.ensure(true);
  ok('ensure() 返回', (Date.now() - t0) + 'ms');
} catch (e) {
  bad('ensure() 抛错', e.message);
  process.exit(1);
}
snap ? ok('快照非空', Object.keys(snap).length + ' fields') : bad('快照为空');

console.log('=== 2. 指纹 ===');
const fp = probe.fingerprint();
typeof fp === 'string' && fp.length >= 8 ? ok('fingerprint 非空', fp.slice(0, 12)) : bad('fingerprint 异常', String(fp));

console.log('=== 3. 渲染（brief）===');
const text = probe.render(snap);
typeof text === 'string' && text.length > 100 ? ok('render() 有内容', text.length + ' chars') : bad('render() 过短', text.length + ' chars');

const lines = text.split('\n');
const has = (re) => lines.some((l) => re.test(l));
has(/^os:/m) ? ok('含 os 行') : bad('缺 os 行');
has(/^shell:/m) ? ok('含 shell 行') : bad('缺 shell 行');
has(/^have:/m) ? ok('含 have（工具链）行') : bad('缺 have 行');
has(/^hw:/m) ? ok('含 hw（硬件）行') : bad('缺 hw 行');
has(/^disk/m) ? ok('含 disk（磁盘）行') : bad('缺 disk 行');
has(/^sampled:/m) ? ok('含 sampled 时间戳') : bad('缺 sampled 时间戳');

console.log('=== 4. 渲染（full）===');
const full = probe.render(snap, 'full');
full.length > text.length ? ok('full 比 brief 长', full.length + ' vs ' + text.length) : bad('full 未展开');

console.log('=== 5. 缓存 ===');
const t1 = Date.now();
await probe.ensure();
const dt = Date.now() - t1;
dt < 500 ? ok('二次 ensure 命中缓存', dt + 'ms') : bad('二次 ensure 未命中缓存', dt + 'ms');
probe.cachedAt ? ok('cachedAt 可用', new Date(probe.cachedAt).toISOString()) : bad('cachedAt 缺失');

console.log('=== 6. 输出采样 ===');
console.log(text.split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
