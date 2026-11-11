/* =============================================================================
 * DSH 翻译 · 后台
 *
 * 就三件事：
 *  1. 找到 DSH 的 NPU 插件（一键 / 自动），并记住它；
 *  2. 排队：DSH 的翻译角色是单 slot，永远一次只跑一条；
 *  3. 缓存 + 把流式增量转发给页面。
 * ========================================================================== */
importScripts('dsh.js');

var DSH = self.DSH;
var DEFAULTS = DSH.DEFAULTS;

var S = {
  cfg: null,
  queue: [],
  running: 0,
  cache: new Map(),          // 一级：内存缓存（当前会话）
  cacheMax: 900,
  disk: null,                // 二级：持久缓存（chrome.storage.local）
  diskMax: 6000,             // 持久缓存最多几条
  diskDirty: false,
  diskTimer: null,
  pumpTimer: null,
  last: null,          // 最近一次请求的统计（速度等）
  conn: null,          // 最近一次连接状态 { ok, base, model, at }
  aborts: new Map()
};

/* ---------------------------------------------------------------- 配置 */

/**
 * Blob → data URL。
 *
 * service worker 里没有 HTMLCanvasElement，所以不能用 canvas.toDataURL 路径
 * （虽然 OffscreenCanvas 有，但把 blob 画进 canvas 再导出会多一次编解码，
 *   而且会改变格式）。FileReader 是最直接的二进制转 base64 方式。
 */
function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    try {
      var fr = new FileReader();
      fr.onload = function () {
        var r = String(fr.result || '');
        // 统一转成 PNG data URL 前缀（原格式可能是 webp/jpeg，浏览器认格式 sniffing）
        resolve(r);
      };
      fr.onerror = function () { reject(new Error('读图片失败')); };
      fr.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}

/**
 * 用 OffscreenCanvas 探一下图片的原始尺寸。
 *
 * 用途：给 content script 判断「图够不够大要翻」。
 * 拿不到就返回 null —— 不编造数字。
 */
async function decodeSize(dataUrl) {
  try {
    var resp = await fetch(dataUrl);
    var blob = await resp.blob();
    var bmp = await createImageBitmap(blob);
    var out = { w: bmp.width, h: bmp.height };
    try { bmp.close(); } catch (e) {}
    return out;
  } catch (e) { return null; }
}

async function getCfg(force) {
  if (S.cfg && !force) return S.cfg;
  var got = {};
  try { got = await chrome.storage.local.get('cfg'); } catch (e) {}
  S.cfg = Object.assign({}, DEFAULTS, (got && got.cfg) || {});
  if (!Array.isArray(S.cfg.autoOffSites)) S.cfg.autoOffSites = [];
  if (!Array.isArray(S.cfg.autoOnSites)) S.cfg.autoOnSites = [];
  return S.cfg;
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.cfg) S.cfg = null;
});

/* ---------------------------------------------------------------- 自动发现 */

/** 探一个地址，是 DSH 就返回描述 */
async function tryProbe(base) {
  var cfg = await getCfg();
  try {
    var info = await DSH.probe(base, Object.assign({}, cfg, { endpoint: base }));
    if (!info) return null;
    var model = cfg.model || DSH.pickModel(info.models, info.slots);
    return { base: base, model: model, info: info };
  } catch (e) {
    return null;
  }
}

/**
 * 找 DSH。
 *
 * 为什么需要这么多手段：DSH 面板默认绑在**局域网网卡**（实测 192.168.1.3:47300），
 * 回环 127.0.0.1:47300 是关的。而 Edge 的 MV3 里：
 *   - chrome.system.network 常常不可用（那是 Chrome Apps 时代的 API），拿不到本机 IP；
 *   - 拿不到 IP 就只剩回环，必然失败。
 * 所以这里按「最可能连上」的顺序把候选地址全试一遍，最后兜底扫常见网段的 DSH 端口。
 */
async function discover(opts) {
  opts = opts || {};
  var cfg = await getCfg();
  var tried = [];       // { base, reason }
  var detail = [];

  // 1) 收集候选
  var candidates = [];

  // 用户明确填的地址排最前
  if (cfg.endpoint) candidates.push(DSH.baseOf({ endpoint: cfg.endpoint }));

  // 上次连成功过的
  try {
    var got = await chrome.storage.local.get('lastBase');
    if (got && got.lastBase) candidates.push(got.lastBase);
  } catch (e) {}

  // 本机网卡（能拿到就用；拿不到会记录原因给界面看）
  var ifaceIps = [];
  var ifaceError = '';
  try {
    if (chrome.system && chrome.system.network && chrome.system.network.getNetworkInterfaces) {
      var ifs = await chrome.system.network.getNetworkInterfaces();
      (ifs || []).forEach(function (it) {
        var ip = String((it && it.address) || '');
        if (!/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(ip)) return;
        if (/^127\./.test(ip) || /^169\.254\./.test(ip)) return;
        ifaceIps.push(ip);
      });
      if (!(ifs || []).length) ifaceError = 'getNetworkInterfaces() 返回空';
    } else {
      ifaceError = 'chrome.system.network 不可用';
    }
  } catch (e) {
    ifaceError = 'getNetworkInterfaces() 抛错：' + String((e && e.message) || e);
  }

  ifaceIps.forEach(function (ip) { candidates.push('http://' + ip + ':' + DSH.DSH_PORT); });
  candidates.push('http://127.0.0.1:' + DSH.DSH_PORT);
  candidates.push('http://localhost:' + DSH.DSH_PORT);

  // 2) 先试这些（每个 2.5 秒超时；不通立刻下一个）
  var seen = {};
  for (var i = 0; i < candidates.length; i++) {
    var b = candidates[i].replace(/\/+$/, '');
    if (seen[b]) continue;
    seen[b] = 1;
    var d = await DSH.probeDetail(b, Object.assign({}, cfg, { endpoint: b }));
    tried.push({ base: b, reason: d.reason || (d.ok ? '' : '未知') });
    if (d.ok) return { ok: true, found: { base: b, model: cfg.model || DSH.pickModel(d.models, d.slots), info: d }, tried: tried, ifaceError: ifaceError, ifaceIps: ifaceIps };
  }

  // 3) 兜底：扫网段（只扫 DSH 端口，16 路并发）
  if (opts.noScan !== true) {
    var prefixes = [];
    ifaceIps.forEach(function (ip) {
      var pr = DSH.subnetOf(ip);
      if (pr && prefixes.indexOf(pr) < 0) prefixes.push(pr);
    });
    // 用户手填的网段优先
    var manual = Array.isArray(cfg.lanSubnets) ? cfg.lanSubnets : [];
    manual.forEach(function (x) {
      var pr = DSH.subnetOf(String(x || '').trim());
      if (!pr) {
        var t = String(x || '').trim();
        if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(t)) pr = t;
      }
      if (pr && prefixes.indexOf(pr) < 0) prefixes.unshift(pr);
    });
    // 还是推不出来就用常见网段
    if (!prefixes.length) prefixes = DSH.COMMON_SUBNETS.slice();

    var scanned = 0;
    for (var q = 0; q < prefixes.length; q++) {
      var bases = DSH.subnetBases([prefixes[q]]);
      var found = await scanSubnet(bases, cfg, seen);
      scanned += bases.length;
      if (found) {
        return {
          ok: true,
          found: { base: found.base, model: cfg.model || DSH.pickModel(found.models, found.slots), info: found },
          tried: tried, scanned: scanned, prefixes: prefixes, ifaceError: ifaceError, ifaceIps: ifaceIps
        };
      }
    }
    return {
      ok: false, tried: tried, scanned: scanned, prefixes: prefixes,
      ifaceError: ifaceError, ifaceIps: ifaceIps,
      error: '没找到 DSH 的 NPU 插件'
    };
  }

  return { ok: false, tried: tried, ifaceError: ifaceError, ifaceIps: ifaceIps, error: '没找到 DSH 的 NPU 插件' };
}

/** 扫一个网段：16 路并发，命中即停 */
async function scanSubnet(bases, cfg, seen) {
  var hit = null;
  var idx = 0;
  var workers = [];
  async function worker() {
    while (idx < bases.length && !hit) {
      var b = bases[idx++];
      if (seen[b]) continue;
      seen[b] = 1;
      var d = await DSH.probeDetail(b, Object.assign({}, cfg, { endpoint: b }), 600);
      if (d.ok) { hit = d; return; }
    }
  }
  for (var w = 0; w < 16; w++) workers.push(worker());
  await Promise.all(workers);
  return hit;
}

/** 记住连接：把地址和角色写进配置 */
async function remember(hit) {
  var cfg = await getCfg(true);
  var next = Object.assign({}, cfg, { endpoint: hit.base, model: hit.model || 'translate' });
  try { await chrome.storage.local.set({ cfg: next, lastBase: hit.base }); } catch (e) {}
  S.cfg = next;
  S.conn = { ok: true, base: hit.base, model: next.model, at: Date.now() };
  return next;
}

/* ---------------------------------------------------------------- 缓存 */

/*
 * 两级缓存：
 *   L1 = 内存 Map（当前会话，最快）
 *   L2 = chrome.storage.local（跨页面/跨会话持久）
 *
 * 分片存储的原因：chrome.storage.local 一次读写整个 key 会把所有东西
 * 反序列化一遍。分 8 片后，每次只读写命中的那一片，几千条也不卡。
 *
 * 淘汰策略：按 (命中次数 × 新近度) 打分，定期把最低分的挤出去。
 */

var DISK_PREFIX = 'tc';
var DISK_SHARDS = 8;
var DISK_DIRTY = new Set();   // 待落盘的分片号

/**
 * 缓存键：必须归一化。
 *
 * 为什么：同一段文字在不同页面/位置常常带着不同的数字、空白、标点
 *   "big breasts 240.9k" vs "big breasts 240.8k"
 *   "Tags:" vs "Tags"
 * 直接拿原文当 key，缓存永远打不中（实测命中率 6/36）。
 *
 * 归一化规则：去掉数字/计数、压缩空白、统一大小写、去尾部标点。
 * 注意只做「不改变语义」的归一，别把不同的词合并了。
 */
/**
 * 缓存版本号。改了「什么算好的译文」时必须 +1，
 * 这样旧版本写进去的坏条目会自动失效（键对不上）。
 *
 * v2：术语表上线 + 字母标签标记 + temperature 0。
 *     旧条目的译文质量不达标，必须全部作废。
 */
var CACHE_VER = 'v2';

function cacheKey(lang, text) {
  var raw = String(text || '');


  // 数字**必须**留在键里。
  // 曾经把数字统一换成 '#' 想让「big breasts 240.9k」和「…240.8k」共缓存，
  // 结果 "Pages: 51" 和 "Pages: 26" 撞成同一个键 ——
  // A 画廊的「页数：26」被套到了 B 画廊上，这是最严重的一类翻译错误。
  // 计数 chip 的文本本身就是数字，翻译它没意义（content 侧已经跳过），
  // 所以这里不需要为它做归一。
  var t = raw;
  // 压缩空白、统一小写（这些不改变语义，安全）
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  // 去掉尾部标点（"Tags:" 和 "Tags" 语义相同）
  t = t.replace(/[\s:：,，.。;；!！?？*]+$/g, '');
  return CACHE_VER + '\u0000' + lang + '\u0000' + t;
}

/** 文本归一到缓存键上的分片号（稳定，不需要 hash 库） */
function shardOf(k) {
  var h = 0;
  for (var i = 0; i < k.length && i < 16; i++) {
    h = (h * 31 + k.charCodeAt(i)) >>> 0;
  }
  return h % DISK_SHARDS;
}

/** 初始化持久缓存（第一次调用时从 storage 读） */
async function diskLoad() {
  if (S.disk) return S.disk;
  var map = new Map();
  try {
    var keys = [];
    for (var i = 0; i < DISK_SHARDS; i++) keys.push(DISK_PREFIX + i);
    var got = await chrome.storage.local.get(keys);
    for (var s = 0; s < DISK_SHARDS; s++) {
      var obj = got[DISK_PREFIX + s];
      if (!obj || typeof obj !== 'object') continue;
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        // 版本前缀对不上 = 旧版本写的（译文质量不达标），直接丢弃并标记该片待重写
        if (k.indexOf(CACHE_VER + '\u0000') !== 0) { DISK_DIRTY.add(s); continue; }
        map.set(k, obj[k]);
      }
    }
  } catch (e) { /* storage 不可用时用空缓存，功能不受影响 */ }
  S.disk = map;
  if (DISK_DIRTY.size) diskScheduleFlush();   // 把清理结果落盘
  return map;
}

/** 排期把脏片刷回 storage（防抖，避免每条都写） */
function diskScheduleFlush() {
  if (S.diskTimer) return;
  S.diskTimer = setTimeout(function () { S.diskTimer = null; diskFlush(); }, 2000);
}


/** 把脏的分片写回 storage */
async function diskFlush() {
  if (!S.disk || !DISK_DIRTY.size) return;
  S.lastFlush = Date.now();
  var shards = Array.from(DISK_DIRTY);
  DISK_DIRTY.clear();
  var patch = {};
  for (var i = 0; i < shards.length; i++) {
    var s = shards[i];
    var obj = {};
    S.disk.forEach(function (v, k) {
      if (shardOf(k) === s) obj[k] = v;
    });
    patch[DISK_PREFIX + s] = obj;
  }
  try { await chrome.storage.local.set(patch); } catch (e) { /* 满了就放弃，内存缓存仍然有效 */ }
}

/** 查缓存：L1 → L2 */
function cacheGet(lang, text) {
  var k = cacheKey(lang, text);
  // L1
  if (S.cache.has(k)) {
    S.hits = (S.hits || 0) + 1;
    S.l1hits = (S.l1hits || 0) + 1;
    var v = S.cache.get(k);
    S.cache.delete(k); S.cache.set(k, v);   // LRU：命中即提到最新
    return v.text || v;
  }
  // L2
  if (S.disk && S.disk.has(k)) {
    S.hits = (S.hits || 0) + 1;
    S.l2hits = (S.l2hits || 0) + 1;
    var rec = S.disk.get(k);
    rec.hits = (rec.hits || 0) + 1;
    rec.last = Date.now();
    DISK_DIRTY.add(shardOf(k));
    diskScheduleFlush();
    // 回填 L1
    var hit = rec.text;
    cacheSet(lang, text, hit, true);
    return hit;
  }
  return null;
}

/**
 * 写缓存。
 * @param trusted  true = 已经经过模型校验的（可以直接命中）
 */
function cacheSet(lang, text, val, trusted) {
  if (!val) return;
  // 译文和原文一模一样 = 这条没翻成功（模型原样返回），
  // 绝不能当成「翻译结果」写进持久缓存 —— 否则以后永远命中这条垃圾记录。
  // 老版本确实写过一批这种记录，这是「某些行时好时坏」的根因之一。
  if (!trusted && String(val).trim() === String(text).trim()) return;
  var k = cacheKey(lang, text);

  // L1
  if (S.cache.has(k)) S.cache.delete(k);
  S.cache.set(k, val);
  while (S.cache.size > S.cacheMax) {
    var first = S.cache.keys().next();
    if (first.done) break;
    S.cache.delete(first.value);
  }

  // L2：只有「模型翻过」的才进持久库（避免把失败/半成品写进去）
  if (!S.disk) { diskLoad(); return; }   // 还没加载完：拉一次，本次先只进 L1
  S.disk.set(k, { text: val, at: Date.now(), last: Date.now(), hits: 0, src: text.slice(0, 200) });
  DISK_DIRTY.add(shardOf(k));
  diskScheduleFlush();
  if (S.disk.size > S.diskMax) diskEvict();
}

/** 淘汰：按「命中次数 × 新近度」打分，挤掉最差的 15% */
function diskEvict() {
  if (!S.disk) return;
  var arr = [];
  S.disk.forEach(function (v, k) { arr.push([k, v]); });
  var now = Date.now();
  arr.sort(function (a, b) {
    function score(x) {
      var rec = x[1];
      var ageH = (now - (rec.last || rec.at || now)) / 3600000;
      return (rec.hits || 0) * 2 - ageH;
    }
    return score(a) - score(b);
  });
  var cut = Math.max(1, Math.floor(arr.length * 0.15));
  for (var i = 0; i < cut; i++) {
    S.disk.delete(arr[i][0]);
    DISK_DIRTY.add(shardOf(arr[i][0]));
  }
  diskScheduleFlush();
}

/** 清空持久缓存 */
async function cacheClearAll() {
  // 先取消待处理的 flush —— 否则清空后 2 秒内定时器会把旧数据再写回去
  if (S.diskTimer) { clearTimeout(S.diskTimer); S.diskTimer = null; }
  S.cache.clear();
  if (S.disk) S.disk.clear();
  DISK_DIRTY.clear();
  var patch = {};
  for (var i = 0; i < DISK_SHARDS; i++) patch[DISK_PREFIX + i] = {};
  try { await chrome.storage.local.set(patch); } catch (e) {}
  // 统计清零，界面才会显示「0 条」
  S.hits = 0; S.l1hits = 0; S.l2hits = 0; S.glossHits = 0; S.lastFlush = 0;
  // 页面级术语参考也一起清 —— 不清的话新翻译仍会沿用旧术语
  S.recentTerms = [];
  // 通知所有页面重置本地单元缓存，下次翻译重新走模型
  try { await broadcastRaw({ t: 'cacheCleared' }); } catch (e) {}
}

/** 缓存统计（给设置页显示） */
async function cacheStats() {
  await diskLoad();
  var n = S.disk ? S.disk.size : 0;
  var bytes = 0;
  if (S.disk) S.disk.forEach(function (v) { bytes += (v.text || '').length + (v.src || '').length + 40; });
  return {
    entries: n, approxBytes: bytes, memEntries: S.cache.size, diskMax: S.diskMax,
    hits: S.hits || 0, l1: S.l1hits || 0, l2: S.l2hits || 0, gloss: S.glossHits || 0,
    diskLoaded: !!S.disk, lastFlush: S.lastFlush || 0
  };
}

/**
 * 判断这段文本是不是「上下文无关的短词」。
 *
 * 为什么区分：短词（big breasts、Tags:、Next、公告）在页面任何地方意思都一样，
 * 命中缓存直接替换没有任何风险，而且能极大加速；
 * 长句则可能因为上下文（在按钮里 vs 在正文里）而需要不同的措辞，
 * 缓存只能当参考，必须让模型再过一遍。
 */
function isShortWord(text) {
  var t = DSH.normSpace(text);
  if (!t) return false;
  if (t.length > 40) return false;                 // 超过 40 字肯定不是「词」
  // 词数 <= 5 且不含句末标点/换行
  var words = t.split(/\s+/).filter(Boolean).length;
  if (words > 5) return false;
  if (/[.!?。！？；;]\s*$/.test(t)) return false;   // 带句末标点是句子
  // 含冒号/逗号但也短的（"Tags:" / "Pages: 71"）仍算短词
  return true;
}

/* ---------------------------------------------------------------- 端口 */

function post(session, msg) {
  if (!session || session.closed || !session.port) return;
  try { session.port.postMessage(msg); } catch (e) { session.closed = true; }
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'dsh') return;
  var tabId = port.sender && port.sender.tab ? port.sender.tab.id : -1;
  var session = { port: port, tabId: tabId, closed: false, gen: 0 };

  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'translate') return handleTranslate(session, msg);
    if (msg.t === 'cancel') {
      var set = S.aborts.get(session);
      if (set) { set.forEach(function (c) { try { c.abort(); } catch (e) {} }); S.aborts.delete(session); }
      S.queue = S.queue.filter(function (it) { return it.session !== session; });
      return;
    }
    if (msg.t === 'progress') return setBadge(session.tabId, msg);
  });

  port.onDisconnect.addListener(function () {
    session.closed = true;
    try { void chrome.runtime.lastError; } catch (e) {}
    S.queue = S.queue.filter(function (it) { return it.session !== session; });
  });
});

async function handleTranslate(session, msg) {
  // 必须先等持久缓存加载完再处理请求：
  // diskLoad 是异步的，startup 里只是 fire-and-forget，
  // 页面一加载就发翻译请求时 S.disk 可能还是 null ——
  // 那样 cacheGet 永远 miss、cacheSet 直接丢弃，缓存等于没有。
  try { await diskLoad(); } catch (e) {}
  var cfg = await getCfg();
  var lang = msg.lang || cfg.targetLang;
  var texts = Array.isArray(msg.texts) ? msg.texts : [];
  if (!texts.length) return;
  if (typeof msg.gen === 'number') {
    if (session.gen !== msg.gen) S.recentTerms = [];   // 新一轮翻译，术语参考重置
    session.gen = msg.gen;
    S.queue = S.queue.filter(function (it) {
      return !(it.session === session && (it.gen || 0) < msg.gen);
    });
  }
  for (var i = 0; i < texts.length; i++) {
    var item = texts[i];
    if (!item || !item.key || !item.text) continue;

    // 站点术语表：命中就直出固定译名，不送模型（最准也最快）
    var term = DSH.glossaryLookup(item.text);
    if (term) {
      S.glossHits = (S.glossHits || 0) + 1;
      post(session, { t: 'seg', key: item.key, text: term, final: true, glossary: true });
      cacheSet(lang, item.text, term, true);
      continue;
    }

    // 缓存策略：
    //   - 独立单词：翻过一次就存进扩展数据库，下次直接替换
    //   - 长句：第一次由模型翻（那一次就是「校准」），结果存进数据库，
    //           下次同样直接替换 —— 已经校准过的不该再花一次推理
    // 想强制重新校准，用设置页的「清空缓存」。
    var hit = cacheGet(lang, item.text);
    // 兜底：命中的译文和原文一模一样 = 这条其实没翻成功。
    // 老版本写过一批这种 identity 记录，直接命中会让页面显示「假译文」。
    // 当成没命中，重新走模型，并顺手把这条脏数据删掉。
    if (hit != null && String(hit).trim() === String(item.text).trim()) {
      hit = null;
      if (S.disk) {
        var dk = cacheKey(lang, item.text);
        if (S.disk.has(dk)) { S.disk.delete(dk); DISK_DIRTY.add(shardOf(dk)); diskScheduleFlush(); }
      }
      if (S.cache) S.cache.delete(cacheKey(lang, item.text));
    }
    if (hit != null) {
      S.cacheHits = (S.cacheHits || 0) + 1;
      post(session, { t: 'seg', key: item.key, text: hit, final: true, cached: true });
      continue;
    }
    // 诊断：记录没命中的键（只留最近 20 条）
    S.misses = S.misses || [];
    if (S.misses.length < 20) S.misses.push({ text: item.text.slice(0, 30), key: cacheKey(lang, item.text).replace(/\u0000/g, '|') });

    S.queue.push({
      session: session, gen: session.gen, key: item.key,
      text: item.text, lang: lang, at: Date.now() + i * 0.001,
      // 长句命中缓存时把旧译文带上，让模型做「校准」而不是从零翻
      hint: (hit != null && !isShort) ? hit : null
    });
  }
  schedulePump();
}

/* ---------------------------------------------------------------- 调度 */

function schedulePump() {
  if (S.pumpTimer) return;
  S.pumpTimer = setTimeout(function () {
    S.pumpTimer = null;
    pump().catch(function () {});
  }, 20);
}

async function pump() {
  var cfg = await getCfg();
  // DSH 前面板底下是 llama.cpp router：单个请求确实串行，但同时排几批能让 prefill/decode 重叠。
  // 实测并发 3 比串行快 1.8 倍（60 段 17.3s → 9.8s）。
  var conc = Math.max(1, Math.min(6, cfg.parallelBatches || 4));
  while (S.running < conc) {
    var batch = takeBatch(cfg);
    if (!batch.length) return;
    S.running++;
    runBatch(batch, cfg)
      .catch(function (e) { failBatch(batch, String((e && e.message) || e)); })
      .then(function () {
        S.running--;
        schedulePump();
      });
  }
}

function takeBatch(cfg) {
  var q = S.queue;
  if (!q.length) return [];
  q.sort(function (a, b) { return a.at - b.at; });

  var maxSeg = Math.max(1, cfg.batchSize || 6);
  var maxChars = Math.max(120, cfg.maxChars || 900);
  var first = q[0];
  var batch = [first];
  var chars = first.text.length;
  // 同组优先：标签云/键值对这类同类短文本一起翻，模型才有上下文
  var firstGrp = first.grp || '';
  if (firstGrp) {
    for (var g = 0; g < q.length && batch.length < maxSeg; g++) {
      var git = q[g];
      if (git === first) continue;
      if (git.session !== first.session) continue;
      if (git.grp !== firstGrp) continue;
      if (chars + git.text.length > maxChars) continue;
      batch.push(git);
      chars += git.text.length;
    }
  }
  for (var i = 1; i < q.length && batch.length < maxSeg; i++) {
    var it = q[i];
    if (batch.indexOf(it) >= 0) continue;
    if (it.session !== first.session) continue;
    if (chars + it.text.length > maxChars) continue;
    batch.push(it);
    chars += it.text.length;
  }
  S.queue = q.filter(function (it) { return batch.indexOf(it) < 0; });
  return batch;
}

function failBatch(batch, message) {
  for (var i = 0; i < batch.length; i++) {
    var it = batch[i];
    post(it.session, { t: 'seg', key: it.key, text: '', final: true, failed: true });
    post(it.session, { t: 'error', message: message });
  }
}

async function runBatch(batch, cfg) {
  var model = cfg.model || 'translate';
  var base = DSH.baseOf(cfg);
  var texts = batch.map(function (it) { return it.text; });

  // 没有地址就先自动找一次
  if (!base) {
    var found = await discover();
    if (!found.ok) throw new Error('还没连上 DSH：请在设置里填 DSH 面板上的地址');
    await remember(found.found);
    cfg = await getCfg();
    base = DSH.baseOf(cfg);
    model = cfg.model || 'translate';
  }

  var ctrl = new AbortController();
  var session = batch[0].session;
  var set = S.aborts.get(session) || new Set();
  set.add(ctrl);
  S.aborts.set(session, set);

  var onSegment = function (idx, text, final) {
    var it = batch[idx];
    if (!it || !text) return;
    post(it.session, { t: 'seg', key: it.key, text: text, final: false });
  };

  // 整批都是同一个「组」（标签云、键值对）时，告诉模型它们是同类短标签
  var allSame = batch.length > 1 && batch.every(function (it) { return (it.grp || '') === (batch[0].grp || '') && it.grp; });
  var cfgB = allSame ? Object.assign({}, cfg, { sameGroup: true }) : cfg;

  // 术语一致性：把本页已经译过的「同类短文本」作为参考传给模型，
  // 让它在同一页面内保持译法一致（同一部作品名不该每次译成不同的词）。
  var hints = batch.map(function (it) { return it.hint || null; });
  if (hints.some(Boolean)) {
    cfgB = Object.assign({}, cfgB, { prevTranslations: hints });
  }
  // 本页最近译过的 6 条短文本（只对短文本生效，避免污染长句）
  if (S.recentTerms && S.recentTerms.length) {
    cfgB = Object.assign({}, cfgB, { pageTerms: S.recentTerms.slice(-6) });
  }

  var results;
  try {
    results = await DSH.translateBatch(cfgB, base, model, texts, onSegment);
  } catch (e) {
    // 连不上 → 自动重新发现一次（用户可能换了网络）
    if (/Failed to fetch|连不上|HTTP 0/i.test(String((e && e.message) || ''))) {
      var again = await discover();
      if (again.ok && again.found.base !== base) {
        await remember(again.found);
        var cfg2 = await getCfg();
        var cfg2b = allSame ? Object.assign({}, cfg2, { sameGroup: true }) : cfg2;
        results = await DSH.translateBatch(cfg2b, DSH.baseOf(cfg2b), cfg2b.model, texts, onSegment);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  } finally {
    set.delete(ctrl);
    if (!set.size) S.aborts.delete(session);
  }

  for (var i = 0; i < batch.length; i++) {
    var it = batch[i];
    var text = results[i] || '';
    if (text) {
      cacheSet(it.lang, it.text, text);
      // 记录本页术语（只收「短且真的是术语」的条目）。
      // 过滤规则：
      //   · 源文已经是中文的（日期时间、中文广告）不算术语
      //   · 纯数字/时间戳不算术语
      //   · 译文和原文一样的（identity）不算术语
      // 不过滤的话，术语参考会被"3小时27分钟前"这种垃圾撑爆，
      // 模型还可能把整段参考当成要翻的内容输出到页面上。
      var isTermCandidate = it.text.length <= 40 && text.length <= 60 && text !== it.text;
      if (isTermCandidate) {
        try {
          if (DSH.scriptStats(it.text).hanRatio >= 0.85) isTermCandidate = false;   // 源文已是中文
          if (/^[\d\s.,:：/\-+%]+[a-zA-Z]?[\u4e00-\u9fff]{0,3}$/.test(it.text)) isTermCandidate = false;  // 纯数字/时间
        } catch (e) { /* ignore */ }
      }
      if (isTermCandidate) {
        S.recentTerms = S.recentTerms || [];
        var sig = it.text.toLowerCase().trim();
        var dup = false;
        for (var rt = 0; rt < S.recentTerms.length; rt++) {
          if (S.recentTerms[rt].src.toLowerCase().trim() === sig) { dup = true; break; }
        }
        if (!dup) {
          S.recentTerms.push({ src: it.text, dst: text });
          if (S.recentTerms.length > 20) S.recentTerms.shift();
        }
      }
    }
    post(it.session, { t: 'seg', key: it.key, text: text, final: true, failed: !text });
  }
}

/* ---------------------------------------------------------------- 徽标 */

function setBadge(tabId, msg) {
  if (tabId == null || tabId < 0 || !chrome.action) return;
  var text = '';
  if (msg && msg.total > 0) text = msg.done >= msg.total ? '✓' : String(Math.min(999, msg.done));
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(function () {});
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: text === '✓' ? '#16a34a' : '#6366f1' }).catch(function () {});
  } catch (e) {}
}

/* ---------------------------------------------------------------- 快捷键 / 菜单 */

chrome.commands.onCommand.addListener(async function (cmd) {
  if (cmd !== 'toggle-translate') return;
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) return;
  try { await chrome.tabs.sendMessage(tabs[0].id, { t: 'dsh-toggle' }); } catch (e) {}
});

/**
 * 注册右键菜单（幂等）。
 *
 * ## 为什么必须幂等
 *
 * 踩过的坑：菜单只在 `onInstalled` 里创建一次。而 Edge 的
 * `onInstalled` 在「重载未打包扩展」时**不一定触发**（只有真正
 * 安装/升级才触发）。于是用户重载扩展后菜单就消失了。
 *
 * 而且如果上一次 `create` 因为重复 id 失败（静默），菜单也再也出不来。
 *
 * 所以：`removeAll()` → 重新 `create()`，两个时机都跑：
 *   · `onInstalled`（首次安装 / 升级）
 *   · `onStartup`（浏览器每次启动）
 *
 * `removeAll` 带回调，避免 create 和 remove 竞态（Edge 里这两个
 * 操作是异步的，不回调就去 create 会命中「duplicate id」）。
 */
function installContextMenus() {
  var MENU_SPECS = [
    {
      id: 'dsh-image',
      title: '用 DSH 翻译这张图的文字',
      contexts: ['image'],
      targetUrlPatterns: ['http://*/*', 'https://*/*', 'data:image/*']
    },
    {
      id: 'dsh-image-layout',
      title: '翻译这张图（推荐：位置准，约 4 秒）',
      contexts: ['image'],
      targetUrlPatterns: ['http://*/*', 'https://*/*', 'data:image/*']
    },
    {
      id: 'dsh-image-fast',
      title: '极速翻译（文本最全，位置可能不准）',
      contexts: ['image'],
      targetUrlPatterns: ['http://*/*', 'https://*/*', 'data:image/*']
    },
    {
      id: 'dsh-image-page',
      title: '整页识别这张图的文字（不盖图，列表显示）',
      contexts: ['image'],
      targetUrlPatterns: ['http://*/*', 'https://*/*', 'data:image/*']
    },
    {
      id: 'dsh-selection',
      title: '用 DSH 翻译选中的文字',
      contexts: ['selection']
    },

    /**
     * ---- 反向翻译：中文 → 外语 ----
     *
     * 用户报的需求：在聊天框/输入框里打完中文，划词选中，
     * 右键选「转译成英语/日语/…」，把中文变成能直接发出去的外语。
     *
     * 与上面 dsh-selection 的区别：
     *   · dsh-selection 是「外→中」，气泡显示译文，不动原文
     *   · dsh-reverse 是「中→外」，除了显示，还能一键**替换原文**
     *
     * 为什么用子菜单而不是「一个入口 + 弹面板选语言」：
     *   ① 用户明确要求「右键菜单中选择翻译为英、日、韩、葡等」
     *   ② 右键时页面焦点还在输入框里，弹面板会抢焦点，
     *      部分站点（Discord / 富文本编辑器）失焦会丢选区
     *   ③ 子菜单是原生 UI，快且不干扰页面
     */
    {
      id: 'dsh-reverse',
      title: '转译成外语（选中→外语）',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    },
    { id: 'dsh-rv-en',    parentId: 'dsh-reverse', title: '英语 English',      contexts: ['selection'] },
    { id: 'dsh-rv-ja',    parentId: 'dsh-reverse', title: '日语 日本語',        contexts: ['selection'] },
    { id: 'dsh-rv-ko',    parentId: 'dsh-reverse', title: '韩语 한국어',        contexts: ['selection'] },
    { id: 'dsh-rv-pt',    parentId: 'dsh-reverse', title: '葡萄牙语 Português', contexts: ['selection'] },
    { id: 'dsh-rv-fr',    parentId: 'dsh-reverse', title: '法语 Français',      contexts: ['selection'] },
    { id: 'dsh-rv-de',    parentId: 'dsh-reverse', title: '德语 Deutsch',       contexts: ['selection'] },
    { id: 'dsh-rv-es',    parentId: 'dsh-reverse', title: '西班牙语 Español',    contexts: ['selection'] },
    { id: 'dsh-rv-ru',    parentId: 'dsh-reverse', title: '俄语 Русский',       contexts: ['selection'] },
    { id: 'dsh-rv-it',    parentId: 'dsh-reverse', title: '意大利语 Italiano',   contexts: ['selection'] },
    { id: 'dsh-rv-tw',    parentId: 'dsh-reverse', title: '繁體中文',           contexts: ['selection'] },
    {
      id: 'dsh-page',
      title: '用 DSH 翻译整页',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    },
    {
      id: 'dsh-restore',
      title: '还原页面 / 关闭图片译文',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    }
  ];

  /**
   * 注册右键菜单（幂等）。
   *
   * ## 为什么要幂等注册
   *
   * 菜单只在 onInstalled 里创建一次的话，Edge「重载未打包扩展」时
   * onInstalled 不一定触发 → 菜单消失。
   * 所以 onInstalled / onStartup / SW 冷启动三个时机都调一次。
   *
   * ## 为什么不能简单 removeAll → create
   *
   * 实测（Edge 157）这个组合**很不可靠**：
   *   · removeAll 的回调里立刻 create → 撞 "Cannot create item with duplicate id"
   *   · 加 50ms 延时 → 仍可能失败（SW 刚启动时 chrome.contextMenus 还没就绪）
   *   · 加 200ms+ 延时 → 能成功，但拖慢扩展启动
   *
   * ## 最终采用的策略：**先试创建，撞车才 removeAll 重试**
   *
   * 1. 逐项 create。如果全部成功 → 完事（这是最常见的路径：
   *    SW 重启但菜单还在时，create 会报 duplicate，走第 2 步）
   * 2. 只要有一项报 duplicate，就 removeAll → 等 250ms → 全部重新创建
   * 3. 250ms 是实测的可靠值（试过 50/200/500/1000，200 起就稳定，
   *    取 250 留余量）
   *
   * 这样「SW 重启」时不会每次都 removeAll 重建（省事、无闪烁），
   * 只有真正的配置冲突才走重试路径。
   */
  function doCreate(specs, onDone) {
    var failed = [];
    var dup = false;
    var i = 0;

    function next() {
      if (i >= specs.length) { onDone(failed, dup); return; }
      var spec = specs[i++];
      try {
        chrome.contextMenus.create(spec, function () {
          var err = chrome.runtime.lastError;
          if (err) {
            if (String(err.message || '').indexOf('duplicate') >= 0) dup = true;
            else failed.push(spec.id + ': ' + err.message);
          }
          next();
        });
      } catch (e) {
        var msg = String((e && e.message) || e);
        if (msg.indexOf('duplicate') >= 0) dup = true;
        else failed.push(spec.id + ': ' + msg);
        next();
      }
    }
    next();
  }

  function settle(failed, dup) {
    S.menuReady = (failed.length === 0);
    S.menuError = failed.join('; ') || (dup ? '曾撞重复 id，已重建' : '');
  }

  try {
    S.menuReady = false;
    if (!chrome.contextMenus) { S.menuError = 'chrome.contextMenus 不可用（缺权限？）'; return; }

    // ---- 第 1 步：直接创建 ----
    doCreate(MENU_SPECS, function (failed1, dup1) {
      if (!dup1 && failed1.length === 0) {
        settle([], false);
        return;
      }
      // ---- 第 2 步：有冲突 → 清空重来 ----
      try {
        chrome.contextMenus.removeAll(function () {
          void chrome.runtime.lastError;
          setTimeout(function () {
            doCreate(MENU_SPECS, function (failed2) {
              settle(failed2, false);
              if (failed2.length) {
                try { console.warn('[DSH] 右键菜单注册失败：' + S.menuError); } catch (e) {}
              }
            });
          }, 250);
        });
      } catch (e) {
        settle([String((e && e.message) || e)], false);
      }
    });
  } catch (e) {
    S.menuReady = false;
    S.menuError = String((e && e.message) || e);
  }
}

chrome.runtime.onInstalled.addListener(function () {
  installContextMenus();
  // 装好就自动找一次 DSH，让用户打开就能用
  discover().then(function (r) {
    if (r.ok) return remember(r.found);
  }).catch(function () {});
});

// 浏览器每次启动也重建（防止 onInstalled 没触发导致菜单消失）
chrome.runtime.onStartup.addListener(function () {
  installContextMenus();
});

// SW 冷启动时也补一次（Edge 会随时回收 SW）
try { installContextMenus(); } catch (e) {}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  var id = info.menuItemId;

  /**
   * 图片翻译。
   *
   * 这是 Alt+点击失效时的**可靠兜底入口**。
   *
   * 为什么右键比 Alt+点击可靠：
   *   · 不受页面 preventDefault 影响（右键菜单是浏览器层的）
   *   · 不受透明覆盖层影响（info.srcUrl / info.linkUrl 由浏览器直接给）
   *   · 不受 Alt 键被系统/输入法截获影响
   *
   * 浏览器在 `contexts: ['image']` 时会直接给出 `info.srcUrl`
   * （图片的真实地址），我们把它转给 content script 去翻。
   */
  if (id === 'dsh-image' || id === 'dsh-image-page' || id === 'dsh-image-layout' || id === 'dsh-image-fast') {
    var srcUrl = String(info.srcUrl || '');
    if (!srcUrl) srcUrl = '';
    var mode = 'overlay';
    if (id === 'dsh-image-page') mode = 'page';
    else if (id === 'dsh-image-layout') mode = 'layout';
    else if (id === 'dsh-image-fast') mode = 'fast';
    try {
      chrome.tabs.sendMessage(tab.id, {
        t: 'dsh-image',
        url: srcUrl,
        x: info.clientX,
        y: info.clientY,
        mode: mode
      }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
    return;
  }

  // 选中文字翻译
  /**
   * 反向翻译：中文 → 外语。
   *
   * 把 info.selectionText（用户在输入框里划中的中文）和语言 id 一起转给
   * content script —— 它知道元素是 textarea / input / contenteditable，
   * 也知道怎么替换，background 只需要传话。
   */
  if (id === 'dsh-reverse' || String(id).indexOf('dsh-rv-') === 0) {
    var rvLang = 'en';
    if (String(id).indexOf('dsh-rv-') === 0) rvLang = String(id).slice('dsh-rv-'.length);
    try {
      chrome.tabs.sendMessage(tab.id, {
        t: 'dsh-reverse',
        text: String(info.selectionText || '').slice(0, 1500),
        lang: rvLang,
        x: info.clientX,
        y: info.clientY,
        editable: !!info.editable
      }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
    return;
  }

  if (id === 'dsh-selection') {
    var text = String(info.selectionText || '').slice(0, 1500);
    // 带上右键位置：右键会清掉选区，靠它给气泡定位
    try {
      chrome.tabs.sendMessage(tab.id, { t: 'dsh-selection', text: text, x: info.clientX, y: info.clientY });
    } catch (e) {}
    return;
  }

  // 整页翻译
  if (id === 'dsh-page') {
    try {
      chrome.tabs.sendMessage(tab.id, { t: 'dsh-page-translate' }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
    return;
  }

  // 还原
  if (id === 'dsh-restore') {
    try {
      chrome.tabs.sendMessage(tab.id, { t: 'dsh-restore-all' }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
    return;
  }
});

/* ---------------------------------------------------------------- 消息 */

async function broadcast(cfg) {
  await broadcastRaw({ t: 'dsh-config', cfg: cfg });
}

/**
 * 向所有标签页广播任意消息。
 *
 * 注意 broadcast(cfg) 只发配置；要用别的类型必须走这个，
 * 否则 {t:'cacheCleared'} 会被包成 {t:'dsh-config', cfg:{t:'cacheCleared'}} —— 页面收不到。
 */
async function broadcastRaw(msg) {
  try {
    var tabs = await chrome.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      if (!tabs[i].id) continue;
      try {
        chrome.tabs.sendMessage(tabs[i].id, msg).catch(function () {});
      } catch (e) {}
    }
  } catch (e) {}
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'getConfig') {
    getCfg(true).then(function (cfg) { sendResponse({ ok: true, cfg: cfg }); });
    return true;
  }

  // 一键连接：自动发现 + 记住 + 返回状态
  if (msg.t === 'connect') {
    (async function () {
      var t0 = Date.now();
      try {
        // 用户给了明确地址就只试它（但也允许网段扫描兜底）
        var target = msg.endpoint ? String(msg.endpoint).trim() : '';
        if (target) {
          var base = DSH.baseOf({ endpoint: target });
          var pd = await DSH.probeDetail(base, Object.assign({}, await getCfg(), { endpoint: base }));
          if (!pd.ok) {
            sendResponse({
              ok: false, ms: Date.now() - t0, error: pd.reason,
              tried: [{ base: base, reason: pd.reason }],
              hint: '检查 DSH 面板是否开着、端口是否正确'
            });
            return;
          }
          await remember({ base: base, model: (await getCfg()).model || DSH.pickModel(pd.models, pd.slots) });
          var d = await DSH.diagnose(await getCfg());
          S.conn = { ok: d.ok, base: base, model: d.model, at: Date.now() };
          sendResponse(Object.assign({}, d, { ok: d.ok, ms: Date.now() - t0, base: base }));
          return;
        }

        var found = await discover({});
        if (!found.ok) {
          sendResponse({
            ok: false, ms: Date.now() - t0,
            error: found.error,
            tried: found.tried,
            scanned: found.scanned,
            prefixes: found.prefixes,
            ifaceError: found.ifaceError,
            ifaceIps: found.ifaceIps,
            hint: 'DSH 面板可能绑在一个扫不到的网段。到设置里填面板上显示的地址（形如 http://192.168.x.x:47300）。'
          });
          return;
        }
        await remember(found.found);
        var diag = await DSH.diagnose(await getCfg());
        S.conn = { ok: diag.ok, base: found.found.base, model: diag.model, at: Date.now() };
        sendResponse(Object.assign({}, diag, {
          ok: diag.ok, ms: Date.now() - t0, base: found.found.base, model: diag.model,
          tried: found.tried, scanned: found.scanned, prefixes: found.prefixes,
          ifaceError: found.ifaceError, ifaceIps: found.ifaceIps
        }));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  // 连接状态（弹窗每次打开都问一次，不发请求也能显示上次结果）
  if (msg.t === 'status') {
    (async function () {
      var cfg = await getCfg();
      var base = DSH.baseOf(cfg);
      sendResponse({
        ok: true,
        connected: !!base,
        base: base,
        model: cfg.model || 'translate',
        conn: S.conn,
        last: S.last
      });
    })();
    return true;
  }

  if (msg.t === 'setMode' || msg.t === 'saveConfig') {
    (async function () {
      var cfg = await getCfg(true);
      var next = Object.assign({}, cfg, msg.cfg || {});
      await chrome.storage.local.set({ cfg: next });
      S.cfg = next;
      if (msg.t === 'saveConfig') await broadcast(next);
      sendResponse({ ok: true, cfg: next });
    })();
    return true;
  }

  if (msg.t === 'clearCache') {
    (async function () {
      await cacheClearAll();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.t === 'probeCache') {
    (async function () {
      try {
        await diskLoad();
        var k = cacheKey('简体中文', msg.text);
        var has = S.disk ? S.disk.has(k) : false;
        var hit = cacheGet('简体中文', msg.text);
        sendResponse({
          ok: true, diskLoaded: !!S.disk, entries: S.disk ? S.disk.size : 0,
          hasKey: has, hit: hit, key: k,
          cfgLang: (await getCfg()).targetLang,
          misses: S.misses || [],
          sampleKeys: S.disk ? Array.from(S.disk.keys()).slice(0, 8).map(function (x) { return x.replace(/\u0000/g, '|'); }) : [],
          rawKeys: S.disk ? Array.from(S.disk.keys()).slice(0, 8) : []
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 查询当前站点是否在白名单里（弹窗打开时用）
  if (msg.t === 'getSiteAuto') {
    (async function () {
      try {
        var cfg = await getCfg();
        var origin = String(msg.origin || '').trim();
        var on = Array.isArray(cfg.autoOnSites) ? cfg.autoOnSites : [];
        var off = Array.isArray(cfg.autoOffSites) ? cfg.autoOffSites : [];
        sendResponse({
          ok: true,
          origin: origin,
          enabled: cfg.autoTranslate !== false && on.indexOf(origin) >= 0 && off.indexOf(origin) < 0,
          onSites: on, offSites: off, globalOn: cfg.autoTranslate !== false
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // 把当前站点加入/移出白名单
  if (msg.t === 'setSiteAuto') {
    (async function () {
      try {
        var cfg = await getCfg();
        var origin = String(msg.origin || '').trim();
        if (!origin) { sendResponse({ ok: false, error: '没有站点来源' }); return; }
        var on = Array.isArray(cfg.autoOnSites) ? cfg.autoOnSites.slice() : [];
        var off = Array.isArray(cfg.autoOffSites) ? cfg.autoOffSites.slice() : [];
        if (msg.enabled) {
          // 开：加进白名单，同时从黑名单移除（两者互斥）
          if (on.indexOf(origin) < 0) on.push(origin);
          var oi = off.indexOf(origin);
          if (oi >= 0) off.splice(oi, 1);
        } else {
          // 关：从白名单移除
          var ii = on.indexOf(origin);
          if (ii >= 0) on.splice(ii, 1);
        }
        // 用户在弹窗里显式打开 → 顺带把总开关也打开（否则白名单形同虚设）
        var next = { autoOnSites: on, autoOffSites: off };
        if (msg.enabled) next.autoTranslate = true;
        var cur = await getCfg();
        var merged = Object.assign({}, cur, next);
        await chrome.storage.local.set({ cfg: merged });
        S.cfg = merged;
        await broadcast(merged);
        sendResponse({
          ok: true, origin: origin,
          enabled: merged.autoTranslate !== false && on.indexOf(origin) >= 0,
          onSites: on, offSites: off, globalOn: merged.autoTranslate !== false
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.t === 'cacheStats') {
    (async function () {
      var st = await cacheStats();
      sendResponse(Object.assign({ ok: true }, st));
    })();
    return true;
  }

  /**
   * 跨域图片抓取。
   *
   * ## 为什么需要这个
   *
   * nhentai / pixiv / 各种图床的图片都在**独立域名**上：
   *   页面   https://nhentai.net/g/695718/3/
   *   图片   https://i4.nhentai.net/galleries/4314521/3.webp
   *
   * content script 里把这种图 drawImage 到 canvas 后，canvas 会被标记为
   * **tainted（被污染）**，任何 getImageData / toDataURL 都抛 SecurityError：
   *
   *   Uncaught DOMException: Failed to execute 'getImageData' on
   *   'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.
   *
   * 所以我们读不到像素 —— 图片翻译直接失效。
   *
   * ## 解法
   *
   * 在 **background** 里 fetch 图片。background 的 fetch 走扩展的
   * host_permissions（manifest 里已经是「所有 http 与 https 域名」），
   * **不受页面同源策略限制**，能拿到图片的二进制。
   *
   * 拿回来后用 `file://` 不行（那是文件系统），要在扩展上下文里解码成
   * ImageBitmap 或直接回 dataURL 给 content script。
   *
   * 最简单可靠的路径：background 里 fetch → blob → FileReader → dataURL。
   * （background 是 service worker，有 FileReader）
   */
  if (msg.t === 'fetchImage') {
    (async function () {
      var t0 = Date.now();
      try {
        var url = String(msg.url || '');
        if (!/^https?:/i.test(url)) { sendResponse({ ok: false, error: '不是 http(s) 地址' }); return; }

        var resp = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
        if (!resp.ok) { sendResponse({ ok: false, error: 'HTTP ' + resp.status }); return; }

        var blob = await resp.blob();
        // 20MB 上限：再大的图大概率是超清原图，缩了也没意义
        if (blob.size > 20 * 1024 * 1024) {
          sendResponse({ ok: false, error: '图片太大（' + Math.round(blob.size / 1048576) + ' MB）' });
          return;
        }

        var dataUrl = await blobToDataUrl(blob);
        var img = await decodeSize(dataUrl);
        sendResponse({
          ok: true,
          dataUrl: dataUrl,
          width: img ? img.w : 0,
          height: img ? img.h : 0,
          bytes: blob.size,
          ms: Date.now() - t0
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  /**
   * 图片翻译：把一张裁剪好的小图块送给 DSH 的 translate 角色。
   *
   * 为什么用 translate 而不是 vision：
   *   · translate 现在配了 mmproj，本身就能看图
   *   · 它是**专用翻译模型**，质量比 vision 顺带翻译好
   *   · 只要一个模型，少一次模型切换
   *
   * 实测：单块 80~120ms。
   */
  /**
   * 整页图片翻译（更简单的一步式方案）。
   *
   * ## 跟 translateImageBlock 的区别
   *
   * translateImageBlock 走「CV 定位 → 逐块 OCR+翻译」，能原位替换译文，
   * 但纯 CV 在网点纸背景上会漏检（实测 7 个气泡只找到 4 个）。
   *
   * translateImagePage 走「整页 OCR 一次 → 整页翻译一次」：
   *   · 只调用 2 次模型（~2000ms）
   *   · **气泡覆盖率 100%**（模型能读全，不受 CV 漏检影响）
   *   · 但没有 bbox，只能在面板里列表展示，不能原位盖
   *
   * 两者互补，让用户按场景选。
   */
  /**
   * 图片版面检测（Surya-OCR-2）。
   *
   * 只给 bbox + label，不给文字内容。用来解决「框不准」导致的错位/超框。
   *
   * 输出：
   *   { ok, boxes: [{x,y,w,h,label}], raw, ms }
   *   x/y/w/h 是 0~1 归一化比例
   */
  if (msg.t === 'detectImageLayout') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var dataUrl = String(msg.dataUrl || '');
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据' }); return;
        }
        var r = await DSH.suryaLayout(base, cfg, dataUrl, {
          model: cfg.layoutModel || 'layout',
          maxTokens: msg.maxTokens || 1400
        });
        sendResponse(Object.assign({ ms: Date.now() - t0 }, r));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  /**
   * 快速模式：整页 OCR 拿文本 + CV 拿位置。
   *
   * 实测三张剧情图覆盖 7/6/4 段（= OCR 全部），而 Surya 只给 3/5/3 框。
   * 速度快 2 倍（1628~2550ms vs 5000ms+）。
   */
  /**
   * 提取 src/zh 对（供图像重绘用）。
   *
   * 流程：整页 OCR（vision）→ 整页翻译（translate，编号对齐）→ 配对
   */
  if (msg.t === 'extractPairs') {
    (async function () {
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var dataUrl = String(msg.dataUrl || '');
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据' }); return;
        }
        var r = await DSH.extractPairs(base, cfg, dataUrl, {
          targetLang: String(msg.targetLang || cfg.targetLang || '简体中文'),
          ocrModel: cfg.ocrModel || 'vision',
          model: cfg.imgModel || cfg.model
        });
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  /**
   * 图像重绘（Qwen-Image-Edit，魔搭异步 API）。
   *
   * 参数：dataUrl（原图）、pairs（[src,zh]）、apiKey / baseUrl / model（从配置读）
   */
  if (msg.t === 'imageEditTranslate') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var apiKey = String(msg.apiKey || cfg.imageEditApiKey || '');
        var baseUrl = String(msg.baseUrl || cfg.imageEditBaseUrl || 'https://api-inference.modelscope.cn');
        if (!apiKey) {
          sendResponse({ ok: false, error: '没有配 ModelScope API Key（设置页 → 图像重绘）', ms: 0 });
          return;
        }
        var dataUrl = String(msg.dataUrl || '');
        var pairs = Array.isArray(msg.pairs) ? msg.pairs : [];
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据', ms: 0 }); return;
        }
        if (!pairs.length) {
          sendResponse({ ok: false, error: '没有替换对', ms: 0 }); return;
        }
        var r = await DSH.imageEditTranslate(baseUrl, apiKey, dataUrl, pairs, {
          model: String(msg.model || cfg.imageEditModel || 'Qwen/Qwen-Image-Edit'),
          timeoutMs: msg.timeoutMs || 300000
        });
        sendResponse(Object.assign({ ms: Date.now() - t0 }, r));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }
  if (msg.t === 'translateImageFast') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var dataUrl = String(msg.dataUrl || '');
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据' }); return;
        }
        var r = await DSH.ocrPairTranslate(base, cfg, dataUrl,
          msg.cvBoxes || [], msg.imageW || 0, msg.imageH || 0, {
            targetLang: String(msg.targetLang || cfg.targetLang || '简体中文'),
            ocrModel: cfg.ocrModel || 'vision',
            model: cfg.imgModel || cfg.model,
            maxTokens: msg.maxTokens || 900
          });
        sendResponse(Object.assign({ ms: Date.now() - t0 }, r));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  if (msg.t === 'translateImagePage') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var target = String(msg.targetLang || cfg.targetLang || '简体中文');
        var dataUrl = String(msg.dataUrl || '');
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据' }); return;
        }
        var r = await DSH.visionPageTranslate(base, cfg, dataUrl, {
          targetLang: target,
          ocrModel: cfg.ocrModel || 'vision',
          model: cfg.imgModel || cfg.model,
          maxTokens: msg.maxTokens || 800
        });
        sendResponse(Object.assign({ ms: Date.now() - t0 }, r));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  if (msg.t === 'translateImageBlock') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var target = String(msg.targetLang || cfg.targetLang || '简体中文');
        var dataUrl = String(msg.dataUrl || '');
        if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
          sendResponse({ ok: false, error: '不是有效的图片数据' }); return;
        }

        /**
         * 走**两阶段流水线**：vision 做 OCR → translate 做翻译。
         *
         * 为什么不用一步到位（visionTranslateBlock）：
         * 实测真实漫画页的竖排日文，一步到位识别就错了：
         *   「どうですか？私の料理は採れたてのものを用意しました」
         *   → 「どうれたどうてですかのと？…」（字符错乱）
         *
         * 两阶段：
         *   vision OCR   → 「どうですか？私の料理は採れたてのものを用意しました」 ✓
         *   translate    → 「怎么样？我用了最新鲜的食材做的菜。」 ✓
         *
         * 因为 OCR 和翻译是两种能力，2B 模型一次干两件事会顾此失彼。
         *
         * 配置里能把 twoStage 关掉（退回一步到位，慢但少一次请求）。
         */
        var useTwo = (cfg.twoStage !== false) && !msg.oneShot;
        var r = useTwo
          ? await DSH.visionTwoStage(base, cfg, dataUrl, {
              targetLang: target,
              ocrModel: cfg.ocrModel || 'vision',
              translateModel: cfg.imgModel || cfg.model,
              maxTokens: msg.maxTokens || 300
            })
          : await DSH.visionTranslateBlock(base, cfg, dataUrl, {
              targetLang: target,
              model: cfg.imgModel || cfg.model,
              maxTokens: msg.maxTokens || 220
            });
        sendResponse(Object.assign({ ok: true, ms: Date.now() - t0 }, r));
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  // 选词翻译
  /**
   * 反向翻译：中文 → 外语。
   *
   * 与 translateText 的区别：
   *   · translateText 走 buildTextTranslatePrompt（默认简体中文）
   *   · 这里走 buildReversePrompt，目标是用户指定的外语
   *
   * 缓存键带上语言 id —— 同一句中文翻成英/日/韩是不同结果，不能串。
   */
  if (msg.t === 'translateReverse') {
    (async function () {
      var t0 = Date.now();
      try {
        var cfg = await getCfg();
        var base = DSH.baseOf(cfg);
        if (!base) {
          var found = await discover();
          if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
          await remember(found.found);
          cfg = await getCfg();
          base = DSH.baseOf(cfg);
        }
        var text = String(msg.text || '').trim();
        if (!text) { sendResponse({ ok: false, error: '没有文本' }); return; }
        if (text.length > 1500) text = text.slice(0, 1500);

        var L = DSH.reverseLang(msg.lang);
        var prompt = DSH.buildReversePrompt(text, L.id);
        var r = await DSH.chatText(base, cfg, cfg.model || 'translate', prompt, {
          maxTokens: 600,
          timeoutMs: 60000
        });

        var out = String(r.content || '').trim();
        // 去掉模型偶尔套的引号（实测偶发）
        out = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        S.last = { speed: r.speed, model: r.model, at: Date.now() };
        sendResponse({ ok: true, text: out, lang: L.id, ms: Date.now() - t0 });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }

  if (msg.t === 'translateText') {
    (async function () {
      var cfg = await getCfg();
      var base = DSH.baseOf(cfg);
      if (!base) {
        var found = await discover();
        if (!found.ok) { sendResponse({ ok: false, error: '还没连上 DSH' }); return; }
        await remember(found.found);
        cfg = await getCfg();
        base = DSH.baseOf(cfg);
      }
      try {
        var res = await DSH.translateBatch(cfg, base, cfg.model, [String(msg.text || '')], null);
        sendResponse({ ok: true, text: res[0] || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  return false;
});
