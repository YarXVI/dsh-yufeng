/* =============================================================================
 * DSH 翻译 · 内容脚本
 *
 * 目标：简单、稳、好看。
 *  - 只翻「真的一段话」（叶子块元素），不碰按钮/链接/表格布局；
 *  - 译文以 <span class="dsh-tr"> 追加在原块里，双语对照；
 *  - 「仅译文」用元素级标记，SPA 重建 DOM 也不会打回双语；
 *  - 富文本（<b>/<a>/<code>）按标签回填，对不上就退回纯文本，绝不错位。
 * ========================================================================== */
(function () {
  'use strict';

  var DSH = globalThis.DSH;
  if (!DSH || globalThis.__DSH_INSTALLED__) return;
  globalThis.__DSH_INSTALLED__ = true;

  /* ---------------------------------------------------------------- 常量 */

  var INLINE_TAGS = new Set([
    'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
    'EM', 'FONT', 'I', 'IMG', 'INPUT', 'INS', 'KBD', 'LABEL', 'MARK', 'METER', 'NOBR',
    'OUTPUT', 'PROGRESS', 'Q', 'RB', 'RP', 'RT', 'RTC', 'RUBY', 'S', 'SAMP', 'SMALL',
    'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR'
  ]);

  var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK',
    'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK',
    // PRE 里的代码缩进敏感，整块跳过
    'PRE',
    // 输入控件本身不翻内容（placeholder 走属性翻译）
    'TEXTAREA', 'INPUT',
    // 表单容器：它的「源文本」是把所有选项拼在一起，翻了会乱；选项由 OPTION 自己处理
    'SELECT'
  ]);

  var INTERACTIVE_SEL = 'a[href], button, [role="button"], [onclick], summary, label[for]';

  /**
   * 站点级内置跳过规则。
   *
   * 有些站点的「导航壳」（服务器图标栏、频道列表、成员列表）结构极复杂：
   * 图标可能是 <img>、可能是背景图、可能套三层 div、还可能被虚拟滚动复用节点。
   * 靠逐个元素的启发式判断，在这种结构上永远会漏 —— 一个判断失误就会把图标包进
   * .dsh-orig 然后隐藏掉。
   *
   * 所以对这些区域直接整体跳过：一个元素都不碰，风险为零。
   * 想翻这些地方的用户可以在设置页把 host 从「跳过」里删掉。
   */
  var SITE_RULES = [
    {
      /**
       * Discord 导航壳。用户给出的是真实结构（2026-11）：
       *
       *   <nav class="wrapper_5dQHTG guilds_pog620" aria-label="服务器侧栏">
       *     <div role="tree" data-list-id="guildsnav" aria-orientation="vertical" class="tree_5dQHTG">
       *       <div class="listItem_rwEpil">
       *         <div class="blobContainer_IapWk5 selected_IapWk5">
       *           <svg width="48" height="48" class="svg_qhZPSU shiftSVG_qhZPSU">
       *             <foreignObject mask="url(#_r_mp_)" width="40" height="40">
       *               ...
       *               <div class="wrapper_JJ-hqG selected_JJ-hqG" role="treeitem"
       *                    data-list-item-id="guildsnav___14790024850480480266"></div>
       *
       * 关键点：
       *  - 图标最终是 **<svg> 里的 <foreignObject> 套一个 div**，不是 <img>、也不一定是背景图
       *  - 「服务器名」不在 DOM 里，只在 aria-label / span.hiddenVisually 里
       *  - 所以这块区域根本没有「该翻的文字」，翻它只会把 SVG 结构搞坏
       *
       * data-list-id 是 Discord 长期稳定的标记（class 名每版本都混淆）。
       */
      host: /^(?:canary\.|ptb\.)?discord\.(?:com|app|gg)$/i,
      autoDetect: 'data-list-id="guildsnav"',
      selectors: [
        'nav[aria-label="服务器侧栏"]',
        'nav[aria-label="Servers sidebar"]',
        '[data-list-id="guildsnav"]',                 // 图标栏 tree
        '[data-list-item-id^="guildsnav___"]',        // 图标栏每一项
        '[data-list-id="channels"]',                  // 频道列表 tree
        '[data-list-item-id^="channels___"]',
        '[data-list-id="guildsnav"] [role="treeitem"]',
        '[data-list-id="private-channels"]',           // 私信列表
        '[data-list-item-id^="private-channels"]'
      ],
      label: 'Discord 导航栏（服务器图标栏 + 频道列表）'
    },
    {
      /**
       * Discord **消息区里的元信息**不能翻。
       *
       * 用户报的两个地方：
       *
       *   ① 频道聊天里的「用户名 + 时间」
       *      截图：`Deleted User  2024/9/18 09:55`
       *      翻它毫无意义 —— 用户名是专名（翻错更糟），日期是数字。
       *
       *   ② 右侧「成员列表」里的文本
       *      截图：一整列用户（!A LittlePan、Honeybot、YarXVI、
       *      "Rubi~2.9、Kira …）
       *      那是**人员名录**，不是聊天内容。翻它只会把昵称搞乱。
       *
       * ## 怎么定位（Discord 的稳定标记）
       *
       * Discord 的 class 名每版本都混淆，但有长期稳定的 aria / data 属性：
       *
       *   · 消息头部：`[class*="message"]` 里的 header 容器。
       *     更稳的是 `[aria-label*="，"]`（含时间的那层）——
       *     但最可靠的是配合下面的「文本启发式」。
       *   · 成员列表：`[data-list-id="members"]`（Discord 长期用它标记右侧成员栏），
       *     以及 `[aria-label="成员列表"]` / `[aria-label="Members list"]`。
       *
       * ## 为什么不只靠 selector
       *
       * Discord 改版频繁，纯 selector 会失效。所以这里再加一条
       * **文本启发式**（见 isDiscordMetaText）：无论目标在哪，
       * 只要「这段文本 = 纯日期 / 纯时间 / 纯数字ID」就不翻。
       *
       * 两条一起上，第一条专治"结构上认得出"，第二条兜底"结构变了也能挡"。
       */
      host: /^(?:canary\.|ptb\.)?discord\.(?:com|app|gg)$/i,
      autoDetect: 'data-list-id^="members-"',
      skipWhole: false,     // 不能整块跳（成员列表里有些是状态文字，但也不该翻）
      selectors: [
        /*
         * ---- ① 右侧成员列表（整块不翻）----
         *
         * ⚠ 踩过的坑（用户给出真实 DOM 后才发现）：
         *
         * 我原来写 `[data-list-id="members"]`（**精确匹配**）→ **匹配 0 个**。
         *
         * 真实结构（Discord 2026-11）：
         *   <div class="members_x" role="list" aria-label="成员"
         *        data-list-id="members-128429929153464371">
         *                          ^^^^^^^ **带频道 ID 后缀**！
         *
         * 每个成员项也一样：
         *   <div class="member_x" role="listitem"
         *        data-list-item-id="members-128429929153464371__0">
         *
         * 所以必须用**前缀匹配**：`[data-list-id^="members-"]`
         */
        '[data-list-id^="members-"]',
        '[data-list-item-id^="members-"]',
        'aside[class*="membersWrap"]',
        'nav[aria-label="Members"]',
        '[aria-label="成员列表"]',
        '[aria-label="Members list"]',
        '[aria-label="成员"]',
        /* 成员项的 role=listitem 只在上面的 list 里出现，但补一条兜底 */
        '[role="listitem"][data-list-item-id*="members"]',
        /* 「APP / ✓ 已验证」徽章文本 */
        '[class*="botTag"]',
        '[class*="botText"]',
        /* 「服务器标签: HST」chip */
        '[class*="clanTag"]',
        '[class*="tagText"]',
        /* 分组标题：Bot — 2 / 在线 — 1,481 */
        'h3[class*="membersGroup"]',
        '[class*="membersGroupName"]',
        /* 成员状态副文本（正在玩 xxx / 自定义状态）*/
        '[class*="customStatusContent"]',
        /*
         * ---- ② 消息头部（用户名 + 时间）----
         *
         * ⚠ 踩过的坑：第一版写成 `[class*="messageContent_"] [class*="header_"]`
         * （后代选择器），**匹配 0 个**。
         *
         * 因为 Discord 的真实结构是：
         *   <div class="body_x">
         *     <div class="header_x">用户名 + 时间</div>   ← 和 messageContent 是**兄弟**
         *     <div class="messageContent_x">正文</div>
         *   </div>
         *
         * header 不是 messageContent 的后代，所以后代选择器抓不到。
         * 用 `:has()` 从父级反查（Edge 157 / Chromium 157 早已支持）：
         */
        'div:has(> [class*="messageContent_"]) > [class*="header_"]',
        'div:has(> [class*="messageContent_"]) [class*="timestamp"]',
        'div:has(> [class*="messageContent_"]) time[datetime]',
        /* ---- ③ 时间戳本身 ---- */
        'time[datetime]',
        /* ---- ④ 回复链/子区标签 ---- */
        '[class*="replyLink_"]',
        '[class*="threadMessageAccessory_"]'
      ],
      /**
       * **祖先级跳过**：命中这些选择器的元素，其整棵子树都不翻。
       *
       * 为什么需要和 selectors 分开：
       *   · selectors 只判「元素自己」。collect 递归遇到容器时能剪枝，
       *     但如果容器里有 React Portal / 动态挂载的子节点，可能剪不干净。
       *   · ancestorSelectors 用 closest **往上找祖先**，更彻底。
       *
       * 为什么只给这一条规则加 closest：
       *   无条件 closest 上溯会把整棵消息树算成「在侧栏里」，导致整站不翻。
       *   所以这个能力只给明确标记了 ancestorSelectors 的规则用。
       *
       * 实测解决的 bug：成员列表里的「服务器标签: HST」
       * 之前被翻译成「服务器标签: 高」这类乱码，就是因为它虽然
       * 在 [data-list-item-id^="members-"] 里，但 shouldSkip 只判
       * 「元素自己」—— 那个 div 自己没命中，于是漏了。
       */
      ancestorSelectors: [
        '[data-list-id^="members-"]',
        'aside[class*="membersWrap"]',
        /* 分组标题（Bot — 2、在线 — 1,481、collaborator — 1）*/
        'h3[class*="membersGroup"]',
        /* 成员项本身（role=listitem + data-list-item-id 双保险）*/
        '[role="listitem"][data-list-item-id^="members-"]',
      ],
      label: 'Discord 消息元信息 + 成员列表'
    },
    {
      /**
       * nhentai / e-hentai：标签页的「专名行」不能翻。
       *
       *   <tr><td class="tc">Artists:</td><td><div class="tags">
       *     <span class="gt"><a><span class="gtl">shikou shiki</span><span class="gtc">13</span></a></span>
       *
       * 作者名、社团名、原作名都是专名，翻了没意义还容易出洋相
       * （"shikou shiki" 会被翻成「策略策略」）。
       * 标签行（Tags）是分类词，要翻（走术语表）。
       */
      host: /^(?:www\.)?nhentai\.net$|^(?:www\.)?e-hentai\.org$|^(?:ex)hentai\.org$/i,
      // nhentai 2026 改版后的结构：
      //   <section id="tags">
      //     <div>Categories: <span><a><span>doujinshi</span></a></span></div>
      //   旧版是 <table id="gdd"><tr><td class="tc">…。两个都要认。
      autoDetect: 'id="tags"',
      properNounRows: /^(?:Artists|Groups|Parodies|Uploader|Artist|Group|Parody|Characters|Character|Uploaded by|角色|艺术家|团体|小组|乐团)\s*[:：]?$/i,
      rowSelector: '#tags > div, #gdd tr',
      label: 'nhentai 专名行（作者/社团/原作）'
    },
    {
      // Slack：左侧工作区栏 + 频道列表
      host: /^app\.slack\.com$/i,
      selectors: ['[class*="p-channel_sidebar"]', '[class*="p-workspace"]', '[data-qa="channel_sidebar_name"]'],
      label: 'Slack 侧栏'
    }
  ];

  /** 当前页面命中的站点规则 */
  /**
   * 找出**所有**命中本页的站点规则。
   *
   * ⚠ 踩过的坑（v4.1.x）：原来叫 matchSiteRule，**匹配第一个就 return**。
   *
   * 结果：Discord 有两条规则
   *   ① 导航壳（服务器图标栏 + 频道列表）—— 排在前面
   *   ② 消息元信息 + 成员列表 —— 排在后面
   *
   * → 第 ① 条先命中就 return → **第 ② 条永远不生效**。
   * → 用户报「成员列表还是被翻」「服务器标签被翻成乱码」就是这个原因。
   *
   * 修法：返回**数组**，把所有命中规则的 selectors 合并。
   */
  function matchSiteRules() {
    var host = '';
    try { host = (location.hostname || '').toLowerCase(); } catch (e) { return []; }
    // 测试用：?dshSite=discord.com 强制套用某个站点的规则
    try {
      var forced = new URLSearchParams(location.search || '').get('dshSite');
      if (forced) host = String(forced).toLowerCase();
    } catch (e) { /* ignore */ }
    if (!host) return [];
    var hits = [];
    for (var i = 0; i < SITE_RULES.length; i++) {
      try {
        if (SITE_RULES[i].host.test(host)) hits.push(SITE_RULES[i]);
      } catch (e) { /* ignore */ }
    }
    if (hits.length) return hits;
    // 结构自动识别：域名不匹配（换肤版、桌面客户端 WebView、镜像站）时，
    // 看页面里有没有 Discord 的结构标记。
    var auto = [];
    for (var j = 0; j < SITE_RULES.length; j++) {
      var ad = SITE_RULES[j].autoDetect;
      if (!ad) continue;
      try {
        if (document.querySelector('[' + ad + ']')) auto.push(SITE_RULES[j]);
      } catch (e) { /* ignore */ }
    }
    return auto;
  }

  /**
   * 这个元素是否在「专名行」里（作者/社团/原作）。
   *
   * 结构：<tr><td class="tc">Artists:</td><td>...chips...</td></tr>
   * 判据：往上找最近的行容器，看它的键名是不是专名类。
   */
  function inProperNounRow(el) {
    var sr = siteSelectors();
    if (!sr || !sr.properNounRows || !el) return false;
    try {
      // 新结构：行是 <div>，键名是**裸文本节点**（不是 td）
      var rowDiv = el.closest ? el.closest('#tags > div') : null;
      if (rowDiv) {
        var bare = '';
        for (var bn = rowDiv.firstChild; bn && bn.nodeType === 3; bn = bn.nextSibling) {
          if (bn.nodeValue) bare += bn.nodeValue;
        }
        bare = bare.trim();
        // 键名翻译过之后裸文本会被清空，改看 label span 里存的原文。
        // 不这么做的话，第二次翻译（或 SPA 重渲染）时专名行判定就失效了，
        // 「mizuryu kei」会被当成普通标签翻成「美津留景」。
        if (!bare) {
          var lab = rowDiv.querySelector('.dsh-tr-label');
          if (lab) bare = (lab.getAttribute('data-dsh-src') || '').trim();
        }
        if (sr.properNounRows.test(bare)) {
          // 键名本身要翻（"Artists:" → "艺术家:"），只有链接里的值不翻
          return !isBareTextOf(rowDiv, el);
        }
        return false;
      }

      // 旧结构：<table id="gdd">
      var row = el.closest ? el.closest('tr, .row') : null;
      if (!row) return false;
      var cells = row.querySelectorAll('td, .tc, .field');
      if (!cells.length) return false;

      // 找出「键名单元格」：文字匹配专名模式的那个
      var keyCell = null;
      for (var ci = 0; ci < cells.length; ci++) {
        var label = (cells[ci].textContent || '').trim();
        if (sr.properNounRows.test(label)) { keyCell = cells[ci]; break; }
      }
      if (!keyCell) return false;

      // 关键：键名单元格本身要翻（"Artists:" → "艺术家:"），只有「值」不翻。
      // 所以如果 el 在键名单元格里，返回 false（照常翻译）。
      if (keyCell.contains && keyCell.contains(el)) return false;
      if (el.closest && el.closest('td, .tc, .field') === keyCell) return false;

      // 其余（值单元格里的 chip）= 专名，不翻
      return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** el 是不是「行首裸文本键名」本身（没有元素祖先在链接里） */
  function isBareTextOf(rowDiv, el) {
    try {
      if (!el || !el.closest) return false;
      if (el.closest('a[href]')) return false;      // 在链接里 = 是值
      return true;                                   // 不在链接里 = 是键名
    } catch (e) { return false; }
  }

  /** 这个元素（或它的祖先）是否落在站点跳过区域里 */
  function inSiteSkippedArea(el) {
    var sr = siteSelectors();
    if (!sr || !el || !sr.selectors) return false;
    for (var i = 0; i < sr.selectors.length; i++) {
      try {
        if (el.matches && el.matches(sr.selectors[i])) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  /** 缓存一次，避免每个元素都查（现在缓存的是**规则数组**） */
  var _siteRules;
  var _siteRulesDone = false;
  function siteRules() {
    if (!_siteRulesDone) { _siteRules = matchSiteRules(); _siteRulesDone = true; }
    return _siteRules;
  }

  /**
   * 把所有命中规则的 selectors / ancestorSelectors 合并成一个视图。
   *
   * 为什么需要合并：Discord 有两条规则（导航壳、成员列表），
   * 各自贡献不同的选择器。判定时应该**任意一条命中就算命中**。
   */
  function siteSelectors() {
    var list = siteRules();
    if (!list || !list.length) return null;
    var sel = [], anc = [], properNoun = null, host = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      host = host || r.host;
      if (r.selectors) for (var a = 0; a < r.selectors.length; a++) sel.push(r.selectors[a]);
      if (r.ancestorSelectors) for (var b = 0; b < r.ancestorSelectors.length; b++) anc.push(r.ancestorSelectors[b]);
      /**
       * ⚠ 必须保留**原始正则**，不能转成 boolean。
       *
       * inProperNounRow 里用的是 `sr.properNounRows.test(bare)`。
       * 我第一版把它聚合成 boolean，结果 `.test` 不存在 →
       * 专名行判定直接抛异常被 catch 掉 → 返回 false → 全都不跳过。
       */
      if (r.properNounRows && !properNoun) properNoun = r.properNounRows;
    }
    return { selectors: sel, ancestorSelectors: anc, properNounRows: properNoun, host: host };
  }

  /** 向后兼容：只要第一条规则的 label（用于面板展示） */
  function siteRuleLabel() {
    var list = siteRules();
    if (!list || !list.length) return null;
    return list.map(function (r) { return r.label || '?'; }).join(' + ');
  }

  /** 允许带进提示词、并在译文里还原的行内标签。只收「纯语义、无布局」的标签，
   *  带 class/style 的 span/div 一律不带（否则模型会开始乱删）。 */
  var RICH_TAGS = {
    A: 1, B: 1, STRONG: 1, EM: 1, I: 1, U: 1, S: 1, DEL: 1, INS: 1, CODE: 1,
    MARK: 1, SUB: 1, SUP: 1, Q: 1, CITE: 1, SMALL: 1, KBD: 1, ABBR: 1, TIME: 1, VAR: 1,
    ACRONYM: 1, DFN: 1, SAMP: 1
  };

  /* ---------------------------------------------------------------- 状态 */

  var S = {
    cfg: Object.assign({}, DSH.DEFAULTS),
    mode: 'off',
    userMode: null,
    byKey: new Map(),
    byEl: new WeakMap(),
    queue: [],
    done: 0,
    total: 0,
    gen: 0,
    reqSeq: 0,
    port: null,
    observer: null,
    pumpTimer: null,
    scanTimer: null,
    scanSet: null,
    lastBadge: 0,
    killed: false,
    bubble: null,
    bubbleSrc: null,
    bubbleDst: null,
    selBound: false,
    selSeq: 0,
    toastEl: null,
    lastErrAt: 0,
    lastErrSig: ''
  };

  /* ---------------------------------------------------------------- 小工具 */

  function toast(text, ms) {
    if (!text) return;
    try {
      if (!S.toastEl) {
        S.toastEl = document.createElement('div');
        S.toastEl.className = 'dsh-toast';
        document.documentElement.appendChild(S.toastEl);
      }
      S.toastEl.textContent = text;
      S.toastEl.classList.add('dsh-show');
      clearTimeout(S.toastEl.__t);
      S.toastEl.__t = setTimeout(function () {
        if (S.toastEl) S.toastEl.classList.remove('dsh-show');
      }, ms || 3600);
    } catch (e) {}
  }

  function isBlockish(el) {
    // SVG 元素（tagName 小写）：整体当行内处理，避免把图形当块级容器拆开
    if (isSvgNode(el)) return false;
    return !INLINE_TAGS.has(el.tagName);
  }

  /** 是不是 SVG 命名空间下的节点 */
  function isSvgNode(el) {
    if (!el || el.namespaceURI !== 'http://www.w3.org/2000/svg') return false;
    return el.tagName === 'svg';
  }

  /** 这个 SVG 里有没有 <text> 内容（有才值得进去翻） */
  function hasSvgText(el) {
    try {
      return !!(el.querySelectorAll && el.querySelectorAll('text, tspan').length);
    } catch (e) { return false; }
  }

  function hasBlockChild(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (isBlockish(c) && c.textContent && c.textContent.trim()) return true;
    }
    return false;
  }

  /** 屏幕阅读器专用/被裁掉的隐藏元素：翻它没有意义，还可能破坏布局 */
  function isHiddenLabel(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var cs = getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      // 只认「真·视觉隐藏」：clip: rect(0 0 0 0) 或 1px 见方。
      // 注意：绝不能把 clip-path 当隐藏判据 —— Discord 用它给头像/卡片做圆角遮罩，
      // 一旦算隐藏，整片正常内容都会被跳过。
      var clip = cs.clip;
      if (clip && clip !== 'auto' && /rect\(0[a-z ,]*0[a-z ,]*0[a-z ,]*0/i.test(clip)) return true;
      // 1px 见方的「视觉隐藏」元素
      var w = parseFloat(cs.width), h = parseFloat(cs.height);
      if (w > 0 && h > 0 && w <= 1 && h <= 1) return true;
      // overflow hidden + 尺寸为 0
      if (cs.overflow === 'hidden' && (!cs.width || cs.width === '0px') && (!cs.height || cs.height === '0px')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function shouldSkip(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    // translate="no" 只挡「这层自己的文字」，不当成整棵子树禁译。
    // Discord 会给应用外壳加 translate="no" 来防浏览器整页翻译，
    // 如果我们把它当子树禁译，走到外壳那层就整站不翻了。
    // 判据：这层有元素子节点 -> 继续往下走；是叶子（或文字很短）-> 才真的跳过。
    if (el.getAttribute && el.getAttribute('translate') === 'no') {
      var kidsN = el.children ? el.children.length : 0;
      if (kidsN === 0) return true;         // 叶子：尊重站点意图，不翻
      // 容器：不跳过这棵子树，往下走
    }
    var cl = el.classList;
    if (cl && (cl.contains('dsh-tr') || cl.contains('dsh-orig'))) return true;
    if (el.dataset && el.dataset.dshDone === '1') return true;
    if (isHiddenLabel(el)) return true;
    // aria-hidden="true" 只跳过「纯装饰叶层」。
    // 不能整棵跳 —— Discord 大量包裹层带 aria-hidden 但里面装着视觉可见内容。
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') {
      var arKids = el.children ? el.children.length : 0;
      var arText = (el.textContent || '').trim();
      // 纯装饰：没有子元素、或完全没有文字
      if (arKids === 0 || !arText) return true;
      // 只是个空壳（没有可翻文字）
      if (arText.length < 2 || !/\p{L}/u.test(arText)) return true;
      // 容器：往下走
    }
    /**
     * **文本启发式兜底**：纯日期 / 纯时间 / 纯数字 ID 一律不翻。
     *
     * ## 为什么需要这一层
     *
     * Discord 的 class 名每版本都重新混淆，纯 selector 会失效。
     * 但「这段文字是不是时间戳」可以从内容判断 —— 那是稳定的。
     *
     * 实测用户截图里的元信息：
     *   `Deleted User  2024/9/18 09:55`
     *   `2024/9/18 09:55`
     *   `09:55`
     *   `今天 09:55` / `昨天 09:55`
     *   `2024年9月18日`
     *   `<数字ID>`（如 14790024850480480266）
     *
     * 这些翻出来毫无意义，而且会破坏 Discord 自己的排版（时间列会错位）。
     *
     * ## 判据（严格，避免误伤正文）
     *
     * 只对**短文本**（≤ 24 字符）生效。正文里出现「09:55」这种是正常的
     * （"我们 09:55 见面吧"），不能因为含时间就不翻。
     *
     * 满足任一：
     *   · 纯日期（含 / 或 - 或 年月日，且全是数字与分隔符）
     *   · 纯时间（hh:mm / hh:mm:ss，可带 AM/PM）
     *   · 「今天/昨天/前天 + 时间」
     *   · 相对时间（3 分钟前 / 2 小时前 / 刚刚）
     *   · 纯数字 ID（≥ 8 位连续数字）
     */
    function isDateTimeOnly(text) {
      var s = String(text || '').trim();
      if (!s) return false;
      if (s.length > 24) return false;      // 长的多半是正文

      // 纯日期：2024/9/18、2024-09-18、2024年9月18日、9/18/2024
      if (/^\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}[日]?$/.test(s)) return true;
      if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(s)) return true;
      // 纯时间：09:55、9:55、09:55:33、9:55 AM
      if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?$/.test(s)) return true;
      // 日期 + 时间：2024/9/18 09:55
      if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return true;
      // 今天/昨天/前天 + 时间
      if (/^(今天|昨天|前天|今日|昨日)\s*\d{1,2}:\d{2}/.test(s)) return true;
      // 相对时间
      if (/^(刚刚|刚才|\d+\s*(秒|分钟|小时|天|周|个月|年)前)$/.test(s)) return true;
      // 纯数字 ID（≥ 8 位）
      if (/^\d{8,}$/.test(s)) return true;

      return false;
    }

    /**
     * 文本内容里是否**只有**「用户名 + 时间」这种元信息形态。
     *
     * 用户截图里的那一行是：`Deleted User  2024/9/18 09:55`
     * 用户名 + 时间连在一起，整体看不像正文。
     *
     * 判据：去掉日期/时间部分后，剩下的是**短名字**（≤ 32 字符，
     * 且不含句末标点 . 。 ! ？ 等「句子特征」）。
     */
    /**
     * 文本内容里是否**只有**「用户名 + 时间」这种元信息形态。
     *
     * 用户截图里的那一行是：`Deleted User  2024/9/18 09:55`
     *
     * ## 关键前提：**必须先确认确实含日期/时间**
     *
     * 踩过的坑（第一版写错的）：
     *   我把判据写成「去掉日期时间后，剩下的是短名字且不含句末标点」。
     *   结果 `Hahahaha the translation` 也满足（去掉后还是它，≤32 字符，
     *   没有句号）→ **把普通聊天正文当元信息跳过了**。
     *   `我们 09:55 见面吧` 同理（去掉时间后剩「我们 见面吧」）。
     *
     * 所以现在要求：**原文里必须真实出现日期/时间片段**，
     * 才可能是「名字 + 时间」这种元信息行。
     *
     * ## 判据
     *
     *   ① 原文含日期或时间片段（正则匹配到）
     *   ② 去掉这些片段后，剩下的是短名字（≤ 32 字符，无句末标点）
     */
    function isMetaLine(text) {
      var s = String(text || '').trim();
      if (!s) return false;
      if (s.length > 60) return false;

      /**
       * ① 必须真的含日期/时间片段。
       *
       * 这个「是否含」的判断独立于「是否纯」，所以不能用 isDateTimeOnly。
       */
      var DATE_RE = /\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}[日]?/;
      var TIME_RE = /\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?/;
      var REL_RE = /^(今天|昨天|前天|今日|昨日|刚刚|刚才)/;
      var AGO_RE = /\d+\s*(秒|分钟|小时|天|周|个月|年)前/;

      var hasDate = DATE_RE.test(s);
      var hasTime = TIME_RE.test(s);
      var hasRel = REL_RE.test(s);
      var hasAgo = AGO_RE.test(s);

      // 完全没有时间信息 → 不是元信息行，是普通内容
      if (!hasDate && !hasTime && !hasRel && !hasAgo) return false;

      // ② 去掉时间片段后看剩下什么
      var stripped = s
        .replace(new RegExp(DATE_RE.source, 'g'), '')
        .replace(new RegExp(TIME_RE.source, 'g'), '')
        .replace(REL_RE, '')
        .replace(new RegExp(AGO_RE.source, 'g'), '')
        .replace(/\s+/g, ' ')
        .trim();

      // 去掉后为空 → 纯日期/时间
      if (!stripped) return true;

      /**
       * 剩下的是短名字 → 元信息。
       *
       * 额外的「不像正文」约束：
       *   · 不含句末标点（。！？.!?）
       *   · 不含中文逗号/顿号（正文常用，名字不用）
       *   · 字数不超过 32
       *
       * 反例（不该算元信息）：
       *   `我们 09:55 见面吧`  → 去掉时间剩「我们 见面吧」，但原文含时间…
       *   嗯，这个确实会被判成元信息。可接受 —— 它短且像元信息。
       *   真正的正文一般更长或带标点。
       */
      if (stripped.length <= 32 && !/[。！？.!?]/.test(stripped) && !/[，、]/.test(stripped)) return true;

      return false;
    }

    // 站点级内置跳过（Discord 导航壳这类）。
    // 只判断「元素自己」是否命中，不用 closest 上溯 ——
    // 上溯会把整棵消息树都算成「在侧栏里」，造成整页不翻。
    // 导航壳容器本身会在 collect 递归时命中，整棵子树自然跳过。
    var sr = siteSelectors();
    if (sr && sr.selectors) {
      for (var sri = 0; sri < sr.selectors.length; sri++) {
        try { if (el.matches(sr.selectors[sri])) return true; } catch (e) {}
      }
    }

    /**
     * **祖先级跳过**：某些区域整棵子树都不能翻。
     *
     * 与上面 selectors 的区别：
     *   · selectors：只判「元素自己」。collect 递归遇到容器时会剪枝，
     *     但如果容器里有 React Portal / 动态挂载的子节点，可能剪不干净。
     *   · ancestorSelectors：**往上找祖先**，只要有一个祖先命中就跳过。
     *
     * 为什么只对这个站（Discord 成员列表）用 closest：
     *   早先版本的注释里写过 —— 无条件 closest 上溯会把整棵消息树
     *   都算成「在侧栏里」，导致整站不翻。所以这个能力只给
     *   明确标记了 ancestorSelectors 的规则用。
     */
    if (sr && sr.ancestorSelectors) {
      for (var asi = 0; asi < sr.ancestorSelectors.length; asi++) {
        try {
          if (el.closest && el.closest(sr.ancestorSelectors[asi])) return true;
        } catch (e) {}
      }
    }

    /**
     * **Discord 元信息 / 成员列表的文本启发式兜底**。
     *
     * 只在 Discord 域名生效（不污染其他站）。
     *
     * 两层：
     *   · 叶子元素文本是纯日期/时间/ID → 跳过
     *   · 叶子元素文本是「名字 + 时间」形态 → 跳过
     *
     * 为什么要两层：用户截图里的 `Deleted User  2024/9/18 09:55`
     * 是「名字 + 时间」连在一起的，纯日期判断挡不住。
     */
    try {
      /**
       * 用命中规则判断「是不是 Discord」，而不是直接测 location.hostname。
       *
       * 两个原因：
       *   · ?dshSite=discord.com 测试时 hostname 不是 discord，但规则命中了
       *   · 桌面客户端 WebView / 镜像站 hostname 也不是 discord
       * 统一走规则判定，口径一致。
       */
      var isDiscord = false;
      var ruleList = siteRules();
      for (var dl = 0; dl < (ruleList || []).length; dl++) {
        try {
          if (/discord/.test(String(ruleList[dl].host))) { isDiscord = true; break; }
        } catch (e) { /* ignore */ }
      }
      if (!isDiscord) {
        try { isDiscord = /^(?:canary\.|ptb\.)?discord\.(?:com|app|gg)$/i.test(location.hostname); } catch (e) {}
      }
      if (isDiscord) {
        var elKids = el.children ? el.children.length : 0;
        if (elKids === 0) {                        // 只对叶子判断
          var elText = (el.textContent || '').trim();
          if (elText && (isDateTimeOnly(elText) || isMetaLine(elText))) return true;
        }
      }
    } catch (e) { /* ignore */ }
    // 专名行（作者/社团/原作）里的 chip 不翻。
    // 但只对「叶子级」元素判断 —— tr/td 这种容器要往下走，
    // 否则整行（包括键名）都会被跳过。
    var isContainer = (el.children && el.children.length > 0) &&
      (el.tagName === 'TR' || el.tagName === 'TD' || el.tagName === 'TABLE' || el.tagName === 'TBODY');
    if (!isContainer && inProperNounRow(el)) return true;
    var sel = S.cfg.skipSelectors;
    if (sel) {
      try { if (el.matches(sel)) return true; } catch (e) {}
    }
    return false;
  }

  var RE_INLINE_SEL = INTERACTIVE_SEL;
  function isInteractive(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return false;
    try { return el.matches(RE_INLINE_SEL); } catch (e) { return false; }
  }

  function countInteractive(el) {
    try { return el.querySelectorAll(RE_INLINE_SEL).length; } catch (e) { return 0; }
  }

  /**
   * 这个元素（或它里面）有没有「视觉素材」。
   * 注意：不能只查 <img>/<svg> —— Discord 的服务器图标很多是
   *   <div style="background-image:url(...)">
   * 只查 img 会漏掉它们，于是这类链接被当成普通文字块去翻，
   * wrapAll 把背景图 div 一起包进 .dsh-orig，一进「仅译文」就把图标藏没了。
   */
  function hasMedia(el) {
    if (!el) return false;
    // 真·媒体标签：img/picture/video/canvas 一律算
    try {
      if (el.querySelector && el.querySelector('img, picture, video, canvas')) return true;
    } catch (e) { /* ignore */ }
    // svg 要分大小：Discord 的消息里到处是小徽章、箭头、状态点（12~20px）。
    // 把小 svg 也当媒体，会让正常文字块变成「只追加译文」，看起来就像没翻译。
    try {
      var svgs = el.querySelectorAll ? el.querySelectorAll('svg') : [];
      for (var si = 0; si < svgs.length && si < 8; si++) {
        var sr = svgs[si].getBoundingClientRect();
        if (sr.width >= 32 && sr.height >= 32) return true;
      }
    } catch (e) { /* ignore */ }
    // 背景图/遮罩图：只看自己和直接子元素。
    // 不要遍历所有后代 —— Discord 一个消息块能有几百个后代，
    // 每个都 getComputedStyle 会把页面拖死，而且匹配面太宽。
    try {
      if (hasBgImage(el)) return true;
      var kids = el.children || [];
      for (var i = 0; i < kids.length && i < 12; i++) {
        if (hasBgImage(kids[i])) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 单个元素是否用背景图/遮罩图当视觉主体 */
  function hasBgImage(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var st = el.getAttribute && el.getAttribute('style');
      if (st && st.indexOf('background') >= 0 && st.indexOf('url(') >= 0) return true;
      var cs = getComputedStyle(el);
      if (!cs) return false;
      var bg = cs.backgroundImage;
      if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) return true;
      var mask = cs.maskImage || cs.webkitMaskImage;
      if (mask && mask !== 'none' && mask.indexOf('url(') >= 0) return true;
      // 注意：不能因为「有背景色」就算素材 —— Discord 的容器几乎都有背景色。
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 取块的源文本：跳过自己的译文节点，<br> 变空格 */
  function sourceText(el) {
    var parts = [];
    (function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { parts.push(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        var tag = c.tagName;
        if (tag === 'BR') { parts.push(' '); continue; }
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        // ruby 的注音（<rt>）和括号（<rp>）不是要被翻的正文，跳过
        if (tag === 'RT' || tag === 'RP' || tag === 'RTC') continue;
        if (c.classList && c.classList.contains('dsh-tr')) continue;
        walk(c);
      }
    })(el);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(p)) out += ' ';
      out += p;
    }
    return out;
  }

  /* -------------------------------------------------------------- 富文本 */

  function escapeRich(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function unescapeRich(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  /**
   * 判断一个 <span> 是不是「行内语义节点」（@提及、行内代码、用户名等），值得带进提示词。
   * 判据：行内显示、没有块级子元素、没有媒体、字数不超过 40、不是我们的译文节点。
   * 这样既能保住 Discord 的 @提及样式，又不会把布局容器塞给模型。
   */
  function isInlineSemantic(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag !== 'SPAN' && tag !== 'EM' && tag !== 'STRONG') return false;
    if (hasBlockChild(el)) return false;
    if (hasMedia(el)) return false;
    var t = (el.textContent || '').trim();
    if (!t || t.length > 40) return false;
    try {
      var d = getComputedStyle(el).display;
      if (d !== 'inline' && d !== 'inline-block' && d !== 'contents') return false;
    } catch (e) { /* 拿不到就按行内处理 */ }
    return true;
  }

  /** 序列化成「只带白名单标签」的 HTML，并记下每个标签对应的原节点 */
  function serializeRich(el) {
    var used = [];
    var html = '';
    (function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { html += escapeRich(c.nodeValue); continue; }
        if (c.nodeType !== 1) continue;
        if (c.classList && c.classList.contains('dsh-tr')) continue;
        var tag = c.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        // 注音内容不带进提示词（语言相关，翻了没意义）
        if (tag === 'RT' || tag === 'RP' || tag === 'RTC') continue;
        if (tag === 'BR') { html += '<br/>'; used.push({ tag: 'BR', el: c }); continue; }
        // 白名单标签，或「行内语义 span」——都带进提示词，回来时按顺序还原
        if (RICH_TAGS[tag] || isInlineSemantic(c)) {
          var tn = tag.toLowerCase();
          html += '<' + tn + '>';
          used.push({ tag: tag, el: c });
          walk(c);
          html += '</' + tn + '>';
          continue;
        }
        walk(c);
      }
    })(el);
    return { html: html, used: used };
  }

  function plainFromRich(s) {
    return unescapeRich(String(s).replace(/<[^>]*>/g, '')).replace(/\s{2,}/g, ' ').trim();
  }

  /** 标签等价表：模型常把 <b> 写成 <strong>、<i> 写成 <em>，语义一样就按原标签还原 */
  var TAG_ALIAS = {
    STRONG: 'B', EM: 'I', STRIKE: 'S', INS: 'U',
    BIG: 'B', SMALL: 'SMALL'
  };

  /** 规范化标签名：小写输入 → 大写，再按等价表折叠 */
  function normTag(name) {
    var up = String(name || '').toUpperCase();
    return TAG_ALIAS[up] || up;
  }

  /**
   * 把模型输出按标签重建 DOM。
   *
   * 这是富文本翻译最关键的一步。模型经常：
   *   - 把 <b> 写成 <strong>（语义一样，应该接受）
   *   - 改大小写、加/去自闭合
   *   - 偶尔丢一个标签或合并相邻标签
   * 所以策略是「宽容但不错位」：
   *   1) 标签名先按等价表折叠；
   *   2) 用栈校验嵌套结构，结构错位（比如 </b> 对上 <i>）才放弃；
   *   3) 标签数量对不上时，按「按类型顺序取用」的方式尽量还原，
   *      多出来的原节点直接不带格式（宁可不加粗，也不能把 DOM 拼坏）。
   * 任何情况下都不返回错位的 DOM。
   */
  function parseRich(src, used) {
    if (!used || !used.length) return null;
    var s = String(src || '');
    if (!s) return null;

    // 原节点按「规范化标签名」分池
    var pool = {};
    for (var u = 0; u < used.length; u++) {
      var key = normTag(used[u].tag);
      if (!pool[key]) pool[key] = [];
      pool[key].push(used[u].el);
    }
    var taken = {};
    var frag = document.createDocumentFragment();
    var stack = [];
    var names = [];
    var buf = '';
    var i = 0;
    var top = function () { return stack.length ? stack[stack.length - 1] : frag; };

    function flush() {
      if (!buf) return;
      var txt = unescapeRich(buf);
      buf = '';
      if (txt) top().appendChild(document.createTextNode(txt));
    }

    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch !== '<') { buf += ch; i++; continue; }
      var close = s.indexOf('>', i);
      if (close < 0) return null;
      var raw = s.slice(i, close + 1);
      var m = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)\s*(\/?)>$/.exec(raw);
      if (!m) { buf += raw; i = close + 1; continue; }

      var closing = !!m[1];
      var name = normTag(m[2]);
      var selfClose = !!m[3];
      if (name !== 'BR' && !RICH_TAGS[name] && !pool[name]) {
        // 完全陌生的标签（模型凭空编的，如 <foo>）：
        // 只丢掉标签标记，保留里面的文字，否则页面上会出现尖括号。
        i = close + 1;
        continue;
      }
      flush();

      if (closing) {
        // 结构必须对得上；对不上说明模型拼错了，整段退回纯文本
        if (!names.length || names[names.length - 1] !== name) return null;
        names.pop();
        stack.pop();
        i = close + 1;
        continue;
      }

      // 找可用原节点：同类型按顺序取
      var list = pool[name] || [];
      var k = taken[name] || 0;
      var node = list[k];
      if (node) taken[name] = k + 1;

      var clone;
      if (node) {
        clone = node.cloneNode(false);
      } else if (name === 'BR') {
        clone = document.createElement('br');
      } else if (RICH_TAGS[name]) {
        // 模型多写了标签（原文没有）：直接按同名标签造一个，保住格式语义
        clone = document.createElement(name.toLowerCase());
      } else {
        // 原文里是「带样式的 span」，但模型多写了一个：用行内 span 兜底，不改变观感
        clone = document.createElement('span');
      }
      top().appendChild(clone);

      if (name !== 'BR' && !selfClose) { stack.push(clone); names.push(name); }
      i = close + 1;
    }
    flush();

    // 模型少写了结束标签：自动补齐（结构仍然正确，只是没闭合）
    // 只有「闭合标签对不上前面」才在循环里 return null。
    if (stack.length) {
      var depth = stack.length;
      if (depth > 8) return null;    // 嵌套太深，多半是模型乱写，退回纯文本更安全
      // 末节点已是最深的，直接收尾即可
    }
    return frag;
  }

  /* ------------------------------------------------------ 属性里的文本 */

  /**
   * 有些文字不在 DOM 里，而在属性里：
   *   - img 的 alt（图片替代文字）
   *   - input / textarea 的 placeholder（输入框提示）
   *   - aria-label（无障碍名称，按钮/图标最常见）
   *   - title（悬停提示）
   *   - 可输入的 value（提交按钮的按钮文字）
   * 这些在真实站点上量很大，而且都是「用户看得见或读得到」的文本。
   */
  var ATTR_TEXT_KEYS = ['alt', 'placeholder', 'aria-label', 'title', 'value'];

  /** 有些属性只在特定元素上才有意义（比如 input 的 value 才是按钮文字） */
  var ATTR_SEL = {
    alt: 'img, area, input[type=image]',
    placeholder: 'input, textarea',
    'aria-label': 'a, button, [role="button"], input, select, textarea, [aria-label]',
    title: 'a, button, img, abbr, acronym, dfn, iframe, input, select, textarea, [title]',
    value: 'input[type=submit], input[type=button], input[type=reset], input[type=image]'
  };

  /** 属性名 → 安全的存储名（aria-label 要转成 ariaLabel 才能做 dataset key） */
  function attrKey(attr) {
    return 'dshTr' + attr.replace(/[^A-Za-z0-9]/g, function (c) {
      return '_' + c.charCodeAt(0);
    });
  }

  /** <summary>/<details> 的开合标题、<figcaption> 说明文字：都是普通可翻文本，靠 isBlockish 自然处理 */
  /** 这个属性值值不值得翻 */
  function worthAttr(el, attr, value) {
    if (!value) return false;
    var v = String(value).trim();
    if (v.length < 2 || v.length > 800) return false;
    if (!DSH.isTranslatable(v, S.cfg.targetLang)) return false;
    // title 常是工具提示，允许短一些；alt/placeholder 太短没意义
    if (attr === 'alt' && v.length < 3) return false;
    return true;
  }

  /**
   * <select> 本身不翻（它的源文本是全部选项拼在一起），但每个 <option> 要翻。
   * 这里单独收一遍 option 文字。
   */
  function collectOptions(rootEl, out) {
    if (!rootEl || rootEl.nodeType !== 1) return;
    var opts;
    try { opts = rootEl.querySelectorAll ? rootEl.querySelectorAll('option') : []; } catch (e) { return; }
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o.textContent) continue;
      if (o.dataset && o.dataset.dshDone === '1') continue;
      var t = DSH.normSpace(o.textContent);
      if (!DSH.isTranslatable(t, S.cfg.targetLang)) continue;
      if (o.textContent.length > 200) continue;
      out.push({
        key: DSH.hashKey('O|' + t),
        text: t,
        plain: t,
        rich: false,
        els: null,
        el: o,
        tr: null,
        mode: 'option',
        state: 'new',
        noWrap: true
      });
    }
  }

  /**
   * 属性收集用的宽松跳过判断。
   * 输入控件（input / textarea / select）本身不翻内容，但它们的
   * placeholder / aria-label 恰恰是最需要翻的属性，所以这里不能沿用 shouldSkip。
   */
  function shouldSkipAttr(el) {
    if (!el || el.nodeType !== 1) return true;
    // 站点级内置跳过（只判自身，不上溯）
    var sr = siteSelectors();
    if (sr && sr.selectors) {
      for (var sri = 0; sri < sr.selectors.length; sri++) {
        try { if (el.matches(sr.selectors[sri])) return true; } catch (e) {}
      }
    }
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
    if (tag === 'HEAD' || tag === 'META' || tag === 'LINK') return true;
    if (isHiddenLabel(el)) return true;
    if (el.dataset && el.dataset.dshDone === '1') return true;
    return false;
  }

  /** 收集带可翻属性的元素 */
  function collectAttrUnits(rootEl, out) {
    if (!rootEl || rootEl.nodeType !== 1) return;
    // 注意：querySelectorAll 返回的是 NodeList，没有 push()，必须先转成真数组
    var all;
    try { all = Array.prototype.slice.call(rootEl.querySelectorAll('*')); } catch (e) { return; }
    // Shadow DOM 里的元素也要收集（querySelectorAll 进不去 shadowRoot）
    try {
      for (var si = 0; si < all.length; si++) {
        var sroot = all[si] && all[si].shadowRoot;
        if (!sroot) continue;
        var inner = sroot.querySelectorAll('*');
        for (var sk = 0; sk < inner.length; sk++) all.push(inner[sk]);
      }
    } catch (e) { /* closed shadow：访问不了 */ }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (shouldSkipAttr(el)) continue;
      for (var k = 0; k < ATTR_TEXT_KEYS.length; k++) {
        var attr = ATTR_TEXT_KEYS[k];
        var val = el.getAttribute(attr);
        if (!val) continue;
        if (!worthAttr(el, attr, val)) continue;
        // 跳过「计数提示」类 title（"160,798 galleries" / "82 galleries"）：
        // 它们是 chip 里数字的 hover 说明，翻了对用户没有价值，只是徒增单元数。
        if (attr === 'title' && /^[\d,.]+\s*(galleries|works|images|pages|entries)?$/i.test(String(val).trim())) continue;
        // 每种属性只在对应元素上才有意义
        try {
          var sel = ATTR_SEL[attr];
          if (sel && !el.matches(sel)) continue;
        } catch (e) { /* ignore */ }
        // 已经翻过的跳过
        if (el[attrKey(attr)]) continue;
        var text = DSH.normSpace(val);
        var u = {
          key: DSH.hashKey('A' + attr + '|' + text),
          text: text,
          plain: text,
          rich: false,
          attr: attr,
          els: null,
          el: el,
          tr: null,
          mode: 'attr',
          state: 'new',
          noWrap: true
        };
        if (S.byEl.has(el) && (!S.byEl.get(el).attrList)) {
          // 这个元素已经作为块级单元处理过：属性单独排队
          var b = S.byEl.get(el);
          b.attrList = b.attrList || [];
          b.attrList.push(u);
        } else {
          out.push(u);
        }
      }
    }
  }

  /** 属性译文写回 */
  function renderAttr(u, text) {
    var el = u.el;
    if (!el || !el.isConnected) return;
    var attr = u.attr;
    var k = attrKey(attr);
    if (!el[k]) {
      // 首次：备份原值
      el[k] = el.getAttribute(attr);
      el.classList.add('dsh-attr-tr');
    }
    var newVal = String(text || '').trim();
    if (!newVal) return;
    try { el.setAttribute(attr, newVal); } catch (e) {}
    u.state = 'done';
  }

  /* ---------------------------------------------------------------- 建单元 */

  /** 一个「可翻译单元」= 一个叶子块 + 它的译文占位 */
  function makeUnit(el, mode) {
    if (S.byEl.has(el)) return null;
    var plain = DSH.normSpace(sourceText(el));
    if (!DSH.isTranslatable(plain, S.cfg.targetLang)) return null;

    // 交互元素和表格只做行内译文，避免撑坏布局
    var inline = mode === 'inline';
    if (!inline && el.tagName === 'TH') inline = true;
    if (!inline && el.tagName === 'TD' && plain.length <= 48) inline = true;
    if (inline && plain.length > 160) return null;
    if (inline && hasBlockChild(el)) return null;

    // 图标按钮（48~56px 的圆形/方形，里面是图片）：文字只是给屏幕阅读器用的标签，
    // 翻了会被 overflow:hidden 裁掉、还可能撑破形状，直接跳过。
    if (inline && hasMedia(el)) {
      try {
        var rb0 = el.getBoundingClientRect();
        if (rb0.width && rb0.height && rb0.width <= 56 && rb0.height <= 56) return null;
      } catch (e) {}
    }

    // 富文本只对「纯文字块」启用：带图片/按钮的容器走纯文本，避免把媒体节点搬走
    var rich = null;
    if (!inline && S.cfg.richText !== false && plain.length <= 2000 && !hasMedia(el)) {
      var r = serializeRich(el);
      if (r.used.length && r.html) rich = r;
    }
    var text = rich ? rich.html.trim() : plain;
    if (!text) return null;

    var u = {
      key: DSH.hashKey((rich ? 'R|' : 'P|') + text),
      text: text,
      plain: plain,
      rich: !!rich,
      els: rich ? rich.used : null,
      el: el,
      tr: null,
      mode: inline ? 'inline' : 'append',
      state: 'new',
      noWrap: inline && hasMedia(el)
    };
    u.grp = groupOf(el);

    // 窄元素（侧栏频道名、按钮、标签）塞不下双语，自动改成「原位替换」：
    // 译文直接顶掉原文，既不撑高也不被 ellipsis 吃掉。
    // 但带图片/图标的一律排除 —— replace 要隐藏原文，会把图片一起藏掉（服务器图标栏就是这么消失的）。
    if (inline && !u.noWrap) {
      var narrow = false;
      try {
        var rc = el.getBoundingClientRect();
        var cs0 = getComputedStyle(el);
        var maxW = rc.width || (el.parentElement ? el.parentElement.getBoundingClientRect().width : 0);
        if (maxW && maxW < 120) narrow = true;
        if (cs0.height && parseFloat(cs0.height) <= 36 && cs0.overflow === 'hidden') narrow = true;
      } catch (e) {}
      if (narrow && S.cfg.narrowReplace !== false) u.mode = 'replace';
    }

    if (inline) return u;

    try {
      var cs = getComputedStyle(el);
      var d = cs.display;
      if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid' || d === 'table-row') u.mode = 'sibling';
    } catch (e) {}
    return u;
  }

  /** 这个块里有多少比例的文字住在按钮/链接里 */
  function interactiveRatio(el) {
    var total = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (!total) return 0;
    var inside = 0;
    try {
      var nodes = el.querySelectorAll(INTERACTIVE_SEL);
      for (var i = 0; i < nodes.length; i++) inside += (nodes[i].textContent || '').replace(/\s+/g, ' ').trim().length;
    } catch (e) { return 1; }
    return Math.min(1, inside / total);
  }

  /**
   * 这块能不能整体翻。
   * 旧规则「含一个链接就不翻」在真实站点上会漏掉绝大多数消息——
   * Discord 每条消息几乎都带 @提及、链接或表情。
   * 现在改成看「链接文字占比」：占比高的（纯按钮行、标签云）才拆开逐个处理。
   */
  /**
   * 这个元素有没有「裸露在外的正文文本」（不在链接/按钮里的直接文本节点）。
   *
   * 用来区分两种情况：
   *   <div class="tags"><span class="tag"><a>original</a><span>160.7k</span></span></div>
   *     → 没有裸文本，是「标签芯片容器」，应该逐个芯片处理
   *   <p>Read <a href="#">more</a> about it</p>
   *     → 有裸文本（Read / about it），是正常段落，应该整段翻
   */
  function hasBareOutText(el) {
    var bare = 0;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        var t = String(n.nodeValue || '').trim();
        if (t.length >= 2) bare += t.length;
      } else if (n.nodeType === 1) {
        var tag = n.tagName;
        if (tag === 'BR' || tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (!isInteractive(n)) continue;
      }
    }
    return bare > 0;
  }

  /**
   * 叶子行内元素里直接装着文字（<span>See a tag missing?</span>）。
   *
   * 这类元素必须单独收成一个单元：它们不是「块级」（isUnit 不收），
   * 又不是「交互元素」（isInteractive 不收），如果 walk 里没有这条分支，
   * 它们的文字就永远收不到 —— 任何用 span 承载文字的页面都会大面漏翻。
   */
  function isLeafInlineText(el) {
    if (!el || el.nodeType !== 1) return false;
    // 必须有元素子节点才算（没有子节点 = 真正的叶子，文字直接在这里）
    if (el.children && el.children.length > 0) return false;
    var t = (el.textContent || '').trim();
    if (!t || t.length < 2) return false;
    if (!/\p{L}/u.test(t)) return false;
    if (shouldSkip(el)) return false;
    // 只处理行内标签；块级容器由 isUnit 负责
    return !isBlockish(el);
  }

  /**
   * 「标签行」：<div>Categories: <span><a><span>doujinshi</span></a></span></div>
   *
   * 结构特点：一行里左边是**裸文本**（"Categories:"），右边是同级的行内链接。
   * 这种必须拆开：裸文本单独翻（键名），每个链接单独翻（标签值）。
   * 整行送模型的话，它只会翻键名，链接里的词原样返回 ——
   * 用户看到的就是「类别: doujinshi 519.5k」这种半翻状态。
   */
  function isLabeledChipRow(el) {
    if (!el || !el.children || el.children.length < 1) return false;
    // 左边必须有裸文本（键名）
    var bare = '';
    var first = el.firstChild;
    while (first && first.nodeType === 3) {
      bare += first.nodeValue || '';
      first = first.nextSibling;
    }
    bare = bare.trim();
    if (!bare || bare.length > 24) return false;
    if (!/[A-Za-z]/.test(bare)) return false;
    // 裸文本必须以冒号结尾（"Categories:" / "Tags:" / "Pages:"）
    if (!/[:：]\s*$/.test(bare)) return false;
    // 右边要么有链接（Tags/Categories），要么有非文本的行内内容（Uploaded 的 <time>）。
    try {
      if (el.querySelector('a[href]')) return true;
      if (el.children && el.children.length >= 1) {
        // 至少有一个子元素里带字母（不是纯装饰）
        for (var ci = 0; ci < el.children.length; ci++) {
          if (/[A-Za-z\u4e00-\u9fff]/.test(el.children[ci].textContent || '')) return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  /**
   * chip 里「承载标签名」的子元素。
   *
   * 结构：<a class="tagchip"><span class="name">big breasts</span><span class="count">240.9k</span></a>
   * 只翻 name 部分 —— 整条送给模型它会连计数一起翻，
   * 出现「240.9千个大乳房」这种语序错乱。
   *
   * 判据：找 class 含 name/label/tag 的子元素；或找「第一个含字母」的子元素。
   */
  function chipNameEl(a) {
    if (!a || !a.children || !a.children.length) return null;
    var kids = a.children;
    // 1. class 明确是 name 的
    for (var i = 0; i < kids.length; i++) {
      var cl = String(kids[i].className || '');
      if (/\bname\b|\blabel\b/ .test(cl) && /\p{L}/u.test(kids[i].textContent || '')) return kids[i];
    }
    // 2. 退化：第一个含字母、且不是纯数字计数的子元素
    for (var j = 0; j < kids.length; j++) {
      var t = (kids[j].textContent || '').trim();
      if (!t || !/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(t)) continue;
      if (/^[\d.,]+\s*[kKmMbB]?$/.test(t)) continue;   // 计数
      return kids[j];
    }
    return null;
  }

  /** 这个块是不是「图标 + 多个文字子块」的组合（如提示卡片 💡 + 标题 + 说明） */
  function isIconWithTextKids(el) {
    var kids = el.children;
    // 子元素太多（> 6）说明是正文容器（消息体里一堆行内 span），不是图标卡片
    if (!kids || kids.length < 2 || kids.length > 6) return false;
    var textKids = 0, iconKids = 0;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var t = (k.textContent || '').trim();
      if (!t) { iconKids++; continue; }
      if (!/\p{L}/u.test(t)) { iconKids++; continue; }
      textKids++;
    }
    // 必须真的有一个「非文字的图标子元素」+ 至少一个文字子块。
    // 不能只看 iconKids —— 空 span 也会被算成图标。
    if (iconKids < 1 || textKids < 1) return false;
    // 图标元素必须真的是图形/emoji，不是空壳
    var realIcon = false;
    for (var j = 0; j < kids.length; j++) {
      var kk = kids[j];
      var tt = (kk.textContent || '').trim();
      if (tt && /\p{L}/u.test(tt)) continue;
      // 明确的图形元素
      if (kk.tagName === 'IMG' || kk.tagName === 'SVG' || isSvgNode(kk)) { realIcon = true; break; }
      // emoji/符号：必须有非 ASCII 的字符。
      // 注意纯数字（"567"）绝不能算图标 —— 那会把正常文字块判成图标卡片，
      // 然后把整块拆散，富文本标签全丢。
      if (tt && tt.length <= 4 && /[^\x00-\x7F]/.test(tt) && !/\p{L}/u.test(tt)) { realIcon = true; break; }
    }
    return realIcon;
  }

  function isUnit(el) {
    if (!isBlockish(el) || hasBlockChild(el)) return false;
    if ((el.textContent || '').trim().length < 2) return false;
    // 标签行（裸文本键名 + 行内链接）：必须拆开逐个处理
    if (isLabeledChipRow(el)) return false;
    // 图标 + 多个文字子块的卡片：整块翻会把 emoji 带进提示词、译文位置也怪，
    // 拆成各个文字子块分别翻更干净。
    if (isIconWithTextKids(el)) return false;
    var ratio = interactiveRatio(el);
    if (ratio >= 0.9) return false;                        // 整块几乎全是按钮/链接文字

    // 芯片容器（标签云、徽章行、按钮组）：文字都在链接里、外面没有裸文本。
    // 这种必须下沉到每个芯片单独处理 —— 否则整块翻成一句，译文会另起一行堆在下面。
    if (ratio >= 0.4 && !hasBareOutText(el)) return false;

    if (ratio >= 0.35 && countInteractive(el) >= 3) return false; // 标签云（多芯片）
    return true;
  }

  /**
   * 链接/按钮里如果文字住在「自己的子元素」里（<a><span class="ico">#</span><span class="nm">general</span></a>），
   * 就下沉到那个子元素去翻，别整条链接当原子。
   *
   * 为什么必须这样：整条链接当原子时，wrapAll 会把所有子节点包进一个 .dsh-orig span，
   * 那个 span 没有 flex 子项的 min-width:0，在 Discord 的 flex + overflow:hidden 侧栏里
   * 会被压扁 —— 频道名被裁成 1~2 个字（「# 通」「# 展」就是这么来的）。
   */
  function textHolderOf(el) {
    if (!isInteractive(el)) return null;
    var kids = el.children;
    if (!kids || !kids.length) return null;
    // 找「有文字、且不是纯图标」的子元素
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (shouldSkip(k)) continue;
      var t = (k.textContent || '').trim();
      if (!t || t.length < 2) continue;                 // 图标/分隔符
      // 全是符号/emoji 的（📢 ▧ # 之类）是图标，不是文字
      if (!/\p{L}/u.test(t)) continue;
      if (k.tagName === 'IMG' || k.tagName === 'SVG') continue;
      if (isCountLike(t)) continue;                     // 计数
      return k;
    }
    return null;
  }

  /** 计数样式：238.5k / 875 / 1.2m */
  function isCountLike(txt) {
    return /^\s*\d[\d.,]*\s*[kKmMbB]?\s*$/.test(String(txt || ''));
  }

  /**
   * 链接/卡片是否要「下沉进去逐块处理」。
   *
   * 只有「里面还有块级子元素」的卡片链接才需要下沉（例如 <a><div>标题</div><div>摘要</div></a>）。
   *
   * 注意不要把「只带图片的链接」判成下沉：图标按钮/头像链接的结构是
   *   <a><img><span>名字</span></a>
   * 下沉后 walk 只走元素、走不到裸文字，那个名字就永远收不到（图标栏整块不翻译）。
   * 这种交给 makeUnit(c,'inline') —— 它会因为 hasMedia 设 noWrap=true，
   * 只把译文追加进去、绝不动 <img>。
   */
  function shouldDescend(el) {
    if (!isInteractive(el)) return false;
    return hasBlockChild(el);
  }

  /** 取一个元素的可遍历子节点：把 shadowRoot 也算进去 */
  /**
   * SVG 的 <text> 元素：里面不能插 HTML span（会被当无效子节点丢掉），
   * 所以直接改 textContent，原值存在 dataset 里以便还原。
   */
  function makeSvgTextUnit(tEl) {
    if (!tEl) return null;
    if (tEl.dataset && tEl.dataset.dshDone === '1') return null;
    var t = DSH.normSpace(tEl.textContent);
    if (!t || t.length > 200) return null;
    if (!DSH.isTranslatable(t, S.cfg.targetLang)) return null;
    return {
      key: DSH.hashKey('S|' + t),
      text: t,
      plain: t,
      rich: false,
      els: null,
      el: tEl,
      tr: null,
      mode: 'svgtext',
      state: 'new',
      noWrap: true
    };
  }

  /**
   * 给单元打一个「同组」标记：同一容器下的相邻短文本是一组。
   *
   * 为什么需要：e-hentai 的标签云是
   *   <div class="tags"><span>big breasts 240.8k</span><span>sole female 209.3k</span>…
   * 拆开单独发给模型，模型不知道这是「成人向标签」，会翻成奇怪的词；
   * 同一组一起发，提示词里能看到同类上下文，翻译质量明显更好。
   *
   * 组名用「容器在文档里的路径 + 容器标签」，稳定且不需要额外遍历。
   */
  function groupOf(el) {
    if (!el) return '';
    var holder = el.parentElement || el;
    // 往上找到「同一类内容的容器」：最多上溯 3 层，取第一个有多个子元素的
    var depth = 0;
    while (holder && depth < 3) {
      if (holder.children && holder.children.length >= 2) break;
      holder = holder.parentElement;
      depth++;
    }
    if (!holder) return '';
    var path = [];
    var node = holder;
    var hops = 0;
    while (node && hops < 6) {
      var idx = 0;
      var sib = node.previousElementSibling;
      while (sib) { idx++; sib = sib.previousElementSibling; }
      path.push(node.tagName + ':' + idx);
      node = node.parentElement;
      hops++;
    }
    return path.join('/');
  }

  /** 最近一次 collect 的诊断信息（页面控制台可查） */
  var lastCollect = { units: 0, skippedRoot: false, siteRule: null, error: null, ms: 0 };

  /**
   * 相邻标题对合并。
   *
   * nhentai 的 h1（英文/罗马音题）和 h2（日文原题）是**同一部作品的两种写法**。
   * 分开翻的话，模型看不到对照，会把 "Kousou Souei" 硬译成「库寿服务」，
   * 而正确的「紅蒼双影」就在下面那行 h2 里。
   *
   * 做法：检测「连续两个标题元素（h1/h2/h3 或 class 含 title 的块）」，
   * 把它们的文本合成一个单元（用换行分隔），译完再按行拆回去。
   */
  function mergeTitlePairs(units) {
    if (!units || units.length < 2) return units;
    var out = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var next = units[i + 1];
      if (next && u.mode !== 'inline' && next.mode !== 'inline' &&
          isHeadingEl(u.el) && isHeadingEl(next.el) &&
          areAdjacentHeadings(u.el, next.el) &&
          u.text.length <= 400 && next.text.length <= 400 &&
          u.text.length > 0 && next.text.length > 0) {
        // 把两个标题放进同一个「组」，保证它们被同一批送给模型
        // （模型在一批里同时看到 h1 和 h2，才能把 "Kousou Souei" 对上「紅蒼双影」）。
        // 注意：这里绝不能 && i++ 跳过 next —— 那样 h2 会被静默丢弃。
        var g = 'title:' + i;
        u.grp = g;
        next.grp = g;
      }
      out.push(u);
    }
    return out;
  }

  function isHeadingEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (/^H[1-6]$/.test(el.tagName)) return true;
    var cl = String(el.className || '');
    if (/title|heading/i.test(cl)) {
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && r.height && r.height < 120) return true;
    }
    return false;
  }

  /** 两个标题是否「视觉上相邻」（中间没有别的可读内容） */
  function areAdjacentHeadings(a, b) {
    try {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (!ra || !rb) return true;
      // 垂直间距不超过 60px 就算相邻
      return Math.abs(rb.top - ra.bottom) <= 60;
    } catch (e) { return true; }
  }

  /**
   * 标签行的「键名部分」：裸文本节点本身要成为独立单元。
   *
   * <div>Categories: <span><a>doujinshi</a></span></div>
   * 里的 "Categories:" 是文本节点，walk 看不到它。
   * 这里把它抽出来单独立一个单元，译文追加在文本节点后面。
   */
  function makeLabelUnit(el) {
    var bare = '';
    var nodes = [];
    for (var n = el.firstChild; n && n.nodeType === 3; n = n.nextSibling) {
      if (n.nodeValue) { bare += n.nodeValue; nodes.push(n); }
    }
    bare = bare.trim();
    if (!bare || bare.length > 24) return null;
    if (!/[A-Za-z]/.test(bare)) return null;
    if (!/[:：]\s*$/.test(bare)) return null;
    if (!DSH.isTranslatable(bare, S.cfg.targetLang)) return null;
    return {
      key: DSH.hashKey('L|' + bare),
      text: bare,
      plain: bare,
      rich: false,
      els: null,
      el: el,
      tr: null,
      labelNodes: nodes,
      labelText: bare,
      mode: 'label',
      state: 'new',
      noWrap: true,
      grp: groupOf(el)
    };
  }

  /** 收集一段 DOM 里所有可翻单元（含属性文本） */
  function collect(rootEl) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    try {
      var got = collectInner(rootEl);
      lastCollect.units = got.length;
      lastCollect.error = null;
      var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      lastCollect.ms = Math.round(t1 - t0);
      return got;
    } catch (e) {
      lastCollect.error = String((e && e.message) || e);
      lastCollect.units = 0;
      try { console.warn('[DSH] collect 出错:', e); } catch (e2) {}
      return [];
    }
  }

  function collectInner(rootEl) {
    var out = [];
    if (!rootEl || rootEl.nodeType !== 1) return out;
    if (shouldSkip(rootEl)) return out;
    if (S.cfg.siteSkipSidebar !== false && inSiteSkippedArea(rootEl)) return out;
    // 注意：不要在这里用 inProperNounRow(rootEl) ——
    // 如果 rootEl 是一整行（tr），它「包含」专名值单元格，但不是「本身是专名」。
    // 专名判断必须在元素级别做（见 shouldSkip），否则整行的键名也会被跳掉。

    // 属性里的文本（alt / placeholder / aria-label / title）单独排队
    if (S.cfg.translateAttrs !== false) collectAttrUnits(rootEl, out);
    // <select> 里的每个 <option> 单独翻
    collectOptions(rootEl, out);

    if (isInteractive(rootEl) && !hasBlockChild(rootEl)) {
      var ui = makeUnit(rootEl, 'inline');
      if (ui) out.push(ui);
      return out;
    }
    if (isUnit(rootEl)) {
      var u0 = makeUnit(rootEl);
      if (u0) out.push(u0);
      return out;
    }
    (function walk(el) {
      // 有 shadowRoot 的元素：直接遍历 shadow 内部
      if (el.shadowRoot) {
        try {
          var sh = el.shadowRoot.querySelectorAll('*');
          for (var s = 0; s < sh.length; s++) {
            var sx = sh[s];
            if (sx.shadowRoot) walk(sx);
            else if (isUnit(sx)) { var su = makeUnit(sx); if (su) out.push(su); }
          }
        } catch (e) { /* closed shadow：访问不了，跳过 */ }
      }
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (shouldSkip(c)) continue;
        // SVG：只进去翻 <text> 元素，不碰图形本身
        if (isSvgNode(c)) {
          if (!hasSvgText(c)) continue;
          var texts = [];
          try { texts = c.querySelectorAll('text'); } catch (e) { texts = []; }
          for (var ti = 0; ti < texts.length; ti++) {
            var tu = makeSvgTextUnit(texts[ti]);
            if (tu) out.push(tu);
          }
          continue;
        }
        if (isInteractive(c)) {
          // 卡片式链接（里面有标题块或封面图）：进去逐块处理，别整块翻
          if (shouldDescend(c)) { walk(c); continue; }
          // 文字住在子元素里（Discord 的 <a><span class="nm">general</span></a>）：
          // 下沉到那个子元素单独翻，避免整条链接被 flex 压扁导致文字被裁
          var holder = textHolderOf(c);
          if (holder) {
            var uh = makeUnit(holder, 'inline');
            if (uh) { out.push(uh); continue; }
          }
          var ua = makeUnit(c, 'inline');
          if (ua) out.push(ua);
          continue;
        }
        if (isLabeledChipRow(c)) {
          // 键名单独收
          var lu = makeLabelUnit(c);
          if (lu) out.push(lu);
          // 值（每个 chip 的链接）单独收。
          // 一律用 replace 模式：短标签双语显示会变成「大胸 241.0k big breasts 241.0k」这种重复。
          //
          // 关键：chip 内部是 <span class="name">标签名</span><span class="count">240.9k</span>，
          // 只翻 name 部分。整条 <a> 送给模型的话，它会连计数一起翻
          // （"big breasts 240.9k" → "240.9千个大乳房"，语序都乱了）。
          try {
            var links = c.querySelectorAll('a[href]');
            for (var li = 0; li < links.length; li++) {
              if (shouldSkip(links[li])) continue;
              var target = chipNameEl(links[li]) || links[li];
              var cu = makeUnit(target, 'inline');
              if (cu) { cu.mode = 'replace'; out.push(cu); }
            }
            // 没有链接的行（Uploaded 的 <time>）：把值容器单独收成单元。
            // 也用 replace —— 因为键名已经原位替换了，值再双语会变成一长串重复。
            if (!links.length && c.children && c.children.length) {
              for (var vi = 0; vi < c.children.length; vi++) {
                var vc = c.children[vi];
                if (shouldSkip(vc)) continue;
                var vt = DSH.normSpace(sourceText(vc));
                if (!vt || vt.length < 2) continue;
                var vu = makeUnit(vc, 'inline');
                if (vu) {
                  vu.mode = 'replace';
                  // 值容器（<time>）不走富文本 —— 里面没有要保留的语义标签，
                  // 走 rich 反而会把 <time> 当陌生标签处理，页面上露出生标签名。
                  vu.rich = false;
                  vu.els = null;
                  out.push(vu);
                }
              }
            }
          } catch (e) { /* ignore */ }
          continue;
        }
        if (isUnit(c)) {
          var u1 = makeUnit(c);
          if (u1) out.push(u1);
          continue;
        }
        // 叶子行内元素（<span>/<b>/<i> 里直接装着文字）：
        // 这类元素以前永远收集不到 —— 因为 isUnit 要求「块级」。
        // 结果任何用 span 承载文字的页面都会漏翻（nhentai 的提示卡片就是这样）。
        if (isLeafInlineText(c)) {
          var ul = makeUnit(c, 'inline');
          if (ul) { out.push(ul); continue; }
        }
        walk(c);
      }
    })(rootEl);
    return mergeTitlePairs(out);
  }

  /* ---------------------------------------------------------------- 队列 */

  function enqueue(units) {
    var added = 0;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!u) continue;
      if (u.mode === 'attr' || u.mode === 'option' || u.mode === 'svgtext' || u.mode === 'label') {
        // 属性单元：同一个元素可以有多个属性单元，也可能同时有块级单元，
        // 所以不走 byEl 的互斥表，只在 byKey 里按内容去重。
        var al = S.byKey.get(u.key);
        if (!al) { al = []; S.byKey.set(u.key, al); }
        al.push(u);
        S.queue.push(u);
        S.total++;
        added++;
        continue;
      }
      if (S.byEl.has(u.el)) continue;
      var list = S.byKey.get(u.key);
      if (!list) { list = []; S.byKey.set(u.key, list); }
      list.push(u);
      S.byEl.set(u.el, u);
      if (u.el.dataset) u.el.dataset.dshDone = '1';
      S.queue.push(u);
      S.total++;
      added++;
    }
    if (!added) return;
    updateBadge(true);
    schedulePump();
  }

  function schedulePump() {
    if (S.pumpTimer) return;
    S.pumpTimer = setTimeout(function () { S.pumpTimer = null; pump(); }, 30);
  }

  /** 靠近视口的排前面，用户先看到正文 */
  function prioritize() {
    var q = S.queue;
    if (q.length < 12) return;   // 小队列没必要算（getBoundingClientRect 会触发重排）
    var n = Math.min(q.length, 160);
    var vh = window.innerHeight || 800;
    var scored = [];
    for (var i = 0; i < n; i++) {
      var u = q[i];
      var r = null;
      try { r = u.el.getBoundingClientRect(); } catch (e) {}
      var s;
      if (!r || (r.width === 0 && r.height === 0)) s = 1e9 + i;
      else if (r.bottom > -300 && r.top < vh + 500) s = Math.max(0, Math.abs(r.top)) + i * 0.001;
      else s = 1e6 + Math.abs(r.top - vh) + i * 0.001;
      scored.push({ s: s, u: u });
    }
    scored.sort(function (a, b) { return a.s - b.s; });
    var out = [];
    for (var k = 0; k < scored.length; k++) out.push(scored[k].u);
    for (var j = n; j < q.length; j++) out.push(q[j]);
    S.queue = out;
  }

  function pump() {
    var _t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (S.mode === 'off' || S.killed) return;
    if (!S.queue.length) return;
    var cfg = S.cfg;
    prioritize();

    // 同时在途的「批数」上限（不是段数）：DSH 单 slot，2 批轮流就够了
    var maxBatches = Math.max(1, Math.min(6, cfg.parallelBatches || 4));
    if ((S.batches || 0) >= maxBatches) return;
    var room = Math.max(1, cfg.batchSize || 6);
    // 首屏：只发很少几段，让第一句尽快出现
    if (!S.sentAny) room = Math.min(room, Math.max(1, cfg.firstBatch || 2));
    // 已发过的批数不到一半时，保持小批，减少首屏等待
    else if ((S.batches || 0) < 2) room = Math.min(room, Math.max(2, Math.ceil((cfg.batchSize || 6) / 2)));
    // 短文本（标签、键值、UI 标签）单独塞更多段：它们 token 少、翻起来快，
    // 一批 6 段太浪费往返开销。
    else {
      var headLen = 0;
      for (var hi = 0; hi < Math.min(room, S.queue.length); hi++) headLen += (S.queue[hi].text || '').length;
      var avg = headLen / Math.max(1, Math.min(room, S.queue.length));
      if (avg > 0 && avg <= 24) room = Math.min(room * 3, 18);
      else if (avg <= 60) room = Math.min(room * 2, 12);
    }

    // 优先取和队首同一个「组」的（标签云、键值对这类同类短文本一起送给模型）
    var take = S.queue.splice(0, room);
    var headGrp = take.length ? take[0].grp : '';
    if (headGrp) {
      var same = [];
      for (var si = 0; si < S.queue.length && take.length < room; si++) {
        if (S.queue[si].grp === headGrp) { same.push(S.queue[si]); }
      }
      for (var sj = 0; sj < same.length && take.length < room; sj++) {
        var at = S.queue.indexOf(same[sj]);
        if (at >= 0) { S.queue.splice(at, 1); take.push(same[sj]); }
      }
    }
    var texts = [];
    for (var i = 0; i < take.length; i++) {
      texts.push({ key: take[i].key, text: take[i].text, rich: take[i].rich ? 1 : 0, grp: take[i].grp || '' });
    }
    S.inflight = (S.inflight || 0) + texts.length;
    S.sentAny = true;

    send({ t: 'translate', reqId: ++S.reqSeq, gen: S.gen, lang: cfg.targetLang, texts: texts });
    // 性能诊断：单次 pump 耗时 > 8ms 说明卡在强制重排
    try {
      var _dt = (performance.now ? performance.now() : 0) - _t0;
      if (_dt > 8) { S.slowPump = (S.slowPump || 0) + 1; S.lastSlowMs = Math.round(_dt); }
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- 通信 */

  function ensurePort() {
    if (S.port) return S.port;
    try { S.port = chrome.runtime.connect({ name: 'dsh' }); } catch (e) { return null; }
    S.port.onMessage.addListener(onPortMessage);
    S.port.onDisconnect.addListener(onPortDisconnect);
    return S.port;
  }

  function send(msg) {
    var p = ensurePort();
    if (!p) return;
    try { p.postMessage(msg); } catch (e) { S.port = null; setTimeout(function () { send(msg); }, 250); }
  }

  function onPortDisconnect() {
    S.port = null;
    try { void chrome.runtime.lastError; } catch (e) {}
    S.inflight = 0;
    S.sentAny = false;
  }

  function onPortMessage(msg) {
    if (!msg || !msg.t) return;
    if (msg.t === 'seg') { applySeg(msg); return; }
    if (msg.t === 'error') {
      var now = Date.now();
      var text = String(msg.message || '未知错误');
      var sig = text.replace(/[0-9]+/g, '#');
      if (sig === S.lastErrSig && now - S.lastErrAt < 8000) return;
      S.lastErrSig = sig;
      S.lastErrAt = now;
      toast('翻译失败：' + text + (hintFor(text)), 8000);
    }
  }

  function hintFor(text) {
    if (/Failed to fetch|连不上/i.test(text)) return '。检查 DSH 面板是否开着、地址是否正确';
    if (/还没连上|还没配置/i.test(text)) return '。打开扩展点「一键连接」';
    if (/HTTP 404|not enabled/i.test(text)) return '。DSH 面板里 translate 角色没加载';
    return '';
  }

  function updateBadge(force) {
    var now = Date.now();
    if (!force && now - S.lastBadge < 250) return;
    S.lastBadge = now;
    send({ t: 'progress', done: S.done, total: S.total });
  }

  /* ---------------------------------------------------------------- 渲染 */

  /** 把块里的直接文字节点包一层，便于「仅译文」整块隐藏 */
  function wrapTextNodes(u) {
    var el = u.el;
    var nodes = [];
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) {
      var s = document.createElement('span');
      s.className = 'dsh-orig';
      el.insertBefore(s, nodes[i]);
      s.appendChild(nodes[i]);
    }
  }

  /**
   * 把「原文」包进 .dsh-orig，方便「仅译文」时整块隐藏。
   *
   * 关键约束：绝不能无差别吞掉所有子节点。
   * <a><span>📢</span><span>announcements</span><span>12</span></a> 这种结构里，
   * 那个 📢（或 <img>/<svg>/背景图 div）是「图标」，不是文字。
   * 一旦被包进 .dsh-orig，一进「仅译文」/replace 模式图标就整个消失 ——
   * 这就是 Discord 图标栏/频道图标消失的真正原因。
   *
   * 所以：图标类子节点原地保留，只把文字节点和语义标签包起来。
   */
  function wrapAll(u) {
    var el = u.el;
    if (!el.firstChild) return;
    var span = document.createElement('span');
    span.className = 'dsh-orig';
    var movable = [];
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (isIconNode(n)) continue;          // 图标留在原地
      movable.push(n);
    }
    if (!movable.length) return;
    // 把 .dsh-orig 插到第一个可移动节点的位置，保持视觉顺序
    el.insertBefore(span, movable[0]);
    for (var i = 0; i < movable.length; i++) span.appendChild(movable[i]);
  }

  /** 这个子节点是不是「图标/素材」（不能跟着原文一起被隐藏） */
  function isIconNode(n) {
    if (!n) return false;
    if (n.nodeType === 3) return false;                    // 文字节点：不是图标
    if (n.nodeType !== 1) return false;
    var tag = n.tagName;
    if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE') return true;
    if (n.classList && (n.classList.contains('dsh-tr') || n.classList.contains('dsh-orig'))) return true;
    // 内联背景图/遮罩图（Discord 大量图标是这种 <div style="background-image:...">）
    try {
      var st = n.getAttribute && n.getAttribute('style');
      if (st && st.indexOf('background') >= 0 && st.indexOf('url(') >= 0) return true;
      var cs = getComputedStyle(n);
      if (cs) {
        var bg = cs.backgroundImage;
        if (bg && bg !== 'none' && bg.indexOf('url(') >= 0) return true;
        var mask = cs.maskImage || cs.webkitMaskImage;
        if (mask && mask !== 'none' && mask.indexOf('url(') >= 0) return true;
      }
    } catch (e) { /* ignore */ }
    // 纯符号/单字符内容（emoji 图标、字形图标）：也不算文字
    var t = (n.textContent || '').trim();
    if (t && t.length <= 2 && !/\p{L}\p{N}/u.test(t)) return true;
    // 里面只有图标（没有文字）的容器
    if (!t) { try { if (n.querySelector && n.querySelector('img, svg, [style*="background-image"]')) return true; } catch (e) {} }
    return false;
  }

  function render(u, text, final) {
    var el = u.el;
    if (!el || !el.isConnected) return;

    // 属性文本（alt / placeholder / aria-label / title）：直接写回属性
    if (u.mode === 'attr') {
      if (final && text) renderAttr(u, text);
      return;
    }

    // 标签行的键名（裸文本节点）：原位替换而不是追加。
    // 双语显示会变成 "Parodies: 恶搞作品:" 这种重复，标签行应该紧凑。
    if (u.mode === 'label') {
      if (final && text) {
        if (!u.labelEl) {
          u.labelEl = document.createElement('span');
          u.labelEl.className = 'dsh-tr dsh-tr-inline dsh-tr-label';
          u.labelEl.setAttribute('data-dsh-src', u.plain.slice(0, 200));
          if (u.labelNodes && u.labelNodes.length) {
            var lastNode = u.labelNodes[u.labelNodes.length - 1];
            if (lastNode.parentNode) lastNode.parentNode.insertBefore(u.labelEl, lastNode.nextSibling);
            // 隐藏原文本节点
            for (var ln = 0; ln < u.labelNodes.length; ln++) {
              try { u.labelNodes[ln].nodeValue = ''; } catch (e) {}
            }
          } else {
            u.el.insertBefore(u.labelEl, u.el.firstChild);
          }
        }
        // 补一个分隔：原文通常是 "Categories: " 这种，替换后需要前面的空格
        var needsSpace = /[:：]\s*$/.test(text);
        u.labelEl.textContent = needsSpace ? text + ' ' : text;
        u.state = 'done';
      }
      return;
    }

    // SVG <text>：直接换文字（SVG 里插 HTML 无效）
    if (u.mode === 'svgtext') {
      if (final && text) {
        if (!u.svgBackup) {
          u.svgBackup = u.el.textContent;
          u.el.dataset.dshSvgSrc = u.svgBackup;
        }
        u.el.textContent = text;
        u.state = 'done';
      }
      return;
    }

    // <option> 译文：直接换文本，不插 span（select 里插 DOM 会出问题）
    if (u.mode === 'option') {
      if (final && text) {
        u.el.textContent = text;
        u.state = 'done';
      }
      return;
    }

    if (!u.tr) {
      var inInteractive = false;
      try {
        inInteractive = (el.matches && el.matches(RE_INLINE_SEL)) || !!(el.closest && el.closest(RE_INLINE_SEL));
      } catch (e) {}
      // noWrap（带图片/视频的元素）永远最优先：
      // 这类元素绝不能包 .dsh-orig，否则「仅译文」「replace」会把图片一起藏掉。
      if (u.noWrap) {
        el.classList.add('dsh-no-wrap');
      } else if (u.mode === 'replace') {
        // replace 模式：窄元素里直接顶掉原文，不做双语
        wrapAll(u);
        el.classList.add('dsh-replaced');
      } else if (inInteractive && u.mode !== 'inline') {
        u.mode = 'inline';
        wrapAll(u);
      } else if (u.mode === 'inline') {
        wrapAll(u);
      } else if (u.mode === 'append') {
        wrapTextNodes(u);
      }

      var tr = document.createElement('span');
      tr.className = u.mode === 'replace' ? 'dsh-tr dsh-tr-replace'
        : (u.mode === 'inline' ? 'dsh-tr dsh-tr-inline' : 'dsh-tr');
      try { if (u.plain && u.plain.length <= 200) tr.setAttribute('data-dsh-src', u.plain); } catch (e) {}
      var lg = DSH.langTag(S.cfg.targetLang);
      if (lg) tr.setAttribute('lang', lg);

      if (u.mode === 'sibling') {
        if (!el.parentNode) return;
        el.parentNode.insertBefore(tr, el.nextSibling);
        el.classList.add('dsh-sib');
      } else if (u.mode === 'replace') {
        // 译文插到最前面，原文 .dsh-orig 被 CSS 隐藏
        el.insertBefore(tr, el.firstChild);
        el.classList.add('dsh-inline-unit');
      } else {
        el.appendChild(tr);
        if (u.mode === 'inline') el.classList.add('dsh-inline-unit');
      }
      el.classList.add('dsh-has-tr');
      el.classList.toggle('dsh-elm-only', S.mode === 'only');
      u.tr = tr;
    }

    if (u.rich && final && u.els) {
      var frag = parseRich(text, u.els);
      if (frag) {
        while (u.tr.firstChild) u.tr.removeChild(u.tr.firstChild);
        u.tr.appendChild(frag);
        u.tr.classList.add('dsh-rich');
        u.tr.classList.remove('dsh-live');
        u.state = 'done';
        return;
      }
      // 富文本还原失败：退回纯文本，但要留痕方便排查
      u.fmtLost = true;
      u.tr.classList.remove('dsh-rich');
      var shown = plainFromRich(text);
      if (u.tr.textContent !== shown) u.tr.textContent = shown;
    } else {
      var t2 = u.rich ? plainFromRich(text) : text;
      if (u.tr.textContent !== t2) u.tr.textContent = t2;
    }

    if (final) { u.tr.classList.remove('dsh-live'); u.state = 'done'; }
    else { u.tr.classList.add('dsh-live'); u.state = 'streaming'; }
  }

  function markFailed(u) {
    if (!u || !u.el) return;
    if (u.tr && u.tr.parentNode) u.tr.parentNode.removeChild(u.tr);
    u.tr = null;
    u.state = 'failed';
    if (u.el.classList) u.el.classList.remove('dsh-has-tr', 'dsh-sib', 'dsh-inline-unit', 'dsh-no-wrap', 'dsh-elm-only');
  }

  function applySeg(msg) {
    var list = S.byKey.get(msg.key);
    if (!list) return;
    if (S.mode === 'off' || S.killed) return;
    if (msg.final) S.batches = Math.max(0, (S.batches || 0) - 1);
    if (!msg.final) {
      if (!msg.text) return;
      for (var s = 0; s < list.length; s++) render(list[s], msg.text, false);
      return;
    }
    if (S.inflight > 0) S.inflight--;
    if (!msg.failed && msg.text) {
      S.done++;
      for (var i = 0; i < list.length; i++) render(list[i], msg.text, true);
    } else {
      for (var f = 0; f < list.length; f++) markFailed(list[f]);
    }
    updateBadge(S.done >= S.total);
    schedulePump();
  }

  /** 把「仅译文」标记同步到所有已翻元素（不重翻、不重建） */
  function applyModeToUnits(only) {
    S.byKey.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        if (!u || !u.el || !u.tr) continue;
        try { u.el.classList.toggle('dsh-elm-only', !!only); } catch (e) {}
      }
    });
  }

  function setMode(mode) {
    if (mode !== 'bilingual' && mode !== 'only') return;
    S.mode = mode;
    S.userMode = mode;
    document.documentElement.classList.toggle('dsh-only', mode === 'only');
    applyModeToUnits(mode === 'only');
    updateBadge(true);
  }

  /* ---------------------------------------------------------------- 起停 */

  function start(mode) {
    if (S.mode !== 'off') stop();
    S.gen++;
    S.mode = mode || S.userMode || S.cfg.mode || 'bilingual';
    S.killed = false;
    S.sentAny = false;
    S.inflight = 0;
    document.documentElement.classList.toggle('dsh-only', S.mode === 'only');
    ensureObserver();

    var units = collect(document.body);
    var cap = Math.max(50, S.cfg.maxUnits || 1200);
    if (units.length > cap) units = units.slice(0, cap);
    if (!units.length) { toast('这个页面没有找到可翻译的文字'); return; }
    enqueue(units);
    applyModeToUnits(S.mode === 'only');
    setTimeout(schedulePump, 100);
  }

  function stop() {
    S.mode = 'off';
    S.killed = true;
    S.gen++;
    send({ t: 'cancel' });
    document.documentElement.classList.remove('dsh-only');
    S.byKey.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var u = list[i];
        var el = u.el;
        if (u.tr && u.tr.parentNode) u.tr.parentNode.removeChild(u.tr);
        // 标签行的键名：恢复裸文本，移除译文 span
        if (u.mode === 'label' && el) {
          if (u.labelNodes && u.labelNodes.length) {
            for (var lb = 0; lb < u.labelNodes.length; lb++) {
              try { u.labelNodes[lb].nodeValue = u.labelText != null ? u.labelText : (u.plain || ''); } catch (e) {}
            }
          }
          if (u.labelEl && u.labelEl.parentNode) u.labelEl.parentNode.removeChild(u.labelEl);
        }
        if (u.mode === 'option' && el) {
          var ok2 = u.plain;
          if (ok2) el.textContent = ok2;
        }
        if (u.mode === 'svgtext' && el) {
          var sv = el.dataset && el.dataset.dshSvgSrc;
          if (sv) el.textContent = sv;
          if (el.dataset) delete el.dataset.dshSvgSrc;
        }
        if (u.attrList && el) {
          for (var av = 0; av < u.attrList.length; av++) {
            var au = u.attrList[av];
            var ak = attrKey(au.attr);
            if (el[ak] !== undefined && el[ak] !== null) {
              try { el.setAttribute(au.attr, el[ak]); } catch (e) {}
              try { delete el[ak]; } catch (e) { el[ak] = undefined; }
            }
          }
          el.classList.remove('dsh-attr-tr');
        }
        u.tr = null;
        if (!el) continue;
        el.classList.remove('dsh-has-tr', 'dsh-sib', 'dsh-inline-unit', 'dsh-no-wrap', 'dsh-elm-only');
        // 属性译文还原
        for (var ai = 0; ai < ATTR_TEXT_KEYS.length; ai++) {
          var aAttr = ATTR_TEXT_KEYS[ai];
          var aK = attrKey(aAttr);
          if (el[aK] !== undefined && el[aK] !== null) {
            try { el.setAttribute(aAttr, el[aK]); } catch (e) {}
            try { delete el[aK]; } catch (e) { el[aK] = undefined; }
          }
        }
        el.classList.remove('dsh-attr-tr');
        if (el.dataset) delete el.dataset.dshDone;
        var origs = el.querySelectorAll(':scope > .dsh-orig');
        for (var k = 0; k < origs.length; k++) {
          var s = origs[k];
          while (s.firstChild) el.insertBefore(s.firstChild, s);
          if (s.parentNode) s.parentNode.removeChild(s);
        }
      }
    });
    S.byKey.clear();
    S.byEl = new WeakMap();
    S.queue = [];
    S.done = 0;
    S.total = 0;
    S.inflight = 0;
    send({ t: 'progress', done: 0, total: 0 });
    hideBubble();
  }

  /* ------------------------------------------------------------ 动态内容 */

  function isOurs(node) {
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    if (el.classList && el.classList.contains('dsh-tr')) return true;
    return !!(el.closest && el.closest('.dsh-tr'));
  }

  function inOrig(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('.dsh-orig'));
  }

  function unitAncestor(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      if (S.byEl.has(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function ensureObserver() {
    if (S.observer) return;
    S.observer = new MutationObserver(function (muts) {
      if (S.mode === 'off') return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') {
          if (isOurs(m.target)) continue;
          var holder = unitAncestor(m.target);
          if (holder) queueScan(holder);
          continue;
        }
        if (isOurs(m.target)) continue;
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (isOurs(n) || inOrig(n)) continue;
          queueScan(n);
        }
      }
    });
    S.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function queueScan(node) {
    if (!S.scanSet) S.scanSet = new Set();
    S.scanSet.add(node);
    if (S.scanTimer) return;
    S.scanTimer = setTimeout(function () {
      S.scanTimer = null;
      var set = S.scanSet;
      S.scanSet = null;
      rescan(set);
    }, 400);
  }

  function rescan(nodes) {
    if (S.mode === 'off' || !nodes) return;
    var add = [];
    nodes.forEach(function (n) {
      if (!n || !n.isConnected || n.nodeType !== 1) return;
      if (n.dataset && n.dataset.dshDone === '1') { retranslate(n); return; }
      var got = collect(n);
      for (var i = 0; i < got.length; i++) add.push(got[i]);
    });
    if (add.length) enqueue(add);
  }

  function retranslate(el) {
    var u = S.byEl.get(el);
    if (!u) return;
    if (u.tr && u.tr.parentNode) u.tr.parentNode.removeChild(u.tr);
    u.tr = null;
    var origs = el.querySelectorAll(':scope > .dsh-orig');
    for (var k = 0; k < origs.length; k++) {
      var s = origs[k];
      while (s.firstChild) el.insertBefore(s.firstChild, s);
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    el.classList.remove('dsh-has-tr', 'dsh-sib', 'dsh-inline-unit', 'dsh-no-wrap', 'dsh-elm-only');
    if (el.dataset) delete el.dataset.dshDone;
    S.byEl.delete(el);
    var list = S.byKey.get(u.key);
    if (list) {
      var i = list.indexOf(u);
      if (i >= 0) list.splice(i, 1);
    }
    var nu = makeUnit(el);
    if (nu) enqueue([nu]);
  }

  /* ------------------------------------------------------------ 划词翻译 */

  /**
   * 划词翻译的气泡。
   *
   * 设计要点（都是踩过或用过之后确定的）：
   *   1. **两层结构**：英文原文（小字灰）+ 中文译文（大字）。用户可能忘了自己选了啥。
   *   2. **跟随滚动**：用选区在视口里的坐标定位，滚动时重新算。原来算一次就固定，
   *      往下滚气泡就飘走了。
   *   3. **点击外部关闭**：气泡不该赖着不走。点页面任意处 / 按 Esc 都关。
   *   4. **复制按钮**：译文一键复制。翻译完最常见的动作就是复制。
   *   5. **自动消失**：无操作 25 秒后自己关（避免堆屏）。
   *   6. **不吞选区**：气泡自己是 user-select:text，选中气泡里的字不会再触发翻译。
   */
  var BUBBLE_TTL = 25000;     // 无操作多少毫秒后自动关闭
  var SEL_DEBOUNCE = 220;     // 选区变化防抖：拖拽途中不触发
  var selTimer = null;        // 防抖定时器
  var selAnchorText = '';     // 上次处理过的选区文本（避免重复翻译同一段）
  var bubbleTimer = null;     // 自动关闭定时器

  /** 当前选区在视口里的矩形（多点取并集，跨行也准） */
  function selectionRects() {
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      var out = [];
      for (var ri = 0; ri < sel.rangeCount; ri++) {
        var range = sel.getRangeAt(ri);
        var rects = range.getClientRects();
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i];
          if (r && (r.width > 1 || r.height > 1)) out.push(r);
        }
      }
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  /** 选区的并集矩形（给气泡定位用） */
  function selectionBBox() {
    var rects = selectionRects();
    if (!rects) return null;
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].left < l) l = rects[i].left;
      if (rects[i].top < t) t = rects[i].top;
      if (rects[i].right > r) r = rects[i].right;
      if (rects[i].bottom > b) b = rects[i].bottom;
    }
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }

  /** 气泡定位：选区下方优先；下方放不下就放上方；都不行贴边 */
  function placeBubble(b, bbox) {
    var vw = window.innerWidth, vh = window.innerHeight;
    b.style.visibility = 'hidden';
    b.style.left = '0px';
    b.style.top = '0px';
    var w = b.offsetWidth, h = b.offsetHeight;

    var left = (bbox ? bbox.left : vw / 2) - 8;
    left = Math.max(8, Math.min(vw - w - 8, left));

    var top = (bbox ? bbox.bottom + 10 : vh / 2);
    if (top + h > vh - 8) {
      var above = (bbox ? bbox.top - h - 10 : 0);
      top = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    b.style.visibility = '';
  }

  /** 建气泡骨架（原文块 + 译文块 + 工具条）。只在第一次建，后续只更新内容 */
  function buildBubble() {
    hideBubble();
    var b = document.createElement('div');
    b.className = 'dsh-bubble';
    b.setAttribute('data-dsh-ui', '1');

    var src = document.createElement('div');
    src.className = 'dsh-bubble-src';
    var dst = document.createElement('div');
    dst.className = 'dsh-bubble-dst dsh-bubble-loading';
    dst.textContent = '翻译中…';

    var tools = document.createElement('div');
    tools.className = 'dsh-bubble-tools';
    var btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'dsh-bubble-btn';
    btnCopy.textContent = '复制';
    var btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'dsh-bubble-btn';
    btnClose.textContent = '×';
    tools.appendChild(btnCopy);
    tools.appendChild(btnClose);

    b.appendChild(src);
    b.appendChild(dst);
    b.appendChild(tools);
    document.documentElement.appendChild(b);
    S.bubble = b;
    S.bubbleSrc = src;
    S.bubbleDst = dst;

    btnCopy.addEventListener('click', function (e) {
      e.stopPropagation();
      copyText(dst.textContent || '');
      btnCopy.textContent = '已复制';
      setTimeout(function () { btnCopy.textContent = '复制'; }, 1400);
    });
    btnClose.addEventListener('click', function (e) {
      e.stopPropagation();
      hideBubble();
    });
    // 气泡自己的交互不该被当成"点外部"
    b.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    return b;
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) { /* 回退 */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* ignore */ }
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (S.bubble && S.bubble.parentNode) S.bubble.parentNode.removeChild(S.bubble);
    S.bubble = null;
    S.bubbleSrc = null;
    S.bubbleDst = null;
  }

  /** 有操作就重置自动关闭计时 */
  function armBubbleTimer() {
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { hideBubble(); }, BUBBLE_TTL);
  }

  /**
   * 选区变化 → 要不要翻译。
   *
   * 这里有六道过滤，每道都对应一个真实误触场景：
   */
  function onSelectionSettled() {
    if (S.cfg.selectionTranslate === false) return;   // ① 用户关了开关

    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();

    if (!text) return;
    if (text.length < 2) return;                       // ② 单字符（中文一个字）不翻
    if (text.length > 1200) return;                    // ③ 太长：撑爆 translate 的 2048 ctx
    if (text === selAnchorText) return;                // ④ 同一段已经翻过了

    var node = sel.anchorNode;
    if (!node) return;
    var host = node.nodeType === 1 ? node : node.parentElement;
    if (!host) return;
    // ⑤ 选中的是我们自己画的东西（气泡 / 译文）→ 不翻
    try {
      if (host.closest && host.closest('[data-dsh-ui], .dsh-bubble, .dsh-tr, .dsh-orig, .dsh-panel, .dsh-imgpanel')) return;
    } catch (e) { /* ignore */ }
    // ⑥ 在输入框 / contenteditable 里选 → 不翻（用户可能在编辑）
    try {
      if (host.closest && host.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    } catch (e) { /* ignore */ }
    // ⑦ 已经是目标语言 → 不翻（这个用 DSH 自己的判定，最准）
    try {
      if (!DSH.isTranslatable(text, S.cfg.targetLang)) return;
    } catch (e) { /* ignore */ }

    selAnchorText = text;
    translateSelection(text);
  }

  function onSelectionChange() {
    if (selTimer) clearTimeout(selTimer);
    selTimer = setTimeout(onSelectionSettled, SEL_DEBOUNCE);
  }

  /** 把选区文本交给后台翻译，结果写进气泡 */
  function translateSelection(text, opts) {
    var t = DSH.normSpace(text).slice(0, 1200);
    if (!t) return;
    opts = opts || {};

    var bbox = selectionBBox();
    // 右键菜单来的没有选区（右键会清掉），用鼠标坐标造一个点状 bbox
    if (!bbox && opts.x != null && opts.y != null) {
      bbox = { left: opts.x, top: opts.y, right: opts.x, bottom: opts.y, width: 0, height: 0 };
    }
    var b = buildBubble();
    if (S.bubbleSrc) S.bubbleSrc.textContent = t;
    placeBubble(b, bbox);
    armBubbleTimer();

    var reqId = (S.selSeq = (S.selSeq || 0) + 1);

    if (opts.cached) {
      // 后台直接命中缓存时走这条：不展示"翻译中"，直接出结果
      if (S.bubbleDst) {
        S.bubbleDst.classList.remove('dsh-bubble-loading');
        S.bubbleDst.textContent = opts.cached;
      }
      return;
    }

    chrome.runtime.sendMessage({ t: 'translateText', text: t }).then(function (r) {
      if (reqId !== S.selSeq) return;                  // 已经发了新的请求，丢弃旧结果
      if (!S.bubbleDst) return;
      S.bubbleDst.classList.remove('dsh-bubble-loading');
      if (!r || !r.ok) {
        S.bubbleDst.textContent = '失败：' + ((r && r.error) || '未知错误');
        S.bubbleDst.classList.add('dsh-bubble-err');
        return;
      }
      S.bubbleDst.textContent = r.text || '（无结果）';
      // 译文变了就重定位（气泡高度可能变）
      placeBubble(S.bubble, selectionBBox());
    }).catch(function (e) {
      if (reqId !== S.selSeq || !S.bubbleDst) return;
      S.bubbleDst.classList.remove('dsh-bubble-loading');
      S.bubbleDst.textContent = '失败：' + ((e && e.message) || '网络错误');
      S.bubbleDst.classList.add('dsh-bubble-err');
    });
  }

  /* ============================================ 反向翻译（中 → 外） */

  /**
   * 抓取「要转译的目标」：元素 + 选区 + 文本。
   *
   * 返回 { el, kind, text, start, end } ——
   *   kind: 'textarea' | 'input' | 'contenteditable' | 'plain'
   *
   * ## 判定顺序（实测得出）
   *
   * ① 先看**当前焦点元素**是不是可编辑的。
   *    右键时焦点通常还在输入框里，这是最可靠的信号。
   *
   * ② 焦点不在输入框，再看 window.getSelection() 的 anchorNode 祖先里
   *    有没有可编辑的（有些站点不把焦点给 textarea）。
   *
   * ③ 都没有 → plain（普通页面选区，只能显示译文，不能替换）。
   */
  function grabReverseTarget(fallbackText) {
    function pick(el) {
      if (!el || el.nodeType !== 1) return null;
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') {
        var ts = el.selectionStart, te = el.selectionEnd;
        if (ts == null || te == null) { ts = 0; te = String(el.value || '').length; }
        return {
          el: el, kind: 'textarea',
          text: String(el.value || '').slice(ts, te),
          start: ts, end: te
        };
      }
      if (tag === 'INPUT') {
        var type = String(el.type || 'text').toLowerCase();
        // 这些 input 没有文本选区
        if (type === 'checkbox' || type === 'radio' || type === 'file' ||
            type === 'submit' || type === 'button' || type === 'color' ||
            type === 'range' || type === 'date' || type === 'time') return null;
        var s = el.selectionStart, e = el.selectionEnd;
        if (s == null || e == null) { s = 0; e = String(el.value || '').length; }
        return {
          el: el, kind: 'input',
          text: String(el.value || '').slice(s, e),
          start: s, end: e
        };
      }
      var ce = null;
      if (el.isContentEditable) ce = el;
      else if (el.closest) {
        try { ce = el.closest('[contenteditable=""], [contenteditable="true"]'); } catch (x) { ce = null; }
      }
      if (ce) {
        var sel0 = window.getSelection();
        var txt0 = sel0 && !sel0.isCollapsed ? String(sel0.toString()) : '';
        return { el: ce, kind: 'contenteditable', text: txt0, sel: sel0 };
      }
      return null;
    }

    /**
     * ⚠ 实测坑：右键时 document.activeElement 有时会变成 body，
     * 而不是原来的输入框（不同站点行为不一致）。
     *
     * 所以判定顺序调整为：
     *   ① 先拿候选元素（焦点元素 / 选区祖先里可编辑的）
     *   ② 如果候选自身能给出选区文本 → 用它
     *   ③ 候选给不出，但 msg.text（浏览器给的 selectionText）非空
     *      → 用 msg.text，同时保留候选元素（这样仍能替换）
     */
    var candidates = [];
    var act = document.activeElement;
    var c1 = pick(act);
    if (c1) candidates.push(c1);

    try {
      var selA = window.getSelection();
      if (selA && selA.rangeCount && !selA.isCollapsed) {
        var nodeA = selA.anchorNode;
        var hostA = nodeA ? (nodeA.nodeType === 1 ? nodeA : nodeA.parentElement) : null;
        for (var upA = hostA, dp = 0; upA && dp < 8; upA = upA.parentElement, dp++) {
          var gA = pick(upA);
          if (gA && gA !== c1) { gA.text = String(selA.toString()); candidates.push(gA); }
        }
      }
    } catch (x) { /* ignore */ }

    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = candidates[ci];
      if (cand.text && String(cand.text).trim()) return cand;
    }

    // 候选拿不到文本，但浏览器给了 selectionText → 用浏览器给的
    var fb = String(fallbackText || '').trim();
    if (fb) {
      var best = candidates.length ? candidates[0] : null;
      if (best) {
        /**
         * 有元素但位置值可能失效（activeElement 变了）。
         * 用全文搜索定位这段文本在 value 里的位置，这样替换还能用。
         */
        try {
          if (best.kind === 'textarea' || best.kind === 'input') {
            var full = String(best.el.value || '');
            var at = full.indexOf(fb);
            if (at >= 0) { best.text = fb; best.start = at; best.end = at + fb.length; return best; }
          }
        } catch (x) { /* ignore */ }
        best.text = fb;
        return best;
      }
      return { el: null, kind: 'plain', text: fb };
    }

    // ② 选区 anchorNode 往上找可编辑容器
    try {
      var sel2 = window.getSelection();
      if (sel2 && sel2.rangeCount && !sel2.isCollapsed) {
        var node = sel2.anchorNode;
        var host = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
        for (var up = host, depth = 0; up && depth < 8; up = up.parentElement, depth++) {
          var g2 = pick(up);
          if (g2) { g2.text = String(sel2.toString()); g2.sel = sel2; return g2; }
        }
      }
    } catch (x) { /* ignore */ }

    // ③ 普通页面选区
    var t = String(fallbackText || '').trim();
    if (t) return { el: null, kind: 'plain', text: t };
    try {
      var sel3 = window.getSelection();
      if (sel3 && !sel3.isCollapsed) {
        var t3 = String(sel3.toString()).trim();
        if (t3) return { el: null, kind: 'plain', text: t3, sel: sel3 };
      }
    } catch (x) { /* ignore */ }
    return null;
  }

  /**
   * 把译文写回输入框，替换掉原来的选区。
   *
   * ## 为什么用 execCommand('insertText')
   *
   * 直接改 el.value 的问题：React / Vue 受控组件监听的是原生 input 事件，
   * 直接赋值 .value 不会触发 onChange → 组件状态和 DOM 不一致，
   * 用户再输入一个字就整段回滚。
   *
   * execCommand('insertText') 走浏览器原生编辑路径：
   *   · 触发 input 事件 → 受控组件能同步
   *   · 自动进 Undo 栈（Ctrl+Z 能撤销）
   *
   * @returns {boolean} 是否成功
   */
  function replaceSelection(payload, newText) {
    if (!payload || !payload.el) return false;
    var el = payload.el;

    try {
      if (payload.kind === 'textarea' || payload.kind === 'input') {
        var s = payload.start, e = payload.end;
        if (s == null || e == null) return false;
        // 先恢复焦点和选区（右键可能把焦点挪走了，但位置值还在）
        try { el.focus(); } catch (x) { /* ignore */ }
        try { el.setSelectionRange(s, e); } catch (x) { /* ignore */ }
        try {
          var okIns = document.execCommand('insertText', false, newText);
          if (okIns) return true;
        } catch (x) { /* ignore */ }
        /**
         * 兜底：execCommand 不可用时退回 setRangeText。
         * 它同样能保留 Undo 栈，但不触发 input 事件 —— 手动派发一次。
         */
        try {
          el.setRangeText(newText, s, e, 'end');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        } catch (x) { /* ignore */ }
        return false;
      }

      if (payload.kind === 'contenteditable') {
        try { el.focus(); } catch (x) { /* ignore */ }
        var sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          var range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(newText));
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newText }));
          return true;
        }
        try {
          var ok2 = document.execCommand('insertText', false, newText);
          if (ok2) return true;
        } catch (x) { /* ignore */ }
        return false;
      }

      return false;   // plain：普通页面选区，不能替换
    } catch (e) {
      return false;
    }
  }

  /**
   * 反向翻译面板：显示译文 + [复制] [替换原文]。
   *
   * 为什么不用现有气泡：
   *   气泡是「只读展示」定位在选区上方，而反向翻译需要两个操作按钮，
   *   且用户可能要先对照原文再决定改不改。做成小面板更合适。
   */
  function buildReversePanel(payload, langLabel) {
    var old = document.querySelector('.dsh-revpanel');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var p = document.createElement('div');
    p.className = 'dsh-revpanel';
    p.setAttribute('data-dsh-ui', '1');

    var head = document.createElement('div');
    head.className = 'dsh-rv-head';
    head.textContent = '转译成 ' + langLabel;
    p.appendChild(head);

    var src = document.createElement('div');
    src.className = 'dsh-rv-src';
    src.textContent = payload.text.slice(0, 300);
    p.appendChild(src);

    var dst = document.createElement('div');
    dst.className = 'dsh-rv-dst dsh-rv-loading';
    dst.textContent = '翻译中…';
    p.appendChild(dst);

    var foot = document.createElement('div');
    foot.className = 'dsh-rv-foot';

    var btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.textContent = '复制';
    btnCopy.disabled = true;

    var btnReplace = document.createElement('button');
    btnReplace.type = 'button';
    btnReplace.className = 'dsh-rv-primary';
    btnReplace.textContent = payload.kind === 'plain' ? '替换（不可用）' : '替换原文';
    btnReplace.disabled = true;

    var btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.textContent = '关闭';

    foot.appendChild(btnCopy);
    foot.appendChild(btnReplace);
    foot.appendChild(btnClose);
    p.appendChild(foot);

    document.body.appendChild(p);
    S.revPanel = p;
    S.revPayload = payload;
    S.revOut = '';

    btnClose.addEventListener('click', function () {
      if (p.parentNode) p.parentNode.removeChild(p);
      S.revPanel = null;
    });

    btnCopy.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(S.revOut || '');
        btnCopy.textContent = '已复制';
        setTimeout(function () { btnCopy.textContent = '复制'; }, 1500);
      } catch (x) {
        // 剪贴板权限被拒 → 把译文选中，让用户自己 Ctrl+C
        var r = document.createRange();
        r.selectNodeContents(dst);
        var s = window.getSelection();
        if (s) { s.removeAllRanges(); s.addRange(r); }
        btnCopy.textContent = '请按 Ctrl+C';
      }
    });

    btnReplace.addEventListener('click', async function () {
      var ok = replaceSelection(S.revPayload, S.revOut || '');
      if (ok) {
        btnReplace.textContent = '已替换';
        setTimeout(function () {
          if (p.parentNode) p.parentNode.removeChild(p);
          S.revPanel = null;
        }, 800);
      } else {
        btnReplace.textContent = '替换失败，请用复制';
        btnReplace.disabled = true;
      }
    });

    return { panel: p, dst: dst, copy: btnCopy, replace: btnReplace };
  }

  /**
   * 反向翻译主流程。
   *
   * @param {object} payload grabReverseTarget 的结果
   * @param {string} langId  语言 id（en / ja / ko / ...）
   */
  async function reverseTranslate(payload, langId, pos) {
    var L = DSH.reverseLang(langId);
    var ui = buildReversePanel(payload, L.zh);

    // 面板定位：放在鼠标点附近（右键位置最稳，选区矩形有时拿不到）
    try {
      var ax = pos && pos.x != null ? pos.x : window.innerWidth / 2;
      var ay = pos && pos.y != null ? pos.y : 60;
      var w = 320, h = 190;
      ui.panel.style.left = Math.max(8, Math.min(ax, window.innerWidth - w - 8)) + 'px';
      ui.panel.style.top = Math.max(8, Math.min(ay + 12, window.innerHeight - h - 8)) + 'px';
    } catch (x) { /* ignore */ }

    var t0 = Date.now();
    var r;
    try {
      r = await chrome.runtime.sendMessage({
        t: 'translateReverse',
        text: payload.text,
        lang: L.id
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }

    if (!r || !r.ok) {
      ui.dst.classList.remove('dsh-rv-loading');
      ui.dst.classList.add('dsh-rv-err');
      ui.dst.textContent = '失败：' + ((r && r.error) || '未知错误');
      return { ok: false, error: (r && r.error) || 'unknown' };
    }

    S.revOut = String(r.text || '').trim();
    ui.dst.classList.remove('dsh-rv-loading');
    ui.dst.textContent = S.revOut || '（无结果）';
    ui.copy.disabled = false;
    if (payload.kind !== 'plain') ui.replace.disabled = false;

    return { ok: true, text: S.revOut, lang: L.id, ms: Date.now() - t0, kind: payload.kind };
  }

  /* ---- 划词翻译的事件绑定（只绑一次） ---- */

  function bindSelectionUX() {
    if (S.selBound) return;
    S.selBound = true;

    document.addEventListener('selectionchange', onSelectionChange);

    // 滚动 / 缩放时把气泡跟过去
    var reposition = function () {
      if (!S.bubble) return;
      var bbox = selectionBBox();
      if (bbox) placeBubble(S.bubble, bbox);
    };
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });

    // 点外部 / Esc 关闭
    document.addEventListener('mousedown', function (e) {
      if (!S.bubble) return;
      var t = e.target;
      if (t && t.closest && t.closest('[data-dsh-ui]')) return;
      hideBubble();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.bubble) hideBubble();
    }, true);
  }

  /* ---------------------------------------------------------- 图片翻译接线 */

  /**
   * 把图片翻译模块（imgtranslate.js）接到扩展的能力上。
   *
   * 模块自己不碰 chrome.runtime（那样要处理 port 重连、错误重试）；
   * 这里统一给它一个「图块 dataURL → 译文」的函数，出错的重试/缓存
   * 都留在扩展这层，职责清楚。
   */
  function wireImageTranslate() {
    var M = globalThis.__DSH_IMG__;
    if (!M) { console.warn('[DSH] imgtranslate 模块未加载'); return; }

    M.setConfig(S.cfg);

    /**
     * 图块翻译：
     *   ① 先查缓存（同一块图以前翻过就秒回）
     *      缓存键用「内容 hash」—— 同一张图重复翻不花时间
     *   ② 没命中就发后台
     */
    M.setTranslator(async function (dataUrl, targetLang) {
      var key = 'img:' + String(dataUrl).length + ':' + simpleHash(String(dataUrl));
      try {
        var hit = await chrome.runtime.sendMessage({ t: 'probeCache', text: key });
        if (hit && hit.ok && hit.hit) {
          return { text: hit.hit, src: '', cached: true };
        }
      } catch (e) { /* ignore */ }

      var r = await chrome.runtime.sendMessage({
        t: 'translateImageBlock',
        dataUrl: dataUrl,
        targetLang: targetLang
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '翻译失败');
      return { text: r.text || '', src: r.src || '', ms: r.ms };
    });

    M.setEnabled(S.cfg.imageTranslate !== false);
    // 自动翻译开关（图片变化即翻）
    try { M.setAutoTranslate(S.cfg.imageAutoTranslate === true); } catch (e) { /* ignore */ }

    /**
     * 跨域图加载能力。
     *
     * 页面里的图常常在独立域名上（nhentai 的 i4.nhentai.net、pixiv 的 i.pximg.net），
     * 直接 drawImage 到 canvas 会被标记 tainted，读不到像素。
     *
     * 交给 background 抓：它的 fetch 走扩展 host_permissions，不受页面同源策略限制。
     * 拿回来的是 data URL（同源），content script 就能安全地画进 canvas 了。
     */
    M.setImageLoader(async function (srcUrl) {
      var r = await chrome.runtime.sendMessage({ t: 'fetchImage', url: srcUrl });
      if (!r || !r.ok) throw new Error((r && r.error) || '抓图失败');
      return { dataUrl: r.dataUrl, width: r.width, height: r.height, bytes: r.bytes };
    });

    /**
     * 整页翻译器（Alt+Shift+点击 → 列表展示，覆盖率高）。
     *
     * 跟 setTranslator 的区别：这个不做定位、不盖图，
     * 一次 OCR + 一次翻译，把整页文字列出来。
     */
    /**
     * 版面检测器（Surya-OCR-2，650M，给精确 bbox + 区分 Text/Image）。
     *
     * 这是「定位不准」问题的最终解：
     *   · 纯 CV 形态学 → 会框错（同一段文字被拆成两块）
     *   · Surya → 完美（实测 9/9 区域全对）
     */
    /**
     * 快速模式翻译器：把 CV 框 + 整页图一起送后台，
     * 后台做 OCR + 翻译 + 按阅读顺序配对。
     */
    M.setFastTranslator(async function (dataUrl, cvBoxes, imageW, imageH) {
      var r = await chrome.runtime.sendMessage({
        t: 'translateImageFast',
        dataUrl: dataUrl,
        cvBoxes: cvBoxes,
        imageW: imageW,
        imageH: imageH,
        targetLang: S.cfg.targetLang || '简体中文'
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '快速翻译失败');
      return r;
    });

    M.setLayoutDetector(async function (dataUrl) {
      var r = await chrome.runtime.sendMessage({ t: 'detectImageLayout', dataUrl: dataUrl });
      if (!r || !r.ok) throw new Error((r && r.error) || '版面检测失败');
      return { ok: true, boxes: r.boxes || [], imageBlocks: r.imageBlocks || [], raw: r.raw, ms: r.ms };
    });

    M.setPageTranslator(async function (dataUrl, targetLang) {
      var r = await chrome.runtime.sendMessage({
        t: 'translateImagePage',
        dataUrl: dataUrl,
        targetLang: targetLang
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '整页识别失败');
      return r;
    });
  }

  /** 快速哈希（用于图片内容缓存键，不要求密码学强度） */
  function simpleHash(str) {
    var h = 0;
    var step = Math.max(1, Math.floor(str.length / 512));
    for (var i = 0; i < str.length; i += step) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return String(h >>> 0);
  }

  /* ---------------------------------------------------------------- 消息 */

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case 'dsh-ping': sendResponse({ ok: true }); return;
      // 后台缓存被清空：本页的键也作废，下次翻译重新走模型。
      // 已渲染的译文不删 —— 用户眼前不该闪一下。
      case 'cacheCleared':
        try {
          S.byKey = {};
          S.batches = [];
        } catch (e) {}
        sendResponse({ ok: true });
        return;
      case 'dsh-status':
        sendResponse({ ok: true, mode: S.mode, total: S.total, done: S.done });
        return;
      case 'dsh-toggle':
        S.autoBlocked = true;
        if (S.mode === 'off') start(); else stop();
        sendResponse({ ok: true, mode: S.mode });
        return;
      case 'dsh-mode':
        S.autoBlocked = true;
        if (msg.mode === 'off') stop();
        else if (S.mode === 'off') start(msg.mode);
        else setMode(msg.mode);
        sendResponse({ ok: true, mode: S.mode });
        return;
      case 'dsh-retranslate':
        S.autoBlocked = true;
        var keep = S.userMode || S.mode;
        stop();
        if (keep && keep !== 'off') start(keep);
        sendResponse({ ok: true, mode: S.mode });
        return;
      case 'dsh-config':
        var old = S.cfg;
        S.cfg = Object.assign({}, DSH.DEFAULTS, msg.cfg || {});
        try { wireImageTranslate(); } catch (e) { /* ignore */ }
        if (S.mode !== 'off') {
          var needReload =
            old.targetLang !== S.cfg.targetLang ||
            old.endpoint !== S.cfg.endpoint ||
            old.model !== S.cfg.model ||
            old.batchSize !== S.cfg.batchSize ||
            old.maxChars !== S.cfg.maxChars ||
            old.skipSelectors !== S.cfg.skipSelectors;
          if (needReload) { var k2 = S.mode; stop(); start(k2); }
          else if (old.mode !== S.cfg.mode) setMode(S.userMode || S.cfg.mode);
        }
        sendResponse({ ok: true });
        return;
      /**
       * ---- 反向翻译：中文 → 外语 ----
       *
       * ## 为什么不能复用 dsh-selection
       *
       * dsh-selection 的前提是「选区在页面里、而且不是输入框」——
       * onSelectionChange 里就明确把 input/textarea/contenteditable 排除了
       * （避免用户编辑时反复弹气泡）。
       *
       * 反向翻译的场景**恰好全在输入框里**，所以要单开一条路径。
       *
       * ## 选区怎么拿（实测结论）
       *
       * 右键时浏览器**不会**清掉输入框里的选区：
       *
       *   textarea:      el.selectionStart / el.selectionEnd 仍然有效
       *   input:         同上
       *   contenteditable: window.getSelection() 仍然有效
       *
       * 实测（Edge 157 / textarea「I want to translate…」）：
       *   mousedown  → start=0 end=34 selected="I want to translate this sentence "
       *   mouseup    → 同上
       *   contextmenu → 同上   ← 关键：没被清掉
       *
       * 所以两种方式都取，取到非空优先；都失败才退回 info.selectionText。
       */
      case 'dsh-reverse':
        (async function () {
          try {
            var payload = grabReverseTarget(msg.text);
            if (!payload || !payload.text) {
              sendResponse({ ok: false, error: '没拿到选中的文字' });
              return;
            }
            var out = await reverseTranslate(payload, msg.lang, { x: msg.x, y: msg.y });
            sendResponse({ ok: true, result: out });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
        })();
        return true;

      case 'dsh-selection':
        // 右键菜单是显式操作，不管 selectionTranslate 开关；
        // 位置优先用消息里带来的鼠标点（右键可能已经清掉了选区）
        translateSelection(msg.text || '', { x: msg.x, y: msg.y });
        sendResponse({ ok: true });
        return;

      /**
       * 右键「翻译这张图的文字」。
       *
       * 参数里没有 IMG 元素（右键菜单只给 url / 坐标），所以要按坐标
       * 从页面里反查那张图 —— 跟 Alt+点击用的是同一套 resolveTargetImage
       * 逻辑，保证两边行为一致。
       */
      case 'dsh-image':
        (async function () {
          try {
            var M = globalThis.__DSH_IMG__;
            if (!M) { sendResponse({ ok: false, error: '图片翻译模块没加载' }); return; }
            var img = null;
            // ① 坐标命中（右键位置就是用户看到的图）
            if (msg.x != null && msg.y != null) {
              img = M.findImageAt(msg.x, msg.y);
            }
            // ② 退一步：用浏览器给的图片地址在页面里找对应的 <img>
            if (!img && msg.url) {
              img = M.findImageByUrl(msg.url);
            }
            if (!img) { sendResponse({ ok: false, error: '没在这张图附近找到可翻译的图片' }); return; }

            /**
             * 三种模式：
             *   mode='layout' → Surya 版面检测（最准，逐区域）
             *   mode='page'   → 整页 OCR（列表展示，覆盖率高）
             *   其它          → CV 逐块（原位盖，最快）
             */
            var mode = String(msg.mode || 'overlay');
            var r;
            if (mode === 'layout') r = await M.translateLayout(img);
            else if (mode === 'page') r = await M.translatePage(img);
            else if (mode === 'fast') r = await M.translateFast(img);
            else r = await M.translate(img, { mode: S.cfg.imgMode || 'overlay' });
            sendResponse({
              ok: !!r.ok,
              error: r.error || '',
              boxes: r.boxes ? r.boxes.length : 0,
              items: r.items ? r.items.length : 0,
              segments: r.segments ? r.segments.length : 0,
              layoutBoxes: r.layoutBoxes || 0,
              mode: mode
            });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
        })();
        return true;

      // 右键「翻译整页」
      case 'dsh-page-translate':
        S.autoBlocked = true;
        if (S.mode === 'off') start(); else setMode(S.cfg.mode || 'bilingual');
        sendResponse({ ok: true, mode: S.mode });
        return;

      // 右键「还原」
      case 'dsh-restore-all':
        S.autoBlocked = true;
        stop();
        try { if (globalThis.__DSH_IMG__) globalThis.__DSH_IMG__.restore(); } catch (e) {}
        sendResponse({ ok: true });
        return;
      default: return;
    }
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  /* ---------------------------------------------------------------- 启动 */

  /**
   * 自动翻译判定：**白名单机制**。
   *
   * 默认什么都不自动翻；只有用户在当前页打开「本站自动翻译」开关，
   * 这个站点的 origin 才会进 autoOnSites，下次打开才自动翻。
   *
   * 为什么用白名单而不是黑名单：
   *   · 自动翻译会消耗 NPU 算力，还可能在用户不想翻的站上乱翻
   *   · 黑名单模式下，没列过的站全都自动翻 —— 等于「默认全开」
   *   · 白名单模式下，没列过的站全都不翻 —— 等于「默认全关」，更可控
   *
   * autoOffSites 保留，作为「明确不改」的反向覆盖（优先级更高）。
   */
  function maybeAuto() {
    var cfg = S.cfg;
    if (S.mode !== 'off' || S.autoBlocked) return;
    if (!cfg.autoTranslate) return;

    var origin = location.origin;
    // 黑名单优先级最高
    var off = Array.isArray(cfg.autoOffSites) ? cfg.autoOffSites : [];
    if (off.indexOf(origin) >= 0) return;
    // 白名单：必须是明确列过的站
    var on = Array.isArray(cfg.autoOnSites) ? cfg.autoOnSites : [];
    if (on.indexOf(origin) < 0) return;

    var sample = '';
    try {
      var els = document.body.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,td,article,a,span,figure');
      for (var i = 0; i < els.length && sample.length < 2000; i++) {
        var t = els[i].textContent;
        if (t && t.length >= 2 && t.length <= 400) sample += t + '\n';
      }
    } catch (e) {}
    if (DSH.scriptStats(sample).letters < 60) return;
    var lang = DSH.detectLang(sample);
    if (!lang || DSH.sameLangAsTarget(lang, cfg.targetLang)) return;
    start();
  }

  chrome.storage.local.get('cfg', function (got) {
    if (chrome.runtime.lastError) { afterCfg(null); return; }
    afterCfg(got && got.cfg);
  });

  function afterCfg(cfg) {
    if (S.cfg.__loaded) return;
    S.cfg = Object.assign({}, DSH.DEFAULTS, cfg || {});
    S.cfg.__loaded = true;
    // 划词翻译的事件绑定：配置到位后再绑，避免和 dsh-config 消息抢顺序
    try { bindSelectionUX(); } catch (e) { /* ignore */ }
    // 图片翻译模块：注入翻译器 + 配置
    try { wireImageTranslate(); } catch (e) { /* ignore */ }
    setTimeout(maybeAuto, 500);
  }

  // 用户诊断出口：控制台敲 __DSH_DIAG() 一行看全部状态
  try {
    globalThis.__DSH_DIAG = function () { return globalThis.__DSH_INTERNALS__ && globalThis.__DSH_INTERNALS__.diag(); };
    globalThis.__DSH_FIX = function () {
      // 强制重扫一遍并翻当前页面（如果之前卡住了）
      try {
        globalThis.__DSH_INTERNALS__.stop();
        setTimeout(function () { globalThis.__DSH_INTERNALS__.start('bilingual'); }, 300);
        return '已重新开始，2 秒后再敲 __DSH_DIAG() 看进度';
      } catch (e) { return '失败: ' + e.message; }
    };
  } catch (e) {}

  // 测试出口（只读）
  try {
    globalThis.__DSH_INTERNALS__ = {
      collect: collect, makeUnit: makeUnit, isUnit: isUnit, shouldSkip: shouldSkip,
      sourceText: sourceText, serializeRich: serializeRich, parseRich: parseRich,
      setMode: setMode, start: start, stop: stop,
      render: render, renderAttr: renderAttr, applySeg: applySeg,
      lastCollect: function () { return lastCollect; },
      inProperNounRow: inProperNounRow,
      // 反向翻译（供测试直接调用；也方便日后外部集成）
      grabReverseTarget: grabReverseTarget,
      reverseTranslate: reverseTranslate,
      replaceSelection: replaceSelection,
      /** 一行诊断：把关键状态全打出来，用户在控制台敲 __DSH_DIAG() 就能看到 */
      diag: function () {
        var out = {
          installed: true,
          cfgLoaded: !!S.cfg.__loaded,
          mode: S.mode,
          endpoint: S.cfg.endpoint || '(auto)',
          model: S.cfg.model,
          hasPort: !!S.port,
          queue: S.queue.length,
          total: S.total,
          done: S.done,
          inflight: S.inflight,
          byKey: S.byKey.size,
          siteRule: (function () { return siteRuleLabel(); })(),
          lastCollectErr: lastCollect.error,
          lastCollectUnits: lastCollect.units,
          lastCollectMs: lastCollect.ms,
          skipSelectors: S.cfg.skipSelectors,
          bodyText: (document.body.textContent || '').trim().length
        };
        try { console.table(out); } catch (e) { console.log(out); }
        return out;
      },
      siteRule: function () { return siteRuleLabel(); },
      debugQueue: function () { return S.queue.map(function (u) { return { mode: u.mode, attr: u.attr || null, text: u.text.slice(0, 20) }; }); },
      state: function () {
        return {
          mode: S.mode, killed: S.killed, gen: S.gen,
          queue: S.queue.length, inflight: S.inflight, sentAny: !!S.sentAny,
          done: S.done, total: S.total, byKey: S.byKey.size,
          hasPort: !!S.port, reqSeq: S.reqSeq,
          slowPump: S.slowPump || 0, lastSlowMs: S.lastSlowMs || 0
        };
      }
    };
  } catch (e) {}
})();

