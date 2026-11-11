/**
 * 数据根目录解析。
 *
 * ## 约定：DSHQK 与 DSH 安装目录同级
 *
 * ```
 *   D:\DeepSeek Harness\      ← DSH 本体
 *   D:\DSHQK\                 ← 插件数据根（同级 sibling）
 *     ├─ SuiXin\              ← 燧心 / dsh-npu
 *     │   ├─ mods\
 *     │   ├─ runtimes\
 *     │   └─ logs\
 *     ├─ LengJing\            ← 棱镜 / companion-memory
 *     └─ YuFeng\              ← 御风（本插件）
 *         ├─ config.json
 *         ├─ edge-ext\
 *         └─ logs\
 * ```
 *
 * 为什么不放 ~/.dsh：
 *   · 插件数据（模型/运行时/扩展）动辄几百 MB，放用户主目录会占系统盘；
 *   · DSH 本体常装在非系统盘（D: / E:），数据跟着本体走才合理；
 *   · 用户重装 DSH 时数据能保留（独立目录，不被卸载器清掉）。
 *
 * 为什么不用 %LOCALAPPDATA%（第一版的做法）：
 *   和燧心的 SuiXin 分家了 —— 用户要备份/迁移时得记两个位置。
 *   统一到 DSHQK 下，一个目录打包就是完整的数据备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 数据根目录名（DSHQK 下的子目录名） */
const DATA_DIR_NAME = 'YuFeng';

/** 数据根目录的父目录名 */
const ROOT_DIR_NAME = 'DSHQK';

/**
 * 推测 DSH 安装目录。
 *
 * 三条来源，按可靠性排序：
 *   ① process.resourcesPath —— Electron 里是 <install>/resources
 *   ② process.execPath —— <install>/DeepSeek Harness.exe
 *   ③ 常见安装位置兜底（独立 Node 跑测试时上面两条都不靠谱）
 *
 * @returns {string|null}
 */
export function dshInstallDir() {
  try {
    if (process.resourcesPath) {
      const dir = path.dirname(String(process.resourcesPath));
      if (fs.existsSync(dir)) return dir;
    }
  } catch { /* ignore */ }
  try {
    if (process.execPath) {
      const dir = path.dirname(String(process.execPath));
      // Node 自己跑测试时 execPath 是 node.exe，不是 DSH 目录 —— 要排除
      if (/^node\.exe$/i.test(path.basename(process.execPath))) return null;
      if (fs.existsSync(dir)) return dir;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 列出可能的 DSHQK 父目录（用于找数据根）。
 *
 * 顺序（找到第一个「存在且像数据根」的就用）：
 *   ① DSH 安装目录的同级 DSHQK
 *   ② D:\DSHQK、E:\DSHQK（历史惯例）
 *   ③ 用户主目录下的 DSHQK
 */
function candidateRoots() {
  const out = [];

  // ① DSH 同级的 DSHQK —— 这是用户要的约定
  const install = dshInstallDir();
  if (install) {
    out.push(path.join(path.dirname(install), ROOT_DIR_NAME));
  }

  // ② 常见盘符（燧心装在这儿时会被采纳）
  out.push('D:' + path.sep + ROOT_DIR_NAME);
  out.push('E:' + path.sep + ROOT_DIR_NAME);

  // ③ 主目录兜底
  out.push(path.join(os.homedir(), ROOT_DIR_NAME));

  return out;
}

/**
 * 数据根目录是否「看起来像」已初始化的数据根。
 *
 * 判据：目录存在，且里面有 config.json 或 edge-ext/ 或 DSHQK 下的兄弟插件目录。
 * 不凭空认领：只认真正有内容的目录。
 */
function looksLikeDataRoot(p) {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false;
    const entries = fs.readdirSync(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * 解析数据根目录（不创建）。
 *
 * 优先级：
 *   ① 配置里显式写的 dataRoot（且目录存在）
 *   ② 环境变量 DSH_YUFENG_DATA
 *   ③ 第一版遗留位置 %LOCALAPPDATA%\\dsh-toolbox（有内容时迁过去，见 migrateIfNeeded）
 *   ④ DSH 同级的 DSHQK\\YuFeng
 *   ⑤ D:\\DSHQK\\YuFeng、E:\\DSHQK\\YuFeng
 *   ⑥ ~/DSHQK/YuFeng
 */
export function resolveDataRoot(configured) {
  // ① 显式配置
  if (configured) {
    try {
      if (fs.existsSync(configured) && fs.statSync(configured).isDirectory()) return configured;
    } catch { /* ignore */ }
  }

  // ② 环境变量
  const env = process.env.DSH_YUFENG_DATA;
  if (env) {
    try {
      if (fs.existsSync(env) && fs.statSync(env).isDirectory()) return env;
    } catch { /* ignore */ }
  }

  // ③/④/⑤/⑥ 按候选顺序找「已存在」的那个
  for (const root of candidateRoots()) {
    const dir = path.join(root, DATA_DIR_NAME);
    if (looksLikeDataRoot(dir)) return dir;
  }

  // 都没找到 → 用首选候选（DSH 同级），由 ensureDataRoot 创建
  const roots = candidateRoots();
  return path.join(roots[0], DATA_DIR_NAME);
}

/**
 * 确保数据根目录存在（不存在就创建）。
 *
 * @returns {{ok:boolean, root:string, created:boolean, error?:string}}
 */
export function ensureDataRoot(configured) {
  const root = resolveDataRoot(configured);
  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
      return { ok: true, root, created: true };
    }
    return { ok: true, root, created: false };
  } catch (e) {
    return { ok: false, root, created: false, error: String((e && e.message) || e) };
  }
}

/** 第一版遗留位置（%LOCALAPPDATA%\\dsh-toolbox） */
export function legacyDataRoot() {
  const base = process.env.LOCALAPPDATA ||
    (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'dsh-toolbox');
}

/** 第一版遗留的配置文件（~/.dsh/dsh-toolbox.json） */
export function legacyConfigFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-toolbox.json');
}