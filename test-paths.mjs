import * as P from './lib/paths.mjs';
import { loadConfig, currentDataRoot, saveConfig, publicConfig } from './lib/config.mjs';
import { migrateIfNeeded } from './lib/migrate.mjs';
import { installDir } from './lib/edge-ext.mjs';
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

let bad = 0;
function t(n, ok, d) { console.log((ok?'OK   ':'FAIL ')+n+(d!=null?'  ['+d+']':'')); if(!ok)bad++; }

console.log('=== 1. DSH 安装目录探测 ===');
const inst = P.dshInstallDir();
// 纯 Node 里 execPath 是 node.exe，找不到 DSH 安装目录是**正确行为**；
// 在真实 DSH（Electron）里 process.resourcesPath 有值，才能解析到。
t('纯 Node 下正确返回 null（Electron 里才有值）', inst === null, String(inst));

console.log('');
console.log('=== 2. 数据根解析 ===');
const root = P.resolveDataRoot('');
t('解析出数据根', !!root, root);
t('路径含 DSHQK', root.indexOf('DSHQK') >= 0, root);
t('路径含 YuFeng', root.indexOf('YuFeng') >= 0, root);

// 验证「和 DSH 同级」
if (inst) {
  const expect = P.dshInstallDir().replace(/\\[^\\]+$/, '\\DSHQK\\YuFeng');
  t('与 DSH 同级', root === expect, '期望 ' + expect + ' 实际 ' + root);
}

console.log('');
console.log('=== 3. 目录自动创建 ===');
const ens = P.ensureDataRoot('');
t('创建成功', ens.ok, ens.root + (ens.created ? '（新建）' : '（已存在）'));
t('目录确实存在', (await import('node:fs')).existsSync(ens.root), ens.root);

console.log('');
console.log('=== 4. 配置读写（新位置）===');
const r1 = currentDataRoot();
t('currentDataRoot 正确', r1 === ens.root, r1);
const c1 = saveConfig({ hotkey: 'Ctrl+Shift+F3', lang: 'ja' });
t('写入成功', c1.hotkey === 'Ctrl+Shift+F3', c1.hotkey);
const c2 = loadConfig();
t('读回一致', c2.hotkey === 'Ctrl+Shift+F3' && c2.lang === 'ja', c2.hotkey + '/' + c2.lang);
t('publicConfig 带 dataRoot', publicConfig(c2).dataRoot === r1, publicConfig(c2).dataRoot);

console.log('');
console.log('=== 5. Edge 扩展目录（新位置）===');
const ed = installDir();
t('扩展目录在数据根下', ed.indexOf('YuFeng') >= 0, ed);

console.log('');
console.log('=== 6. 遗留数据迁移 ===');
const mg = migrateIfNeeded(ens.root, (m) => console.log('   [log] ' + m));
t('迁移函数可调用', typeof mg.migrated !== 'undefined', 'migrated=' + mg.migrated.length + ' skipped=' + mg.skipped.length);
mg.migrated.forEach((m) => console.log('   迁移: ' + m));
mg.skipped.forEach((m) => console.log('   跳过: ' + m));

// 恢复默认配置
saveConfig({ hotkey: 'Ctrl+Shift+T', lang: 'en', mode: 'replace' });

console.log('');
console.log(bad === 0 ? 'PATHS OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);