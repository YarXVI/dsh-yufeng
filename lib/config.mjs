import fs from 'node:fs';
import path from 'node:path';
import { resolveDataRoot, ensureDataRoot } from './paths.mjs';

/**
 * 配置存储。
 *
 * 位置：`<dataRoot>/config.json`，dataRoot 默认 `D:\\DSHQK\\YuFeng`。
 *
 * ## 多后端设计（provider）
 *
 * 用户明确要求：默认走燧心，但没有燧心时要能手动配第三方 OpenAI 兼容服务。
 *
 * 所以配置里不是「一个 baseUrl」，而是：
 *
 *   providers: [
 *     { id: 'suxin', kind: 'local',  name: '燧心',  baseUrl, model, apiKey }
 *     { id: 'custom', kind: 'cloud', name: '自定义', baseUrl, model, apiKey }
 *   ]
 *   activeProvider: 'suxin'  ← 当前用哪个
 *
 * 为什么用数组而不是两组固定字段：
 *   · 用户可以加多个云端服务，随时切换（比如 DeepSeek / 智谱 / 硅基流动）
 *   · 每个 provider 的 key/model 独立，切换回来不用重填
 *   · 将来加「按语言选不同服务」也有地方放
 *
 * 向后兼容：第一版只有单套 baseUrl/model/apiToken。读到旧配置时
 * migrateLegacyConfig() 会自动把它包装成 providers[0]。
 */

/**
 * 第一个 provider 永远是「本机燧心」—— 它的 id 固定，默认激活。
 * kind 区分本机 / 云端，面板据此显示不同提示。
 */
const DEFAULT_PROVIDERS = [
  {
    id: 'suxin',
    kind: 'local',
    name: '燧心 · 本机 NPU',
    baseUrl: 'http://127.0.0.1:47300',
    model: 'translate',
    apiKey: '',
  },
];

export const DEFAULT_CONFIG = {
  enabled: true,

  // --- 触发 ---
  hotkey: 'Ctrl+Shift+F',
  pollMs: 30,

  // --- 翻译后端 ---
  providers: DEFAULT_PROVIDERS,
  activeProvider: 'suxin',   // 默认走燧心
  lang: 'en',
  translateTimeoutMs: 60000,

  // --- 行为 ---
  mode: 'replace',
  pasteDelayMs: 400,
  grabTimeoutMs: 900,
  grabRetries: 3,

  // --- 高级 ---
  koffiPath: '',
  dataRoot: '',
};

/** 当前生效的数据根（启动时解析一次，缓存） */
let _root = null;
let _cfgFile = null;

export function currentDataRoot() {
  if (!_root) {
    const c = _readConfigRaw();
    const r = ensureDataRoot(c.dataRoot || '');
    _root = r.root;
    _cfgFile = path.join(_root, 'config.json');
  }
  return _root;
}

export function configFile() {
  currentDataRoot();
  return _cfgFile;
}

function _readConfigRaw() {
  const probe = resolveDataRoot('');
  try {
    const f = path.join(probe, 'config.json');
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function loadConfig() {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return normalize({ ...DEFAULT_CONFIG });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return normalize(migrateLegacyConfig({ ...DEFAULT_CONFIG, ...(raw || {}) }));
  } catch {
    return normalize({ ...DEFAULT_CONFIG });
  }
}

export function saveConfig(patch) {
  const cur = loadConfig();
  const next = normalize({ ...cur, ...(patch || {}) });
  try {
    const f = configFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch { /* 写失败不影响内存态 */ }
  return next;
}

/**
 * 第一版配置迁移。
 *
 * 旧形态：{ baseUrl, model, apiToken }
 * 新形态：{ providers: [...], activeProvider }
 *
 * 只有当新形态**不存在**时才迁，且迁完删掉旧字段（避免两套并存）。
 */
function migrateLegacyConfig(cfg) {
  const out = { ...cfg };

  // 已经有 providers 就不用迁
  if (Array.isArray(out.providers) && out.providers.length) return out;

  // 旧配置里有 baseUrl → 保留它当燧心的地址
  const legacyBase = typeof out.baseUrl === 'string' ? out.baseUrl.trim() : '';
  const legacyModel = typeof out.model === 'string' ? out.model.trim() : '';
  const legacyKey = typeof out.apiToken === 'string' ? out.apiToken.trim() : '';

  out.providers = [
    {
      id: 'suxin',
      kind: 'local',
      name: '燧心 · 本机 NPU',
      baseUrl: legacyBase || 'http://127.0.0.1:47300',
      model: legacyModel || 'translate',
      apiKey: legacyKey || '',
    },
  ];
  out.activeProvider = 'suxin';

  // 旧字段删掉，避免和新结构冲突
  delete out.baseUrl;
  delete out.model;
  delete out.apiToken;

  return out;
}

/** 取当前激活的 provider（找不到就退回第一个） */
export function activeProvider(cfg) {
  const list = (cfg && cfg.providers) || DEFAULT_PROVIDERS;
  const want = cfg && cfg.activeProvider;
  for (const p of list) if (p.id === want) return p;
  return list[0] || DEFAULT_PROVIDERS[0];
}

/** 收敛非法值 + 永远剥掉第一版遗留字段 */
function normalize(cfg) {
  const c = { ...cfg };

  /**
   * ⚠ 必须无条件删除旧字段。
   *
   * 踩过的坑：一开始只在 migrateLegacyConfig() 里删，但那个函数
   * 在「已经存在 providers」时直接 return —— 于是旧字段永远留着，
   * 每次 saveConfig 又写回磁盘，config.json 里新旧结构并存，
   * 下次读到就混乱（谁生效说不清）。
   *
   * 所以 normalize 是唯一收口点，每次都剥。
   */
  delete c.baseUrl;
  delete c.model;
  delete c.apiToken;
  delete c.hasToken;
  if (typeof c.hotkey !== 'string' || !c.hotkey.trim()) c.hotkey = DEFAULT_CONFIG.hotkey;
  c.pollMs = clampInt(c.pollMs, 15, 200, DEFAULT_CONFIG.pollMs);
  c.pasteDelayMs = clampInt(c.pasteDelayMs, 100, 3000, DEFAULT_CONFIG.pasteDelayMs);
  c.grabTimeoutMs = clampInt(c.grabTimeoutMs, 200, 5000, DEFAULT_CONFIG.grabTimeoutMs);
  c.grabRetries = clampInt(c.grabRetries, 1, 8, DEFAULT_CONFIG.grabRetries);
  c.translateTimeoutMs = clampInt(c.translateTimeoutMs, 5000, 300000, DEFAULT_CONFIG.translateTimeoutMs);
  if (c.mode !== 'replace' && c.mode !== 'copy') c.mode = DEFAULT_CONFIG.mode;
  if (typeof c.lang !== 'string' || !c.lang.trim()) c.lang = DEFAULT_CONFIG.lang;
  c.enabled = c.enabled !== false;

  // providers 校验：至少一个，每个必须有 baseUrl + model
  const list = Array.isArray(c.providers) ? c.providers : DEFAULT_PROVIDERS;
  const clean = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const baseUrl = String(p.baseUrl || '').trim();
    const model = String(p.model || '').trim();
    if (!baseUrl || !model) continue;   // 缺地址或模型的丢弃
    clean.push({
      id: String(p.id || ('p' + clean.length)),
      kind: p.kind === 'cloud' ? 'cloud' : 'local',
      name: String(p.name || (p.kind === 'cloud' ? '云端服务' : '燧心 · 本机 NPU')),
      baseUrl,
      model,
      apiKey: String(p.apiKey || ''),
    });
  }
  c.providers = clean.length ? clean : DEFAULT_PROVIDERS;

  // activeProvider 必须指向存在的那个
  const active = c.providers.some((p) => p.id === c.activeProvider)
    ? c.activeProvider
    : c.providers[0].id;
  c.activeProvider = active;

  return c;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * 给面板用的公开配置。
 *
 * ⚠ API Key 不返回明文，只给 hasKey 布尔 —— 面板不需要看真 key，
 * 而且配置会经 HTTP 传输，明文 key 不该出门。
 */
export function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    hotkey: cfg.hotkey,
    pollMs: cfg.pollMs,
    lang: cfg.lang,
    mode: cfg.mode,
    pasteDelayMs: cfg.pasteDelayMs,
    grabTimeoutMs: cfg.grabTimeoutMs,
    grabRetries: cfg.grabRetries,
    activeProvider: cfg.activeProvider,
    providers: (cfg.providers || []).map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      hasKey: !!p.apiKey,
    })),
    dataRoot: currentDataRoot(),
  };
}