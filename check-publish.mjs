#!/usr/bin/env node
/**
 * 发布前自检。
 *
 * 检查项：
 *   1. package.json 的 name/version 正确
 *   2. _index.json 里 source.type = git，commit 是**真实**的 40 位 SHA（不是占位 0）
 *   3. commit 在当前 git 仓库里真实存在
 *   4. 索引通过 DSH 官方验证器
 *   5. 安装 spec 能生成
 *
 * 用法：
 *   node check-publish.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
function t(name, ok, detail) {
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail != null ? '  [' + detail + ']' : ''));
  if (!ok) bad++;
}

console.log('=== 1. package.json ===');
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
t('name = dsh-yufeng', pkg.name === 'dsh-yufeng', pkg.name);
t('version 是精确 SemVer', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
t('engines.dsh 存在', !!pkg.engines?.dsh, pkg.engines?.dsh);
t('exports[./client] 存在', !!pkg.exports?.['./client'], pkg.exports?.['./client']);

console.log('');
console.log('=== 2. _index.json ===');
const idx = JSON.parse(fs.readFileSync(path.join(HERE, '_index.json'), 'utf8'));
const v = idx.plugins?.[0]?.versions?.[0];
t('format = 1', idx.format === 1, idx.format);
t('source.type = git', v?.source?.type === 'git', v?.source?.type);
t('url 是 https', String(v?.source?.url || '').startsWith('https://'), v?.source?.url);

const commit = String(v?.source?.commit || '');
t('commit 是 40 位小写 hex', /^[0-9a-f]{40}$/.test(commit), commit.slice(0, 12) + '...');

// 关键：不能是占位全 0
const isPlaceholder = /^0{40}$/.test(commit);
t('★ commit 不是占位全 0', !isPlaceholder, isPlaceholder ? '必须替换成真实 SHA（git rev-parse HEAD）' : 'ok');

console.log('');
console.log('=== 3. commit 在仓库里真实存在 ===');
let commitExists = false;
try {
  execSync('git cat-file -e ' + commit + '^{commit}', { cwd: HERE, stdio: 'ignore' });
  commitExists = true;
} catch { commitExists = false; }
t('★ commit 存在于当前仓库', commitExists, commitExists ? 'ok' : '这个 SHA 不在仓库里（是不是没提交或填错了？）');

// 顺便给出当前 HEAD
try {
  const head = execSync('git rev-parse HEAD', { cwd: HERE }).toString().trim();
  console.log('  当前 HEAD: ' + head);
  if (!isPlaceholder && head !== commit) {
    console.log('  ⚠ 索引里的 commit 与 HEAD 不一致（可能在发新版本，正常）');
  }
} catch { console.log('  （还不是 git 仓库，先 git init）'); }

console.log('');
console.log('=== 4. DSH 官方验证器 ===');
/**
 * ⚠ 路径里有空格（DeepSeek Harness），必须 URL 编码。
 * 直接用 'file:///D:/DeepSeek Harness/...' 会报 Cannot find module。
 */
/**
 * 加载 DSH 官方验证器。
 *
 * ⚠ 不能直接从 app.asar 里 import ——
 * 纯 Node 不认识 asar 路径，且验证器依赖 semver，
 * 从 asar 内部解析不到 node_modules 链。
 *
 * 解法：把验证器 + semver + package-manifest 拷到临时目录，
 * 用那儿的副本 import。一次性开销（首次拷贝约 1MB）。
 */
const VALIDATOR_TMP = 'C:/Users/123/AppData/Local/Temp/dsh-market-validator';
const ASAR = 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules';

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { try { fs.copyFileSync(s, d); } catch { /* 跳过 */ } }
  }
  return true;
}

function ensureValidator() {
  const marker = path.join(VALIDATOR_TMP, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index', 'lib', 'index.js');
  if (fs.existsSync(marker)) return true;
  fs.mkdirSync(VALIDATOR_TMP, { recursive: true });
  copyDir(path.join(ASAR, '@deepseek-ai', 'dsh-plugin-market-index'),
    path.join(VALIDATOR_TMP, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index'));
  copyDir(path.join(ASAR, 'semver'), path.join(VALIDATOR_TMP, 'node_modules', 'semver'));
  copyDir(path.join(ASAR, '@deepseek-ai', 'dsh-package-manifest'),
    path.join(VALIDATOR_TMP, 'node_modules', '@deepseek-ai', 'dsh-package-manifest'));
  fs.writeFileSync(path.join(VALIDATOR_TMP, 'package.json'),
    JSON.stringify({ name: 'tmp-validator', type: 'module' }, null, 2), 'utf8');
  return fs.existsSync(marker);
}

let spec = null;
try {
  if (!ensureValidator()) throw new Error('验证器拷贝失败');
  const MK2 = new URL('file:///' + VALIDATOR_TMP + '/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js').href;
  const mod = await import(MK2);
  const parsed = mod.parseMarketIndex(idx, 'https://YarXVI.github.io/dsh-yufeng/index.json');
  t('parseMarketIndex 通过', true, parsed.plugins[0].name + ' v' + parsed.plugins[0].versions[0].version);
  spec = mod.marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]);
  t('生成安装 spec', !!spec.spec, spec.spec);
} catch (e) {
  t('parseMarketIndex 通过', false, e.message + (e.path ? ' @ ' + e.path : ''));
}

console.log('');
console.log(bad === 0 ? '★ 发布就绪' : ('✗ ' + bad + ' 项未通过'));
process.exit(bad ? 1 : 0);