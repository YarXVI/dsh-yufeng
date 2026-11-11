/**
 * dsh-toolbox 浏览器侧面板 · 0.2.1
 *
 * 单文件 React 脚本（宿主 __ModuleLoader__ 注入 react），无构建期依赖。
 * 结构对照 dsh-npu 的 client.js（同一套 slots API、同一套 --dsw-* token）。
 *
 * ## 挂载方式
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-toolbox',
 *     factory: (require) => { ... return { apply, inject, name, version, theme } }
 *   })
 *
 * apply(ctx) 里注册两个槽位：
 *   · ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelBody)
 *      → 展开后的主面板内容
 *   · ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order, label }, Glyph)
 *      → 侧边栏图标 + 标签
 *
 * 用 ctx.slots.inject 而不是直接 register —— 宿主槽位系统还没就绪时会被排队，
 * 直接 register 会在启动早期抛错。燧心也是这么做的。
 */
window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PANEL_ID = 'dsh-toolbox-panel';
    const ROUTE = '/plugins/dsh-toolbox/panel';
    const STYLE_ID = 'dsh-toolbox-panel-style';
    const VERSION = '0.2.0';

    /* ------------------------------------------------------------ CSS --- */
    /**
     * 样式全部走宿主的 --dsw-* token，理由：
     *   · 深浅色主题由 token 自己切换，不用写 body[data-theme] 选择器
     *   · 不定义面板私有颜色变量 —— 那会和宿主主题打架
     *   · 圆角/描边取 token，跟其它面板视觉一致
     */
    const css = `
.dtb-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100dvh;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 20px 28px 56px;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--dsw-font-family, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: anywhere;
}
.dtb-page *, .dtb-page *::before, .dtb-page *::after { box-sizing: border-box; }
.dtb-page > * {
  flex: none;
  width: 100%;
  max-width: 860px;
  margin-left: auto;
  margin-right: auto;
}

.dtb-card {
  border: .5px solid var(--dsw-alias-settings-card-stroke, rgba(0,0,0,.16));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-settings-card-fill, #fff);
  overflow: hidden;
  margin-bottom: 14px;
}
.dtb-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 15px 16px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.dtb-card-body { padding: 12px 16px 16px; }

.dtb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.dtb-row:last-child { margin-bottom: 0; }
.dtb-label {
  flex: 0 0 auto;
  width: 92px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #4a5568);
}
.dtb-input, .dtb-select {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  background: var(--dsw-alias-bg-module-platform, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 13px;
}
.dtb-input:focus, .dtb-select:focus {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #5865f2);
  outline-offset: 1px;
}

.dtb-btn {
  padding: 6px 14px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  background: var(--dsw-alias-bg-module-platform, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background .12s;
}
.dtb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dtb-btn:disabled { opacity: .5; cursor: not-allowed; }
.dtb-btn.primary {
  background: var(--dsw-alias-button-primary-fill, #5865f2);
  border-color: var(--dsw-alias-button-primary-fill, #5865f2);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 600;
}
.dtb-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #4752c4); }

.dtb-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: var(--dsw-radius-xs, 6px);
  font-size: 12px;
  font-weight: 600;
}
.dtb-badge.ok { background: rgba(59,165,93,.14); color: #3ba55d; }
.dtb-badge.err { background: rgba(237,66,69,.14); color: #ed4245; }
.dtb-badge.warn { background: rgba(240,178,50,.14); color: #f0b232; }
.dtb-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

.dtb-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8b8f96);
  margin-top: 8px;
}
.dtb-note {
  font-size: 12px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04));
  color: var(--dsw-alias-label-secondary, #4a5568);
  margin-top: 10px;
}
.dtb-steps {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #4a5568);
}
.dtb-steps li { margin-bottom: 4px; }
.dtb-steps b { color: var(--dsw-alias-label-primary, #0f1115); }
.dtb-path {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
  padding: 6px 9px;
  margin-top: 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04));
  color: var(--dsw-alias-label-secondary, #4a5568);
  word-break: break-all;
  user-select: all;
}
.dtb-pre {
  font-size: 12px;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04));
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 9px 11px;
  max-height: 180px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary, #4a5568);
  white-space: pre-wrap;
  word-break: break-all;
}
`;
    
    /* ------------------------------------------------------- 数据层 --- */

    /**
     * 面板数据获取。
     *
     * 走的就是插件自己的 HTTP 面板 API（GET /plugins/dsh-toolbox/panel/state）。
     * 不用 WebSocket / SSE —— 状态变化不频繁，轮询 2 秒足够，
     * 而且少一套连接管理。
     */
    async function fetchState() {
      const r = await fetch(ROUTE + '/state', { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    async function postPatch(path, body) {
      const r = await fetch(ROUTE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ('HTTP ' + r.status));
      return j;
    }

    /* ------------------------------------------------------------ UI --- */

    /** 状态徽章 */
    function StatusBadge(props) {
      const s = props.state;
      if (!s) return h('span', { className: 'dtb-badge warn' }, '读取中…');
      const svc = s.service || {};
      if (!svc.ffi) {
        return h('span', { className: 'dtb-badge err' },
          h('span', { className: 'dtb-dot' }),
          'FFI 不可用');
      }
      if (!svc.running) {
        return h('span', { className: 'dtb-badge warn' },
          h('span', { className: 'dtb-dot' }),
          '已停用');
      }
      if (svc.busy) {
        return h('span', { className: 'dtb-badge warn' },
          h('span', { className: 'dtb-dot' }),
          '处理中…');
      }
      return h('span', { className: 'dtb-badge ok' },
        h('span', { className: 'dtb-dot' }),
        '运行中');
    }

    /**
     * 侧边栏图标。
     *
     * 画一个「文/译」意象：两支箭头对向，代表双向转译。
     * 用纯 SVG 而不是字体图标 —— 宿主不保证带图标字体。
     */
    /**
     * 侧边栏图标：与 icon.svg 同一图形（方块 ↔ 横线）。
     *
     * 为什么内联绘制而不是读 icon.svg 文件：
     *   · 侧边栏只需要一个 18px 的微型版本，不需要完整 512 的细节
     *   · 内联避免客户端再发一个 HTTP 请求
     *   · currentColor 让图标自动跟随主题色
     *
     * 18px 时的取舍：512 单位缩到 18 是 28:1，
     * 所以只保留「左方块 + 右三横」两块主结构，去掉内部留白。
     */
    function ToolboxGlyph(props) {
      const s = (props && props.size) || 18;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 18 18', fill: 'none',
        'aria-hidden': 'true',
        'data-testid': 'dtb-glyph',
      },
        // 左：方块（中文的方质感）
        h('rect', { x: 1.2, y: 3.4, width: 6.4, height: 11.2, rx: 1.6, fill: 'currentColor', opacity: .95 }),
        // 右：三条横线（外语的横排感），长度递减
        h('rect', { x: 9.2, y: 3.4, width: 7.6, height: 2.4, rx: 1.2, fill: 'currentColor' }),
        h('rect', { x: 9.2, y: 7.8, width: 5.4, height: 2.4, rx: 1.2, fill: 'currentColor', opacity: .7 }),
        h('rect', { x: 9.2, y: 12.2, width: 6.6, height: 2.4, rx: 1.2, fill: 'currentColor', opacity: .45 }),
      );
    }
    /** 主面板 */
    function PanelBody() {
      const [state, setState] = useState(null);
      /** 各 provider 的 API Key 草稿（不写进 config 直到保存） */
      const [draftKeys, setDraftKeys] = useState({});
      const [err, setErr] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [draft, setDraft] = useState(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      const refresh = useCallback(async () => {
        try {
          const s = await fetchState();
          if (!alive.current) return;
          setState(s);
          setErr('');
          // 首次拿到配置时初始化草稿
          setDraft((d) => d || Object.assign({}, s.config || {}));
        } catch (e) {
          if (alive.current) setErr(String((e && e.message) || e));
        }
      }, []);

      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 2000);
        return () => clearInterval(t);
      }, [refresh]);

      const set = (k, v) => setDraft((d) => Object.assign({}, d || {}, { [k]: v }));

      /** 改某个 provider 的字段（本地草稿，保存时才落盘） */
      const patchProvider = (id, patch) => {
        setDraft((d) => {
          const base = d || (state && state.config) || {};
          const list = (base.providers || []).map((p) =>
            p.id === id ? Object.assign({}, p, patch) : p
          );
          return Object.assign({}, base, { providers: list });
        });
      };

      const setDraftKey = (id, val) => setDraftKeys((d) => Object.assign({}, d, { [id]: val }));

      const setActiveProvider = (id) => set('activeProvider', id);

      /**
       * 加一个云端 provider 空壳。
       *
       * 只给 id + kind + 默认名，地址/模型/Key 用户填 ——
       * 预填默认值 99% 是错的，留空反而清楚。
       */
      const addCloudProvider = () => {
        setDraft((d) => {
          const base = d || (state && state.config) || {};
          const list = (base.providers || []).slice();
          let n = 1;
          const used = new Set(list.map((p) => p.id));
          while (used.has('custom' + n)) n++;
          const id = 'custom' + n;
          list.push({ id, kind: 'cloud', name: '云端 ' + n, baseUrl: '', model: '', hasKey: false });
          return Object.assign({}, base, { providers: list, activeProvider: id });
        });
      };

      /** 测试某个 provider 的连通性 */
      const testProvider = async (id) => {
        setBusy('test');
        setNotice('');
        try {
          const r = await postPatch('/provider/test', { id });
          setNotice(r && r.ok
            ? ('连接正常' + (r.via === 'models' ? ('（' + (r.models || 0) + ' 个模型）') : '（翻译探活）') + ' · ' + r.ms + 'ms')
            : ('连接失败：' + ((r && r.error) || '未知')));
        } catch (e) {
          setNotice('测试失败：' + ((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const save = async () => {
        setBusy('save');
        setNotice('');
        try {
          /**
           * 把 draftKeys 合并进 providers 后再提交。
           *
           * 为什么要单独合并：publicConfig 不返回明文 key（只给 hasKey），
           * 所以 state 里的 providers 是**没有 key** 的。如果直接把 draft
           * 提交上去，会把用户已存的 key 覆盖成空。
           *
           * 规则：
           *   · draftKeys[id] 非空 → 用它（用户在改）
           *   · draftKeys[id] 为空 → 不传这个字段，后端 normalize 会保留原值？
           *     不会 —— normalize 每次重建对象。所以要显式带上原 key。
           *
           * 但原 key 我们拿不到（publicConfig 隐藏了）。所以改成后端处理：
           * 提交时只传 providers 的非敏感字段 + 新增的 key 字段 keyOverride。
           */
          const payload = Object.assign({}, draft || {});
          if (Object.keys(draftKeys || {}).length) {
            payload.providerKeys = {};
            for (const [id, val] of Object.entries(draftKeys)) {
              if (val && val.trim()) payload.providerKeys[id] = val.trim();
            }
          }
          await postPatch('/config', payload);
          setNotice('已保存并应用');
          setDraftKeys({});
          await refresh();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const toggle = async () => {
        const running = !!(state && state.service && state.service.running);
        setBusy('toggle');
        setNotice('');
        try {
          await postPatch('/toggle', { enabled: !running });
          setNotice(running ? '已停用' : '已启用');
          await refresh();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const runNow = async () => {
        setBusy('run');
        setNotice('');
        try {
          await postPatch('/run', {});
          setNotice('已执行一次');
          await refresh();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const grabTest = async () => {
        setBusy('grab');
        setNotice('');
        try {
          const r = await postPatch('/grab', {});
          setNotice(r && r.ok ? ('抓到 ' + (r.text || '').length + ' 字（' + r.ms + 'ms）') : ('没抓到：' + ((r && r.error) || '未知')));
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const ext = (state && state.extension) || { installed: false, path: '' };
      const [extBusy, setExtBusy] = useState('');
      const [extMsg, setExtMsg] = useState('');

      const prepExt = async () => {
        setExtBusy('prep');
        setExtMsg('');
        try {
          const r = await postPatch('/extension/prepare', {});
          if (r && r.ok) {
            setExtMsg('已准备 ' + (r.result && r.result.files || 0) + ' 个文件，可以开始加载了');
            await refresh();
          } else {
            setExtMsg('准备失败：' + ((r && r.error) || '未知'));
          }
        } catch (e) {
          setExtMsg('准备失败：' + ((e && e.message) || e));
        } finally {
          setExtBusy('');
        }
      };

      const openExt = async () => {
        try {
          const r = await postPatch('/extension/open', {});
          if (r && r.opened) {
            setExtMsg('已打开扩展页（Edge 里应该多了个标签）');
          } else {
            setExtMsg('自动打开失败（' + ((r && r.via) || '?') + '）。请手动在地址栏输入 edge://extensions/');
          }
        } catch (e) {
          setExtMsg('打开失败，请手动访问 edge://extensions/');
        }
      };

      const cfg = (draft && state && state.config) ? Object.assign({}, state.config, draft) : (draft || (state && state.config) || {});
      const langs = (state && state.langs) || [];
      const svc = (state && state.service) || {};

      return h('div', { className: 'dtb-page' },
        // ---- 头部 ----
        h('div', { style: { marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, '御风'),
          h(StatusBadge, { state }),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b8f96)' } }, 'v' + VERSION),
        ),

        // ---- 错误提示 ----
        err ? h('div', { className: 'dtb-note', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #ed4245)' } }, '请求失败：' + err) : null,
        notice ? h('div', { className: 'dtb-note', role: 'status' }, notice) : null,

        // ---- 主配置卡片 ----
        h('div', { className: 'dtb-card' },
          h('div', { className: 'dtb-card-head' }, '划词转译'),
          h('div', { className: 'dtb-card-body' },
            h('div', { className: 'dtb-row' },
              h('span', { className: 'dtb-label' }, '快捷键'),
              h('input', {
                className: 'dtb-input',
                value: cfg.hotkey || '',
                placeholder: 'Ctrl+Shift+F',
                onChange: (e) => set('hotkey', e.target.value),
                'aria-label': '快捷键',
              }),
            ),
            h('div', { className: 'dtb-row' },
              h('span', { className: 'dtb-label' }, '目标语言'),
              h('select', {
                className: 'dtb-select',
                value: cfg.lang || 'en',
                onChange: (e) => set('lang', e.target.value),
                'aria-label': '目标语言',
              }, langs.map((l) => h('option', { key: l.id, value: l.id }, l.zh)))
            ),
            h('div', { className: 'dtb-row' },
              h('span', { className: 'dtb-label' }, '模式'),
              h('select', {
                className: 'dtb-select',
                value: cfg.mode || 'replace',
                onChange: (e) => set('mode', e.target.value),
                'aria-label': '模式',
              },
                h('option', { value: 'replace' }, '替换原文（自动 Ctrl+V）'),
                h('option', { value: 'copy' }, '只复制到剪贴板'),
              ),
            ),
            // ---- 翻译后端选择 ----
            h('div', { className: 'dtb-row' },
              h('span', { className: 'dtb-label' }, '翻译后端'),
              h('select', {
                className: 'dtb-select',
                value: cfg.activeProvider || 'suxin',
                onChange: (e) => setActiveProvider(e.target.value),
                'aria-label': '翻译后端',
              }, (cfg.providers || []).map((p) =>
                h('option', { key: p.id, value: p.id },
                  p.name + (p.hasKey ? ' 已配置Key' : (p.kind === 'cloud' ? ' 未配Key' : ''))
                )
              )),
            ),
            (function () {
              const cur = (cfg.providers || []).find((p) => p.id === cfg.activeProvider) || (cfg.providers || [])[0];
              if (!cur) return null;
              return [
                h('div', { className: 'dtb-row', key: 'url' },
                  h('span', { className: 'dtb-label' }, 'API 地址'),
                  h('input', {
                    className: 'dtb-input',
                    value: cur.baseUrl || '',
                    placeholder: 'https://api.example.com/v1',
                    onChange: (e) => patchProvider(cur.id, { baseUrl: e.target.value }),
                    'aria-label': 'API 地址',
                  }),
                ),
                h('div', { className: 'dtb-row', key: 'model' },
                  h('span', { className: 'dtb-label' }, '模型名'),
                  h('input', {
                    className: 'dtb-input',
                    value: cur.model || '',
                    placeholder: cur.kind === 'local' ? 'translate' : 'gpt-4o-mini / deepseek-chat',
                    onChange: (e) => patchProvider(cur.id, { model: e.target.value }),
                    'aria-label': '模型名',
                  }),
                ),
                h('div', { className: 'dtb-row', key: 'key' },
                  h('span', { className: 'dtb-label' }, 'API Key'),
                  h('input', {
                    className: 'dtb-input',
                    type: 'password',
                    value: (draftKeys && draftKeys[cur.id]) || '',
                    placeholder: cur.kind === 'local' ? '本机服务通常不需要' : (cur.hasKey ? '已配置，留空则不修改' : 'sk-...'),
                    onChange: (e) => setDraftKey(cur.id, e.target.value),
                    'aria-label': 'API Key',
                  }),
                ),
                h('div', { className: 'dtb-row', key: 'test', style: { marginTop: 2 } },
                  h('button', { className: 'dtb-btn', onClick: () => testProvider(cur.id), disabled: !!busy },
                    busy === 'test' ? '测试中...' : '测试连接'),
                  cur.kind === 'local'
                    ? h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #8b8f96)' } }, '本机 NPU，免 Key')
                    : null,
                ),
                h('div', { className: 'dtb-row', key: 'add', style: { marginTop: 4 } },
                  h('button', {
                    className: 'dtb-btn',
                    onClick: () => addCloudProvider(),
                    disabled: !!busy,
                  }, '+ 添加云端服务'),
                  h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary, #8b8f96)' } }, '没有燧心？配个云端 OpenAI 兼容服务'),
                ),
              ];

            })(),
            h('div', { className: 'dtb-row', style: { marginTop: 4 } },
              h('button', { className: 'dtb-btn primary', onClick: save, disabled: !!busy }, busy === 'save' ? '保存中…' : '保存并应用'),
              h('button', { className: 'dtb-btn', onClick: toggle, disabled: !!busy }, svc.running ? '停用' : '启用'),
              h('button', { className: 'dtb-btn', onClick: runNow, disabled: !!busy }, busy === 'run' ? '执行中…' : '手动跑一次'),
              h('button', { className: 'dtb-btn', onClick: grabTest, disabled: !!busy }, busy === 'grab' ? '抓取中…' : '测试抓取'),
            ),
            h('div', { className: 'dtb-hint' },
              '用法：在任何应用里划词选中 → 按快捷键 → 就地转译。',
              h('br'),
              '剪贴板会被临时占用，之后自动恢复（连图片/文件都备份）。',
            ),
          ),
        ),

        // ---- Edge 扩展 ----
        h('div', { className: 'dtb-card' },
          h('div', { className: 'dtb-card-head' },
            '浏览器扩展',
            h('span', { className: 'dtb-badge ' + (ext.installed ? 'ok' : 'warn'), style: { marginLeft: 8 } },
              h('span', { className: 'dtb-dot' }),
              ext.installed ? ('已准备 v' + (ext.version || '?')) : '未准备'),
          ),
          h('div', { className: 'dtb-card-body' },
            h('div', { style: { fontSize: 13, marginBottom: 8 } },
              'Edge 版翻译扩展：网页划词翻译 + 图片翻译（漫画/竖排文本）。'),
            h('div', { className: 'dtb-row', style: { marginTop: 10 } },
              h('button', { className: 'dtb-btn primary', onClick: prepExt, disabled: !!extBusy },
                extBusy === 'prep' ? '准备中…' : '① 准备扩展文件'),
              h('button', { className: 'dtb-btn', onClick: openExt, disabled: !!extBusy },
                '② 打开扩展页'),
            ),
            extMsg ? h('div', { className: 'dtb-note', role: 'status' }, extMsg) : null,
            h('ul', { className: 'dtb-steps' },
              h('li', null, h('b', null, '① 点「准备扩展文件」'), ' — 把扩展拷到固定位置（不会碰你现有的扩展）'),
              h('li', null, h('b', null, '② 点「打开扩展页」'), ' — 打开 edge://extensions/'),
              h('li', null, h('b', null, '③ 打开右上角「开发人员模式」')),
              h('li', null, h('b', null, '④ 点「加载解压缩的扩展」，选下面这个目录')),
              h('li', null, h('b', null, '⑤ 完成'), ' — 工具栏出现「DSH 翻译」图标'),
            ),
            ext.path ? h('div', { className: 'dtb-path' }, ext.path) : null,
            h('div', { className: 'dtb-hint' },
              '为什么不是全自动：Edge 的扩展列表带机器绑定签名，',
              '第三方写进去会被判定篡改并**重置你现有的所有扩展**。',
              '所以走官方支持的开发者模式加载，约 20 秒，零风险。',
            ),
          ),
        ),

        // ---- 运行信息 ----
        h('div', { className: 'dtb-card' },
          h('div', { className: 'dtb-card-head' }, '运行信息'),
          h('div', { className: 'dtb-card-body' },
            h('div', { className: 'dtb-row' },
              h('span', { className: 'dtb-label' }, '数据目录'),
              h('span', { style: { flex: 1, fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', color: 'var(--dsw-alias-label-tertiary, #8b8f96)', wordBreak: 'break-all' } },
                (state && state.config && state.config.dataRoot) || '解析中…'),
            ),
            h('pre', { className: 'dtb-pre' }, JSON.stringify({
              ffi: svc.ffi,
              koffi: svc.source,
              running: svc.running,
              stats: svc.stats,
              last: svc.last,
            }, null, 2)),
            svc.ffi ? null : h('div', { className: 'dtb-note', style: { color: 'var(--dsw-alias-state-error-primary, #ed4245)' } },
              'FFI 不可用：找不到 koffi，或当前不是 Windows。功能已降级，其余 DSH 功能不受影响。'),
          ),
        ),
      );
    }

    /* -------------------------------------------------------- mounting --- */

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = css;
    }

    function apply(ctx) {
      ensureStyle();
      const registerAll = () => {
        const stopPanel = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ ctx }) }, PanelBody);
        let stopEntry;
        try {
          /**
           * 侧边栏图标 + 标签。
           *
           * order 45 —— 排在燧心（43）、灾备（44）之后，
           * 因为它是「辅助工具」，不该抢在核心功能前面。
           * label 只放静态文本（宿主同时拿它做 aria-label 和 tooltip，
           * 塞动态内容会让读屏器反复播报）。
           */
          stopEntry = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 45,
            label: () => '御风',
          }, ToolboxGlyph);
        } catch (e) {
          stopPanel();
          throw e;
        }
        return () => { try { stopEntry(); } finally { stopPanel(); } };
      };
      ctx.effect(
        () => (typeof ctx.slots.inject === 'function'
          ? ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', registerAll))
          : registerAll()),
        'dsh-toolbox: 面板'
      );
    }

    return { apply, inject: ['slots', 'layout'], name: 'dsh-toolbox', version: VERSION, theme: 'auto' };
  },
});
