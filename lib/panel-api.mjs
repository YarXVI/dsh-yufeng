/**
 * 面板 HTTP API。
 *
 * 挂到 DSH 的 webServer：/plugins/dsh-yufeng/panel/*
 *
 * 路由：
 *   GET  panel          → HTML 页面（调试用；正常走 client.js 的 React 面板）
 *   GET  panel/state    → 状态快照
 *   POST panel/config   → 改配置
 *   POST panel/run      → 手动跑一次
 *   POST panel/grab     → 只抓取不翻译（诊断用）
 *   POST panel/toggle   → 启停热键轮询
 */

import * as edgeExt from './edge-ext.mjs';
import { activeProvider } from './config.mjs';

export const PANEL_PREFIX = '/plugins/dsh-yufeng/panel';

export function createPanelApi(deps) {
  const getCfg = deps.getCfg;
  const setCfg = deps.setCfg;
  const svc = deps.svc;
  const log = deps.log || (() => {});

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let buf = '';
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { resolve(null); req.destroy(); return; }
        buf += c;
      });
      req.on('end', () => {
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  return {
    async handler(req, res) {
      /**
       * 根路径返回自带的调试页。
       *
       * 生产环境走 client.js 的 React 面板（宿主渲染），
       * 这个 HTML 是给「直接浏览器打开 URL 调试」用的，
       * 也方便面板还没接上时验证后端通了。
       */
      const p0 = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && (p0 === PANEL_PREFIX || p0 === PANEL_PREFIX + '/')) {
        try {
          const fsMod = await import('node:fs');
          const pathMod = await import('node:path');
          const urlMod = await import('node:url');
          const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
          const f = pathMod.join(here, '..', 'panel.html');
          const html = fsMod.readFileSync(f, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        } catch (e) {
          return json(res, 500, { ok: false, error: '面板页读取失败: ' + ((e && e.message) || e) });
        }
      }

      const url = String(req.url || '');
      const tail = url.startsWith(PANEL_PREFIX) ? url.slice(PANEL_PREFIX.length) : url;
      const pathOnly = tail.split('?')[0].replace(/^\//, '');

      try {
        // ---- 状态 ----
        if (pathOnly === '' || pathOnly === 'state') {
          return json(res, 200, {
            ok: true,
            config: deps.publicConfig ? deps.publicConfig(getCfg()) : getCfg(),
            service: svc.status(),
            langs: svc.status().langs,
            extension: edgeExt.status(),
          });
        }

        if (req.method === 'GET') {
          return json(res, 404, { ok: false, error: 'unknown route' });
        }

        const body = await readBody(req);
        if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });

        // ---- 改配置 ----
        if (pathOnly === 'config') {
          /**
           * providerKeys 是面板传来的明文 key（publicConfig 隐藏了原值，
           * 所以面板只能单独提交这一项）。
           *
           * 合并规则：
           *   · 传了 key → 覆盖该 provider 的 apiKey
           *   · 没传 → 保留原有（normalize 会重建对象，所以要显式合并）
           */
          const patch = Object.assign({}, body || {});
          const keys = patch.providerKeys || null;
          delete patch.providerKeys;

          if (Array.isArray(patch.providers)) {
            const cur = getCfg();
            const oldById = {};
            for (const p of (cur.providers || [])) oldById[p.id] = p;
            patch.providers = patch.providers.map((p) => {
              const old = oldById[p.id] || {};
              const incomingKey = keys && keys[p.id];
              return Object.assign({}, p, {
                apiKey: incomingKey ? incomingKey : (old.apiKey || ''),
              });
            });
          }

          const next = setCfg(patch);
          log('配置已更新：hotkey=' + next.hotkey + ' lang=' + next.lang + ' mode=' + next.mode);
          // 热键/轮询间隔变了要重启轮询
          if (next.enabled !== false) { svc.stop(); svc.start(); }
          else svc.stop();
          return json(res, 200, { ok: true, config: deps.publicConfig ? deps.publicConfig(next) : next });
        }

        // ---- 手动跑一次 ----
        if (pathOnly === 'run') {
          const r = await svc.trigger({ text: body && body.text, langId: body && body.lang });
          return json(res, 200, r);
        }

        // ---- 只抓取（诊断） ----
        if (pathOnly === 'grab') {
          const r = await svc.grabTest();
          return json(res, 200, r);
        }

        if (pathOnly === 'polldebug') {
          return json(res, 200, { ok: true, poll: svc.pollDebug() });
        }

        // ---- 翻译后端（provider） ----
        /**
         * 测试连接。
         *
         * 面板上每个 provider 都有「测试」按钮 —— 用户配完云端服务
         * 要能立刻知道对不对，而不是靠按热键试。
         */
        if (pathOnly === 'provider/test') {
          const r2 = await svc.testProvider(body && body.id);
          return json(res, 200, Object.assign({ ok: !!r2.ok }, r2));
        }

        /**
         * 切换激活的 provider。
         *
         * 只改 activeProvider 一个字段 —— 不动 providers 数组，
         * 所以用户切回来时原来的地址/key 都还在。
         */
        if (pathOnly === 'provider/activate') {
          const id = String((body && body.id) || '');
          const next = setCfg({ activeProvider: id });
          log('切换翻译后端 → ' + next.activeProvider);
          return json(res, 200, { ok: true, activeProvider: next.activeProvider, config: deps.publicConfig ? deps.publicConfig(next) : next });
        }

        // ---- Edge 扩展安装引导 ----
        if (pathOnly === 'extension/status' && req.method === 'GET') {
          const st = edgeExt.status();
          return json(res, 200, { ok: true, extension: st });
        }

        /**
         * 准备扩展（拷贝到固定位置）。
         *
         * 只做拷贝，不碰浏览器任何配置 —— 用户现有扩展绝不会受影响。
         */
        if (pathOnly === 'extension/prepare') {
          const r = edgeExt.prepareExtension();
          log('扩展准备：' + (r.ok ? ('已拷贝 ' + r.files + ' 个文件到 ' + r.path) : r.error));
          return json(res, 200, { ok: r.ok, result: r, error: r.ok ? null : r.error });
        }

        /**
         * 打开 edge://extensions/ 让用户手动加载。
         *
         * 为什么需要 api 实例：要用 ShellExecuteW。
         * 拿不到 API 时降级为「请手动打开 edge://extensions/」。
         */
        if (pathOnly === 'extension/open') {
          const api = deps.getWin32 ? deps.getWin32() : null;
          const r = edgeExt.openExternal(api, 'edge://extensions/');
          log('打开扩展页：' + (r.ok ? ('成功 via ' + r.via) : ('失败 via ' + r.via + '：' + (r.detail || ''))));
          return json(res, 200, {
            ok: true,
            opened: r.ok,
            via: r.via,
            edgePath: r.detail && r.via === 'exe+args' ? r.detail : null,
            url: 'edge://extensions/',
            fallback: r.ok ? null : '请手动在地址栏输入 edge://extensions/',
          });
        }

        // ---- 启停 ----
        if (pathOnly === 'toggle') {
          if (body && body.enabled === false) { svc.stop(); return json(res, 200, { ok: true, running: false }); }
          const ok2 = svc.start();
          return json(res, 200, { ok: ok2, running: svc.running });
        }

        return json(res, 404, { ok: false, error: 'unknown route' });
      } catch (e) {
        log('面板请求失败：' + ((e && e.message) || e));
        return json(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  };
}