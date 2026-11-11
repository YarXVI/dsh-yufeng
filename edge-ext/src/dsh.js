/* =============================================================================
 * DSH 引擎层 (dsh.js)
 *
 * 只做一件事：跟 DSH 的 NPU 插件说话。不碰 chrome.*、不碰 DOM，
 * 所以能直接在 Node 里跑测试（见 test/）。
 *
 * DSH 的约定（实测）：
 *   前端     GET  http://host:47300/v1        → { service: 'dsh-npu', front, slots }
 *   模型列表 GET  http://host:47300/v1/models → data[].id 就是「角色名」
 *   对话     POST http://host:47300/v1/chat/completions   模型名 = 角色名
 *   translate 角色：Hy-MT2-1.8B，上下文 2048，约 160 tok/s
 * ========================================================================== */
(function (root) {
  'use strict';

  var NL = String.fromCharCode(10);

  /* ------------------------------------------------------------------ 默认值 */

  var DEFAULTS = {
    endpoint: '',           // 留空 = 自动发现（127.0.0.1 → 本机局域网 IP → 常见网段）
    model: 'translate',     // DSH 的角色名；留空时自动挑
    apiKey: '',              // DSH 设了 token 时填同一个值
    targetLang: '简体中文',
    mode: 'bilingual',      // bilingual | only
    batchSize: 6,           // 一次请求最多几段：实测 4/6/10/14 段的「每段耗时」几乎一样，6 段性价比最好
    maxChars: 1400,
    firstBatch: 2,          // 首屏只发这么几段，让第一句尽快出来
    concurrent: 1,          // DSH 的 translate 是单 slot：并发只会排队
    parallelBatches: 4,     // 同时在途的批数：实测并发 3 比串行快 1.8 倍（DSH 的 router 会排队，但能重叠 prefill/decode）
    temperature: 0,      // 贪心解码：同样的输入永远给同样的输出（稳定 > 多样性）
    contextTokens: 2048,
    maxTokens: 640,
    tagProtect: true,       // [Digital]【R版】这类标签原样保留
    dictEnabled: true,
    autoTranslate: false,       // 总开关：默认不自动翻
    autoOnSites: [],            // 白名单：只有这些来源会自动翻（协议 + 域名）
    autoOffSites: [],           // 黑名单：这些来源永远不自动翻（优先级高于白名单）
    lanSubnets: [],         // 手填网段前缀（例如 192.168.1），自动发现时优先扫
    skipSelectors: 'pre, code, kbd, samp, var, textarea, select, [data-no-translate], .dsh-tr',
    maxUnits: 1200,
    siteSkipSidebar: true,  // Discord/Slack 这类站点的导航壳（侧栏、图标栏）整体跳过
    numberProtect: true,    // 用占位符锁住数字（计数 / 金额 / 百分比），翻完原样还原
    selectionTranslate: true,   // 选中文字就弹气泡翻译（右键菜单永远可用，不受这个开关影响）
    selectionTargetLang: '',    // 划词翻成的语言；留空 = 跟随 targetLang
    imageTranslate: true,       // Alt + 点图 → 图片翻译
    imgMode: 'overlay',         // overlay = 译文盖在图上；panel = 只弹面板
    imgMaxBoxes: 40,            // 单张图最多翻多少块（防超大长图拖死）
    imgMaxSide: 1280,           // 检测前把图缩到这个长边（vision ctx 上限决定的）
    /**
     * 两阶段图片翻译：先 vision OCR，再 translate 翻译。
     *
     * 实测（真实漫画页竖排日文）：
     *   一步到位（translate 兼职 OCR） → 识别就错，翻译必然错
     *   两阶段（vision 读字 + translate 翻） → 全对
     *
     * 关掉它会退回一步到位（少一次请求，但对竖排/复杂排版质量差很多）。
     */
    /**
     * 图片自动翻译：图片一变化就自动翻译，无需手动点。
     *
     * 「翻页自动翻译」的实现原理：监听 <img> 的 src 变化（load/error/MutationObserver），
     * 这覆盖了鼠标点、方向键、滚轮、无限滚动等**所有**翻页方式 ——
     * 殊途同归，最终都是主图换了内容。
     *
     * 默认关闭：自动翻译一张图约 3.5 秒，随手滚页面就翻会白烧算力。
     */
    imageAutoTranslate: false,
    twoStage: true,
    ocrModel: 'vision',         // 做 OCR 的角色（LFM3-Omni，读字最强）
  };

  /* -------------------------------------------------------------- 站点术语表 */

  /**
   * 站点级术语表：命中就直译成固定译名，不用模型。
   *
   * 为什么需要：e-hentai / nhentai 的标签是「成人向分类词」，
   * 单独发给模型时它会按通用词义翻 —— anal 翻成「分析」、dilf 翻成「DILF」、
   * netorare 翻成「网络」之类，完全不对。
   *
   * 这些词在站点里的含义是固定的，直接查表最准、也最快（零延迟）。
   * 词表键统一小写；译文用站点惯用译名。
   */
  var GLOSSARY = {
    // ---- 常见分类 ----
    'big breasts': '大胸', 'small breasts': '小胸', 'flat chest': '平胸',
    'anal': '肛交', 'vaginal': '阴道', 'oral': '口交', 'blowjob': '口交',
    'handjob': '手交', 'paizuri': '乳交', 'titfuck': '乳交',
    'stockings': '长袜', 'pantyhose': '连裤袜', 'lingerie': '内衣',
    'garter belt': '吊袜带', 'thigh highs': '过膝袜', 'gloves': '手套',
    'schoolgirl uniform': '女学生制服', 'school uniform': '校服',
    'school gym uniform': '学校体育服', 'cheerleader': '啦啦队',
    'maid': '女仆', 'nurse': '护士', 'kimono': '和服', 'yukata': '浴衣',
    'full color': '全彩', 'color': '彩页', 'monochrome': '单色',
    'x-ray': '透视', 'dark skin': '深色皮肤', 'tan lines': '晒痕',
    'sex toys': '性玩具', 'dildo': '假阳具', 'vibrator': '振动棒',
    'netorare': 'NTR', 'ntr': 'NTR', 'netorase': 'NTS',
    'twintails': '双马尾', 'ponytail': '马尾', 'twin tails': '双马尾',
    'big penis': '巨根', 'small penis': '小阴茎', 'collar': '项圈',
    'anal intercourse': '肛交', 'dilf': '猛男', 'milf': '熟女',
    'hairy': '体毛', 'uncensored': '无码', 'censored': '有码',
    'bald': '光头', 'blackmail': '胁迫', 'inflation': '膨胀',
    'humiliation': '羞辱', 'enema': '灌肠', 'smell': '气味',
    'hairy armpits': '腋毛', 'focus anal': '肛交特写', 'gaping': '扩肛',
    'double anal': '双插肛', 'coach': '教练', 'transparent clothing': '透明衣物',
    'butt plug': '肛塞', 'bloomers': '灯笼裤', 'defloration': '破处',
    'sole female': '单女', 'sole male': '单男', 'sole girl': '单女',
    'sole boy': '单男', 'harem': '后宫', 'incest': '乱伦',
    'mind control': '精神控制', 'hypnosis': '催眠', 'tentacles': '触手',
    'monster': '怪物', 'bestiality': '兽交', 'futanari': '扶她',
    'yaoi': '耽美', 'yuri': '百合', 'lolicon': '萝莉',
    'shotacon': '正太', 'ahegao': '阿黑颜', 'pregnant': '怀孕',
    'impregnation': '受孕', 'lactation': '母乳', 'bondage': '束缚',
    'bdsm': 'BDSM', 'spanking': '打屁股', 'femdom': '女尊',
    'malesub': '男受', 'footjob': '足交', 'rimjob': '舔肛',
    'swimsuit': '泳装', 'bikini': '比基尼', 'leotard': '紧身衣',
    'bodysuit': '连体衣', 'apron': '围裙', 'glasses': '眼镜',
    'catgirl': '猫娘', 'kemonomimi': '兽耳', 'elf': '精灵',
    'witch': '女巫', 'gothic lolita': '哥特萝莉', 'oni': '鬼',
    // ---- 元数据关键词 ----
    'parodies': '恶搞作品', 'parody': '恶搞作品',
    'tags': '标签', 'tag': '标签',
    'artists': '艺术家', 'artist': '艺术家',
    'groups': '团体', 'group': '团体',
    'languages': '语言', 'language': '语言',
    'categories': '类别', 'category': '类别',
    'pages': '页数', 'page': '页',
    'uploaded': '上传时间', 'favorites': '收藏', 'rating': '评分',
    'translated': '已翻译', 'chinese': '中文', 'japanese': '日文',
    'english': '英文', 'korean': '韩文', 'rewrite': '重写',
    'original': '原版', 'doujinshi': '同人志', 'manga': '漫画',
    'artist cg': '画师CG', 'game cg': '游戏CG', 'image set': '图集',
    'cosplay': '角色扮演', 'western': '欧美', 'non-h': '全年龄',
    // ---- nhentai 特殊文案 ----
    'see a tag missing?': '发现标签缺失了吗？',
    "suggest one, it'll surface once others agree": '建议添加一个，其他用户同意后就会显示',
    'definition revised please read the wiki': '定义已更新，请阅读维基',
    'log in to vote': '登录后投票',
    'help shape this gallery tags': '帮助完善这个画廊的标签',
    'favorite': '收藏', 'uploaded': '上传时间', 'pages': '页数',
    'characters': '角色', 'parodies': '恶搞作品', 'groups': '团体',
    'double penetration': '双插', 'mmf threesome': '两男一女', 'gang rape': '轮奸',
    'very long hair': '超长发', 'rape': '强奸', 'ahegao': '阿黑颜',
    'slave': '奴隶', 'leash': '牵引绳', 'tiara': '头饰', 'sister': '姐妹',
    'incest': '乱伦', 'group': '团体', 'kiddy grade': '儿童等级',
    'bbm': 'BBM', 'masturbation': '自慰', 'filming': '拍摄', 'cosplaying': '角色扮演',
    'big ass': '丰臀', 'teacher': '教师', 'bunny girl': '兔女郎',
    'eye-covering bang': '遮眼刘海', 'tomboy': '假小子', 'exposed clothing': '暴露衣物',
    // ---- nhentai 常见日文作品名/角色（固定译法，避免每次翻得不一样）----
    'グレートティーチャー': '伟大的老师',
    'コミックホットミルク': '漫画热牛奶',
    '中国翻訳': '中文翻译', '中国翻译': '中文翻译',
    '個人漢化': '个人汉化', '个人汉化': '个人汉化',
    '漢化': '汉化', '汉化': '汉化',
    '全彩': '全彩', '無修正': '无修正', '無碼': '无码',
    'DL版': 'DL版', 'digital': '数字版'
  };

  /** 归一化术语表键：小写、去多余空格。
   *  注意：连字符不能一律换成空格 —— 'x-ray' 换成 'x ray' 就查不到了。
   *  策略：先按原样查，查不到再试「连字符/下划线换空格」的版本。 */
  function normTerm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** 整串查表（只对完整匹配生效，不做子串替换，避免误伤句子） */
  function glossaryLookup(text) {
    var key = normTerm(text);
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(GLOSSARY, key)) return GLOSSARY[key];

    // 复合标签 "japanese | definition revised please read the wiki"
    // 拆成两段分别查，两段都能查到才拼回去
    if (key.indexOf('|') >= 0) {
      var parts = key.split('|').map(function (x) { return x.trim(); });
      var out = [];
      var allHit = true;
      for (var pi = 0; pi < parts.length; pi++) {
        var pk = parts[pi];
        var pv = Object.prototype.hasOwnProperty.call(GLOSSARY, pk) ? GLOSSARY[pk] : null;
        if (pv == null) {
          var pAlt = pk.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
          pv = Object.prototype.hasOwnProperty.call(GLOSSARY, pAlt) ? GLOSSARY[pAlt] : null;
        }
        if (pv == null) { allHit = false; break; }
        out.push(pv);
      }
      if (allHit) return out.join(' | ');
    }
    // 连字符/下划线换空格后再查（'big_breasts' → 'big breasts'）
    var keyAlt = key.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (keyAlt !== key && Object.prototype.hasOwnProperty.call(GLOSSARY, keyAlt)) return GLOSSARY[keyAlt];
    // 尾部冒号/星号（"Tags:" / "Tags*"）去掉再查
    var key2 = normTerm(key.replace(/[:*]+\s*$/, ''));
    if (key2 && key2 !== key && Object.prototype.hasOwnProperty.call(GLOSSARY, key2)) {
      // 保留原始标点形式：原串是 "Tags:" 就输出 "标签:"
      var raw = String(text).trim();
      var suffix = raw.match(/[:*]+\s*$/);
      return GLOSSARY[key2] + (suffix ? suffix[0] : '');
    }
    return null;
  }

  /* ------------------------------------------------------------------ 小工具 */

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function normSpace(s) {
    return String(s == null ? '' : s)
      .replace(/[\t\r\n\f\v]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function hashKey(text) {
    var h = 0x811c9dc5;
    var t = String(text || '');
    for (var i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36) + '-' + t.length;
  }

  /** 换行常量：编辑过程中反斜杠容易丢，统一用 fromCharCode 拼 */
  var LF = String.fromCharCode(10);
  var CRLF = new RegExp(String.fromCharCode(92) + 'r' + String.fromCharCode(92) + 'n', 'g');

  /* ------------------------------------------------------------ 语言与判定 */

  /** 统计各文字系统字数：判断「这段值不值得翻」全靠它 */
  function scriptStats(input) {
    var t = String(input || '');
    var han = 0, kana = 0, hangul = 0, latin = 0, other = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) han++;
      else if (c >= 0x3040 && c <= 0x30ff) kana++;
      else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff)) hangul++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
      else if (c >= 0x80) other++;
    }
    var letters = han + kana + hangul + latin;
    return {
      han: han, kana: kana, hangul: hangul, latin: latin, other: other, letters: letters,
      hanRatio: letters ? han / letters : 0
    };
  }

  function scriptOf(lang) {
    var s = String(lang || '').toLowerCase();
    if (/chinese|中文|汉语|漢語|zh/.test(s)) return 'han';
    if (/japanese|日本語|日本|ja/i.test(s)) return 'kana';
    if (/korean|한국|ko/i.test(s)) return 'hangul';
    if (/english|英文|英语|en/i.test(s)) return 'latin';
    return 'any';
  }

  function langTag(lang) {
    var s = scriptOf(lang);
    if (s === 'han') return /繁|traditional|hant/i.test(String(lang)) ? 'zh-Hant' : 'zh-CN';
    if (s === 'kana') return 'ja';
    if (s === 'hangul') return 'ko';
    if (s === 'latin') return 'en';
    return '';
  }

  var RE_SCRIPT = {
    kana: /[\u3040-\u30ff]/g,
    hangul: /[\uac00-\ud7af]/g,
    han: /[\u3400-\u4dbf\u4e00-\u9fff]/g,
    cyrillic: /[\u0400-\u04ff]/g,
    arabic: /[\u0600-\u06ff]/g,
    thai: /[\u0e00-\u0e7f]/g,
    latin: /[A-Za-z\u00c0-\u024f]/g
  };

  function detectLang(text) {
    var s = String(text || '');
    if (s.length > 6000) s = s.slice(0, 6000);
    if (!s) return '';
    var counts = {}, total = 0;
    for (var k in RE_SCRIPT) {
      if (!Object.prototype.hasOwnProperty.call(RE_SCRIPT, k)) continue;
      var m = s.match(RE_SCRIPT[k]);
      counts[k] = m ? m.length : 0;
      total += counts[k];
    }
    if (!total) return '';
    var r = function (k) { return counts[k] / total; };
    if (r('kana') > 0.02) return 'ja';
    if (r('hangul') > 0.05) return 'ko';
    if (r('han') > 0.3) return 'zh';
    if (r('thai') > 0.2) return 'th';
    if (r('arabic') > 0.2) return 'ar';
    if (r('cyrillic') > 0.2) return 'ru';
    if (r('latin') > 0.5) return 'en';
    return '';
  }

  function sameLangAsTarget(lang, targetLang) {
    if (!lang) return false;
    var t = scriptOf(targetLang);
    if (t === 'han') return lang === 'zh';
    if (t === 'kana') return lang === 'ja';
    if (t === 'hangul') return lang === 'ko';
    if (t === 'latin') return lang === 'en';
    return false;
  }

  /* ------------------------------------------------------- 方括号标签保护 */

  // 标签标记用「字母」编码，别用数字。
  //
  // 踩过的两个坑：
  //   · 私用区字符 U+E000/U+E001 会被模型直接吞掉，只剩序号 → 标题里冒出孤零零的「0」
  //   · 数字标记 «0» 会被数字保护（protectNumbers）当成计数再包一层 @N0@
  //     → 模型看到 «@N0@» 完全懵了，输出各种残渣，标签还原必然失败
  //
  // 字母标记（«A» «B» ...）同时避开这两条，模型对它的保真度也最高。
  var TAG_OPEN = '«';
  var TAG_CLOSE = '»';
  var TAG_RE = /«([A-Z])»/g;

  /** 序号 → 字母标记（0→A, 1→B …；超过 26 个时用 AA/AB 这种） */
  function tagMark(idx) {
    var s = '';
    var n = idx + 1;
    while (n > 0) {
      n--;
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26);
    }
    return TAG_OPEN + s + TAG_CLOSE;
  }

  /** 字母标记 → 序号 */
  function tagIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) {
      n = n * 26 + (letters.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /** 元数据标签清单：语言 / 版本 / 汉化组 / 连载状态 / 纯编号才原样保留 */
  var META_WORDS = [
    'english', 'chinese', 'japanese', 'korean', 'digital', 'crystallized', 'translated',
    'uncensored', 'censored', 'colorized', 'colored', 'monochrome', 'anthology', 'oneshot',
    'raw', 'sample', 'preview', 'ongoing', 'completed', 'webtoon', 'spanish', 'french',
    'german', 'portuguese', 'italian', 'russian', 'r18', 'r-18',
    '中文', '英文', '日文', '韩文', '汉化', '汉化组', '翻譯', '翻译', '数字版', '数位版',
    '全彩', '彩色', '黑白', '无修', '無修', '有码', '無碼', '无码', '连载中', '完结', '連載',
    '单行本', '單行本', '同人志', '同人誌', '原创', '原創', '已翻译', '完全版'
  ].map(function (w) { return w.toLowerCase(); });

  function isMetaTag(inner) {
    var raw = String(inner || '').trim();
    var s = raw.toLowerCase();
    if (!s) return false;
    if (/^[0-9\s.\-_~]+$/.test(s)) return true;
    if (/汉化组|翻譯組|翻译组|制作组|製作組|字幕组|字幕組/.test(raw)) return true;
    for (var i = 0; i < META_WORDS.length; i++) if (s.indexOf(META_WORDS[i]) >= 0) return true;

    // 方括号里的「作者名 / 社团名 / 作品名」也是专名，不要翻、也不要让模型改大小写。
    // 判据：长度 ≤ 60、几乎没有假名/汉字、且不是句子（不含句末标点）。
    // 例子：[Nishiki no Yokuen(Shikou Shiki Nishikino Niki)]、[Ramen Rice]、[Fukudahda]
    if (raw.length <= 60 && !/[。！？.!?]\s*$/.test(raw)) {
      var kana = (raw.match(/[\u3040-\u30ff]/g) || []).length;
      var han = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
      // 没有假名、汉字极少（≤1 个）、以拉丁字母为主 → 专名
      if (kana === 0 && han <= 1 && /[A-Za-z]/.test(raw)) {
        var latin = (raw.match(/[A-Za-z]/g) || []).length;
        // 必须有「大写字母」才算专名 —— 否则 "(see below)" 这种普通说明也会被保护住不翻
        if (latin >= 2 && /[A-Z]/.test(raw)) return true;
      }
    }
    return false;
  }

  /**
   * 方括号正则：() （） [] 【】 都算，每种括号各自配对。
   *
   * 不能写成「所有左括号 / 所有右括号」的字符类：
   *   "[Nishiki no Yokuen(Shikou Shiki Nishikino Niki)]" 这种「方括号里套圆括号」的结构，
   *   混在一起的字符类会把 ) 当成右括号提前截断，导致整段专名保护不住。
   * 长度上限也从 24 提到 80 —— 作者名经常很长。
   */
  var _bracketRe = null;
  function bracketRegex() {
    if (_bracketRe) return _bracketRe;
    var BS = String.fromCharCode(92);
    // 顺序很重要：先匹配方括号（它通常是最外层），再匹配其他。
    // 反过来的话 "[Nishiki no Yokuen(Shikou Shiki Nishikino Niki)]" 会被拆成
    // "[Nishiki no Yokuen" + "(Shikou...)" 两段，专名就保护不住了。
    var P = [
      BS + '\[[^' + BS + '\]]{0,80}' + BS + '\]',            // [ ]：允许里面含圆括号
      '【[^】]{0,80}】',
      '（[^）]{0,80}）',
      BS + '\([^' + BS + '\)]{0,80}' + BS + '\)'
    ];
    _bracketRe = new RegExp(P.join('|'), 'g');
    return _bracketRe;
  }

  /**
   * 把元数据标签换成占位符，正文交给模型。
   *
   * 但有一个回退：如果保护完之后「剩下的可翻文字太少」，
   * 说明这条文本基本全是专名（例如 "(C105) [Shikoushoku (Shikou Shiki)] Kousou Souei (Kiddy Grade)"），
   * 模型面对几乎空的正文只会原样返回 —— 用户看到的就是「这条没翻」。
   * 这种情况只保留真正的元数据标签（[Digital] / [Chinese] 这类），
   * 其余交给模型，让它至少给出一个音译。
   */
  /** 估算「这段文字还剩下多少可翻内容」：字母+假名+汉字的加权字数 */
  function translatableWeight(s) {
    var t = String(s || '');
    var latin = (t.match(/[A-Za-z]/g) || []).length;
    var kana = (t.match(/[\u3040-\u30ff]/g) || []).length;
    var han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    // 拉丁字母大约 2 个字符抵 1 个「可翻单位」（单词短、信息密度低）
    return latin / 2 + kana + han;
  }

  function protectTags(text) {
    if (!text) return { text: '', tags: [] };
    var tags = [];
    var re = bracketRegex();
    re.lastIndex = 0;
    var out = String(text).replace(re, function (m) {
      var inner = m.slice(1, -1);
      if (!isMetaTag(inner)) return m;      // 作者名/作品名照样翻
      tags.push(m);
      return tagMark(tags.length - 1);
    });

    // 回退：保护完之后「剩下能翻的东西太少」→ 模型只会原样返回，用户看到「这条没翻」。
    // 典型例子："(C105) [Shikoushoku (Shikou Shiki)] Kousou Souei (Kiddy Grade)"
    // 保护掉两个专名后只剩 "Kousou Souei"（纯罗马音），模型直接抄回去。
    // 这种情况只保留「真正的元数据标签」（[Digital] / [Chinese] / [DL版]…），
    // 其余交给模型 —— 宁可它音译，也不要整条不动。
    if (tags.length) {
      var remain = out.replace(/«[A-Z]+»/g, ' ');
      if (translatableWeight(remain) < 12) {
        var keep = [];
        var keepOut = String(text);
        re.lastIndex = 0;
        keepOut = String(text).replace(re, function (m) {
          var inner = m.slice(1, -1);
          if (!isMetaTagStrict(inner)) return m;
          keep.push(m);
          return tagMark(keep.length - 1);
        });
        return { text: keepOut, tags: keep };
      }
    }

    return { text: out, tags: tags };
  }

  /** 严格版元数据判定：只认 META_WORDS 和纯编号这类，不认「拉丁专名」 */
  function isMetaTagStrict(inner) {
    var raw = String(inner || '').trim();
    var s = raw.toLowerCase();
    if (!s) return false;
    if (/^[0-9\s.\-_~]+$/.test(s)) return true;
    if (/汉化组|翻譯組|翻译组|制作组|製作組|字幕组|字幕組/.test(raw)) return true;
    for (var i = 0; i < META_WORDS.length; i++) if (s.indexOf(META_WORDS[i]) >= 0) return true;
    return false;
  }

  /**
   * 保护「数字 + 单位」的计数（240.8k / 1,234 / 42% / $0.0016 / 18h27m）。
   *
   * 为什么必须硬保护：模型经常把 240.8k 改写成 240,800，或者把 18 hours 翻成
   * 「18小时」但把数字丢了。这类计数是页面的事实数据，改动就等于错。
   * 用私用区占位符锁住，翻完原样换回。
   */
  // 用可见的 ASCII 标记，别用私用区字符 —— 实测模型会把 \uE004/\uE005 直接吞掉，
  // 结果数字全丢。@N0@ 这种 ASCII 标记模型能看见，也更容易照抄。
  var NUM_OPEN = '@N';
  var NUM_CLOSE = '@';
  var NUM_RE = new RegExp(NUM_OPEN + '(\\d+)' + NUM_CLOSE, 'gi');

  function protectNumbers(text) {
    if (!text) return { text: '', nums: [] };
    var nums = [];
    // 匹配：带千分位/小数/单位的数量，货币金额，百分比，编号，日期时间里的数字
    var s = String(text).replace(
      // 单位（k/m/b）必须紧跟数字、后面不接字母；否则 "27 minutes" 会被切成 "27 m"
      /(?:[$€¥£]\s?)?\d[\d.,]*(?:[kKmMbB](?![a-zA-Z]))?(?:\s?%)?/g,
      function (m) {
        // 单字符数字且不是计数样式（比如 "1" 单独出现）也保护，反正还原后一样
        if (!m || !/[0-9]/.test(m)) return m;
        nums.push(m);
        return NUM_OPEN + String(nums.length - 1) + NUM_CLOSE;
      }
    );
    return { text: s, nums: nums };
  }

  function restoreNumbers(text, nums) {
    if (!nums || !nums.length) return String(text == null ? '' : text);
    var s = String(text == null ? '' : text);
    var hitCount = 0;
    var out = s.replace(NUM_RE, function (m, idx) {
      var i = parseInt(idx, 10);
      hitCount++;
      return (i >= 0 && i < nums.length) ? nums[i] : m;
    });
    if (hitCount > 0) {
      // 部分占位符回来了、但还有没回来的 —— 按顺序把缺的补回去。
      // 实测长句里 11 个数字可能只回来 10 个，漏的那个页面上就凭空消失了。
      if (hitCount < nums.length) {
        var used = {};
        NUM_RE.lastIndex = 0;
        var m2;
        var re2 = new RegExp(NUM_OPEN + '(\\d+)' + NUM_CLOSE, 'gi');
        while ((m2 = re2.exec(s))) used[parseInt(m2[1], 10)] = true;
        var missing = [];
        for (var mi = 0; mi < nums.length; mi++) if (!used[mi]) missing.push(nums[mi]);
        if (missing.length) {
          // 只补「值得补」的（带单位/千分位/长数字）；单个序号补错位置反而更糟
          var worth = missing.filter(function (x) { return /[.,]|[kKmMbB%$€¥£]/.test(x) || x.length >= 3; });
          if (worth.length) out = out + ' ' + worth.join(' ');
        }
      }
      return out;
    }
    // 模型把占位符全吞了（实测会发生在数字密集的长句里）：
    // 至少把最关键的计数补回去，否则页面上的数字就凭空消失了。
    var cleaned = s.replace(NUM_RE, '');
    if (!cleaned.trim()) return nums.join(' ');
    // 只补「带单位/千分位/小数」的计数，纯序号数字不硬塞（位置通常对不上）
    var key = nums.filter(function (x) { return /[.,]|[kKmMbB%$€¥£]/.test(x) || x.length >= 3; });
    if (!key.length) return cleaned;
    return cleaned + ' ' + key.join(' ');
  }

  function restoreTags(text, tags) {
    var s = String(text == null ? '' : text);
    if (!tags || !tags.length) return s;

    // 模型可能把 «A» 改写成各种近形符号 —— 统一回标准形态。
    // 实测模型最常写成 «a»（小写）、‹A›、《A》、「A」、“A”、[A]、(A)。
    s = s.replace(/<+\s*([A-Za-z]{1,2})\s*>/g, '«$1»')
         .replace(/[‹《〈「［\[<(‘“\u2018\u201c]\s*([A-Za-z]{1,2})\s*[›》〉」］\]>’”—\u2019\u201d]/g, '«$1»')
         .replace(/[«‹《〈「［‘“]\s*([A-Za-z]{1,2})\s*[»›》〉」］’”]/g, '«$1»')
         // 单独被引号包着的字母
         .replace(/['\u0060'"\u201c\u201d\u2018\u2019]\s*([A-Za-z]{1,2})\s*['\u0060'"\u201c\u201d\u2018\u2019]/g, '«$1»');

    // 把 «a» 之类小写标记改成大写，方便统一匹配
    s = s.replace(/«([A-Za-z]{1,2})»/g, function (mm, letters) {
      return '«' + letters.toUpperCase() + '»';
    });

    var used = {};
    var replacedAny = false;

    // 先把「模型自己还原成原文标签」的标出来，别重复追加
    for (var ut = 0; ut < tags.length; ut++) {
      if (tags[ut] && s.indexOf(tags[ut]) >= 0) used[ut] = true;
    }

    // 正常还原
    s = s.replace(TAG_RE, function (mm, letters) {
      var idx = tagIndex(letters);
      if (!(idx >= 0 && idx < tags.length)) return '';
      if (used[idx]) return '';
      used[idx] = true;
      replacedAny = true;
      return tags[idx];
    });

    // 清掉残留标记（含各种变体写法）
    s = s.replace(TAG_RE, '');
    s = s.replace(/«\s*[A-Za-z]{1,2}\s*»/g, '');
    s = s.replace(/[«‹《〈「［]\s*[A-Za-z]{1,2}\s*[»›》〉」］]/g, '');

    // 还有标签没出现？按顺序补在后面
    var missing = [];
    for (var mi = 0; mi < tags.length; mi++) if (!used[mi]) missing.push(mi);
    for (var mj = 0; mj < missing.length; mj++) {
      if (!used[missing[mj]]) s += ' ' + tags[missing[mj]];
    }

    return s.replace(/[ \t]{2,}/g, ' ').trim();
  }

  /* -------------------------------------------------------- 值不值得翻 */

  function stripTags(text) {
    var re = bracketRegex();
    return String(text || '').replace(re, ' ');
  }

  /**
   * 这段值不值得送模型。
   * 关键：判断「已经是中文」不能只看汉字比例 —— 日文标题汉字占比常超过一半。
   */
  function isTranslatable(text, targetLang) {
    if (!text) return false;
    var t = String(text);
    if (t.length < 2 || t.length > 4000) return false;
    if (!/\p{L}/u.test(t)) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(t)) return false;
    // 两三个字符的短词（"ok" / "npm" / "FAQ"）翻过来反而更怪，直接跳过
    if (t.length <= 3 && /^[A-Za-z&]+$/.test(t)) return false;
    if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(t)) return false;

    var digits = (t.match(/[0-9]/g) || []).length;
    var letters = (t.match(/\p{L}/gu) || []).length;
    // 只有「数字远多于文字」的串才算纯数字（1,234 / 42% / 238.5k）。
    // 阈值不能定太低：像 "18 hours, 27 minutes ago (2026年11月9日)" 这种
    // 带日期但明显是可翻句子的，数字占比能到 0.38，会被误杀。
    if (digits >= 2 && digits / (digits + letters) > 0.6) return false;
    if (/^[0-9\s.,:/\-+%$€¥]+[a-zA-Z]{0,2}$/.test(t)) return false;

    // 注意：这里必须用**原文**统计，不能用 stripTags 之后的文本。
    // 反例："(Hyouuma)星野心晴 (2026/11/08更新) [chinese][屁眼派对]"
    //   stripTags 会把 ( ) [ ] 里全部去掉 → 只剩「星野心晴」→ hanRatio=1.0 → 误判成「已是中文」跳过。
    var script = scriptOf(targetLang);
    var st = scriptStats(t);

    if (script === 'han') {
      if (st.kana >= 2 || st.hangul >= 2) return true;        // 有假名/谚文 → 一定要翻
      // 纯汉字且比例很高 → 已是中文。
      // 注意：像「中文区」这种 3 字短词，letters 只有 3，不能被 letters>=4 的条件漏掉。
      // 判据改成「只要几乎没有外语字符（假名/拉丁/谚文 ≤ 1）且汉字占比 ≥ 0.85」就是中文。
      if (st.hanRatio >= 0.85 && (st.kana + st.latin + st.hangul) <= 1) return false;
      return true;
    }
    if (script === 'latin') return st.han + st.kana + st.hangul > 0;
    return true;
  }

  /* ------------------------------------------------------------ 提示词 */

  function defaultSystem(target) {
    return 'You are a professional webpage translator. Translate every segment into ' + target + '.' + LF +
      'Rules: output only the translation. Never explain, never repeat the source, never add quotes.' + LF +
      'Segments may be UI labels, tags, metadata keys, or short standalone words — translate them as UI text, not as sentences.' + LF +
      'For titles and work names: transliterate or translate the name once and use that same rendering consistently.' + LF +
      '  Do not expand, embellish, or invent words that are not in the source.' + LF +
      '  Keep the bracket structure [..] exactly as given.' + LF +

      'Copy numbers, dates, times, amounts and version strings exactly as written — do not convert time zones or reformat.' + LF +
      'Keep proper nouns, product names and URLs unchanged.';
  }

  /**
   * 多段协议：带编号的一行一段。
   * 实测比 @@1@@ 标记更稳（Hy-MT 训练时见过这种格式），且漏段能按编号定位。
   */
  function buildPrompt(cfg, texts) {
    var n = texts.length;
    var target = (cfg && cfg.targetLang) || '简体中文';
    var sys = defaultSystem(target);
    var user;

    // 参考材料必须放在 **system** 消息里，不能放 user 消息。
    //
    // 踩过的坑（真实截图为证）：参考材料放在 user 里，模型会把那段英文说明
    // 当成要翻的内容，译出「本页面已使用的术语（……）：- 3小时27分钟前…」这种垃圾，
    // 然后渲染到页面上。
    // system 是「指令区」，模型只遵守不输出，放那儿最安全。
    var refSuffix = '';
    var terms = cfg && cfg.pageTerms;
    if (terms && terms.length) {
      var termLines = [];
      for (var ti = 0; ti < terms.length; ti++) {
        var t = terms[ti];
        if (!t || !t.src || !t.dst) continue;
        // 只收「源文不是中文」的条目 —— 源文已经是中文的（"3小时27分钟前"）
        // 记进参考没有任何意义，还会污染提示词。
        if (scriptStats(t.src).hanRatio >= 0.85) continue;
        if (String(t.src).trim() === String(t.dst).trim()) continue;
        termLines.push('- ' + t.src + ' = ' + t.dst);
      }
      if (termLines.length) {
        refSuffix += LF + 'Terminology already used on this page (reuse the same rendering, never output this list):' + LF + termLines.join(LF);
      }
    }
    var prev = cfg && cfg.prevTranslations;
    if (prev && prev.some && prev.some(Boolean)) {
      var prevLines = [];
      for (var pi = 0; pi < prev.length; pi++) if (prev[pi]) prevLines.push((pi + 1) + '. ' + prev[pi]);
      if (prevLines.length) {
        refSuffix += LF + 'Reference drafts (terminology hints only, never output them):' + LF + prevLines.join(LF);
      }
    }
    if (refSuffix) sys += refSuffix;

    if (n === 1) {
      user = 'Translate this into ' + target + ':' + LF + LF + texts[0];
    } else {
      // 同组短文本（标签云、键值对）：明确告诉模型它们是同类，别各翻各的
      var same = cfg && cfg.sameGroup;
      var kind = same ? 'These are labels/tags from the same list. Translate each consistently as UI text. ' : '';
      user = 'Translate the ' + n + ' numbered lines below into ' + target + '.' + LF + kind +
        'Output exactly ' + n + ' lines, keeping the number prefix (1. ... ' + n + ' ...). No other text.' + LF + LF +
        texts.map(function (t, i) { return (i + 1) + '. ' + t; }).join(LF);
    }
    return { system: sys, user: user };
  }

  /** 解析「编号行」：容忍模型把编号写成 1) / 1、 / 1  */
  function parseNumbered(raw, n) {
    var out = new Array(n).fill('');
    var seen = new Array(n).fill(false);
    var lines = String(raw || '').split(/\r?\n/);
    var cur = -1;
    var buf = [];
    function flush() {
      if (cur >= 0 && cur < n && !seen[cur] && buf.length) {
        var t = clean(buf.join(LF));
        if (t) { out[cur] = t; seen[cur] = true; }
      }
      buf = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = line.match(/^\s*([0-9]{1,3})\s*[.、)）:：]\s*(.*)$/);
      if (m) {
        flush();
        var idx = parseInt(m[1], 10) - 1;
        cur = (idx >= 0 && idx < n) ? idx : -2;
        if (m[2] && cur >= 0) buf.push(m[2].trim());
        continue;
      }
      if (cur >= 0) buf.push(line);
    }
    flush();
    var missing = [];
    for (var k = 0; k < n; k++) if (!out[k]) missing.push(k);
    return { parts: out, missing: missing };
  }

  /** 兜底：没有任何编号时按非空行对齐 */
  function parseLines(raw, n) {
    var lines = String(raw || '').split(/\r?\n/).map(function (l) { return clean(l); })
      .filter(Boolean);
    if (lines.length !== n) return null;
    return lines;
  }

  function clean(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<\/?think\b[^>]*>/gi, '');
    s = s.replace(/^\s*(?:译文|翻译|translation|translated)\s*[:：]\s*/i, '');
    s = s.trim();
    if (s.length > 1) {
      var a = s.charAt(0), b = s.charAt(s.length - 1);
      if ((a === '"' && b === '"') || (a === '\u201c' && b === '\u201d') || (a === '「' && b === '」')) {
        s = s.slice(1, -1).trim();
      }
    }
    return s;
  }

  /** 「有效翻译量」：模型把原文原样抄回来时，这段等于没翻 */
  function looksUntranslated(src, dst, targetLang) {
    var s = normSpace(src);
    var d = normSpace(dst);
    if (!d) return true;
    if (s === d) return true;
    var a = s.replace(/\p{P}/gu, '').replace(/\s+/g, '');
    var b = d.replace(/\p{P}/gu, '').replace(/\s+/g, '');
    if (a && a === b) return true;
    if (scriptOf(targetLang) === 'han') {
      var sSt = scriptStats(s);
      var dSt = scriptStats(d);

      // 日文 → 中文：假名必须明显减少。这是最可靠的信号。
      // 反例（踩过）：标题 "[水龍敬] GTS グレートティーチャーサヨコ Lesson10 (…)"
      //   kana 23 → 13（假名换成汉字了），但 han 只多 2，按「汉字增长比例」算出来 0.03 < 0.15
      //   → 被判成「没翻」→ 译文被丢掉，页面显示原文。
      if (sSt.kana >= 4) {
        var kanaDrop = (sSt.kana - dSt.kana) / sSt.kana;
        if (kanaDrop >= 0.35) return false;   // 假名掉了三分之一以上 → 确实翻了
        // 假名没怎么变：再按汉字增长判
      }

      // 韩文 → 中文：谚文必须减少
      if (sSt.hangul >= 4) {
        var hangulDrop = (sSt.hangul - dSt.hangul) / sSt.hangul;
        if (hangulDrop >= 0.35) return false;
      }

      var foreign = sSt.kana + sSt.latin;
      if (foreign < 8) return false;                        // 专名密集的短标题：能改一两个字就算翻了
      var gained = Math.max(0, dSt.han - sSt.han);
      return gained / Math.max(1, dSt.letters) < 0.15;
    }
    return false;
  }

  /* ---------------------------------------------------------- 图片翻译 */

  /**
   * 图片翻译的提示词。
   *
   * 实测过很多写法，这几条是必须的：
   *   · **只要译文**，否则模型会输出"JP: … / ZH: …"对，行数翻倍
   *   · **明确说没有解释**，否则会加"这句话的意思是…"
   *   · enable_thinking: false（Qwen 系模型默认会思考，思考内容会漏进 content）
   */
  var IMG_PROMPT_ZH = '请把图中所有文字翻译为' ;
  var IMG_PROMPT_TAIL = '，只输出译文，不要输出原文，不要任何解释。';

  /**
   * 图片翻译的提示词。
   *
   * ## 核心要求：**这是 OCR + 翻译，不是看图说话**
   *
   * 用户拿真实漫画页测时，模型返回的全是**图像描述**：
   *
   *   画面中：山崎说到：你吃了吗？…旁边写着山崎说到和女面商会
   *   这位角色的上半身画面中可以看到她穿着带有花纹的日式和服式上衣…
   *   图片中的文本无法显示或无效。
   *   图片中的文本已全部翻译成简体中文；图像中没有任何可见的文本内容。
   *
   * 这些被盖到图上，完全不是用户要的东西。
   *
   * ## 为什么会走 captioning 路径
   *
   * 多模态模型对「大部分是画面、文字只占小部分」的 crop，会倾向描述画面。
   * 光说「翻译图中文字」不够——模型仍可能先理解画面再描述。
   *
   * ## 修法：把 task 说得**极其具体、可执行**
   *
   *   ① 明确说这是 OCR 任务（"识别文字"），不是理解任务
   *   ② 明确禁止描述画面
   *   ③ 给出「没有文字时输出什么」（否则它会自己编一段）
   *   ④ 给一个输出示例格式，锁定行为
   */
  function buildImagePrompt(targetLang) {
    var lang = String(targetLang || '简体中文');

    if (lang === 'English') {
      return '[OCR TASK] Read the text in this image and translate it into English. ' +
        'Output ONLY the translated text, one line per original line. ' +
        'DO NOT describe the image, DO NOT describe characters, clothing, poses or background. ' +
        'DO NOT output the source text. DO NOT explain. DO NOT repeat. ' +
        'If there is no text in this image, output exactly: (no text)';
    }
    if (lang === '日本語') {
      return '【OCRタスク】この画像の中の文字を読み取り、日本語に翻訳してください。' +
        '翻訳だけを1行ずつ出力。画像の説明（人物・服装・姿勢・背景）は書かない。' +
        '原文を出力しない。説明しない。繰り返さない。文字が無ければ「（文字なし）」と出力。';
    }

    /**
     * 中文 prompt（逐句都是踩坑后加的）：
     *
     * 「这是文字识别（OCR）任务」—— 最关键的定性。不加这句，模型把它当图片理解。
     * 「不要描述画面内容」     —— 直接堵 captioning 路径，并举例（人物/穿着/动作/背景）
     * 「只输出译文」           —— 否则输出「原文：… 译文：…」两段
     * 「不要输出原文」         —— 强化上一条
     * 「不要重复」             —— 2B 模型老毛病（"明天吧 明天吧"）
     * 「不要任何解释」         —— 否则加"这句话的意思是…"
     * 「没有文字就输出「（无文字）」」—— 否则模型会编一段描述来"交差"
     *
     * 最后补一个输出示例，锁定格式（实测加了示例后模型听话很多）。
     */
    return '这是文字识别（OCR）与翻译任务，不是图片理解任务。' +
      '请把图中出现的所有文字翻译为' + lang + '。' +
      '要求：' +
      '1) 只输出译文，不要输出原文；' +
      '2) 不要描述画面内容（不要写「画面中」「可以看到」「穿着」「背景」这类描述）；' +
      '3) 不要解释、不要重复；' +
      '4) 一行对应一行，保持换行结构；' +
      '5) 如果图中确实没有任何文字，只输出「（无文字）」。';
    /**
     * **绝对不要给示例输出**。
     *
     * 踩过的坑：为了锁定格式在 prompt 末尾加了两行示例：
     *
     *   示例输出：
     *   你好，今天做什么？
     *   这个真的很好！
     *
     * 实测（Index-Translate-2B）：模型把示例当成**标准答案**，
     * 遇到没有文字的图（纯插画）也原样吐出这两句：
     *
     *   插画块 → "您好，今天做什么？这真的很不错！"
     *
     * 这是小模型 few-shot 的经典陷阱：大模型会「参考格式」，
     * 2B 模型会「照抄内容」。
     *
     * 所以格式约束只能用**规则**（"只输出译文""一行一行"），
     * 不能用示例。
     */
  }

  /* ---------------------------------------------------- 图片翻译·两阶段 */

  /**
   * OCR 提示词。
   *
   * ## 为什么 OCR 要单独一步
   *
   * 实测（真实 nhentai 漫画页）：让 translate（Index-Translate-2B）
   * 「直接把图里的日文翻成中文」，它做不好 —— 因为它要同时干两件事：
   * 识别文字 + 翻译。2B 模型的注意力不够分。
   *
   *   竖排 どうですか？私の料理は採れたてのものを用意しました
   *     → translate 一步到位: 「どうれたどうてですかのと？…」 （识别就错了）
   *
   * 而 vision（LFM3-Omni-2B）只做 OCR 时**完全正确**。
   * 所以拆成两阶段：vision 读字 → translate 翻译。
   *
   * ## prompt 要点
   *
   *   · 「逐字照抄」「不要翻译」—— 否则模型会顺手翻译
   *   · 「不要描述画面」     —— 否则走 captioning（真实踩过）
   *   · 「只输出你看到的字符」—— 锁定输出范围
   */
  var OCR_PROMPT_ZH = '读取图片中的所有文字，逐字照抄原文，不要翻译，不要解释，不要描述画面。只输出你看到的字符。如果没有文字，输出「（无文字）」。';

  /**
   * 用 vision 模型做 OCR，再用 translate 模型翻译。
   *
   * @param {string} base DSH 地址
   * @param {object} cfg  配置
   * @param {string} dataUrl 图块
   * @param {object} opts { targetLang, ocrModel, translateModel, maxTokens }
   * @returns {Promise<{text, src, ms, ocrMs, transMs, skipped}>}
   */
  async function visionTwoStage(base, cfg, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var target = opts.targetLang || (cfg && cfg.targetLang) || '简体中文';

    /**
     * 模型选择。
     *
     * 实测对比（同一批竖排日文块）：
     *
     *   OCR 质量（只让模型照抄原文）
     *     vision (LFM3-Omni-2B)  → 3/3 完全正确
     *     translate (Index-Tr-2B) → 0/3 正确（字符错乱、漏字）
     *
     *   翻译质量（给中文原文）
     *     translate 是专用翻译模型，质量更好
     *
     * 所以：OCR 用 vision，翻译用 translate。
     *
     * 如果配置里没有 vision（旧版 DSH），自动退回一步到位。
     */
    var ocrModel = opts.ocrModel || (cfg && cfg.ocrModel) || 'vision';
    var transModel = opts.translateModel || (cfg && cfg.model) || 'translate';

    /* ---- 阶段 1：OCR（要不要做？配置可关）---- */
    var doOcr = opts.twoStage !== false && (cfg ? cfg.twoStage !== false : true);
    if (!doOcr) {
      return await visionTranslateBlock(base, cfg, dataUrl, opts);
    }

    var ocrMs = 0;
    var sourceText = '';

    try {
      var ocrRes = await chatVision(base, cfg, ocrModel, OCR_PROMPT_ZH, dataUrl, {
        maxTokens: opts.maxTokens || 300,
        timeoutMs: opts.timeoutMs || 30000
      });
      ocrMs = ocrRes.ms;
      sourceText = clean(ocrRes.content || '');
    } catch (e) {
      // OCR 失败 → 退回一步到位（至少不会完全没结果）
      return await visionTranslateBlock(base, cfg, dataUrl, opts);
    }

    /* ---- OCR 结果为空 / 无文字 → 跳过 ---- */
    var ocrClean = pickTranslationOnly(sourceText);
    // 去掉「（无文字）」这类占位
    if (!ocrClean || /^[（(]\s*(?:无文字|沒有文字|no text|文字なし)\s*[)）]$/i.test(ocrClean)) {
      return { text: '', src: '', skipped: true, ms: Date.now() - t0, ocrMs: ocrMs, transMs: 0,
               raw: sourceText.slice(0, 200) };
    }

    /* ---- 阶段 2：翻译（文本模型，不带图）---- */
    /**
     * 把 OCR 出的原文交给 translate 模型。
     *
     * 注意**不用视觉通道**：这一步是纯文本翻译，走 /v1/chat/completions
     * 只发 text，速度更快（不带图省几千 token）。
     */
    /**
     * 第二阶段：纯文本翻译。
     *
     * 用 chatText（不带图），比走多模态通道快得多：
     * 不带图能省几千 prompt token，2B 模型上就是几百毫秒。
     */
    var transRes = await chatText(base, cfg, transModel, buildTextTranslatePrompt(ocrClean, target), {
      maxTokens: opts.maxTokens || 400,
      timeoutMs: opts.timeoutMs || 30000
    });
    var transMs = transRes.ms;

    /**
     * 翻译结果再过滤一次：
     *   · 剥掉「原文 → 译文」双段落
     *   · 去重复
     *   · 剔除图像描述（模型偶尔还是会把 OCR 出的日文描述「描述」一遍）
     */
    var finalText = extractUsableImageText(transRes.content || '');

    return {
      text: finalText,
      src: ocrClean.slice(0, 200),       // 面板里显示识别出的原文
      skipped: finalText === '',
      raw: finalText === '' ? String(transRes.content || '').slice(0, 200) : '',
      ms: Date.now() - t0,
      ocrMs: ocrMs,
      transMs: transMs
    };
  }

  /* ------------------------------------- Surya 布局 → 逐区域 OCR+翻译 */

  /**
   * 完整流水线：Surya 定位 → 逐区域 OCR → 翻译。
   *
   * ## 为什么这个组合最优
   *
   * | 环节 | 用什么 | 为什么 |
   * |---|---|---|
   * | 定位 | **Surya-OCR-2** | 650M，给精确 bbox + 区分 Text/Image |
   * | OCR | vision（LFM3-Omni） | 实测竖排日文 3/3 全对 |
   * | 翻译 | translate（Index-Translate） | 专用翻译模型质量最好 |
   * | 渲染框 | 按译文长度扩张 | 避免中文挤进竖排窄框 |
   *
   * ## 每区域做什么
   *
   * 对 Surya 给的每个 Text 框：
   *   ① 从整页 canvas 裁出该区域（+4px padding）
   *   ② vision OCR → 原文
   *   ③ translate 翻译 → 中文
   *   ④ 根据译文长度**扩张渲染框**（竖排要横向扩、横排要纵向扩）
   *
   * @param {object} opts { targetLang, onProgress }
   * @returns {{ok, items: [{box, src, zh, renderBox}], layoutMs, ocrMs, transMs}}
   */
  async function suryaTranslateRegions(base, cfg, dataUrl, layoutBoxes, imageW, imageH, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var ocrTotal = 0, transTotal = 0;
    var items = [];

    for (var i = 0; i < layoutBoxes.length; i++) {
      var lb = layoutBoxes[i];

      // 归一化 → 像素（带 padding）
      var padPx = 4;
      var px = Math.max(0, Math.floor(lb.nx1 * imageW) - padPx);
      var py = Math.max(0, Math.floor(lb.ny1 * imageH) - padPx);
      var pw = Math.min(imageW - px, Math.ceil(lb.w * imageW) + padPx * 2);
      var ph = Math.min(imageH - py, Math.ceil(lb.h * imageH) + padPx * 2);
      if (pw < 8 || ph < 8) continue;

      if (opts.onProgress) { try { opts.onProgress(i + 1, layoutBoxes.length, 'crop'); } catch (e) {} }

      // 裁图（调用方提供 cropper：dataUrl + box → 新 dataUrl）
      var regionUrl = opts.cropper ? opts.cropper(dataUrl, px, py, pw, ph) : null;
      if (!regionUrl) continue;

      /* ---- OCR：vision 读原文 ---- */
      var ocrText = '';
      try {
        var ocr = await chatVision(base, cfg, opts.ocrModel || 'vision', OCR_PROMPT_ZH, regionUrl, {
          maxTokens: 300, timeoutMs: opts.timeoutMs || 30000
        });
        ocrTotal += ocr.ms;
        ocrText = clean(ocr.content || '');
      } catch (e) { /* OCR 失败 → 跳过这块 */ }

      // 无文字就跳过
      var srcText = pickTranslationOnly(ocrText);
      if (!srcText || /^[（(]\s*(?:无文字|沒有文字|no text|文字なし)\s*[)）]$/i.test(srcText)) continue;

      if (opts.onProgress) { try { opts.onProgress(i + 1, layoutBoxes.length, 'translate'); } catch (e) {} }

      /* ---- 翻译：translate ---- */
      var zh = '';
      try {
        var tr = await chatText(base, cfg, opts.translateModel || (cfg && cfg.model) || 'translate',
          buildTextTranslatePrompt(srcText, opts.targetLang || '简体中文'),
          { maxTokens: 400, timeoutMs: opts.timeoutMs || 30000 });
        transTotal += tr.ms;
        zh = extractUsableImageText(tr.content || '');
      } catch (e) { /* 翻译失败 → 保留原文 */ }

      if (!zh) continue;

      /**
       * 渲染框扩张：按译文长度算需要的空间。
       *
       * 竖排日文（宽 < 高）：中文要横着排 → 往左右扩
       * 横排原文（宽 > 高）：中文换行 1~2 行 → 上下扩
       *
       * 扩张量 = 到「能放下译文」为止，上限 3 倍原尺寸，
       * 且不超出图片边界。
       */
      var renderBox = computeRenderBox(lb, px, py, pw, ph, srcText, zh, imageW, imageH);

      items.push({
        box: { x: px, y: py, w: pw, h: ph },
        renderBox: renderBox,
        src: srcText,
        zh: zh,
        label: lb.label
      });
    }

    return {
      ok: items.length > 0,
      items: items,
      ocrMs: ocrTotal,
      transMs: transTotal,
      ms: Date.now() - t0
    };
  }

  /**
   * 算渲染框（放得下中文译文的区域）。
   *
   * ## 为什么必须算
   *
   * 日文竖排 30 个字只占 28px 宽 × 240px 高（每字 8px 高 × 28px 宽，竖叠）。
   * 中文同样 30 个字横排需要 240px 宽 × 40px 高。
   * 塞回 28px 宽的框 → 只能排 8 行、每行 3 字 → 必然超框。
   *
   * **这就是用户截图里「错位 + 超框」的根因。**
   *
   * ## 算法
   *
   * 中文字符近似 1em 宽，行高 1.25em。已知框内字号 fs：
   *   每行字数 = floor(框宽 / fs)
   *   需要行数 = ceil(译文字数 / 每行字数)
   *   需要高度 = 行数 × fs × 1.25
   *
   * 逐步扩张到满足为止（每次 +25%），上限 3 倍。
   */
  function computeRenderBox(lb, px, py, pw, ph, srcText, zh, imageW, imageH) {
    var isVertical = ph > pw * 1.5;   // 竖排原文

    // 初始字号：按原框短边的 60%（让字不至于太小）
    var baseFont = Math.max(10, Math.round(Math.min(pw, ph) * 0.6));
    if (isVertical) baseFont = Math.max(10, Math.round(pw * 0.85));   // 竖排框窄，字号跟宽度走

    var need = estimateTextBox(zh, baseFont, pw, ph);

    var x0 = px, y0 = py, w0 = pw, h0 = ph;
    var maxGrow = 6;
    for (var g = 0; g < maxGrow && need.fits === false; g++) {
      if (isVertical) {
        // 竖排 → 往左右扩（中文横排需要宽度）
        var addW = Math.round(w0 * 0.25);
        x0 = Math.max(0, x0 - Math.round(addW / 2));
        w0 = Math.min(imageW - x0, w0 + addW);
      } else {
        // 横排 → 往上下扩（中文换行需要高度）
        var addH = Math.round(h0 * 0.25);
        y0 = Math.max(0, y0 - Math.round(addH / 2));
        h0 = Math.min(imageH - y0, h0 + addH);
      }
      need = estimateTextBox(zh, baseFont, w0, h0);
    }

    return {
      x: x0, y: y0, w: w0, h: h0,
      fontSize: fitFontSize(zh, w0, h0),
      isVertical: isVertical
    };
  }

  /** 估算「给定字号下译文要占多少空间、能否装进框」 */
  function estimateTextBox(text, font, boxW, boxH) {
    var s = String(text || '');
    var emW = 0;
    for (var i = 0; i < s.length; i++) {
      var cp = s.charCodeAt(i);
      var full = (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xFF00 && cp <= 0xFF60) ||
                 (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xFE30 && cp <= 0xFE6F);
      emW += full ? 1 : 0.55;
    }
    if (emW < 1) emW = 1;
    var perLine = Math.max(1, Math.floor(boxW / font));
    var lines = Math.ceil(emW / perLine);
    var needH = lines * font * 1.25;
    return { fits: needH <= boxH, needH: needH, lines: lines, perLine: perLine };
  }

  /** 在框里挑最大能放下的字号 */
  function fitFontSize(text, boxW, boxH) {
    // 优先单行放得下
    for (var f1 = Math.floor(boxH); f1 >= 11; f1--) {
      var emW1 = 0;
      var s = String(text || '');
      for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i);
        var full = (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xFF00 && cp <= 0xFF60) ||
                   (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xFE30 && cp <= 0xFE6F);
        emW1 += full ? 1 : 0.55;
      }
      if (emW1 * f1 <= boxW && f1 * 1.25 <= boxH) return f1;
    }
    // 退让：多行
    for (var f2 = Math.floor(boxH); f2 >= 8; f2--) {
      var per = Math.max(1, Math.floor(boxW / f2));
      var lines = Math.ceil((String(text || '').length || 1) / per);
      if (lines * f2 * 1.25 <= boxH) return f2;
    }
    return 9;
  }

  /**
   * 解析 Surya 输出里的 **Image 类**块（供上层做「裁出来重检」）。
   *
   * 为什么要单独返回：这些块常常是「插画 + 文字混排」的大区域，
   * 直接把里面的文字丢了会漏检一半的气泡。
   */
  function parseSuryaImageBlocks(raw) {
    var out = [];
    var re = /\{\s*"label"\s*:\s*"([^"]+)"\s*,\s*"bbox"\s*:\s*"([^"]+)"/g;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var label = m[1];
      if (!/^(Image|Table|Figure)$/i.test(label)) continue;
      var parts = String(m[2]).split(/\s+/).map(Number);
      if (parts.length < 4 || parts.some(function (v) { return !isFinite(v); })) continue;
      var x1 = parts[0] / 1000, y1 = parts[1] / 1000;
      var x2 = parts[2] / 1000, y2 = parts[3] / 1000;
      var w = x2 - x1, h = y2 - y1;
      if (w <= 0 || h <= 0) continue;
      out.push({ x: x1, y: y1, w: w, h: h, label: label });
    }
    return out;
  }

  /**
   * 提取 src/zh 对（供图像重绘用）。
   *
   * 流程跟 ocrPairTranslate 一样，但**不需要 CV 框** ——
   *   因为图像重绘模型不需要坐标。
   *
   * @returns {{ok, items:[{src,zh}], ocrMs, transMs}}
   */
  async function extractPairs(base, cfg, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var target = opts.targetLang || (cfg && cfg.targetLang) || '简体中文';

    /* ① 整页 OCR */
    var ocr = await chatVision(base, cfg, opts.ocrModel || 'vision', OCR_PAGE_PROMPT, dataUrl, {
      maxTokens: opts.maxTokens || 900,
      timeoutMs: opts.timeoutMs || 60000
    });
    var ocrMs = ocr.ms;

    var rawLines = String(ocr.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });

    /* 去重 */
    var seen = {}, lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var key = rawLines[i].replace(/\s+/g, '');
      if (seen[key]) continue;
      seen[key] = true;
      lines.push(rawLines[i]);
    }
    if (!lines.length) return { ok: false, error: '没识别到文字', items: [], ocrMs: ocrMs, transMs: 0 };

    /* ② 翻译（编号对齐） */
    var numbered = lines.map(function (l, idx) { return (idx + 1) + '. ' + l; }).join('\n');
    var transPrompt = '逐行翻译下面的日文为简体中文。' +
      '必须保留每行开头的编号（1. 2. 3. …），输出行数必须与输入行数相同。' +
      '不要合并、不要拆分、不要加解释。只输出带编号的译文：\n\n' + numbered;

    var trans = await chatText(base, cfg, opts.model || (cfg && cfg.model) || 'translate', transPrompt, {
      maxTokens: opts.transMaxTokens || 900,
      timeoutMs: opts.timeoutMs || 60000
    });
    var transMs = trans.ms;

    var zhLines = String(trans.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; })
      .map(function (x) { return x.replace(/^\d+\s*[.、)）]\s*/, '').trim(); })
      .filter(function (x) { return x.length > 0; });

    var items = [];
    for (var j = 0; j < lines.length; j++) {
      items.push({ src: lines[j], zh: zhLines[j] || '' });
    }

    return {
      ok: true, items: items,
      ocrMs: ocrMs, transMs: transMs,
      missing: Math.max(0, lines.length - zhLines.length),
      ms: Date.now() - t0
    };
  }
  /* --------------------------------- Qwen-Image-Edit 图片替换 */

  /**
   * 用 Qwen-Image-Edit（魔搭异步 API）把图中原文直接替换成译文，输出一张新图。
   *
   * ## 为什么这是「终极方案」
   *
   * 之前所有方案都在跟「bbox 不准」较劲：
   *   · CV → 网点纸上框碎
   *   · Surya → 把插画+文字混排区判成 Image，漏 40~60%
   *   · 整页 OCR → 没 bbox，不能原位盖
   *
   * 而 Image-Edit 模型**根本不需要 bbox** —— 它直接看图，
   * 理解「这段日文在这个气泡里」，然后重绘成中文。
   * 位置、字体、气泡形状都由模型自己保持一致。
   *
   * ## 魔搭的 API 是异步任务制（不是 chat/completions）
   *
   *   POST /v1/images/generations   headers: X-ModelScope-Async-Mode: true
   *     → { task_id }
   *   GET  /v1/tasks/{task_id}      headers: X-ModelScope-Task-Type: image_generation
   *     → { task_status: RUNNING|SUCCEED|FAILED, output_images: [url] }
   *
   * 实测：60~120 秒出结果（Qwen-Image-Edit 20B 模型在云端跑）。
   *
   * ## prompt 必须给具体的替换对
   *
   * 实测踩过的坑：第一次用
   *   「把图中所有日文对话气泡里的文字替换成对应的简体中文译文」
   * → 模型**一个都没改**。因为这句话没告诉它「原文是什么、要写成什么」。
   *
   * 正确写法：把 src → zh 逐条列出来。
   *
   * @param {object} opts { model, pairs, timeoutMs, pollMs, onProgress }
   * @returns {Promise<{ok, imageUrl, ms, error}>}
   */
  async function imageEditTranslate(baseUrl, apiKey, dataUrl, pairs, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var base = (baseUrl || 'https://api-inference.modelscope.cn').replace(/\/$/, '');
    var model = opts.model || 'Qwen/Qwen-Image-Edit';
    var pollMs = opts.pollMs || 5000;
    var timeoutMs = opts.timeoutMs || 300000;

    if (!apiKey) return { ok: false, error: '没有 API Key', ms: 0 };
    if (!pairs || !pairs.length) return { ok: false, error: '没有替换对', ms: 0 };

    var limited = pairs.slice(0, 12);
    var list = limited.map(function (p, i) {
      return (i + 1) + ') 把「' + p.src + '」改成「' + p.zh + '」';
    }).join('；');
    var prompt = '把图片中对话框/气泡内的日文文字替换成对应的简体中文译文，具体替换如下：' +
      list + '。要求：保持原有字体风格、字号、位置、气泡形状和排版完全不变，' +
      '除上述文字外不要修改图片的任何其他部分。';

    var submitResp;
    try {
      submitResp = await fetch(base + '/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'X-ModelScope-Async-Mode': 'true'
        },
        body: JSON.stringify({ model: model, prompt: prompt, image_url: dataUrl }),
        signal: (function () { try { return AbortSignal.timeout(60000); } catch (e) { return undefined; } })()
      });
    } catch (e) {
      return { ok: false, error: '提交失败：' + ((e && e.message) || e), ms: Date.now() - t0 };
    }
    if (!submitResp.ok) {
      var errTxt = '';
      try { errTxt = (await submitResp.text()).slice(0, 200); } catch (e) {}
      return { ok: false, error: 'HTTP ' + submitResp.status + (errTxt ? '：' + errTxt : ''), ms: Date.now() - t0 };
    }
    var submitJson = await submitResp.json();
    var taskId = submitJson.task_id;
    if (!taskId) return { ok: false, error: '没拿到 task_id', ms: Date.now() - t0 };
    if (opts.onProgress) { try { opts.onProgress('submitted', taskId); } catch (e) {} }

    while (Date.now() - t0 < timeoutMs) {
      await new Promise(function (r) { setTimeout(r, pollMs); });
      var st;
      try {
        var pollResp = await fetch(base + '/v1/tasks/' + taskId, {
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'X-ModelScope-Task-Type': 'image_generation'
          },
          signal: (function () { try { return AbortSignal.timeout(30000); } catch (e) { return undefined; } })()
        });
        st = await pollResp.json();
      } catch (e) {
        continue;
      }
      if (st.task_status === 'SUCCEED') {
        var url = (st.output_images || [])[0];
        if (!url) return { ok: false, error: '成功但没输出图', ms: Date.now() - t0 };
        return {
          ok: true, imageUrl: url, taskId: taskId,
          ms: Date.now() - t0,
          pairCount: limited.length,
          skipped: Math.max(0, pairs.length - limited.length)
        };
      }
      if (st.task_status === 'FAILED') {
        return {
          ok: false,
          error: '任务失败：' + JSON.stringify(st.errors || {}).slice(0, 200),
          taskId: taskId, ms: Date.now() - t0
        };
      }
      if (opts.onProgress) {
        try { opts.onProgress('running', Math.round((Date.now() - t0) / 1000)); } catch (e) {}
      }
    }
    return { ok: false, error: '超时（' + Math.round(timeoutMs / 1000) + ' 秒）', taskId: taskId, ms: Date.now() - t0 };
  }
  /* ----------------------------------------- 整页 OCR + 位置配对 */

  /**
   * 整页 OCR 的提示词（**一个气泡一行**，三次实测完全一致）。
   *
   * 这个 prompt 是整页文本的来源。要点：
   *   · 「一个气泡里的文字合并成一行，不要按物理换行拆开」
   *     —— 不写这句，同一张图两次分别 11 段 / 19 段（实测）
   *   · 「不要编号，不要翻译，不要描述画面」—— 防止格式污染
   */
  var OCR_PAGE_PROMPT = [
    '识别图中所有对话气泡里的文字。',
    '规则：一个气泡里的文字合并成一行，不要按物理换行拆开。',
    '每个气泡输出一行，不要编号，不要翻译，不要描述画面。',
    '只输出文字。'
  ].join('');

  /**
   * 用「整页 OCR 拿文本 + CV 拿位置」的方式，把每段译文盖到对应位置。
   *
   * ## 为什么不用 Surya
   *
   * 实测三张连续剧情图（真实 nhentai 页）：
   *
   * | 图 | Surya 框 | 整页 OCR 段 | Surya 的 Image 块占比 |
   * |---|---|---|---|
   * | ttest1 | 3 | **7** | 39.8% |
   * | ttest2 | 5 | **6** | 24.3% + 39.8% + 25.7% = 89.8% |
   * | ttest3 | 3 | **4** | 44.0% + 49.7% = 93.7% |
   *
   * 根因：Surya 把「插画 + 文字混排的大区域」判成一个巨大的 Image 块
   * （ttest3 竟然 93.7% 的页面都是 Image），里面明明有文字。
   *
   * 所以**文本必须用整页 OCR**（它直接读图，不受 layout 分割限制），
   * 位置用 CV 形态学（它按笔画连通，不受「这块是不是插图」影响）。
   *
   * ## 匹配策略
   *
   * OCR 的输出顺序 = 阅读顺序（实测稳定）；CV 的块按 y 再 x 排序也是阅读顺序。
   * 两边数量不一致时，按「y 坐标分位」匹配：
   *
   *   · 把 CV 的块按 y 从小到大排
   *   · OCR 的段也按顺序
   *   · 按比例分配（第 i 段 → CV 块的第 floor(i * n / m) 个）
   *
   * 不是完美匹配，但**文本 100% 正确 + 覆盖 100%**，
   * 位置大致对。比 Surya 漏 40~60% 好得多。
   *
   * @param {object} opts { targetLang, cvBoxes, maxTokens }
   * @returns {{ok, items: [{text, box}], ocrMs, ms}}
   */
  async function ocrPairTranslate(base, cfg, dataUrl, cvBoxes, imageW, imageH, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var target = opts.targetLang || (cfg && cfg.targetLang) || '简体中文';

    /* ---- ① 整页 OCR ---- */
    var ocr = await chatVision(base, cfg, opts.ocrModel || 'vision', OCR_PAGE_PROMPT, dataUrl, {
      maxTokens: opts.maxTokens || 900,
      timeoutMs: opts.timeoutMs || 60000
    });
    var ocrMs = ocr.ms;

    var rawLines = String(ocr.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });

    // 去重（实测偶尔同一段输出两遍）
    var seen = {}, lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var key = rawLines[i].replace(/\s+/g, '');
      if (seen[key]) continue;
      seen[key] = true;
      lines.push(rawLines[i]);
    }
    if (!lines.length) return { ok: false, error: '没识别到文字', items: [], ocrMs: ocrMs, ms: Date.now() - t0 };

    /* ---- ② 翻译（编号对齐，保证一行对一行）---- */
    var numbered = lines.map(function (l, idx) { return (idx + 1) + '. ' + l; }).join('\n');
    var transPrompt = '逐行翻译下面的日文为简体中文。' +
      '必须保留每行开头的编号（1. 2. 3. …），输出行数必须与输入行数相同。' +
      '不要合并、不要拆分、不要加解释。只输出带编号的译文：\n\n' + numbered;

    var trans = await chatText(base, cfg, opts.model || (cfg && cfg.model) || 'translate', transPrompt, {
      maxTokens: opts.transMaxTokens || 900,
      timeoutMs: opts.timeoutMs || 60000
    });
    var transMs = trans.ms;

    var zhLines = String(trans.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; })
      .map(function (x) { return x.replace(/^\d+\s*[.、)）]\s*/, '').trim(); })
      .filter(function (x) { return x.length > 0; });

    /* ---- ③ 按阅读顺序配对位置 ---- */
    var boxes = (cvBoxes || []).slice();

    /**
     * **第 1 步：去掉嵌套重复的框。**
     *
     * 实测（ttest1）：CV 输出 9 个框，其中框 7 完全在框 1 里面。
     * 这是「同一片文字被检测了两遍」（整块 + 内部一个碎片）。
     *
     * 嵌套的框若都保留，配对时会把两段译文塞进同一区域。
     */
    boxes = boxes.filter(function (b, i) {
      return !boxes.some(function (a, j) {
        if (j === i) return false;
        if (a.w * a.h <= b.w * b.h) return false;              // 不比它大
        return a.x <= b.x && a.y <= b.y &&
               a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;  // 完全包住
      });
    });

    // 按 y 再 x 排（阅读顺序）
    boxes.sort(function (a, b) { return a.y - b.y || a.x - b.x; });

    /**
     * **第 2 步：如果块数多于 OCR 段数，合并最近的块。**
     *
     * 实测 ttest1：CV 8 块，OCR 7 段 —— 差 1 个。
     * 差太多时（比如 CV 13 块 vs OCR 6 段）说明 CV 把同一气泡的多列拆碎了。
     *
     * 合并策略：反复把「中心点距离最近」的两块合成一个并集框，
     * 直到块数 == 段数（或只剩 1 块）。
     *
     * 为什么用「最近中心点」而不是「同 y」：
     *   竖排文字的多列在**垂直方向**展开，同 y 的不同气泡反而会被误合。
     *   中心点距离同时考虑了 x 和 y，更稳。
     */
    var guard = 0;
    while (boxes.length > lines.length && boxes.length > 1 && guard < 60) {
      guard++;
      // 找最近的一对
      var bi = 0, bj = 1, best = Infinity;
      for (var a1 = 0; a1 < boxes.length; a1++) {
        for (var a2 = a1 + 1; a2 < boxes.length; a2++) {
          var A = boxes[a1], B = boxes[a2];
          var dx = (A.x + A.w / 2) - (B.x + B.w / 2);
          var dy = (A.y + A.h / 2) - (B.y + B.h / 2);
          var dist = dx * dx + dy * dy;
          if (dist < best) { best = dist; bi = a1; bj = a2; }
        }
      }
      // 合成并集
      var A2 = boxes[bi], B2 = boxes[bj];
      var nx = Math.min(A2.x, B2.x), ny = Math.min(A2.y, B2.y);
      var nx2 = Math.max(A2.x + A2.w, B2.x + B2.w);
      var ny2 = Math.max(A2.y + A2.h, B2.y + B2.h);
      boxes[bi] = { x: nx, y: ny, w: nx2 - nx, h: ny2 - ny };
      boxes.splice(bj, 1);
      boxes.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    }

    var items = [];
    for (var j = 0; j < lines.length; j++) {
      var zh = zhLines[j] || '';
      var box = null;
      if (boxes.length) {
        /**
         * 按比例分配。第 j 段 → 第 floor(j * boxes.length / lines.length) 个块。
         * 段数多于块数时会有重复，段数少于块数时会空出一些块 —— 都接受，
         * 因为文本准确率优先于位置精确度。
         */
        var bi = Math.min(boxes.length - 1, Math.floor((j * boxes.length) / lines.length));
        box = boxes[bi];
      }
      items.push({
        src: lines[j],
        zh: zh,
        box: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null,
        /** 没有位置的段，退回列表展示（面板里仍能看到） */
        noBox: !box
      });
    }

    return {
      ok: true,
      items: items,
      ocrMs: ocrMs,
      transMs: transMs,
      ms: Date.now() - t0,
      missing: Math.max(0, lines.length - zhLines.length),
      cvCount: boxes.length,
      ocrCount: lines.length
    };
  }

  /* --------------------------------------------- Surya 布局检测 · 定位 */  /* --------------------------------------------- Surya 布局检测 · 定位 */

  /**
   * 用 Surya-OCR-2 做**文字区域定位**（不给文字内容，只给 bbox）。
   *
   * ## 为什么需要它
   *
   * 之前用纯 CV（形态学方向闭运算）定位，在网点纸背景上会漏检/框错。
   * 用户实测截图里「文字错位 + 超框」的根因就是 bbox 不准。
   *
   * ## 为什么用它
   *
   * Surya-OCR-2 650M 参数，**llama.cpp 原生支持**（架构 qwen35）。
   * 实测（真实漫画页 1280×1810）：
   *   · 1.7 秒，输出 11 个 Text 区 + 4 个 Image 区
   *   · 位置精确到像素
   *   · **自动区分 Text / Image / Page-Header** —— 插画天然被排除
   *   · 三次运行结果几乎一致（稳定）
   *
   * ## 输出格式
   *
   * ```json
   * [{"label":"Text","bbox":"925 40 961 174","count":20},
   *  {"label":"Image","bbox":"450 115 710 235","count":100}]
   * ```
   * bbox 是 0~1000 归一化坐标（空格分隔）。
   *
   * @param {string} base DSH 地址
   * @param {object} cfg 配置
   * @param {string} dataUrl 整页图
   * @param {object} opts { model, maxTokens, timeoutMs }
   * @returns {{ok, boxes: Array<{x,y,w,h,label}>, ms}}
   */
  async function suryaLayout(base, cfg, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var model = opts.model || (cfg && cfg.layoutModel) || 'layout';

    var res = await chatVision(base, cfg, model, 'Text Detection', dataUrl, {
      maxTokens: opts.maxTokens || 1400,
      timeoutMs: opts.timeoutMs || 60000
    });

    var raw = String(res.content || '').trim();
    var boxes = parseSuryaLayout(raw);

    return {
      ok: boxes.length > 0,
      boxes: boxes,
      /**
       * Image / Table / Figure 类块。
       * 上层会挑「面积 > 15% 且不是整页框」的裁出来重检 ——
       * 实测 Surya 会用一个大 Image 块吞掉整片「插画+文字」区域。
       */
      imageBlocks: parseSuryaImageBlocks(raw),
      raw: raw.slice(0, 800),
      ms: Date.now() - t0
    };
  }

  /**
   * 解析 Surya 的布局 JSON。
   *
   * 输出可能不完整（模型生成有 token 上限），所以用**正则逐条抽取**
   * 而不是 JSON.parse —— 实测模型偶尔会漏最后几个 `}`。
   *
   * bbox 是 0~1000 归一化的四个整数（空格分隔），
   * 这里转成比例（0~1），调用方乘以图片宽高。
   */
  /**
   * 解析 Surya 的布局 JSON。
   *
   * @returns {Array} 只返回**文字类**块（Text / Caption / Page-Header …）
   *
   * 注：**Image 块不在这里返回**。实测 Surya 会把「插画 + 文字混排的大区域」
   * 标成一个大 Image 块（如 "0 350 700 1000" 覆盖左下 70% 宽的整片区域），
   * 里面的文字就被吞了。这类块需要上层**裁出来重检**（见 translateLayout
   * 的第二轮深度检测）。用 parseSuryaImageBlocks() 拿它们。
   */
  function parseSuryaLayout(raw) {
    var out = [];
    var re = /\{\s*"label"\s*:\s*"([^"]+)"\s*,\s*"bbox"\s*:\s*"([^"]+)"/g;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var label = m[1];
      var parts = String(m[2]).split(/\s+/).map(Number);
      if (parts.length < 4 || parts.some(function (v) { return !isFinite(v); })) continue;
      var x1 = parts[0] / 1000, y1 = parts[1] / 1000;
      var x2 = parts[2] / 1000, y2 = parts[3] / 1000;
      /**
       * 过滤：
       *   · 只留 label 是 Text / Page-Header / Page-Footer 的（文字类）
       *   · 排除 Image / Table / 整页框（0,0,1000,1000）
       *   · 排除太小（< 1% 宽或高）和太大（> 90% 宽或高）
       */
      /**
       * 收集**所有** label（包括 Image），交给上层决定怎么用。
       * 之前直接丢弃 Image 是个 bug —— 实测 Surya 会把一整块
       * 「插画 + 文字混排区」标成 Image（如 "0 350 700 1000"
       * 覆盖左下 70% 宽、65% 高的整个区域），里面明明有文字。
       * 丢弃它等于把下半页的 4 个气泡全丢了。
       */
      if (!/^(Text|Page-Header|Page-Footer|Section-Header|Caption|Footnote|ListItem|Title)$/i.test(label)) continue;
      var w = x2 - x1, h = y2 - y1;
      if (w < 0.008 || h < 0.008) continue;
      if (w > 0.9 && h > 0.9) continue;
      // 归一化到 0~1 且合法（x1<x2, y1<y2）
      if (x2 <= x1 || y2 <= y1) continue;
      out.push({ x: x1, y: y1, w: w, h: h, label: label, nx1: x1, ny1: y1, nx2: x2, ny2: y2 });
    }
    return out;
  }

  /* ------------------------------------------------------ 整页图片翻译 */

  /**
   * 整页 OCR 提示词。
   *
   * ## 这是「图→图」最简可行方案的核心
   *
   * 实测结论（真实漫画页 1280×1810，3 次重复）：
   *
   *   模糊的 prompt（"按阅读顺序逐段输出"）
   *     → 有时 11 段、有时 19 段 —— **同一张图每次不一样**
   *
   *   明确「一个气泡 = 一行」
   *     → 三次**完全一致**，1300ms
   *
   * 所以提示词必须锁死「分段规则」，不能只说"逐段"。
   *
   * ## 为什么这比「CV 定位 + 逐块 OCR」好
   *
   * | | CV 定位 + 逐块 | 整页 OCR |
   * |---|---|---|
   * | 气泡覆盖 | 4/7（网点背景的漏检） | **7/7** |
   * | 耗时 | 1873ms | 1300ms |
   * | 能否原位替换 | 能（有 bbox） | 不能（无 bbox） |
   *
   * 两者互补，所以都保留，让用户选。
   */
  var OCR_PAGE_PROMPT = [
    '识别图中所有对话气泡里的文字。',
    '规则：一个气泡里的文字合并成一行，不要按物理换行拆开。',
    '每个气泡输出一行，不要编号，不要翻译，不要描述画面。',
    '只输出文字。'
  ].join('');

  /**
   * 整页翻译：一次 OCR + 一次纯文本翻译。
   *
   * @param {object} opts { targetLang, model, maxTokens }
   * @returns {{ok, segments: [{src, zh}], ms, ocrMs, transMs}}
   */
  async function visionPageTranslate(base, cfg, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var target = opts.targetLang || (cfg && cfg.targetLang) || '简体中文';

    /* ---- 阶段 1：整页 OCR ---- */
    var ocrRes = await chatVision(base, cfg, opts.ocrModel || 'vision', OCR_PAGE_PROMPT, dataUrl, {
      maxTokens: opts.maxTokens || 700,
      timeoutMs: opts.timeoutMs || 60000
    });
    var ocrMs = ocrRes.ms;

    var rawLines = String(ocrRes.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });

    // 去重（实测出现过同一段输出两遍）
    var seen = {};
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var key = rawLines[i].replace(/\s+/g, '');
      if (seen[key]) continue;
      seen[key] = true;
      lines.push(rawLines[i]);
    }
    if (!lines.length) {
      return { ok: false, error: '没识别到文字', segments: [], ocrMs: ocrMs, transMs: 0, ms: Date.now() - t0 };
    }

    /* ---- 阶段 2：整页翻译（编号对齐，保证一行对一行）---- */
    /**
     * 用「编号对齐」而不是「直接给行」。
     *
     * 实测对比（同一批 19 行输入）：
     *   直接给行 + "输出必须一行对一行"  → 输出 13 行（合并了）
     *   加编号 + "保留行号"              → 输出 19 行（完全对齐）
     *
     * 2B 模型对「行数守恒」这种抽象约束不可靠，但对「保留编号」这种
     * 显式锚点很听话。
     */
    var numbered = lines.map(function (l, i) { return (i + 1) + '. ' + l; }).join('\n');
    var transPrompt = '逐行翻译下面的日文为简体中文。' +
      '必须保留每行开头的编号（1. 2. 3. …），输出行数必须与输入行数相同。' +
      '不要合并、不要拆分、不要加解释。只输出带编号的译文：\n\n' + numbered;

    var transRes = await chatText(base, cfg, opts.model || (cfg && cfg.model) || 'translate', transPrompt, {
      maxTokens: opts.maxTokens || 800,
      timeoutMs: opts.timeoutMs || 60000
    });
    var transMs = transRes.ms;

    /* ---- 对齐 ---- */
    var zhLines = String(transRes.content || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; })
      .map(function (x) {
        // 剥掉行首编号（"1. " / "1、" / "1）"）
        return x.replace(/^\d+\s*[.、)）]\s*/, '').trim();
      })
      .filter(function (x) { return x.length > 0; });

    var segments = [];
    for (var j = 0; j < lines.length; j++) {
      segments.push({ src: lines[j], zh: zhLines[j] || '' });
    }

    return {
      ok: true,
      segments: segments,
      ocrMs: ocrMs,
      transMs: transMs,
      ms: Date.now() - t0,
      /** 有几句没翻到（模型输出行数少于输入行数） */
      missing: Math.max(0, lines.length - zhLines.length)
    };
  }

  /** 低层：发给模型一条**纯文本**消息（不带图，比多模态快） */  /** 低层：发给模型一条**纯文本**消息（不带图，比多模态快） */
  async function chatText(base, cfg, model, prompt, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var body = {
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: clamp(opts.maxTokens || 400, 16, 2048),
      repeat_penalty: 1.15,
      chat_template_kwargs: { enable_thinking: false }
    };
    var resp = await fetch(base.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        (cfg && cfg.apiKey) ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      body: JSON.stringify(body),
      signal: (function () { try { return AbortSignal.timeout(opts.timeoutMs || 30000); } catch (e) { return undefined; } })()
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var j = await resp.json();
    return {
      content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
      ms: Date.now() - t0,
      usage: j.usage || null
    };
  }

  /** 纯文本翻译的提示词（两阶段的第二阶段用） */
  /* ------------------------------------------------ 反向翻译（中→外） */

  /**
   * 反向翻译支持的目标语言。
   *
   * 与正向翻译（外→中）不同：这里的中文原文是**用户自己写的**，
   * 要转成外国语言用于发消息 / 写邮件 / 发帖。
   *
   * 用 native name 而不只是中文名 —— 提示词里写 "English" / "日本語"
   * 比写 "英语" / "日语" 更准（模型对语言自称更敏感，实测一致）。
   */
  var REVERSE_LANGS = [
    { id: 'en', zh: '英语',     native: 'English' },
    { id: 'ja', zh: '日语',     native: '日本語' },
    { id: 'ko', zh: '韩语',     native: '한국어' },
    { id: 'pt', zh: '葡萄牙语', native: 'Português' },
    { id: 'fr', zh: '法语',     native: 'Français' },
    { id: 'de', zh: '德语',     native: 'Deutsch' },
    { id: 'es', zh: '西班牙语', native: 'Español' },
    { id: 'ru', zh: '俄语',     native: 'Русский' },
    { id: 'it', zh: '意大利语', native: 'Italiano' },
    { id: 'zh-tw', zh: '繁體中文', native: '繁體中文' }
  ];

  /** 按 id 找语言（找不到返回英语） */
  function reverseLang(id) {
    for (var i = 0; i < REVERSE_LANGS.length; i++) {
      if (REVERSE_LANGS[i].id === String(id || '')) return REVERSE_LANGS[i];
    }
    return REVERSE_LANGS[0];
  }

  /**
   * 反向翻译的提示词。
   *
   * ## 与正向翻译 prompt 的关键差别
   *
   * 正向（外→中）：
   *   "把下面的文本翻译成简体中文，只输出译文"
   *
   * 反向（中→外）要额外约束三件事：
   *
   *  ① **必须真的输出目标语言**。
   *     实测坑：只写 "翻译成 English"，模型有时会把中文原样返回
   *     （它认为 "English" 只是标签）。必须写 "用 English 表达"。
   *
   *  ② **不要解释 / 不要加注音**。
   *     日语容易输出「日本語（にほんご）」这种，用户要的是能直接发出去的文本。
   *
   *  ③ **保留占位符和专名**。
   *     用户写的 {name}、@someone、URL、代码片段不能被翻译。
   */
  function buildReversePrompt(sourceText, langId) {
    var L = reverseLang(langId);
    return [
      '把下面的中文用' + L.native + '表达出来（' + L.zh + '）。',
      '只输出' + L.native + '译文，不要输出中文原文，不要解释，不要加注音。',
      '保留原文里的 {占位符}、@提及、URL、代码片段、表情符号不动。',
      '',
      sourceText
    ].join('\n');
  }

  function buildTextTranslatePrompt(sourceText, targetLang) {
    var lang = String(targetLang || '简体中文');
    return '把下面的文本翻译成' + lang + '，只输出译文，不要输出原文，不要解释：\n\n' + sourceText;
  }

  /** 低层：发给模型一条多模态消息 */
  async function chatVision(base, cfg, model, prompt, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var body = {
      model: model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]}],
      temperature: 0,
      max_tokens: clamp(opts.maxTokens || 300, 32, 1024),
      repeat_penalty: 1.22,
      chat_template_kwargs: { enable_thinking: false }
    };
    var resp = await fetch(base.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        (cfg && cfg.apiKey) ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      body: JSON.stringify(body),
      signal: (function () { try { return AbortSignal.timeout(opts.timeoutMs || 30000); } catch (e) { return undefined; } })()
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var j = await resp.json();
    return {
      content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
      ms: Date.now() - t0,
      usage: j.usage || null
    };
  }

  /**
   * 翻译一张裁剪好的图块。
   *
   * @param {string} base DSH 地址
   * @param {object} cfg  配置
   * @param {string} dataUrl data:image/jpeg;base64,...
   * @param {object} opts { targetLang, model, maxTokens, timeoutMs }
   * @returns {Promise<{text:string, src:string, ms:number, usage:object}>}
   */
  async function visionTranslateBlock(base, cfg, dataUrl, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var target = opts.targetLang || (cfg && cfg.targetLang) || '简体中文';
    var model = opts.model || (cfg && cfg.model) || 'translate';
    var maxTok = clamp(opts.maxTokens || 220, 32, 1024);
    var timeoutMs = opts.timeoutMs || 30000;

    var body = {
      model: model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: buildImagePrompt(target) },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0,
      max_tokens: maxTok,
      /**
       * 抑制重复。实测 2B 模型在多气泡图上会陷入 repetition loop，
       * 一块图也可能（尤其是图里有重复字样时）。1.1 是实测的平衡点：
       * 1.0 会循环，1.2 会把正常重复的字（比如「谢谢」出现两次）压没。
       */
      repeat_penalty: 1.22,   // 实测 1.1 还会重复（"明天吧 明天吧"），1.22 能压住；再高会伤短句译文
      // Qwen 系模型的思考开关。不开的话思考内容会漏进 content
      chat_template_kwargs: { enable_thinking: false }
    };

    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { /* 老浏览器 */ }
    var timer = null;
    if (ctrl) timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);

    try {
      var resp = await fetch(base.replace(/\/$/, '') + '/v1/chat/completions', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' },
          (cfg && cfg.apiKey) ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!resp.ok) {
        var errText = '';
        try { errText = (await resp.text()).slice(0, 300); } catch (e) {}
        throw new Error('HTTP ' + resp.status + (errText ? '：' + errText : ''));
      }
      var j = await resp.json();
      var content = clean((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');

      /**
       * 从模型输出里提取可用的译文。
       *
       * 这里做三件事（顺序有讲究）：
       *   ① 剥掉「原文 → 译文」双段落
       *   ② 去重复
       *   ③ **剔除图像描述**
       *
       * 第 ③ 步是这个函数存在的核心理由：用户拿真实漫画页测时，
       * 模型把 7 个块全返回成了看图说话（「画面中：山崎说到…」），
       * 直接盖到图上是纯污染。
       *
       * 返回空字符串时调用方应该**保持原文不动**，不要盖空块。
       */
      var text = extractUsableImageText(content);
      /**
       * 识别到描述 → 标记一下，让 content script 知道这块没结果。
       * 不抛异常（那会让整张图的中断），只是一个块失败。
       */
      var skipped = (content.length > 0 && text === '');
      return {
        text: text,
        src: '',
        skipped: skipped,
        raw: skipped ? content.slice(0, 200) : '',
        ms: Date.now() - t0,
        usage: j.usage || null
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 从模型输出里挑出「译文」部分。
   *
   * 为什么需要：模型偶尔会输出
   *   ```
   *   原文：こんにちは
   *   译文：你好
   *   ```
   * 这种对称结构，取 `译文：` 后面的部分。
   *
   * 也处理 `JP: … / ZH: …` 这种交替代码。
   */
  function pickTranslationOnly(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';

    // ① 「译文：xxx」形态
    var m = s.match(/^(?:译文|翻译|中文|Translation|Chinese|ZH)\s*[:：]\s*([\s\S]+)$/im);
    if (m && m[1].trim()) return m[1].trim();

    // ② 「原文：… \n 译文：…」两段形态 → 取译文那行之后
    var m2 = s.match(/(?:译文|翻译|Translation|Chinese|ZH)\s*[:：]\s*([\s\S]+)$/im);
    if (m2 && m2[1].trim()) return m2[1].trim();

    // ③ 行数 > 2 且前半段「不像译文」（没有目标语言特征）→ 尝试后半段
    var lines = s.split(/\n/).filter(function (x) { return x.trim(); });
    if (lines.length > 2) {
      var half = Math.floor(lines.length / 2);
      var first = lines.slice(0, half).join('\n');
      var second = lines.slice(half).join('\n');
      // 前半段不含汉字（目标中文时）→ 前半段是原文，取后半段
      if (scriptStats(first).han === 0 && scriptStats(second).han > 0) return second.trim();
    }

    // ④ 去掉「整句重复」：模型偶尔会把同一句吐两遍
    var dup = dedupeLines(s);
    if (dup) return dup;

    return s;
  }

  /**
   * 去掉重复行。
   *
   * 实测被咬过：`また明日ね` → "明天吧 明天吧"（同一行内重复），
   * 或者两行的内容完全一样。
   *
   * 处理两种重复：
   *   · 行内重复：整行是同一个短句重复 N 次 → 保留一份
   *   · 跨行重复：连续几行完全一样 → 只留一份
   */
  /**
   * 去掉重复行。
   *
   * 实测被咬过：`また明日ね` → "明天吧 明天吧"（同一行内重复），
   * 或者两行的内容完全一样。
   *
   * 处理两种重复：
   *   · 行内重复：整行是同一个短句重复 N 次 → 保留一份
   *   · 跨行重复：连续几行完全一样 → 只留一份
   */
  function dedupeLines(text) {
    var s = String(text || '');
    var lines = s.split('\n');

    // ① 行内重复：一个短句（≤14 字）连着出现 ≥2 次
    var outLines = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var trimmed = ln.trim();
      if (!trimmed) { outLines.push(ln); continue; }
      var m = trimmed.match(/(.{2,14})\s*\1/);
      if (m) {
        var unit0 = m[1];
        /**
         * 中文叠词保护。
         *
         * 中文里单字重复是正常表达：「啊啊啊啊」「好好好」「谢谢谢谢」。
         * 但也有真的重复：「你好你好」（模型吐了两遍）。
         *
         * 区分方法：
         *   · **有分隔符**（空格 / 标点 / 换行）的重复 → 一定是真重复，去重
         *   · **无分隔符**的纯中文重复 → 分不清叠词还是真重复 → **不去重**
         *
         * 至于无分隔符的真重复，交给 repeat_penalty 和 prompt 先挡。
         */
        var between = m[0].slice(unit0.length, m[0].length - unit0.length);
        var hasSep = between.length > 0 || /\s/.test(m[0]);
        var cleaned0 = unit0.replace(/\s/g, '');
        if (!hasSep && cleaned0 && /^\p{Script=Han}+$/u.test(cleaned0)) m = null;
      }
      if (m) {
        var unit = m[1];
        var repeated = trimmed;
        var cut = repeated.length;
        while (cut > unit.length) {
          var tail = repeated.slice(cut - unit.length, cut);
          if (tail !== unit) break;
          cut -= unit.length;
        }
        ln = repeated.slice(0, cut).trim();
      }
      outLines.push(ln);
    }

    // ② 跨行连续重复
    var finalLines = [];
    for (var j = 0; j < outLines.length; j++) {
      var cur = outLines[j];
      if (finalLines.length && cur.trim() === finalLines[finalLines.length - 1].trim() && cur.trim()) continue;
      finalLines.push(cur);
    }
    return finalLines.join('\n');
  }

  /**
   * 识别并剔除「图像描述」输出。
   *
   * ## 这是一个真实且严重的 bug
   *
   * 用户拿真实漫画页测，模型返回的不是翻译，而是**看图说话**：
   *
   *   画面中：山崎说到：你吃了吗？...旁边写着山崎说到和女面商会
   *   画面中有一处细节：一个带有标签的容器旁边写着「かっ？」
   *   这位角色的上半身画面中可以看到她穿着带有花纹的日式和服式上衣
   *   图片中的文本无法显示或无效。
   *   图片中的文本已全部翻译成简体中文；图像中没有任何可见的文本内容。
   *
   * 这些被当作译文盖到了图上，完全不是用户要的东西。
   *
   * ## 为什么会这样
   *
   * 多模态模型在收到一张「大部分是画面、文字只占小部分」的 crop 时，
   * 会走 **captioning（图像描述）** 路径，而不是 OCR + 翻译。
   *
   * 诱因：
   *   ① crop 里图像内容占主导（检测把插画误判成文字块）
   *   ② prompt 里的「图中所有文字」不够强硬，模型理解成「描述这张图」
   *
   * ## 处理策略：**宁可返回空，也不返回描述**
   *
   * 描述文字没有任何翻译价值，盖到图上是纯污染。检测到就丢弃，
   * 让那块保持原样（用户至少还能看到原文）。
   *
   * ## 判据（都用真实输出标定）
   *
   * 命中任意一条就判定为「图像描述」：
   *   · 含「画面中」「图片中」「图像中」「图中」「这幅图」等指代整体图的话
   *   · 含「可以看到」「可以看到她」「穿着」「站在」「背景是」等视觉叙述词
   *   · 含「无法显示」「没有可见」「未检测到」「没有文字」等自我否定
   *   · 含「已全部翻译」「翻译成简体中文」等自我宣告
   *   · 以「这是/这张/该图片」开头且长度超过 20 字（描述式开头）
   */
  var CAPTION_MARKERS = [
    // 指代整图
    /画面中/, /图片中/, /图像中/, /图中/, /这幅图/, /这张图/, /该图/, /此图/,
    /这张图片/, /这张照片/, /画面里/, /画面上/,
    // 视觉叙述
    /可以看到/, /能看到/, /显示着/, /显示了一个/, /画着/, /绘有/,
    /穿着/, /上身/, /下身/, /表情/, /姿势/, /背景是/, /背景为/,
    /站在/, /坐在/, /躺/, /举着/, /拿着/, /手里/,
    // 自我否定
    /无法显示/, /无法辨认/, /没有可见/, /没有任何可见/, /未检测到/,
    /没有检测到/, /不存在文字/, /没有文字/, /无文字/,
    // 自我宣告
    /已全部翻译/, /已翻译成/, /翻译成简体中文；/, /文本已全部/
  ];

  function looksLikeCaption(text) {
    var s = String(text || '').trim();
    if (!s) return false;
    /**
     * 长度门槛：短句不可能是描述。
     *
     * 但**自我否定类**（"图片中的文本无法显示或无效。"）只有 14 字，
     * 不能一刀切挡掉。所以先扫一遍「强标记」，命中就直接判描述，
     * 再走长度门槛。
     */
    var STRONG = [
      /无法显示/, /无法辨认/, /没有可见/, /没有任何可见/, /未检测到/,
      /没有检测到/, /不存在文字/, /没有文字/, /无文字/,
      /已全部翻译/, /已翻译成/, /文本已全部/,
      /图片中/, /图像中/, /画面中/
    ];
    for (var si = 0; si < STRONG.length; si++) {
      if (STRONG[si].test(s)) return true;
    }
    if (s.length < 18) return false;

    for (var i = 0; i < CAPTION_MARKERS.length; i++) {
      if (CAPTION_MARKERS[i].test(s)) return true;
    }

    /**
     * 开头就是描述式。
     *
     * 注意**只认「图/照片」量词**，不认「段/个/位」——
     * 实测误判过：「这是一段很长的说明文字…」是正常译文，
     * 但被 `/^这是[一]?(?:张|幅|个|位|名|段)/` 命中判成描述了。
     */
    if (/^这是[一]?(?:张|幅|张图|幅图|画面|照片|漫画|页面)/.test(s)) return true;
    if (/^该(?:图|画|角)/.test(s)) return true;

    return false;
  }

  /**
   * 从模型输出里提取「可以用的译文」。
   *
   * 步骤：
   *   ① clean + 剥双段落（pickTranslationOnly）
   *   ② 去重复（dedupeLines）
   *   ③ **剔除图像描述**（looksLikeCaption）
   *
   * 返回空字符串时调用方应该「保持原文不动」，而不是盖一个空块上去。
   */
  function extractUsableImageText(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = pickTranslationOnly(s);
    s = dedupeLines(s);

    /**
     * 按行过滤：把「描述行」从「译文行」里挑掉。
     *
     * 有些输出是混合的（前面一句译文 + 后面一段描述）。
     * 逐行判断，只保留不像描述的。
     */
    var lines = s.split('\n');
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) continue;
      if (looksLikeCaption(ln)) continue;
      kept.push(ln);
    }

    /**
     * 全都像描述 → 这块没结果。
     *
     * **注意不要因为一行描述就把整块丢掉**：实测输出常常是
     * 「你好！ / 画面中可以看到她穿着和服。 / 谢谢」这种混合，
     * 逐行过滤能保住真正的译文行。
     */
    if (!kept.length) return '';

    // 整段再判一次（防止多行拼起来才像描述）
    var joined = kept.join('\n');
    if (looksLikeCaption(joined)) return '';

    /**
     * prompt 里让模型「没文字就输出（无文字）」—— 那个占位符本身不是译文，
     * 不能盖到图上。识别后返回空。
     */
    if (/^[（(]\s*(?:无文字|沒有文字|no text|文字なし|沒有|没有)\s*[)）]$/i.test(joined)) return '';

    return joined;
  }

  /* ------------------------------------------------------- 地址候选生成 */

  /** DSH 面板的默认端口 */
  var DSH_PORT = 47300;

  /** 常见局域网网段。找不到网卡时逐个试，命中即停。 */
  var COMMON_SUBNETS = ['192.168.1', '192.168.0', '192.168.2', '192.168.31', '10.0.0', '10.0.1', '10.1.1', '172.16.0'];

  /** 从一个 IP 推出 /24 前缀 */
  function subnetOf(ip) {
    var parts = String(ip || '').split('.');
    if (parts.length !== 4) return '';
    return parts.slice(0, 3).join('.');
  }

  /** 从任意字符串里抠 IPv4（用户粘贴的 URL、DSH 面板地址等） */
  function extractHost(text) {
    var m = String(text || '').match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
    return m ? m[1] : '';
  }

  /**
   * 生成要探测的候选地址列表，按「最可能连上」排序。
   * 顺序：用户填的 → 上次连上的 → 回环 → 已知网段里的本机 IP → 常见网段的常见主机位
   */
  function candidateBases(cfg, knownIps) {
    var out = [];
    function add(b) {
      var s = String(b || '').trim().replace(/\/+$/, '');
      if (!s) return;
      if (s.indexOf('http') !== 0) s = 'http://' + s;
      // 去掉用户粘贴时带的 /v1
      var m = s.match(/(\/v[0-9]+)$/i);
      if (m) s = s.slice(0, s.length - m[1].length);
      if (!/:\d+$/.test(s)) s = s + ':' + DSH_PORT;
      if (out.indexOf(s) < 0) out.push(s);
    }
    if (cfg && cfg.endpoint) add(cfg.endpoint);
    (knownIps || []).forEach(add);
    add('http://127.0.0.1:' + DSH_PORT);
    add('http://localhost:' + DSH_PORT);
    return out;
  }

  /**
   * 网段扫描：只试 DSH 端口。
   * 这是「本机回环打不通、面板绑在局域网」时的救命手段 —— 上一版实测 254 个地址 × 1 端口约 1~2 秒。
   */
  function subnetBases(prefixes) {
    var out = [];
    (prefixes || []).forEach(function (p) {
      for (var n = 1; n <= 254; n++) out.push('http://' + p + '.' + n + ':' + DSH_PORT);
    });
    return out;
  }

  /* ------------------------------------------------------------ 请求 */

  function estimateTokens(text) {
    var st = scriptStats(text);
    return st.han + st.kana + st.hangul + Math.ceil(st.latin / 4) + Math.ceil(st.other / 2) + 4;
  }

  /** 按上下文预算把一批再切小 */
  function splitForBudget(cfg, texts) {
    var ctx = clamp((cfg && cfg.contextTokens) || 2048, 512, 131072);
    var overhead = 260;
    var budget = Math.max(160, ctx - overhead);
    var outReserve = Math.min(360, Math.floor(budget * 0.45));
    var avail = Math.max(48, budget - outReserve);
    var groups = [], cur = [], used = 0;
    for (var i = 0; i < texts.length; i++) {
      var t = estimateTokens(texts[i]) + 8;
      if (cur.length && used + t > avail) { groups.push(cur); cur = []; used = 0; }
      cur.push(texts[i]); used += t;
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  function authHeaders(cfg) {
    var k = cfg && cfg.apiKey ? String(cfg.apiKey).trim() : '';
    return k ? { Authorization: 'Bearer ' + k } : {};
  }

  function baseOf(cfg) {
    var s = String((cfg && cfg.endpoint) || '').trim().replace(/\/+$/, '');
    var m = s.match(/(\/v[0-9]+)$/i);
    if (m) s = s.slice(0, s.length - m[1].length).replace(/\/+$/, '');
    return s;
  }

  async function fetchJson(cfg, url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms || 6000);
    try {
      var r = await fetch(url, { headers: authHeaders(cfg), signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  /**
   * 探测一个地址，返回结构化结论（含失败原因）。
   * 失败原因要能区分「连不上」「不是 DSH」「HTTP 错误」，界面上才好说清楚。
   */
  async function probeDetail(base, cfg, timeoutMs) {
    var info;
    try {
      info = await fetchJson(cfg, base + '/v1', timeoutMs || 2500);
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (/HTTP 404/.test(msg)) return { ok: false, base: base, reason: '这个端口上没有 /v1 接口' };
      if (/HTTP 401|HTTP 403/.test(msg)) return { ok: false, base: base, reason: '需要 token（HTTP ' + msg.replace('HTTP ', '') + '）' };
      if (/HTTP/.test(msg)) return { ok: false, base: base, reason: msg };
      return { ok: false, base: base, reason: '连不上（端口没开或不在同一网段）' };
    }
    if (!info || info.service !== 'dsh-npu') {
      return { ok: false, base: base, reason: '这个端口上的服务不是 DSH' };
    }
    var models = [];
    try {
      var m = await fetchJson(cfg, base + '/v1/models', 3000);
      models = ((m && m.data) || []).map(function (x) { return x.id; }).filter(Boolean);
    } catch (e) { /* 拿不到就算了 */ }
    var slots = (info.slots || []).map(function (s) {
      return {
        id: String(s.id || '').split('-')[0] || '',
        model: String(s.model || '').split(/[\\/]/).pop() || '',
        ready: !!s.ready
      };
    });
    var ready = slots.filter(function (s) { return s.ready; });
    return {
      ok: true, base: base,
      front: info.front || base + '/v1',
      models: models, slots: slots,
      readyRoles: ready.map(function (s) { return s.id; }),
      service: info.service
    };
  }

  /** 兼容旧调用：是 DSH 就返回详情，否则 null */
  async function probe(base, cfg) {
    var d = await probeDetail(base, cfg);
    return d && d.ok ? d : null;
  }

  /** 从已就绪的槽位里挑最合适的角色名 */
  function pickModel(models, slots) {
    var ids = (models || []).slice();
    if (!ids.length) {
      ids = (slots || []).filter(function (s) { return s.ready; }).map(function (s) { return s.id; }).filter(Boolean);
    }
    var byName = function (name) {
      return ids.filter(function (x) { return String(x).toLowerCase() === name; })[0];
    };
    return byName('translate') || byName('chat') || ids[0] || '';
  }

  /** 发一次对话请求（非流式；流式在下面单独实现） */
  async function chatOnce(cfg, base, model, prompt, onDelta) {
    var body = {
      model: model,
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      stream: !!(onDelta && cfg.stream !== false),
      temperature: clamp(cfg.temperature == null ? 0 : cfg.temperature, 0, 1.5),
      max_tokens: clamp(cfg.maxTokens || 640, 16, 2048),
      chat_template_kwargs: { enable_thinking: false }
    };
    var url = base + '/v1/chat/completions';
    var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 120000);
    try {
      var r = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!r.ok) {
        var txt = '';
        try { txt = (await r.text()).slice(0, 200); } catch (e) {}
        throw new Error('HTTP ' + r.status + (txt ? ('：' + txt) : ''));
      }
      if (!body.stream) {
        var j = await r.json();
        return { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', usage: j.usage || null, timings: j.timings || null };
      }
      return await readStream(r, onDelta);
    } finally { clearTimeout(timer); }
  }

  /** 读 SSE 流：每收到一段正文就回调，攒够就渲染 */
  async function readStream(res, onDelta) {
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '', full = '', last = Date.now();
    var usage = null, timings = null;
    var watch = setInterval(function () {
      if (Date.now() - last > 45000) { try { reader.cancel(); } catch (e) {} }
    }, 500);
    try {
      while (true) {
        var rd = await reader.read();
        if (rd.done) break;
        buf += dec.decode(rd.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf(LF)) >= 0) {
          var line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.slice(0, 5) === 'data:') line = line.slice(5).trim();
          if (line === '[DONE]') { buf = ''; break; }
          var obj;
          try { obj = JSON.parse(line); } catch (e) { continue; }
          if (obj.usage) usage = obj.usage;
          if (obj.timings) timings = obj.timings;
          var c = obj.choices && obj.choices[0];
          var d = c && c.delta && c.delta.content;
          if (d) { last = Date.now(); full += d; if (onDelta) onDelta(full); }
        }
      }
    } finally {
      clearInterval(watch);
      try { reader.cancel(); } catch (e) {}
    }
    return { text: full, usage: usage, timings: timings };
  }

  /* ------------------------------------------------------------ 翻译主流程 */

  /**
   * 翻一批。返回与输入同序的字符串数组。
   * onSegment(index, text, final) 让上层边生成边回填。
   */
  async function translateBatch(cfg, base, model, texts, onSegment) {
    var results = new Array(texts.length).fill('');
    var pending = [], pendingIdx = [];
    for (var i = 0; i < texts.length; i++) {
      if (!texts[i]) continue;
      pending.push(texts[i]);
      pendingIdx.push(i);
    }
    if (!pending.length) return results;

    // 超出上下文就先切小
    var groups = splitForBudget(cfg, pending);

    var offset = 0;
    for (var g = 0; g < groups.length; g++) {
      var chunk = groups[g];
      await fillOne(cfg, base, model, chunk, pendingIdx, offset, results, onSegment);
      offset += chunk.length;
    }
    return results;
  }

  async function fillOne(cfg, base, model, texts, idxMap, offset, results, onSegment) {
    var n = texts.length;
    var ctx = clamp((cfg && cfg.contextTokens) || 2048, 512, 131072);
    // 输出预算：按输入字符数估（中文 1 字≈1 token，留 1.6 倍余量），再受配置硬顶约束
    var inChars = 0;
    for (var q = 0; q < texts.length; q++) inChars += texts[q].length;
    var wantTok = Math.ceil(inChars * 1.6) + 32 * n;
    var maxTok = Math.min(clamp(cfg.maxTokens || 640, 16, 2048), Math.max(128, wantTok));

    // 标签保护
    var bags = [];
    var send = texts.slice();
    if (cfg.tagProtect !== false) {
      send = texts.map(function (t) {
        var p = protectTags(t);
        bags.push(p.tags);
        return p.text;
      });
    } else {
      texts.forEach(function () { bags.push([]); });
    }

    // 数字保护：计数、金额、百分比、编号一律锁住，翻完原样还原。
    // 但短句（标题、标签）不保护 —— 占位符在短句里比数字本身更让模型困惑。
    //
    // 阈值必须按**可见文字**算，不能用 t.length。
    // 踩过的坑：富文本标题带 <span class="before"> 等标签，
    // t.length 有 230 字但可见文字只有 60 字 → 误触发保护 →
    // @N0@ 被模型当成序号，标题变成「第0课 (Comic Hot Milk 第1年第2月刊)」。
    var numBags = [];
    if (cfg.numberProtect !== false) {
      send = send.map(function (t) {
        // 可见文字长度 = 去掉 HTML 标签、去掉括号包裹的专名部分后的长度。
        // 富文本标题的 t.length 含 <span class="before"> 这类标签，会长 2~3 倍，
        // 直接用它判断会把标题误判成「长文本」。
        var visible = stripTags(String(t).replace(/<[^>]*>/g, '')).length;
        if (visible <= 80) { numBags.push([]); return t; }
        var n = protectNumbers(t);
        numBags.push(n.nums);
        return n.text;
      });
    } else {
      send.forEach(function () { numBags.push([]); });
    }

    var prompt = buildPrompt(Object.assign({}, cfg, { maxTokens: maxTok }), send);
    var streamed = [];
    var raw = '';
    try {
      var r = await chatOnce(cfg, base, model, prompt, n > 1 ? function (fullSoFar) {
        var p = parseNumbered(fullSoFar, n);
        for (var k = 0; k < n; k++) {
          if (!p.parts[k] || streamed[k] === p.parts[k]) continue;
          streamed[k] = p.parts[k];
          if (onSegment) onSegment(idxMap[offset + k], restoreNumbers(restoreTags(p.parts[k], bags[k]), numBags[k]), false);
        }
      } : function (fullSoFar) {
        var t = clean(fullSoFar);
        if (t && onSegment) onSegment(idxMap[offset], restoreNumbers(restoreTags(t, bags[0]), numBags[0]), false);
      });
      raw = r.text;
      lastUsage = r;
    } catch (e) {
      // 批量失败就拆半重试，最坏退化成逐段
      if (n > 1) {
        var half = Math.ceil(n / 2);
        await fillOne(cfg, base, model, texts.slice(0, half), idxMap, offset, results, onSegment);
        await fillOne(cfg, base, model, texts.slice(half), idxMap, offset + half, results, onSegment);
        return;
      }
      throw e;
    }

    var out = new Array(n).fill('');
    if (n === 1) {
      out[0] = restoreNumbers(restoreTags(clean(raw), bags[0]), numBags[0]);
    } else {
      var parsed = parseNumbered(raw, n);
      if (parsed.missing.length === 0) {
        for (var a = 0; a < n; a++) out[a] = restoreNumbers(restoreTags(parsed.parts[a], bags[a]), numBags[a]);
      } else {
        var lines = parseLines(raw, n);
        if (lines) {
          for (var b = 0; b < n; b++) out[b] = restoreTags(lines[b], bags[b]);
        } else {
          var hf = Math.ceil(n / 2);
          await fillOne(cfg, base, model, texts.slice(0, hf), idxMap, offset, results, onSegment);
          await fillOne(cfg, base, model, texts.slice(hf), idxMap, offset + hf, results, onSegment);
          return;
        }
      }
    }

    // 漏翻的那段单独再来一次（最多一次：noRetry 防止递归重试形成死循环）
    if (cfg && cfg.__noRetry) {
      // 重试进来的这一层不再检查漏翻，直接落结果
    } else {
      var target = (cfg && cfg.targetLang) || '简体中文';
      for (var c = 0; c < n; c++) {
        if (!out[c]) continue;
        if (!looksUntranslated(texts[c], out[c], target)) continue;
        var one = new Array(1).fill('');
        try {
          await fillOne(
            Object.assign({}, cfg, { tagProtect: false, __noRetry: true }),
            base, model, [texts[c]], [0], 0, one, null
          );
        } catch (e) { /* 保留原结果 */ }
        if (one[0] && !looksUntranslated(texts[c], one[0], target)) {
          out[c] = one[0];
          if (onSegment) onSegment(idxMap[offset + c], one[0], false);
        }
      }
    }

    for (var d = 0; d < n; d++) {
      results[idxMap[offset + d]] = out[d];
      if (onSegment && out[d]) onSegment(idxMap[offset + d], out[d], true);
    }
  }

  var lastUsage = null;

  /* ------------------------------------------------------------ 自检 */

  /**
   * 一次「能不能用」的完整检查：地址通、角色在、能出字、能流式。
   * 返回 { ok, ms, steps[], sample, ttft, model, base, speed }
   */
  async function diagnose(cfg) {
    var t0 = Date.now();
    var steps = [];
    var base = baseOf(cfg);
    var out = { ok: false, ms: 0, steps: steps, base: base, model: '', models: [], sample: '', ttft: 0, speed: null };

    async function step(name, fn) {
      var s0 = Date.now();
      try {
        var d = await fn();
        steps.push({ name: name, ok: true, ms: Date.now() - s0, detail: d || '' });
        return true;
      } catch (e) {
        steps.push({ name: name, ok: false, ms: Date.now() - s0, detail: String((e && e.message) || e) });
        return false;
      }
    }

    await step('连接 DSH 前端', async function () {
      var info = await probe(base, cfg);
      if (!info) throw new Error('这个地址不是 DSH 的 NPU 前端');
      out.front = info.front;
      out.models = info.models;
      out.slots = info.slots;
      var ready = (info.slots || []).filter(function (s) { return s.ready; });
      return '前端 ' + info.front + ' · 已就绪角色 ' + (ready.map(function (s) { return s.id; }).join(',') || '无');
    });

    out.model = (cfg && cfg.model) || pickModel(out.models, out.slots);
    await step('加载翻译角色 ' + (out.model || '?'), async function () {
      var pr = buildPrompt(Object.assign({}, cfg, { maxTokens: 32 }), ['Say OK.']);
      var r = await chatOnce(Object.assign({}, cfg, { stream: false, maxTokens: 32 }), base, out.model, pr, null);
      var t = clean(r.text);
      if (!t) throw new Error('返回为空');
      return t.slice(0, 40);
    });

    await step('流式首字', async function () {
      var s0 = Date.now();
      var pr = buildPrompt(Object.assign({}, cfg, { maxTokens: 64 }), ['The quick brown fox jumps over the lazy dog.']);
      var first = 0;
      var r = await chatOnce(Object.assign({}, cfg, { stream: true, maxTokens: 64 }), base, out.model, pr, function (full) {
        if (!first && full) first = Date.now() - s0;
      });
      out.ttft = first;
      out.sample = clean(r.text).slice(0, 60);
      var t = r.timings || {};
      out.speed = Math.round(t.predicted_per_second || 0);
      out.prefill = Math.round(t.prompt_per_second || 0);
      if (!first) throw new Error('流里没有正文');
      return first + 'ms 出首字' + (out.speed ? ('，' + out.speed + ' tok/s') : '');
    });

    if (steps.every(function (s) { return s.ok; })) {
      out.ok = true;
      if (!out.speed) out.speed = lastUsage && lastUsage.timings ? Math.round(lastUsage.timings.predicted_per_second || 0) : 0;
    }
    out.ms = Date.now() - t0;
    out.error = out.ok ? '' : steps.filter(function (s) { return !s.ok; }).map(function (s) { return s.name + '：' + s.detail; }).join('；');
    return out;
  }

  /* ------------------------------------------------------------ 导出 */

  var API = {
    DEFAULTS: DEFAULTS,
    hashKey: hashKey, normSpace: normSpace, clamp: clamp,
    scriptStats: scriptStats, scriptOf: scriptOf, langTag: langTag,
    detectLang: detectLang, sameLangAsTarget: sameLangAsTarget,
    isTranslatable: isTranslatable,
    protectTags: protectTags, restoreTags: restoreTags, isMetaTag: isMetaTag,
    protectNumbers: protectNumbers, restoreNumbers: restoreNumbers,
    GLOSSARY: GLOSSARY, glossaryLookup: glossaryLookup, normTerm: normTerm,
    buildPrompt: buildPrompt, parseNumbered: parseNumbered, parseLines: parseLines, clean: clean,
    looksUntranslated: looksUntranslated, estimateTokens: estimateTokens, splitForBudget: splitForBudget,
    probe: probe, probeDetail: probeDetail, pickModel: pickModel, baseOf: baseOf,
    DSH_PORT: DSH_PORT, COMMON_SUBNETS: COMMON_SUBNETS,
    subnetOf: subnetOf, extractHost: extractHost,
    candidateBases: candidateBases, subnetBases: subnetBases,
    chatOnce: chatOnce, translateBatch: translateBatch, diagnose: diagnose,
    // 图片翻译
    visionTranslateBlock: visionTranslateBlock,
    visionTwoStage: visionTwoStage,
    visionPageTranslate: visionPageTranslate,
    suryaLayout: suryaLayout,
    ocrPairTranslate: ocrPairTranslate,
    imageEditTranslate: imageEditTranslate,
    extractPairs: extractPairs,
    OCR_PAGE_PROMPT: OCR_PAGE_PROMPT,
    suryaTranslateRegions: suryaTranslateRegions,
    computeRenderBox: computeRenderBox,
    OCR_PROMPT_ZH: OCR_PROMPT_ZH,
    parseSuryaLayout: parseSuryaLayout,
    parseSuryaImageBlocks: parseSuryaImageBlocks,
    buildTextTranslatePrompt: buildTextTranslatePrompt,
    buildReversePrompt: buildReversePrompt,
    REVERSE_LANGS: REVERSE_LANGS,
    reverseLang: reverseLang,
    chatText: chatText,
    chatVision: chatVision,
    buildImagePrompt: buildImagePrompt,
    pickTranslationOnly: pickTranslationOnly, dedupeLines: dedupeLines,
    looksLikeCaption: looksLikeCaption, extractUsableImageText: extractUsableImageText
  };

  root.DSH = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
