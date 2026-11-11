/**
 * 语言表 + 翻译客户端。
 *
 * ## 为什么走 HTTP 而不是进程内直调
 *
 * 用户明确要求走 HTTP，理由很对：**模型随时可能换**。
 * 进程内直调要把 dsh-npu 的 inference 模块 import 进来，耦合死了
 * 它的接口；走 /v1/chat/completions 只依赖 OpenAI 兼容协议，
 * 换模型、换框架、换插件版本都不影响这里。
 *
 * 代价是本机 HTTP 往返（实测约 2~5ms），相对翻译本身 180~280ms 可忽略。
 */

/**
 * 反向翻译的目标语言。
 *
 * native 用语言自称而不是中文名 —— 提示词里写 "English" / "日本語"
 * 比写 "英语" / "日语" 更准（模型对语言自称更敏感）。
 * 与浏览器扩展 dsh-translate 的 REVERSE_LANGS 保持一致。
 */
export const REVERSE_LANGS = [
  { id: 'en',    zh: '英语',     native: 'English' },
  { id: 'ja',    zh: '日语',     native: '日本語' },
  { id: 'ko',    zh: '韩语',     native: '한국어' },
  { id: 'pt',    zh: '葡萄牙语', native: 'Português' },
  { id: 'fr',    zh: '法语',     native: 'Français' },
  { id: 'de',    zh: '德语',     native: 'Deutsch' },
  { id: 'es',    zh: '西班牙语', native: 'Español' },
  { id: 'ru',    zh: '俄语',     native: 'Русский' },
  { id: 'it',    zh: '意大利语', native: 'Italiano' },
  { id: 'zh-tw', zh: '繁體中文', native: '繁體中文' },
];

export function findLang(id) {
  for (const l of REVERSE_LANGS) if (l.id === String(id || '')) return l;
  return REVERSE_LANGS[0];
}

/**
 * 反向翻译提示词。
 *
 * 三条约束缺一不可（都是实测踩出来的）：
 *   ① 必须写语言**自称**（English），只写中文名「英语」时模型有时原样返回中文；
 *   ② 必须禁止注音，否则日语会输出「日本語（にほんご）」这种没法直接发出去的文本；
 *   ③ 必须声明保留占位符，否则 {path}、@张三、URL 会被翻掉。
 */
export function buildPrompt(text, langId) {
  const l = findLang(langId);
  return [
    '把下面的中文用' + l.native + '表达出来（' + l.zh + '）。',
    '只输出' + l.native + '译文，不要输出中文原文，不要解释，不要加注音。',
    '保留原文里的 {占位符}、@提及、URL、代码片段、表情符号不动。',
    '',
    String(text),
  ].join('\n');
}

/**
 * 调燧心的 OpenAI 兼容端点翻译。
 *
 * @param {object} opts
 *   { baseUrl, model, text, langId, timeoutMs, apiToken }
 * @returns {Promise<{ok:boolean, text?:string, error?:string, ms:number}>}
 */
export async function translate(opts) {
  const t0 = Date.now();

  /**
   * 支持两种调用形态：
   *   ① 新：opts.provider = { baseUrl, model, apiKey, kind }
   *   ② 旧：opts.baseUrl / opts.model / opts.apiToken（向后兼容）
   *
   * 新形态优先。provider 就是 config 里 providers[] 的一项。
   */
  const prov = opts.provider || null;
  const base = String((prov ? prov.baseUrl : opts.baseUrl) || '').replace(/\/$/, '');
  if (!base) return { ok: false, error: '没有配置燧心地址', ms: 0 };

  const body = {
    model: String((prov ? prov.model : opts.model) || 'translate'),
    messages: [{ role: 'user', content: buildPrompt(opts.text, opts.langId) }],
    temperature: 0,
    max_tokens: 600,
    chat_template_kwargs: { enable_thinking: false },
  };

  const headers = { 'Content-Type': 'application/json' };
  const key = prov ? prov.apiKey : opts.apiToken;
  if (key) headers['Authorization'] = 'Bearer ' + key;

  let resp;
  try {
    resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || 60000),
    });
  } catch (e) {
    return { ok: false, error: '连不上燧心：' + ((e && e.message) || e), ms: Date.now() - t0 };
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { ok: false, error: 'HTTP ' + resp.status + ': ' + t.slice(0, 200), ms: Date.now() - t0 };
  }

  let j;
  try { j = await resp.json(); }
  catch (e) { return { ok: false, error: '返回不是 JSON', ms: Date.now() - t0 }; }

  const raw = j && j.choices && j.choices[0] && j.choices[0].message
    ? String(j.choices[0].message.content || '')
    : '';

  /**
   * 去掉模型偶尔套的外层引号。
   * 实测：偶尔会把整句包成 "译文" 或 “译文”，直接粘进聊天框会多两个引号。
   */
  const text = raw.trim().replace(/^[\u0022\u0027\u201c\u201d\u2018\u2019]+|[\u0022\u0027\u201c\u201d\u2018\u2019]+$/g, '').trim();

  if (!text) return { ok: false, error: '模型返回空', ms: Date.now() - t0 };
  return { ok: true, text, ms: Date.now() - t0 };
}