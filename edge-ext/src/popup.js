/* 弹窗：状态 + 一键连接 + 开关 + 显示方式 */
(function () {
  'use strict';

  var DSH = globalThis.DSH || {};
  var DEFAULTS = DSH.DEFAULTS || {};
  var $ = function (s) { return document.querySelector(s); };

  var ui = {
    status: $('#status'), connTitle: $('#connTitle'), connSub: $('#connSub'),
    connectBtn: $('#connectBtn'), toggle: $('#toggle'),
    progress: $('#progress'), bar: $('#bar'), count: $('#count'),
    stat: $('#stat'), statDot: $('#statDot'), statText: $('#statText'),
    mode: $('#mode'), lang: $('#lang'), hint: $('#hint'),
    opts: $('#opts'), again: $('#again'),
    autoSite: $('#autoSite'), autoSiteHint: $('#autoSiteHint')
  };

  var cfg = Object.assign({}, DEFAULTS);
  var tabId = null;
  var tabOrigin = '';       // 当前标签页的 origin，自动翻译白名单用
  var alive = true;
  var timer = null;
  var connecting = false;

  function setHint(text, cls) {
    if (!ui.hint) return;
    ui.hint.textContent = text || '';
    ui.hint.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function sendTab(msg) {
    if (tabId == null) return Promise.resolve(null);
    return chrome.tabs.sendMessage(tabId, msg).catch(function () { return null; });
  }

  /** 连接状态：绿色 = 可用；黄色 = 已配置但没验证过；红色 = 没连上 */
  function paintConn(state, info) {
    var ok = state === 'ok';
    ui.statDot.className = 'dot ' + (ok ? 'ok' : (state === 'warn' ? 'wait' : 'err'));
    if (info && info.text) ui.statText.textContent = info.text;
    if (!info || !info.connTitle) return;
    ui.connTitle.textContent = info.connTitle;
    ui.connSub.textContent = info.connSub || '';
    ui.connectBtn.textContent = ok ? '重新连接' : '一键连接';
  }

  /* -------------------------------------------- 本站自动翻译（白名单） */

  function paintAutoSite(info) {
    if (!ui.autoSite) return;
    var isFile = /^(file:|chrome-extension:|edge:|about:)/.test(tabOrigin);
    var enabled = !!(info && info.enabled);
    ui.autoSite.checked = enabled;
    ui.autoSite.disabled = !tabOrigin || isFile;
    if (ui.autoSiteHint) {
      if (!tabOrigin) {
        ui.autoSiteHint.textContent = '当前页面不可用';
        ui.autoSiteHint.className = 'hint-inline';
      } else if (isFile) {
        ui.autoSiteHint.textContent = '本地/内置页面不适用';
        ui.autoSiteHint.className = 'hint-inline';
      } else if (enabled) {
        ui.autoSiteHint.textContent = '已加入白名单 · 下次打开自动翻了';
        ui.autoSiteHint.className = 'hint-inline on';
      } else {
        ui.autoSiteHint.textContent = '默认关闭 · 打开后本站自动翻';
        ui.autoSiteHint.className = 'hint-inline';
      }
    }
  }

  /**
   * 图片自动翻译开关的显示。
   *
   * 跟「本站自动翻译」不同：这个**不需要**白名单，是全局开关
   * （所有站点都生效），因为它的触发条件是「用户主动翻了某张图之后
   * 又翻页了」—— 这本身就是强意图信号。
   */
  function paintAutoImg() {
    if (!ui.autoImg) return;
    ui.autoImg.checked = cfg.imageAutoTranslate === true;
    if (ui.autoImgHint) {
      if (cfg.imageAutoTranslate === true) {
        ui.autoImgHint.textContent = '已开启 · 翻页后自动翻新图';
        ui.autoImgHint.className = 'hint-inline on';
      } else {
        ui.autoImgHint.textContent = '默认关闭 · 一张图约 3.5 秒';
        ui.autoImgHint.className = 'hint-inline';
      }
    }
  }

  async function refreshAutoSite() {
    if (!tabOrigin) { paintAutoSite(null); return; }
    var r = await chrome.runtime.sendMessage({ t: 'getSiteAuto', origin: tabOrigin }).catch(function () { return null; });
    if (r && r.ok) paintAutoSite(r);
  }

  async function refreshConn() {
    var r = await chrome.runtime.sendMessage({ t: 'status' }).catch(function () { return null; });
    if (!r || !r.ok) return;
    cfg.endpoint = r.base || cfg.endpoint;
    if (r.model) cfg.model = r.model;

    if (r.connected) {
      var tested = r.conn && r.conn.ok;
      paintConn(tested ? 'ok' : 'warn', {
        text: tested
          ? (r.last && r.last.speed ? ('速度 ' + r.last.speed + ' tok/s') : '已连接')
          : '已配置，未验证',
        connTitle: '已连接 DSH',
        connSub: (r.conn && r.conn.model ? r.conn.model : r.model) + ' · ' + (r.base || '')
      });
      if (!ui.hint.textContent) setHint('');
    } else {
      paintConn('err', { text: '未连接', connTitle: '还没有连上 DSH', connSub: '点右边的一键连接' });
      setHint('DSH 的 NPU 插件开着的话，点「一键连接」就能找到它。', 'warn');
    }
  }

  async function doConnect() {
    if (connecting) return;
    connecting = true;
    ui.connectBtn.disabled = true;
    ui.connectBtn.textContent = '连接中…';
    setHint('正在寻找 DSH 的 NPU 插件…');
    try {
      var r = await chrome.runtime.sendMessage({ t: 'connect' });
      if (r && r.ok) {
        cfg.endpoint = r.base || cfg.endpoint;
        cfg.model = r.model || cfg.model;
        paintConn('ok', {
          text: r.speed ? ('速度 ' + r.speed + ' tok/s') : '连接正常',
          connTitle: '已连接 DSH',
          connSub: (r.model || 'translate') + ' · ' + (r.base || '')
        });
        setHint('连上了。现在可以点「翻译此页」。', 'ok');
        refreshStatsSoon();
      } else {
        paintConn('err', { text: '未连接', connTitle: '没找到 DSH', connSub: '点「设置」填面板地址' });
        var msg = (r && r.error) || '没找到 DSH 的 NPU 插件';
        if (r && r.scanned) msg += '（已扫 ' + r.scanned + ' 个地址）';
        setHint(msg + '。DSH 面板上的地址可以直接填到设置里。', 'err');
      }
    } catch (e) {
      setHint('连接失败：' + (e && e.message), 'err');
    } finally {
      connecting = false;
      ui.connectBtn.disabled = false;
    }
  }

  function paintPage(state) {
    var mode = state && state.mode ? state.mode : 'off';
    var active = mode !== 'off';
    ui.toggle.textContent = active ? '还原页面' : '翻译此页';
    if (!active) ui.toggle.insertAdjacentHTML('beforeend', ' <span class="mono">Alt+T</span>');
    ui.toggle.classList.toggle('on', active);

    ui.status.textContent = !state ? '不在当前页'
      : active ? (mode === 'only' ? '仅译文' : '双语对照') : '未翻译';

    var total = state ? state.total || 0 : 0;
    var done = state ? state.done || 0 : 0;
    if (total > 0) {
      ui.progress.hidden = false;
      ui.bar.style.width = Math.round((Math.min(done, total) / total) * 100) + '%';
      ui.count.textContent = done + ' / ' + total + ' 段';
    } else {
      ui.progress.hidden = true;
    }

    var btns = ui.mode.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].dataset.mode === (mode === 'off' ? (cfg.mode || 'bilingual') : mode));
    }
  }

  async function refreshPage() {
    if (!alive) return;
    var state = await sendTab({ t: 'dsh-status' });
    if (!state) {
      paintPage(null);
      ui.toggle.disabled = true;
      ui.toggle.textContent = '此页面不可用';
      setHint('Edge 的内置页面（edge://、扩展商店、PDF 阅读器）不允许注入脚本。', 'warn');
      return;
    }
    ui.toggle.disabled = false;
    paintPage(state);
  }

  async function refreshStats() {
    var r = await chrome.runtime.sendMessage({ t: 'status' }).catch(function () { return null; });
    if (!r || !r.ok || !r.last || !r.last.speed) return;
    ui.stat.hidden = false;
    ui.statText.textContent = r.last.speed + ' tok/s' + (r.last.model ? (' · ' + r.last.model) : '');
  }

  function refreshStatsSoon() { setTimeout(refreshStats, 600); }

  async function init() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs && tabs[0] ? tabs[0].id : null;
    try { tabOrigin = (tabs && tabs[0] && tabs[0].url) ? new URL(tabs[0].url).origin : ''; }
    catch (e) { tabOrigin = ''; }

    var res = await chrome.runtime.sendMessage({ t: 'getConfig' }).catch(function () { return null; });
    cfg = Object.assign({}, DEFAULTS, (res && res.cfg) || {});

    if (cfg.targetLang && ui.lang) {
      var has = Array.prototype.some.call(ui.lang.options, function (o) { return o.text === cfg.targetLang; });
      if (!has) {
        var o = document.createElement('option');
        o.text = cfg.targetLang;
        ui.lang.appendChild(o);
      }
      ui.lang.value = cfg.targetLang;
    }

    await refreshConn();
    await refreshAutoSite();
    paintAutoImg();
    await refreshPage();
    refreshStats();
    timer = setInterval(function () { refreshPage(); refreshStats(); }, 900);
  }

  /* ---------------------------------------------------------------- 交互 */

  ui.connectBtn.addEventListener('click', doConnect);

  if (ui.autoImg) {
    ui.autoImg.addEventListener('change', async function () {
      var want = ui.autoImg.checked;
      cfg.imageAutoTranslate = want;
      paintAutoImg();
      // 存配置（background 会广播给所有 content script）
      await chrome.runtime.sendMessage({ t: 'saveConfig', cfg: cfg }).catch(function () { return null; });
      // 立刻给当前标签页发一次，让模块马上生效
      await sendTab({ t: 'dsh-config', cfg: cfg }).catch(function () { return null; });
      setHint(want ? '已开启图片自动翻译：翻页后会自动翻新图。' : '已关闭图片自动翻译。', 'ok');
    });
  }

  if (ui.autoSite) {
    ui.autoSite.addEventListener('change', async function () {
      var want = ui.autoSite.checked;
      ui.autoSite.disabled = true;
      var r = await chrome.runtime.sendMessage({ t: 'setSiteAuto', origin: tabOrigin, enabled: want })
        .catch(function () { return null; });
      ui.autoSite.disabled = false;
      if (!r || !r.ok) {
        ui.autoSite.checked = !want;
        setHint((r && r.error) || '设置失败', 'err');
        return;
      }
      paintAutoSite(r);
      // 打开时顺便把当前页也翻一遍（用户的意图就是"现在就要中文"）
      if (want && tabId != null) {
        var st = await sendTab({ t: 'dsh-status' }).catch(function () { return null; });
        if (st && st.mode === 'off') await sendTab({ t: 'dsh-toggle' });
        refreshPage();
      }
      setHint(want ? '已加入白名单：下次打开 ' + tabOrigin + ' 会自动翻译。' : '已移出白名单：本站不再自动翻译。', want ? 'ok' : '');
    });
  }

  ui.toggle.addEventListener('click', async function () {
    var r = await sendTab({ t: 'dsh-toggle' });
    if (r) paintPage(r);
    else refreshPage();
  });

  ui.mode.addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-mode]');
    if (!b) return;
    var mode = b.dataset.mode;
    cfg.mode = mode;
    chrome.runtime.sendMessage({ t: 'saveConfig', cfg: { mode: mode } }).catch(function () {});
    var r = await sendTab({ t: 'dsh-mode', mode: mode });
    if (r) paintPage(r);
  });

  ui.lang.addEventListener('change', async function () {
    cfg.targetLang = ui.lang.value;
    chrome.runtime.sendMessage({ t: 'saveConfig', cfg: { targetLang: cfg.targetLang } }).catch(function () {});
    await sendTab({ t: 'dsh-config', cfg: cfg });
    refreshPage();
  });

  ui.opts.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  ui.again.addEventListener('click', async function () {
    var r = await sendTab({ t: 'dsh-retranslate' });
    if (r) paintPage(r);
  });

  window.addEventListener('unload', function () {
    alive = false;
    if (timer) clearInterval(timer);
  });

  init();
})();
