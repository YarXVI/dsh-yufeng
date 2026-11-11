import { VK, INPUT_KEYBOARD, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE } from './win32.mjs';

/** 便于外部引用（VKx 避免和局部变量名冲突） */
export const VKx = VK;

/**
 * 键盘注入与「模拟 Ctrl+C 抓取选中文本」（全异步）。
 *
 * ==============================================================
 *  四条实测得出的硬约束
 * ==============================================================
 *
 * ## ① 必须 AttachThreadInput
 *
 * SendInput 把按键投进当前线程的输入队列。插件跑在 DSH 后台线程，
 * 不挂到前台窗口线程上时按键会被丢弃。
 *
 *   不挂接 → 6037ms 全失败（剪贴板完全不变）
 *   挂接   →   33ms 成功
 *
 * ## ② 按下和抬起必须分两批发
 *
 * 一次 SendInput 发 Ctrl↓ C↓ C↑ Ctrl↑，Chromium 系应用约一半概率忽略
 * （它的输入处理按事件批次走，同批内按下-抬起太快会被当成自动重复）。
 *
 *   一次发完（410ms，2 轮）→ 拆两批 + 8ms（47ms，1 轮）
 *
 * ## ③ 剪贴板序列号变了 ≠ 数据可读
 *
 * Ctrl+C 的瞬间序列号就变，但文本要再过几十毫秒才写入。
 * 必须轮询到「读到非空文本」才返回。
 *
 * ## ④ 绝不能用 Atomics.wait
 *
 * 第一版用 Atomics.wait 做 sleep → 堵死 DSH host 事件循环 →
 * 整个 DSH 的 HTTP 服务和 llm 请求集体停摆 → host 崩溃。
 * 现在全部用 await delay()。
 */

/**
 * 异步 sleep。
 *
 * ⚠ 绝不要改成 Atomics.wait —— 那会阻塞整个 Node 事件循环，
 * 在 DSH host 里等于让所有插件（含 NPU 推理）一起卡住。
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));

/** 构造一个键盘事件 */
function keyInput(api, vk, up) {
  return {
    type: INPUT_KEYBOARD,
    _pad: 0,
    wVk: vk,
    wScan: 0,
    dwFlags: up ? KEYEVENTF_KEYUP : 0,
    time: 0,
    dwExtraInfo: 0,
    _pad2: 0,
  };
}

/** 发送一组按键（内部拆成「按下批」和「抬起批」，中间隔 8ms） */
export async function keyCombo(api, vks) {
  if (!vks || !vks.length) return;
  const down = vks.map((v) => keyInput(api, v, false));
  api.SendInput(down.length, down, api.INPUT_SIZE);
  await delay(8);
  const up = vks.slice().reverse().map((v) => keyInput(api, v, true));
  api.SendInput(up.length, up, api.INPUT_SIZE);
}

/** 直接注入 Unicode 字符（绕开输入法） */
export function typeUnicode(api, text) {
  const inputs = [];
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    inputs.push({ type: INPUT_KEYBOARD, _pad: 0, wVk: 0, wScan: c, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0, _pad2: 0 });
    inputs.push({ type: INPUT_KEYBOARD, _pad: 0, wVk: 0, wScan: c, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0, _pad2: 0 });
  }
  if (inputs.length) api.SendInput(inputs.length, inputs, api.INPUT_SIZE);
}

/** 挂到前台窗口所在线程。返回 tid（0 表示无需/失败），调用方负责 detach。 */
export function attachToForeground(api) {
  const fg = api.GetForegroundWindow();
  if (!fg) return 0;
  const tid = Number(api.GetWindowThreadProcessId(fg, null)) >>> 0;
  const my = Number(api.GetCurrentThreadId()) >>> 0;
  if (!tid || tid === my) return 0;
  return api.AttachThreadInput(my, tid, true) ? tid : 0;
}

export function detach(api, tid) {
  if (!tid) return;
  try { api.AttachThreadInput(Number(api.GetCurrentThreadId()) >>> 0, tid, false); } catch { /* ignore */ }
}

/**
 * 模拟 Ctrl+C 抓取当前选中文本。
 *
 * @returns {Promise<{ok, text?, error?, ms, round}>}
 */
export async function grabSelection(api, clip, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 900;
  const rounds = Math.max(1, Number(opts.retries) || 3);
  const start = Date.now();

  for (let r = 0; r < rounds; r++) {
    if (r > 0) await delay(120);
    const seq0 = Number(api.GetClipboardSequenceNumber()) >>> 0;
    const tid = attachToForeground(api);

    /**
     * ⚠ 整个等待期间保持挂接，不要发完就 detach。
     * 踩过的坑：发完立刻解除 → 第一轮几乎总失败（按键还没被前台消费就丢了）。
     */
    await keyCombo(api, [VK.CONTROL, VK.C]);

    const perRound = Math.max(220, Math.floor(timeoutMs / rounds));
    let elapsed = 0;
    let changed = false;
    let text = null;

    while (elapsed < perRound) {
      await delay(25);
      elapsed += 25;
      if (!changed && (Number(api.GetClipboardSequenceNumber()) >>> 0) !== seq0) changed = true;
      if (changed) {
        text = await clip.readText(api, 1);
        if (text) break;
      }
    }

    detach(api, tid);

    if (text) return { ok: true, text, ms: Date.now() - start, round: r + 1 };
    if (changed) {
      return { ok: false, error: '剪贴板里是图片或文件，取不出文字', ms: Date.now() - start, round: r + 1 };
    }
  }

  return { ok: false, error: '剪贴板没有变化（可能没选中内容）', ms: Date.now() - start, round: rounds };
}

/**
 * 热键轮询。
 *
 * 为什么不用 RegisterHotKey：它需要窗口收 WM_HOTKEY，插件在 Node 线程
 * 没有消息循环（实测用 koffi 建窗口失败，CreateWindowEx 返回 err 1407）。
 *
 * GetAsyncKeyState 轮询 30ms：不需要窗口，人类感知不到延迟。
 */
export function createHotkeyPoller(api, opts = {}) {
  const vks = Array.isArray(opts.keys) && opts.keys.length ? opts.keys : [VK.CONTROL, VK.SHIFT, VK.F];
  const intervalMs = Math.max(15, Number(opts.intervalMs) || 30);
  let timer = null;
  let armed = true;
  let lastFire = 0;
  const minGapMs = Number(opts.minGapMs) || 400;

  function allDown() {
    for (const v of vks) {
      if (!(api.GetAsyncKeyState(v) & 0x8000)) return false;
    }
    return true;
  }

  let ticks = 0;
  let lastDown = false;

  return {
    /** 诊断：轮询次数 + 最近一次按键状态 */
    debug() { return { ticks, armed, lastDown, intervalMs, vks }; },
    start(onFire) {
      if (timer) return;
      timer = setInterval(() => {
        try {
          ticks++;
          const down = allDown();
          lastDown = down;
          if (!down) { armed = true; return; }
          if (!armed) return;
          const now = Date.now();
          if (now - lastFire < minGapMs) return;
          armed = false;
          lastFire = now;
          onFire();
        } catch { /* 轮询出错不能让定时器断掉 */ }
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    get running() { return !!timer; },
  };
}

/** 解析快捷键字符串（如 "Ctrl+Shift+F"）为 VK 列表 */
export function parseHotkey(str) {
  const MODS = { ctrl: VK.CONTROL, control: VK.CONTROL, shift: VK.SHIFT, alt: VK.ALT };
  const out = [];
  for (const raw of String(str || '').split('+')) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (MODS[k]) { out.push(MODS[k]); continue; }
    if (k.length === 1) {
      const ch = k.toUpperCase();
      if (ch >= 'A' && ch <= 'Z') { out.push(ch.charCodeAt(0)); continue; }
    }
  }
  return out.length >= 2 ? out : [VK.CONTROL, VK.SHIFT, VK.F];
}