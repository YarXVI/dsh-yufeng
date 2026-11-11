/**
 * Win32 绑定层。
 *
 * ## 设计原则
 *
 * 1. **所有 P/Invoke 声明只在这里**。业务层不碰 koffi —— 换 FFI 库时只改这一个文件。
 * 2. **结构体按 x64 对齐**。Win32 的 INPUT 是 40 字节（不是 28），MSG 是 48/56，
 *    写错会静默错位（调用不报错但行为诡异）。每个结构都注明了 sizeof 验证值。
 * 3. **加载失败不抛**。返回 { ok:false, error } —— 插件在非 Windows 或 koffi 缺失时
 *    应该降级而不是崩掉整个宿主。
 *
 * ## 为什么需要 AttachThreadInput
 *
 * SendInput 把按键投进**当前线程的输入队列**。插件跑在 DSH 的后台线程里，
 * 不挂到前台窗口的线程上时，按键会被 Windows 直接丢弃 ——
 * 实测：不挂接 6037ms 全失败，挂接后 33ms 成功。这不是优化，是必需。
 */

export const VK = {
  CONTROL: 0x11, SHIFT: 0x10, ALT: 0x12, ESC: 0x1B,
  A: 0x41, C: 0x43, V: 0x56, T: 0x54, F: 0x46, S: 0x53,
}

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const WM_HOTKEY = 0x0312;
const MOD_CTRL = 0x0002, MOD_SHIFT = 0x0004, MOD_ALT = 0x0001, MOD_WIN = 0x0008;
const MOD_NOREPEAT = 0x4000;

/**
 * 建立 Win32 绑定。
 *
 * @param {object} koffi koffi 实例
 * @returns {object|null} 绑定对象；失败返回 null
 */
export function bind(koffi) {
  let user32, k32, shell32;
  try {
    user32 = koffi.load('user32.dll');
    k32 = koffi.load('kernel32.dll');
  } catch {
    return null;
  }
  // shell32 是可选的：打不开也不影响其它功能
  try { shell32 = koffi.load('shell32.dll'); } catch { shell32 = null; }
  // advapi32 用于读注册表（找 Edge 安装路径）
  let advapi32 = null;
  try { advapi32 = koffi.load('advapi32.dll'); } catch { advapi32 = null; }

  /**
   * 键盘输入结构。x64 上是 40 字节。
   *
   * 原生定义里 INPUT 是个 union，键盘分支只有 24 字节有效数据，
   * 但**整个结构必须按最大成员的对齐**（x64 是 8）填充到 40。
   * 写小了 SendInput 会返回 0 并静默失败。
   */
  const INPUT = koffi.struct('DSH_INPUT', {
    type: 'uint32',
    _pad: 'uint32',          // 对齐填充：让 wVk 落在偏移 8
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uint64',
    _pad2: 'uint64',         // 补齐到 40
  });
  const INPUT_SIZE = koffi.sizeof(INPUT);

  const api = {
    INPUT, INPUT_SIZE,

    /**
     * ⚠ 参数类型必须是**具体结构指针**，不能写 void*。
     *
     * 踩过的坑：写 'uint SendInput(uint n, void *p, int cb)' 时 koffi 报
     * "Cannot pass ambiguous value to void *, use koffi.as()" ——
     * 因为 koffi 无法从 JS 数组推断要把什么转成 void*。
     * 声明成 INPUT* 后它会自动按结构数组处理。
     */
    SendInput: user32.func('uint SendInput(uint n, DSH_INPUT *p, int cb)'),
    GetAsyncKeyState: user32.func('int16 GetAsyncKeyState(int vk)'),

    // --- 窗口 / 线程 ---
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func('uint GetWindowThreadProcessId(void *h, uint *pid)'),
    AttachThreadInput: user32.func('bool AttachThreadInput(uint a, uint b, bool f)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(void *h)'),
    GetCurrentThreadId: k32.func('uint GetCurrentThreadId()'),

    // --- 剪贴板 ---
    OpenClipboard: user32.func('bool OpenClipboard(void *h)'),
    CloseClipboard: user32.func('bool CloseClipboard()'),
    EmptyClipboard: user32.func('bool EmptyClipboard()'),
    GetClipboardData: user32.func('void *GetClipboardData(uint fmt)'),
    SetClipboardData: user32.func('void *SetClipboardData(uint fmt, void *h)'),
    IsClipboardFormatAvailable: user32.func('bool IsClipboardFormatAvailable(uint fmt)'),
    GetClipboardSequenceNumber: user32.func('uint GetClipboardSequenceNumber()'),
    CountClipboardFormats: user32.func('int CountClipboardFormats()'),
    EnumClipboardFormats: user32.func('uint EnumClipboardFormats(uint fmt)'),

    /**
     * 用系统默认程序打开 URL / 协议。
     *
     * 用于「安装 Edge 扩展」按钮 —— 打开 edge://extensions/ 让用户手动加载。
     * shell32 不可用时是 undefined，调用方要判空。
     *
     * 返回值 > 32 表示成功（Win32 历史约定，不是布尔）。
     */
    ShellExecuteW: shell32
      ? shell32.func('void *ShellExecuteW(void *hWnd, char16 *op, char16 *file, char16 *params, char16 *dir, int show)')
      : null,

    /** 注册表读取（找 Edge 安装路径用） */
    RegOpenKeyExW: advapi32
      ? advapi32.func('int RegOpenKeyExW(uint64 hKey, char16 *subKey, uint32 opts, uint32 sam, void **phkResult)')
      : null,
    RegQueryValueExW: advapi32
      ? advapi32.func('int RegQueryValueExW(void *hKey, char16 *valueName, uint32 *reserved, uint32 *type, void *data, uint32 *cbData)')
      : null,
    RegCloseKey: advapi32
      ? advapi32.func('int RegCloseKey(void *hKey)')
      : null,

    // --- 全局内存（剪贴板数据必须放这里）---
    GlobalAlloc: k32.func('void *GlobalAlloc(uint f, uint64 n)'),
    GlobalLock: k32.func('void *GlobalLock(void *h)'),
    GlobalUnlock: k32.func('bool GlobalUnlock(void *h)'),
    GlobalFree: k32.func('void *GlobalFree(void *h)'),
    GlobalSize: k32.func('uint64 GlobalSize(void *h)'),

    /**
     * 内存读写便捷方法（包一层，业务层不用直接碰 koffi）。
     *
     * ⚠ 注意：koffi 3.x 的 encode 签名是 (ptr, type, value) **或**
     * (ptr, offset, type, value)，但**不支持** (ptr, type, 数组)。
     * 第一版试过 koffi.encode(p, 'uint8[]', arr) → 报 "Invalid array length"。
     * 所以这里逐元素调，慢一点但绝不会错。
     */
    decode: (ptr, offset, type) => koffi.decode(ptr, offset, type),
    encode: (ptr, offset, type, value) => koffi.encode(ptr, offset, type, value),
  };

  // 自检：结构体大小错了立刻报出来，不要等运行时诡异失败
  if (INPUT_SIZE !== 40) {
    throw new Error('DSH_INPUT 结构大小异常: ' + INPUT_SIZE + '（期望 40）');
  }

  return api;
}

export { CF_UNICODETEXT, GMEM_MOVEABLE, INPUT_KEYBOARD, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, WM_HOTKEY };
export { MOD_CTRL, MOD_SHIFT, MOD_ALT, MOD_WIN, MOD_NOREPEAT };