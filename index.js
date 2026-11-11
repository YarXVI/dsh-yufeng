/**
 * dsh-yufeng — 御风 · DSH Windows 工具箱 · 宿主入口。
 *
 * 当前功能：**系统级划词转译**。
 * 在任何应用（QQ / 微信 / Edge / 记事本 / 编辑器）里划词选中，
 * 按 Ctrl+Shift+T，就地转译成外语并替换原文。
 *
 * ## 为什么是独立插件而不是塞进 dsh-npu
 *
 *  · dsh-npu 的职责是「本机推理」，Windows 工具是另一类东西；
 *  · 混在一起会让 dsh-npu 越做越胖，且工具功能出问题会连累推理；
 *  · 独立插件可以单独卸载，不影响推理服务。
 *
 * 两者通过 HTTP 解耦：工具箱只调 /v1/chat/completions，不 import dsh-npu 任何东西。
 * 好处是模型随时可以换，甚至换成完全别的翻译服务。
 *
 * ## 纪律
 *
 * 插件装配或运行时失败绝不能拖垮宿主 —— 所有宿主服务调用都包 try/catch。
 */
import { loadConfig, saveConfig, publicConfig, DEFAULT_CONFIG, currentDataRoot } from './lib/config.mjs';
import { createWinTranslate } from './lib/service.mjs';
import { createPanelApi, PANEL_PREFIX } from './lib/panel-api.mjs';
import { migrateIfNeeded } from './lib/migrate.mjs';

export const name = 'dsh-yufeng';

/**
 * 只注入 webServer（挂面板路由）。
 *
 * 不注入 llm：翻译走 HTTP，不需要 DSH 的模型层。这样模型换了也不影响。
 */
export const inject = ['webServer'];

export function apply(ctx, config = {}) {
  let cfg = loadConfig();
  let svc = null;
  let disposePanel = null;
  let log = (m) => { try { console.log('[dsh-yufeng] ' + m); } catch { /* ignore */ } };

  try {
    if (ctx && ctx.logger && typeof ctx.logger === 'function') {
      const l = ctx.logger('dsh-yufeng');
      if (l && typeof l === 'function') log = l;
      else if (l && typeof l.info === 'function') log = (m) => { try { l.info(m); } catch { /* ignore */ } };
    }
  } catch { /* ignore */ }

  /**
   * 数据根：启动时就定下来，后面所有路径都从这里派生。
   *
   * 目录不存在会自动创建（含父目录），所以用户第一次装完插件就能用，
   * 不用手动建目录。
   */
  let dataRoot = '';
  try {
    dataRoot = currentDataRoot();
    log('数据根: ' + dataRoot);
  } catch (e) {
    log('数据根解析失败：' + ((e && e.message) || e));
  }

  /**
   * 从第一版遗留位置迁移（幂等，不覆盖已有数据）。
   *
   * 第一版把配置放在 ~/.dsh/dsh-toolbox.json、扩展放在 %LOCALAPPDATA%/dsh-toolbox，
   * 现在统一到 DSHQK\\YuFeng。用户已有的配置应当跟过来，不能白丢。
   */
  if (dataRoot) {
    try {
      const mg = migrateIfNeeded(dataRoot, log);
      if (mg.migrated.length) log('已迁移 ' + mg.migrated.length + ' 项旧数据');
    } catch (e) {
      log('迁移失败（用默认配置继续）：' + ((e && e.message) || e));
    }
  }

  // 预热：看看 FFI 到底有没有
  svc = createWinTranslate({
    log,
    getCfg: () => cfg,
    onResult: (r) => {
      if (r && r.ok) log('转译成功 ' + r.ms + 'ms ' + JSON.stringify(String(r.text || '').slice(0, 40)));
      else log('转译失败[' + (r && r.stage) + '] ' + (r && r.error));
    },
  });

  const st = svc.status();
  log('FFI: ' + (st.ffi ? ('可用（' + st.source + '）') : '不可用'));

  /**
   * 启动/停热键轮询。
   *
   * 用 ctx.effect 挂 dispose —— DSH 卸载插件时自动停掉定时器，
   * 否则热键轮询会在插件卸载后继续跑（用户会以为插件坏了）。
   */
  try {
    ctx.effect(() => {
      if (cfg.enabled !== false) {
        const ok = svc.start();
        if (!ok) log('热键轮询启动失败（FFI 不可用，功能降级）');
      }
      return () => { try { svc.stop(); } catch { /* ignore */ } };
    });
  } catch (e) {
    log('effect 注册失败：' + ((e && e.message) || e));
  }

  /**
   * 挂 HTTP 面板路由。
   *
   * 参考 dsh-npu 的做法：ctx.inject(['webServer'], scoped => ...)，
   * 用 scoped.effect 挂 register 的 dispose。
   */
  try {
    const panel = createPanelApi({
      log,
      getCfg: () => cfg,
      setCfg: (patch) => { cfg = saveConfig(patch); return cfg; },
      publicConfig,
      svc,
      /**
       * Edge 扩展安装引导要用 ShellExecuteW，需要拿到底层 Win32 绑定。
       * 通过回调暴露，避免 panel-api 直接依赖 FFI 层（保持分层）。
       */
      getWin32: () => svc.getApi(),
    });

    ctx.effect(() => {
      try {
        ctx.inject(['webServer'], (scoped) => {
          try {
            const server = scoped.get ? scoped.get('webServer') : null;
            if (!server || typeof server.register !== 'function') {
              log('webServer.register 不可用：面板不可用（功能本身不受影响）');
              return;
            }
            disposePanel = scoped.effect(
              () => server.register({
                kind: 'prefix',
                path: PANEL_PREFIX,
                handler: (req, res) => panel.handler(req, res),
              }),
              'dsh-yufeng: panel route',
            );
            log('面板路由已挂载 ' + PANEL_PREFIX);
          } catch (e) {
            log('面板路由挂载失败：' + ((e && e.message) || e));
          }
        });
      } catch (e) {
        log('webServer 注入失败：' + ((e && e.message) || e));
      }
    });
  } catch (e) {
    log('面板装配失败：' + ((e && e.message) || e));
  }

  /**
   * 提供一个只读句柄，方便同进程其它插件查询（比如让 agent 知道有这个能力）。
   */
  try {
    ctx.provide('toolbox', {
      status: () => svc.status(),
      trigger: (opts) => svc.trigger(opts),
    });
  } catch { /* 旧版宿主没有 provide，忽略 */ }
}

export { DEFAULT_CONFIG, loadConfig, saveConfig };