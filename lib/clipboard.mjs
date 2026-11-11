import { CF_UNICODETEXT, GMEM_MOVEABLE } from './win32.mjs';

/**
 * 剪贴板读写 + 备份恢复（全异步）。
 *
 * ==============================================================
 *  三条硬约束（每一条都对应一次线上事故）
 * ==============================================================
 *
 * ## ① 绝不要枚举所有格式做备份
 *
 * 第一版「枚举所有剪贴板格式，逐格式 GlobalLock + GlobalSize 深拷贝」，
 * 结果按热键时 DSH host 崩溃，错误码 0xC0000374（STATUS_HEAP_CORRUPTION）。
 *
 * 根因：剪贴板里不同格式存的是**不同类型的句柄**：
 *
 *   CF_UNICODETEXT (13)  -> HGLOBAL          能 GlobalLock
 *   CF_BITMAP (2)        -> HBITMAP          不能！
 *   CF_METAFILEPICT (3)  -> HMETAFILEPICT    不能！
 *   CF_PALETTE (9)       -> HPALETTE         不能！
 *   CF_ENHMETAFILE (14)  -> HENHMETAFILE     不能！
 *
 * 对 GDI 句柄调 GlobalLock 等于把对象头当内存读 → 堆损坏。
 * 现在只备份文本。
 *
 * ## ② 绝不能用 Atomics.wait 阻塞
 *
 * 第一版用 Atomics.wait(SharedArrayBuffer, ...) 做 sleep。
 * 这在**主线程**会把整个事件循环堵死 —— DSH 的 HTTP 服务、
 * llm 请求、其它插件的回调全部停摆。
 *
 * 症状：崩溃日志里出现大量重复的
 *   [llm-deepseek-account] model listing ... loaded 2 model(s)
 * ——那是请求卡住后不断重试的特征。
 *
 * 现在全部改成 await delay()（setTimeout 包装），让出事件循环。
 *
 * ## ③ SetClipboardData 成功后不能再碰那块内存
 *
 * 所有权交给系统。只有 Set 失败时才 GlobalFree。
 */

/**
 * 异步 sleep。
 *
 * ⚠ 不要改成 Atomics.wait —— 那样会阻塞整个 Node 事件循环。
 * 在 DSH host 里这意味着所有插件（包括 NPU 推理服务）一起卡住。
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));

/** 已持有剪贴板锁时读文本（调用方负责 Open/Close） */
function readTextUnlocked(w) {
  try {
    if (!w.IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
    const h = w.GetClipboardData(CF_UNICODETEXT);
    if (!h) return null;
    const p = w.GlobalLock(h);
    if (!p) return null;
    try {
      const buf = [];
      for (let i = 0; i < 8000; i++) {
        const c = w.decode(p, i * 2, 'uint16');
        if (c === 0) break;
        buf.push(c);
      }
      return String.fromCharCode.apply(null, buf);
    } finally {
      w.GlobalUnlock(h);
    }
  } catch {
    return null;
  }
}

/** 读剪贴板文本（自己 Open/Close） */
export async function readText(w, retries = 8) {
  for (let r = 0; r < (retries || 8); r++) {
    if (!w.OpenClipboard(null)) { await delay(12); continue; }
    try {
      return readTextUnlocked(w);
    } finally {
      w.CloseClipboard();
    }
  }
  return null;
}

/** 写文本到剪贴板 */
export async function writeText(w, text, retries = 8) {
  const s = String(text == null ? '' : text);
  const bytes = (s.length + 1) * 2;

  const hMem = w.GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!hMem) return false;
  const p = w.GlobalLock(hMem);
  if (!p) { w.GlobalFree(hMem); return false; }
  try {
    for (let i = 0; i < s.length; i++) w.encode(p, i * 2, 'uint16', s.charCodeAt(i));
    w.encode(p, s.length * 2, 'uint16', 0);
  } finally {
    w.GlobalUnlock(hMem);
  }

  for (let r = 0; r < (retries || 8); r++) {
    if (!w.OpenClipboard(null)) { await delay(12); continue; }
    try {
      w.EmptyClipboard();
      if (w.SetClipboardData(CF_UNICODETEXT, hMem)) return true;
    } finally {
      w.CloseClipboard();
    }
    await delay(12);
  }

  w.GlobalFree(hMem);
  return false;
}

/** 备份剪贴板 —— 只备份文本，返回 { text, hadText } */
export async function backup(w) {
  for (let r = 0; r < 8; r++) {
    if (!w.OpenClipboard(null)) { await delay(12); continue; }
    try {
      const had = !!w.IsClipboardFormatAvailable(CF_UNICODETEXT);
      const text = had ? readTextUnlocked(w) : null;
      return { text, hadText: had };
    } finally {
      w.CloseClipboard();
    }
  }
  return { text: null, hadText: false };
}

/** 恢复备份（只有原来有文本才恢复） */
export async function restore(w, bk) {
  if (!bk || !bk.hadText || typeof bk.text !== 'string') return false;
  return writeText(w, bk.text);
}