/**
 * 数据迁移：从第一版遗留位置搬到 DSHQK\\YuFeng。
 *
 * ## 要迁什么
 *
 * | 第一版位置 | 新位置 |
 * |---|---|
 * | `~/.dsh/dsh-toolbox.json` | `<dataRoot>/config.json` |
 * | `%LOCALAPPDATA%/dsh-toolbox/edge-ext` | `<dataRoot>/edge-ext` |
 *
 * ## 迁移原则
 *
 * 1. **只在目标不存在时迁**——不覆盖用户已经在新位置改过的配置
 * 2. **迁完不删源**——用户可能还想回去，或者我们判断有误。留一份不费什么空间。
 * 3. **失败不阻断启动**——迁移是锦上添花，坏了就用默认配置继续跑
 */
import fs from 'node:fs';
import path from 'node:path';
import { legacyConfigFile, legacyDataRoot } from './paths.mjs';

/**
 * 执行迁移。
 *
 * @param {string} dataRoot  新数据根（必须已存在）
 * @param {function} log     日志函数
 * @returns {{migrated: string[], skipped: string[]}}
 */
export function migrateIfNeeded(dataRoot, log) {
  const migrated = [];
  const skipped = [];
  const say = (m) => { try { log(m); } catch { /* ignore */ } };

  // ---- ① 配置文件 ----
  const newCfg = path.join(dataRoot, 'config.json');
  const oldCfg = legacyConfigFile();
  if (!fs.existsSync(newCfg) && fs.existsSync(oldCfg)) {
    try {
      fs.copyFileSync(oldCfg, newCfg);
      migrated.push('配置: ' + oldCfg + ' → ' + newCfg);
      say('已迁移配置：' + oldCfg);
    } catch (e) {
      skipped.push('配置迁移失败（用默认值）: ' + ((e && e.message) || e));
    }
  } else if (fs.existsSync(newCfg)) {
    skipped.push('配置: 新位置已有，不覆盖');
  }

  // ---- ② Edge 扩展目录 ----
  const newExt = path.join(dataRoot, 'edge-ext');
  const oldExt = path.join(legacyDataRoot(), 'edge-ext');
  if (!fs.existsSync(newExt) && fs.existsSync(oldExt)) {
    try {
      copyTree(oldExt, newExt);
      migrated.push('扩展: ' + oldExt + ' → ' + newExt);
      say('已迁移 Edge 扩展目录');
    } catch (e) {
      skipped.push('扩展迁移失败（可重新准备）: ' + ((e && e.message) || e));
    }
  } else if (fs.existsSync(newExt)) {
    skipped.push('扩展: 新位置已有，不覆盖（面板可重新准备）');
  }

  return { migrated, skipped };
}

/** 递归拷贝目录 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}