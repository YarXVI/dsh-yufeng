/**
 * Edge 扩展安装引导。
 *
 * ## 为什么不是「静默安装」
 *
 * 真正的静默安装有两条路，都不能走：
 *
 *   ① **写 Secure Preferences**
 *      扩展列表存在 `Edge\User Data\Default\Secure Preferences`，
 *      里面每条扩展都带机器绑定的 HMAC。写到是写进去，但 Edge 启动时校验不过
 *      → 它会认为配置被篡改 → **重置整个扩展配置**。
 *      用户现有的十几个扩展可能全部丢失。这个风险不能承担。
 *
 *   ② **CDP Extensions.loadUnpacked**
 *      需要在启动 Edge 时加 `--remote-debugging-port`。
 *      普通用户的 Edge 没这个参数，得改快捷方式甚至注册表；
 *      而且下次用户正常启动浏览器时扩展**还在**（因为已经写进 Preferences），
 *      但前提是首次安装那次恰好被 CDP 看到了 —— 不可靠。
 *
 * ## 所以采用「引导式安装」
 *
 * 把扩展准备好放在一个固定位置，然后打开 edge://extensions/，
 * 面板给出 3 步图示。用户操作约 20 秒，且**绝不会**影响现有扩展。
 *
 * 这是 Chrome/Edge 对外部扩展的**唯一安全路径**（开发者模式加载解压扩展）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { currentDataRoot } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 安装目标目录。
 *
 * 为什么不直接用插件目录里的 edge-ext？
 *   插件装在 `~/.dsh/profiles/desktop/plugins/dsh-toolbox/edge-ext`，
 *   路径里有中文目录名（profiles/desktop 还好，但用户可能改），
 *   且 Edge 对路径里的非 ASCII 字符有时会出问题。
 *
 * 所以拷到 `%LOCALAPPDATA%\dsh-toolbox\edge-ext` —— 全 ASCII、固定位置、
 * 用户重装 DSH 也不会丢（扩展还在，Edge 里已注册的路径继续有效）。
 */
/**
 * 扩展安装目录：`<dataRoot>/edge-ext`。
 *
 * dataRoot 默认 `D:\DSHQK\YuFeng`（与燧心 D:\DSHQK\SuiXin 同级）。
 *
 * 为什么不放在插件目录里：
 *   插件装在 profile 下，用户重装 DSH 会一起没掉；
 *   但 Edge 注册的是**绝对路径** —— 路径一消失扩展就失效。
 *   所以必须放一个稳定位置。
 *
 * 为什么放 DSHQK 而不是 %LOCALAPPDATA%：
 *   和燧心统一，用户备份数据只需打包一个目录。
 */
export function installDir() {
  try {
    return path.join(currentDataRoot(), 'edge-ext');
  } catch {
    // 数据根解析失败时退回落环安全位置（不让整个功能挂掉）
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'dsh-toolbox', 'edge-ext');
  }
}

/**
 * 找到 Edge 的可执行文件路径。
 *
 * 查找顺序：
 *   ① 注册表 App Paths（最权威，用户装哪儿都能找到）
 *   ② 常见安装位置
 *
 * ## 为什么不能直接 ShellExecute('edge://…')
 *
 * ⚠ 踩过的坑（用户截图）：ShellExecute 对一个 `edge://` URL 会弹
 * 「获取打开此 edge 链接的应用」——因为 **edge:// 没在注册表注册处理器**，
 * 它是浏览器内部的私有 scheme，系统层面不认识。
 *
 * 正确做法：用 msedge.exe 启动并把它当命令行参数传进去：
 *   msedge.exe "edge://extensions/"
 * Edge/Chrome 会复用已运行的实例，只是开个新标签页，不会起第二个进程。
 *
 * @param {object} api  win32 绑定
 * @returns {string|null}
 */
export function findEdgePath(api) {
  // ① 注册表 App Paths
  try {
    if (api && typeof api.RegOpenKeyExW === 'function') {
      // RegOpenKeyExW(HKEY_LOCAL_MACHINE=0x80000002, path, 0, KEY_READ=0x20019, &hkey)
      const hkeyOut = [null];
      // koffi 的 out 参数写法：传数组
      const KEY_READ = 0x20019;
      const opened = api.RegOpenKeyExW(0x80000002n, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', 0, KEY_READ, hkeyOut);
      if (opened === 0 && hkeyOut[0]) {
        const buf = Buffer.alloc(1024);
        const sizeOut = [1024];
        const got = api.RegQueryValueExW(hkeyOut[0], null, null, null, buf, sizeOut);
        api.RegCloseKey(hkeyOut[0]);
        if (got === 0) {
          const s = buf.toString('utf16le').replace(/\0.*/, '').trim();
          if (s && fs.existsSync(s)) return s;
        }
      }
    }
  } catch { /* 注册表读失败就走兜底 */ }

  // ② 常见路径
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    (process.env.LOCALAPPDATA || '') + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 打开一个 URL。按 scheme 分流：
 *
 *   · `edge://` / `chrome://` → 用浏览器可执行文件带参数启动
 *   · 其它（http/https/协议）  → ShellExecute，走系统默认程序
 *
 * @param {object} api  win32 绑定
 * @param {string} target
 * @returns {{ok:boolean, via:string, detail?:string}}
 */
export function openExternal(api, target) {
  const t = String(target || '');
  const isBrowserScheme = /^(edge|chrome|about|view-source):/i.test(t);

  if (isBrowserScheme) {
    const exe = findEdgePath(api);
    if (!exe) return { ok: false, via: 'exe', detail: '没找到 Edge 可执行文件' };
    // 用 CreateProcess 起（比 ShellExecute 更可控，不弹 UAC/关联对话框）
    try {
      if (api && typeof api.ShellExecuteW === 'function') {
        // ShellExecute 直接用 exe + 参数：不经过协议关联，不会弹「找不到应用」
        const ret = api.ShellExecuteW(null, 'open', exe, '"' + t + '"', null, 1);
        const n = Number(ret);
        if (n > 32) return { ok: true, via: 'exe+args', detail: exe };
        return { ok: false, via: 'exe+args', detail: 'ShellExecute 返回 ' + n };
      }
    } catch (e) {
      return { ok: false, via: 'exe+args', detail: String((e && e.message) || e) };
    }
    return { ok: false, via: 'exe+args', detail: '没有 ShellExecuteW' };
  }

  try {
    if (!api || typeof api.ShellExecuteW !== 'function') return { ok: false, via: 'shell', detail: '没有 ShellExecuteW' };
    const ret = api.ShellExecuteW(null, 'open', t, null, null, 1);
    return Number(ret) > 32 ? { ok: true, via: 'shell' } : { ok: false, via: 'shell', detail: '返回 ' + Number(ret) };
  } catch (e) {
    return { ok: false, via: 'shell', detail: String((e && e.message) || e) };
  }
}

/** 插件自带的扩展源目录 */
export function bundledDir() {
  return path.join(HERE, '..', 'edge-ext');
}

/**
 * 把扩展拷到安装目录。
 *
 * 幂等：每次都覆盖（版本升级时自然更新）。
 *
 * @returns {{ok:boolean, path?:string, files?:number, error?:string}}
 */
export function prepareExtension() {
  const src = bundledDir();
  const dst = installDir();

  if (!fs.existsSync(src)) {
    return { ok: false, error: '插件里没有自带扩展（edge-ext 目录缺失）' };
  }

  try {
    fs.mkdirSync(dst, { recursive: true });
    let files = 0;
    const walk = (s, d) => {
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = path.join(s, e.name);
        const dp = path.join(d, e.name);
        if (e.isDirectory()) {
          fs.mkdirSync(dp, { recursive: true });
          walk(sp, dp);
        } else {
          fs.copyFileSync(sp, dp);
          files++;
        }
      }
    };
    walk(src, dst);

    // 校验：拷完后必须能读到 manifest
    const mf = path.join(dst, 'manifest.json');
    if (!fs.existsSync(mf)) return { ok: false, error: '拷贝后找不到 manifest.json' };
    let name = '', version = '', mid = '';
    try {
      const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
      name = j.name || '';
      version = j.version || '';
      mid = j.key ? '(已固定 ID)' : '(未固定 ID)';
    } catch { /* ignore */ }

    return { ok: true, path: dst, files, name, version, idNote: mid };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 检查安装目录里是否已有扩展，以及版本。
 */
export function status() {
  const dst = installDir();
  const mf = path.join(dst, 'manifest.json');
  if (!fs.existsSync(mf)) return { installed: false, path: dst };
  try {
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    return { installed: true, path: dst, name: j.name || '', version: j.version || '' };
  } catch {
    return { installed: false, path: dst, error: 'manifest.json 读不出来' };
  }
}