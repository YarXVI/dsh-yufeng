/**
 * koffi（FFI）加载器。
 *
 * ## 为什么不把 koffi 声明成依赖
 *
 * DSH 自己打包了 koffi（原生模块必须解包到 app.asar.unpacked），
 * dsh-npu 已经在用它做 Windows Job Object。插件再装一份：
 *   · 体积翻倍（koffi 带二进制，约 2MB）
 *   · 版本可能不一致，两套 koffi 同时 load 同一个 dll 会互相干扰
 *
 * 所以走「运行时查找」：和 dsh-npu 的 koffiCandidates 同一套思路。
 *
 * ## 查找顺序
 *   1. 显式传入的路径（config.koffiPath）
 *   2. 直接 require('koffi')（插件自己装了就用这个）
 *   3. DSH 安装目录的 app.asar.unpacked 里的那份（最常见）
 *
 * 全都没找到时返回 null —— 调用方负责降级（Windows 功能不可用，但插件不崩）。
 */
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/**
 * @param {string} [explicit] 用户配置里的 koffi 路径
 * @returns {{koffi: object, from: string}|null}
 */
export function loadKoffi(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  candidates.push('koffi')

  /**
   * 找 DSH 安装目录。
   *
   * 三条路都试，因为运行环境不同：
   *   ① process.resourcesPath —— Electron 主进程里有
   *   ② process.execPath 推断 —— Electron 子进程/打包环境
   *   ③ 硬编码常见安装位置 —— 独立 Node 跑测试时上面两条都没有值
   *
   * 第 ③ 条是为了让插件能在「用系统 Node 跑单测」的场景也工作，
   * 否则每次调试都得手动传 koffiPath。
   */
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  if (process.execPath) roots.push(path.join(path.dirname(process.execPath), 'resources'))
  // 常见安装位置（用户机器上大概率在其中一个）
  roots.push('D:\\DeepSeek Harness\\resources')
  roots.push(path.join(process.env.LOCALAPPDATA || '', 'DeepSeek Harness', 'resources'))
  roots.push(path.join(process.env.PROGRAMFILES || '', 'DeepSeek Harness', 'resources'))

  for (const res of roots) {
    if (!res) continue
    candidates.push(path.join(res, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'))
    candidates.push(path.join(res, 'app.asar.unpacked', 'node_modules', 'koffi'))
  }

  for (const c of candidates) {
    try {
      const m = require(c)
      const k = (m && m.default) || m
      if (k && typeof k.load === 'function') return { koffi: k, from: String(c) }
    } catch { /* 继续试下一个 */ }
  }
  return null
}

/** 加载 Win32 库；失败返回 null */
export function loadWin32(koffi) {
  try {
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    return { user32, kernel32 }
  } catch {
    return null
  }
}