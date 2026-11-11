import { loadKoffi } from './koffi-loader.mjs';
import { bind } from './win32.mjs';
import * as clip from './clipboard.mjs';
import { grabSelection, keyCombo, attachToForeground, detach, createHotkeyPoller, parseHotkey, VKx } from './input.mjs';
import { translate, REVERSE_LANGS } from './translate.mjs';
import { activeProvider } from './config.mjs';

/**
 * Windows 转译主服务。
 *
 * 生命周期：
 *   start() → 加载 koffi → 绑定 Win32 → 启动热键轮询
 *   stop()  → 停轮询 → 清理 FFI 回调
 *
 * 热键触发时跑一次完整链路：
 *   ① 备份剪贴板（全格式）
 *   ② Ctrl+C 抓选中文本
 *   ③ HTTP 调燧心翻译
 *   ④ 写回剪贴板 + Ctrl+V 粘贴
 *   ⑤ 恢复原剪贴板
 *
 * 失败的每一步都只记录、不抛 —— 插件绝不能因为一次翻译失败拖垮宿主。
 */
export function createWinTranslate(deps) {
  const log = (deps && deps.log) || (() => {});
  const getCfg = (deps && deps.getCfg) || (() => ({}));
  const onResult = (deps && deps.onResult) || (() => {});

  let koffi = null, api = null, poller = null, source = '';
  let busy = false;
  let lastRun = null;
  let stats = { runs: 0, ok: 0, fail: 0, lastMs: 0 };

  function ensureFFI() {
    if (api) return api;
    const cfg = getCfg();
    const loaded = loadKoffi(cfg.koffiPath);
    if (!loaded) {
      log('koffi 不可用：Windows 转译功能关闭（其余功能不受影响）');
      return null;
    }
    koffi = loaded.koffi;
    source = loaded.from;
    log('koffi <- ' + source);
    try {
      api = bind(koffi);
    } catch (e) {
      log('Win32 绑定失败：' + ((e && e.message) || e));
      api = null;
    }
    return api;
  }

  /**
   * 跑一次完整转译。
   *
   * @param {object} [opts] { text?: string（跳过抓取，直接译这段）, langId? }
   */
  async function runOnce(opts = {}) {
    if (busy) return { ok: false, error: '上一次还没结束' };
    busy = true;
    const t0 = Date.now();
    const cfg = getCfg();
    const langId = String(opts.langId || cfg.lang || 'en');
    let backup = null;
    let grabbedClipboard = false;

    try {
      const a = ensureFFI();
      if (!a) return { ok: false, error: 'FFI 不可用' };

      // ---- ① 抓取 ----
      let text = String(opts.text || '').trim();
      if (!text) {
        // 抓取前先备份剪贴板（Ctrl+C 会覆盖它）
        backup = await clip.backup(a);
        const g = await grabSelection(a, clip, {
          timeoutMs: Number(cfg.grabTimeoutMs) || 900,
          retries: Number(cfg.grabRetries) || 3,
        });
        if (!g.ok) {
          stats.fail++; stats.runs++;
          if (backup) await clip.restore(a, backup);
          onResult({ ok: false, error: g.error, stage: 'grab', ms: Date.now() - t0 });
          return { ok: false, error: g.error, stage: 'grab' };
        }
        text = g.text;
        grabbedClipboard = true;
        log('抓取 ' + text.length + ' 字（' + g.ms + 'ms，第 ' + g.round + ' 轮）');
      }

      // ---- ② 翻译 ----
      /**
       * 用当前激活的 provider（默认燧心，可切云端）。
       *
       * 一句代码都不用知道是本地还是云端 —— 反正都是 OpenAI 兼容接口。
       * 区别只在：燧心 loopback 免 token，云端要 Authorization。
       */
      const prov = activeProvider(cfg);
      if (!prov || !prov.baseUrl) {
        stats.fail++; stats.runs++;
        onResult({ ok: false, error: '没有配置翻译后端', stage: 'translate', ms: Date.now() - t0 });
        return { ok: false, error: '没有配置翻译后端', stage: 'translate' };
      }

      const tr = await translate({
        provider: prov,
        text,
        langId,
        timeoutMs: Number(cfg.translateTimeoutMs) || 60000,
      });
      if (!tr.ok) {
        stats.fail++; stats.runs++;
        if (grabbedClipboard && backup) await clip.restore(a, backup);
        onResult({ ok: false, error: tr.error, stage: 'translate', ms: Date.now() - t0 });
        return { ok: false, error: tr.error, stage: 'translate' };
      }
      log('翻译 ' + tr.ms + 'ms');

      // ---- ③ 写回 ----
      if (cfg.mode === 'replace') {
        if (!await clip.writeText(a, tr.text)) {
          stats.fail++; stats.runs++;
          if (grabbedClipboard && backup) await clip.restore(a, backup);
          onResult({ ok: false, error: '写剪贴板失败', stage: 'write', ms: Date.now() - t0 });
          return { ok: false, error: '写剪贴板失败', stage: 'write' };
        }
        await new Promise((r) => setTimeout(r, 60));
        const tid = attachToForeground(a);
        await keyCombo(a, [VKx.CONTROL, VKx.V]);
        detach(a, tid);
        await new Promise((r) => setTimeout(r, Number(cfg.pasteDelayMs) || 400));
        // 恢复用户原剪贴板（粘贴已完成）
        if (backup) {
          await new Promise((r) => setTimeout(r, 200));
          await clip.restore(a, backup);
        }
      } else {
        // 只复制模式：把译文放进剪贴板，用户自己粘
        await clip.writeText(a, tr.text);
      }

      stats.ok++; stats.runs++; stats.lastMs = Date.now() - t0;
      const result = { ok: true, text: tr.text, langId, ms: Date.now() - t0, mode: cfg.mode || 'replace' };
      lastRun = result;
      onResult(result);
      return result;
    } catch (e) {
      stats.fail++; stats.runs++;
      const err = String((e && e.message) || e);
      if (grabbedClipboard && backup && api) { try { await clip.restore(api, backup); } catch { /* ignore */ } }
      onResult({ ok: false, error: err, stage: 'exception', ms: Date.now() - t0 });
      return { ok: false, error: err, stage: 'exception' };
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      const a = ensureFFI();
      if (!a) return false;
      const cfg = getCfg();
      const keys = parseHotkey(cfg.hotkey || 'Ctrl+Shift+T');
      poller = createHotkeyPoller(a, { keys, intervalMs: Number(cfg.pollMs) || 30 });
      poller.start(() => {
        runOnce().catch((e) => log('热键触发失败：' + ((e && e.message) || e)));
      });
      log('热键轮询已启动（' + (cfg.hotkey || 'Ctrl+Shift+T') + '）');
      return true;
    },
    stop() {
      if (poller) { poller.stop(); poller = null; }
    },
    get running() { return !!(poller && poller.running); },
    runOnce,
    // 手动触发用（面板按钮）
    trigger(opts) { return runOnce(opts); },
    /** 诊断：热键轮询的内部状态 */
    pollDebug() {
      return poller && poller.debug ? poller.debug() : null;
    },
    status() {
      return {
        ffi: !!api,
        source,
        running: !!(poller && poller.running),
        poll: poller && poller.debug ? poller.debug() : null,
        busy,
        stats: { ...stats },
        last: lastRun,
        langs: REVERSE_LANGS.map((l) => ({ id: l.id, zh: l.zh })),
      };
    },
    /**
     * 测试某个 provider 能不能用（面板「测试连接」按钮）。
     *
     * 不做真翻译（省 token、也避免污染剪贴板），只发一句最短的请求：
     * "hi" → 期望拿到非空回复或至少 200。
     *
     * @param {string} providerId  留空则测当前激活的那个
     */
    async testProvider(providerId) {
      const cfg = getCfg();
      const list = cfg.providers || [];
      const prov = providerId
        ? (list.find((p) => p.id === providerId) || activeProvider(cfg))
        : activeProvider(cfg);
      if (!prov) return { ok: false, error: '没有配置' };

      const t0 = Date.now();
      try {
        const r = await fetch(String(prov.baseUrl).replace(/\/$/, '') + '/v1/models', {
          method: 'GET',
          headers: prov.apiKey ? { Authorization: 'Bearer ' + prov.apiKey } : {},
          signal: AbortSignal.timeout(10000),
        });
        const body = await r.text();
        if (!r.ok) {
          // /v1/models 可能没实现 —— 退一步，直接用一次翻译探活
          const tr = await translate({
            provider: prov, text: '你好', langId: 'en',
            timeoutMs: Number(cfg.translateTimeoutMs) || 60000,
          });
          return tr.ok
            ? { ok: true, ms: Date.now() - t0, via: 'chat', sample: tr.text, note: '/v1/models 返回 ' + r.status + '，但翻译可用' }
            : { ok: false, error: tr.error, ms: Date.now() - t0, via: 'chat' };
        }
        // 解析模型列表里有几个
        let count = 0;
        try {
          const j = JSON.parse(body);
          count = Array.isArray(j.data) ? j.data.length : 0;
        } catch { /* ignore */ }
        return { ok: true, ms: Date.now() - t0, via: 'models', models: count };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
    },

    /** 暴露 Win32 绑定（面板要用 ShellExecuteW 打开 edge://extensions/） */
    getApi() { return ensureFFI(); },

    /** 直接抓一次（不翻译），用于面板「测试抓取」 */
    async grabTest() {
      const a = ensureFFI();
      if (!a) return { ok: false, error: 'FFI 不可用' };
      const bk = await clip.backup(a);
      const g = await grabSelection(a, clip, {});
      if (bk && !g.ok) await clip.restore(a, bk);
      return g;
    },
  };
}