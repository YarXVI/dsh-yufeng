/* 图片翻译 · 自包含模块（不依赖 content.js 的内部实现）
 *
 * ## 做什么
 *
 * 把页面里的图片翻成中文，两种呈现方式：
 *   · overlay 模式（默认）：在图上盖一层译文，原文视觉上被盖住但可一键还原
 *   · panel 模式：图旁边弹一个译文面板（原图不动）
 *
 * ## 怎么定位文字
 *
 * **不依赖模型给 bbox**（实测 LFM3-Omni / Index-Translate 给不出可用坐标），
 * 而是用纯 CV 算法自己算：
 *
 *   ① 灰度化 + 二值化（前景 = 深色笔画）
 *   ② 连通域分析（行扫描 + union-find）
 *   ③ 剔除超大块（页面边框）/ 超扁长条（分隔线）/ 过小（噪点）
 *   ④ 剩下的每个小块算一个「字形」
 *   ⑤ 聚类：垂直重叠 > 45% 且水平间距 < 1.8 倍字高 → 同一文字块
 *   ⑥ 每簇的外接矩形 = 文字区域
 *
 * 实测 1000×1400 只要 **36ms**（浏览器端 TypedArray 比 Python numpy 还快）。
 *
 * ## 怎么翻译
 *
 * 逐块裁剪 → 交给 DSH 的 translate 角色（它现在带 mmproj，能直接看图）。
 * 一次裁一块送一次，比整页送一次可靠得多：
 *   · 整页送会被模型输出退化（重复/漏句）——实测 2B 模型扛不住多气泡
 *   · 逐块送上下文独立，不会互相干扰
 *   · 位置由 CV 决定，天然对齐
 *
 * 实测 4 块串行 396ms。
 */

(function () {
  'use strict';

  var S = {
    enabled: false,
    cfg: {},
    panel: null,
    busy: false,
    seq: 0,
    items: [],          // [{ img, card, boxes, overlay }]
    bound: false,
    imgWatchBound: false,   // 图片变化监听是否已绑定
    autoImgEnabled: false,  // 图片自动翻译（配置同步）
    busyRetry: 0,           // 上一张还在翻时的排队重试计数
    imgObserver: null,      // MutationObserver 实例
    imageLoader: null,  // 跨域图加载器（由 content.js 注入）
    pageTranslator: null, // 整页翻译器（由 content.js 注入）
    layoutDetector: null, // 版面检测器（由 content.js 注入）
    fastTranslator: null, // 快速模式翻译器（由 content.js 注入）
    pairExtractor: null,  // src/zh 提取器（由 content.js 注入）
    imageEditor: null,    // 图片重绘器（由 content.js 注入）
    evtLog: [],         // 最近的事件日志（排查「点击没反应」用）
    lastImg: null,      // 最后处理过的图
    lastError: ''       // 最后一次失败原因
  };

  /* ---------------------------------------------------------------- 工具 */

  function log() {
    try { if (S.cfg.debug) console.log.apply(console, ['[DSH 图片翻译]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  /** 元素是不是「值得翻译的图」 */
  function isTranslatableImg(img) {
    if (!img || img.tagName !== 'IMG') return false;
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (w < 120 || h < 80) return false;          // 小图标不翻
    if (w * h < 20000) return false;               // 太小的图没文字
    // 长宽比离谱的（分隔条 / 装饰条）
    var ar = w / h;
    if (ar < 0.15 || ar > 8) return false;
    return true;
  }

  /* ------------------------------------------------------- ① 灰度 + 二值化 */

  /**
   * 把图片画进 canvas 并取出像素，返回 { bw, W, H }。
   * bw 是 Uint8Array（1 = 前景/深色笔画，0 = 背景）。
   *
   * 阈值 150 是实测值：漫画线稿的笔画通常在 0~90，气泡白底在 230+，
   * 150 能干净地分开，同时保留抗锯齿的灰边（不算前景，避免把字撑胖）。
   */
  function binarize(img, maxSide, threshold) {
    maxSide = maxSide || 1280;
    threshold = threshold == null ? 150 : threshold;
    var w0 = img.naturalWidth || img.width;
    var h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;

    var scale = Math.min(1, maxSide / Math.max(w0, h0));
    var W = Math.max(1, Math.round(w0 * scale));
    var H = Math.max(1, Math.round(h0 * scale));

    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    try {
      g.drawImage(img, 0, 0, W, H);
    } catch (e) {
      // 跨域图会倒这里（canvas 被污染）
      return { error: 'tainted' };
    }

    var data;
    try { data = g.getImageData(0, 0, W, H).data; }
    catch (e) { return { error: 'tainted' }; }

    var bw = new Uint8Array(W * H);
    /**
     * 同时生成第二张「**只有很黑的笔画**」的二值图（阈值 120）。
     *
     * 为什么需要两张：
     *
     *   · 阈值 150 → 适合逐字形分析（保留抗锯齿灰边，字形完整）
     *   · 阈值 120 → 适合形态学闭运算（**把浅灰网点排除掉**）
     *
     * 实测（真实漫画页）：
     *   阈值 150 时网点前景占 24~32%，纵向闭运算后网点也连成大块，
     *   全部被面积/宽度阈值滤掉 → 只剩 9 个条（Python 里 21 个）
     *   阈值 120 时网点前景降到 12~20%，文字仍是 7~17%，
     *   竖排文字能桥接而网点不能 → 21 个条，18 个真实文字
     */
    var bwDark = new Uint8Array(W * H);
    for (var p = 0, q = 0; p < bw.length; p++, q += 4) {
      // 加权灰度（ITU-R BT.601）
      var y = data[q] * 0.299 + data[q + 1] * 0.587 + data[q + 2] * 0.114;
      bw[p] = y < threshold ? 1 : 0;
      bwDark[p] = y < 120 ? 1 : 0;
    }
    return { bw: bw, bwDark: bwDark, W: W, H: H, scale: scale, canvas: c, threshold: threshold };
  }

  /* ----------------------------------------------- 跨域图处理 */

  /**
   * 检查一张图能不能直接读像素；不能则走 background 抓一份同源副本。
   *
   * ## 为什么需要这一层
   *
   * 页面在 A 域名、图片在 B 域名（nhentai 的 i4.nhentai.net、pixiv 的
   * i.pximg.net、DLsite 的 img.dlsite.jp 都是这种）。把这种图 drawImage
   * 到 canvas 后，**canvas 会被标记为 tainted**，之后任何 getImageData /
   * toDataURL 都抛：
   *
   *   Uncaught DOMException: Failed to execute 'getImageData' on
   *   'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.
   *
   * 用户看到的就是「Alt+点击无效」——因为检测直接失败，什么都画不出来。
   *
   * ## 解法
   *
   * background 的 fetch 走扩展 host_permissions（manifest 里已是所有
   * http/https 域名），不受页面同源策略限制 → 抓成 data URL（同源）→
   * 用它建一个 Image 对象 → 画进 canvas 不再污染。
   *
   * 代价：多一次网络往返 + 一次图片解码。实测 nhentai 的漫画页
   * （约 400KB webp）约 200~400ms。但这是跨域图唯一能读像素的办法。
   */
  async function resolveUsableImage(img) {
    // ① 先试直接画（同源图/已被缓存且带 CORS 头的图会成功）
    try {
      quickDrawTest(img);
      return { image: img };
    } catch (e) {
      // ② 失败了 —— 跨域，走 background 抓
      if (!S.imageLoader) {
        return { error: 'tainted', hint: '这张图跨域，且扩展未加载跨域抓图能力' };
      }
      return await tryLoadCrossOrigin(img);
    }
  }

  /**
   * 极快的探测：把图缩小画进 1x1 canvas 并读 1 个像素。
   * 如果 canvas 被污染，getImageData 会抛 SecurityError。
   */
  function quickDrawTest(img) {
    var c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    var g = c.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2d context');
    g.drawImage(img, 0, 0, 1, 1);
    g.getImageData(0, 0, 1, 1);
  }

  /** 走 background 抓跨域图，建一个同源 Image 对象 */
  async function tryLoadCrossOrigin(img) {
    if (!S.imageLoader) return { error: 'tainted' };
    var src = img.currentSrc || img.src || '';
    if (!/^https?:/i.test(src)) {
      // data: / blob: 开头的理论上同源，但可能因为别的原因污染
      return { error: 'tainted' };
    }
    try {
      var got = await S.imageLoader(src);
      if (!got || !got.dataUrl) return { error: '抓图失败' };
      var newImg = await loadImageFromDataUrl(got.dataUrl);
      return { image: newImg, fetched: true, width: got.width, height: got.height };
    } catch (e) {
      return {
        error: '抓图失败：' + ((e && e.message) || e),
        hint: '图片服务器可能禁止跨域抓取（防盗链）。试试右键「复制图片地址」在新标签打开后再翻。'
      };
    }
  }

  /** data URL → 已 decode 的 Image 对象 */
  function loadImageFromDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('图片解码失败')); };
      im.src = dataUrl;
    });
  }

  /* ------------------------------------------- ② 连通域（行扫描 + union-find） */

  /**
   * 找所有连通域，返回 [{x0,y0,x1,y1,n}]。
   *
   * 实现要点：
   *   · 行扫描把连续前景像素压成一个「行程(run)」，数据量从 W*H 降到 run 数
   *   · 上下两行有水平重叠的 run 就 union —— 这是最快的 4-连通近似
   *   · 用 Int32Array 存 parent，避免 Map 开销
   */
  function connectedComponents(bw, W, H) {
    var runs = [];
    for (var y = 0; y < H; y++) {
      var off = y * W;
      var x = 0;
      while (x < W) {
        if (bw[off + x]) {
          var x0 = x;
          while (x < W && bw[off + x]) x++;
          runs.push({ y: y, a: x0, b: x - 1, id: runs.length });
        } else {
          x++;
        }
      }
    }
    if (!runs.length) return [];

    var parent = new Int32Array(runs.length);
    for (var i = 0; i < runs.length; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

    /** 按行分组，只比较相邻两行 */
    var byRow = new Map();
    for (var i2 = 0; i2 < runs.length; i2++) {
      var r = runs[i2];
      var list = byRow.get(r.y);
      if (!list) { list = []; byRow.set(r.y, list); }
      list.push(r);
    }
    for (var yy = 1; yy < H; yy++) {
      var cur = byRow.get(yy), prev = byRow.get(yy - 1);
      if (!cur || !prev) continue;
      for (var ci = 0; ci < cur.length; ci++) {
        var cr = cur[ci];
        for (var pi = 0; pi < prev.length; pi++) {
          var pr = prev[pi];
          // 水平方向有重叠（允许 1px 缝隙，抗锯齿）
          if (pr.b < cr.a - 1 || cr.b < pr.a - 1) continue;
          var ra = find(cr.id), rb = find(pr.id);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }

    var groups = new Map();
    for (var i3 = 0; i3 < runs.length; i3++) {
      var rr = runs[i3];
      var root = find(rr.id);
      var g = groups.get(root);
      if (!g) {
        g = { x0: rr.a, y0: rr.y, x1: rr.b, y1: rr.y, n: 1, nrun: 1 };
        groups.set(root, g);
      } else {
        if (rr.a < g.x0) g.x0 = rr.a;
        if (rr.b > g.x1) g.x1 = rr.b;
        if (rr.y < g.y0) g.y0 = rr.y;
        if (rr.y > g.y1) g.y1 = rr.y;
        g.n++;
        g.nrun++;
      }
    }
    return Array.from(groups.values());
  }

  /* ------------------------------------------------------------- ③ 剔噪 */

  /**
   * 从连通域里挑出「字形」。
   *
   * 剔掉三类：
   *   · 超大块（页面边框、整块背景）
   *   · 超扁长条（分隔线、下划线）
   *   · 过小的（噪点、网点）
   */
  /**
   * 从连通域里挑出「字形」。
   *
   * ## 判定维度（都在实测数据上标定过）
   *
   * 一个真正的**文字笔画**应该：
   *   · 尺寸适中（不是整块背景、也不是噪点）
   *   · **fill ratio 低**（笔画是细线条，字框里大多是空白）
   *   · 高度和宽度接近（单个字符近似方块）
   *
   * 而下面三类必须剔除：
   *
   * ### ① 中空形状（气泡边框 / 圆角框）
   * fill ratio 极低（0.002~0.005）。
   * 实测：椭圆边框 401×181 只有 356 个像素 → fill=0.005。
   *
   * ### ② **实心色块（角色插画 / 阴影 / 黑背景）** ← 这次新发现的 bug
   * fill ratio 接近 1.0（bbox 内几乎全是前景色）。
   * 实测（用户真实漫画页）：深色插画区域的 fill 达 0.85~1.0。
   *
   * **为什么必须单独处理**：之前的规则只有「fill < 0.02 剔除」这一条下界，
   * 实心块是 fill≈1，**完全从另一边穿过去了**。于是插画被当成"文字块"，
   * crop 送模型后模型只能看图说话 —— 输出「画面中：山崎说到…」这种
   * 图像描述，而不是翻译。用户截图里那 7 条 caption 就是这么来的。
   *
   * ### ③ 超大块（页面边框 / 整块背景）
   *
   * ## 阈值来源
   *
   * 用 PIL 造的真实漫画页 + 用户的截图数据标定：
   *   文字笔画      fill ≈ 0.03 ~ 0.30
   *   抗锯齿粗体字  fill ≈ 0.30 ~ 0.45
   *   实心插画块    fill ≈ 0.85 ~ 1.00
   * 取 **0.55** 作为上界（在 0.45 和 0.85 之间，两边都有余量）。
   */
  function pickGlyphs(comps, W, H) {
    var out = [];
    var area = W * H;

    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      var w = c.x1 - c.x0 + 1;
      var h = c.y1 - c.y0 + 1;

      // ---- 尺寸门槛 ----
      if (w * h > area * 0.10) continue;              // 太大：整块背景
      if (w > 150 && h < 20) continue;                // 横线
      if (h > 150 && w < 20) continue;                // 竖线
      if (w < 5 || h < 5) continue;                   // 噪点
      if (h < 8 && w > 60) continue;                  // 细横条（下划线/分隔线）

      // ---- fill ratio 双向检查 ----
      var fill = c.n / (w * h);

      // 下界：中空形状（气泡边框、圆角框）
      if (fill < 0.02) continue;

      /**
       * 上界：**实心色块**（角色插画 / 阴影 / 大面积黑）。
       *
       * 这是「模型输出图像描述」这个 bug 的直接原因。
       * 之前只检查下界，实心块（fill≈1）从另一边穿过去了。
       *
       * 额外的宽松条件：如果块很小（< 400px²）且 fill 很高，
       * 可能是「。」这种实心标点，仍然保留 —— 靠后边的「每块至少 3 个字形」
       * 和「宽高比」过滤兜住。
       */
      if (fill > 0.55 && (w * h) > 400) continue;

      c.w = w;
      c.h = h;
      c.fill = fill;
      // 保留 run 数，供聚类阶段判断「网点颗粒」用
      c.avgRun = c.nrun > 0 ? c.n / c.nrun : c.n;
      out.push(c);
    }
    return out;
  }

  /* ------------------------------------------------------------- ④ 聚类 */

  /**
   * 把字形聚成「文字块」。
   *
   * 判据（都用实测数据定的）：
   *   · 垂直重叠 ≥ 45%：同一行的字基线接近
   *   · 水平间距 ≤ 1.8 倍字高：太远就是两句话
   *
   * 迭代到不再变化（并查集式扩张），而不是一遍过 —— 因为「行」是逐步长出来的。
   */
  /* --------------------------------------------- 形态学方向闭运算 */

  /**
   * 沿单一方向的闭运算（先膨胀后腐蚀）。
   *
   * ## 为什么这是竖排/横排文字检测的正解
   *
   * 之前的 union-find「字形紧邻聚类」在网点纸上失效：
   * 网点颗粒本身也互相紧邻，所以网点也会被聚成大块。
   *
   * 而**方向性闭运算对网点天然免疫**：
   *
   *   · 闭运算 = 先膨胀 k 像素，再腐蚀 k 像素
   *   · 它**不会创造新形状**，只是把「沿该方向距离 < 2k 的两块」桥接起来
   *   · 竖排日文的字符垂直间距只有 0~5px → 纵向膨胀 12px 就桥接
   *   · 网点是**各向同性点阵** → 不管哪个方向闭运算，出来还是方块
   *   · 腐蚀回来后，竖列恢复原宽度（约 28px）但变成连续长条
   *
   * ## 判据
   *
   *   · 竖条：h/w ≥ 2.5 且 h ≥ 70  → 竖排文字列
   *   · 横条：w/h ≥ 2.5 且 w ≥ 70  → 横排文字行
   *   · 剩余的（长宽比接近 1）→ 网点 / 插画，丢弃
   *
   * ## 实测（真实漫画页 1280×1810）
   *
   * 纵向闭运算 k=12 一次找出 **21 个竖条，其中 18 个是真实文字**，
   * 位置精确到像素，包括之前 union-find 漏掉的那些气泡。
   *
   * ## 实现：O(W*H) 扫描，不用双重循环
   *
   * 「膨胀 k 像素」用**前缀/后缀最大值**式扫描：
   *   for (x = k; x < W; x++) out[x] |= src[x-k]     // 向右扩
   *   for (x = W-k-1; x >= 0; x--) out[x] |= src[x+k] // 向左扩
   * 两遍就是任意方向 ±k 的膨胀。腐蚀同理用 AND。
   *
   * 比「for i in 1..k: 整体位移 OR」快 k 倍。
   *
   * @param {Uint8Array} bw 二值图（1=前景）
   * @param {number} W 宽
   * @param {number} H 高
   * @param {'h'|'v'} dir 方向
   * @param {number} k 半径（像素）
   * @returns {Uint8Array} 闭运算后的二值图
   */
  /**
   * 沿单一方向的闭运算（先膨胀后腐蚀）。
   *
   * ## 数学定义（严格按形态学）
   *
   *   膨胀 D(x) = OR( S(x-k) … S(x+k) )      // 窗口内有任一前景 → 前景
   *   腐蚀 E(x) = AND( D(x-k) … D(x+k) )     // 窗口内**全是**前景 → 前景
   *   闭运算 = E(D(S))
   *
   * ## 踩过的坑
   *
   * 一开始我把腐蚀写成「只看窗口两端各一个点」：
   *
   *   ero[x] = dil[x-k] && dil[x+k]     // ← 错
   *
   * 这在 k>1 时不等价：窗口两端是前景，中间可能有大洞。
   * Python 版用 numpy 切片（每个 i 都整行位移 OR/AND），所以是对的；
   * JS 版必须逐位累加，不能只看两端。
   *
   * 实测差异：错误实现只能找到 6~9 个条，正确实现能找到 21 个。
   *
   * ## 为什么闭运算对网点免疫
   *
   * 闭运算**不创造新形状**，只把「沿该方向距离 < 2k 的两块」桥接。
   *   · 竖排日文字符垂直间距 0~5px → 纵向膨胀 12px 就桥接
   *   · 网点是各向同性点阵 → 桥接后还是方块，长宽比 ≈ 1
   *   · 判据 h/w ≥ 2.5 就把它过滤掉
   *
   * ## 实现：O(W*H + W*k)，用逐步扫描而不是双重循环
   *
   * 「膨胀 k」可以用 k 次单步位移叠加（每次只看 ±1），
   * 复杂度 O(W*H*k) 但常数极小；或者用前缀/后缀累计 O(W*H)。
   * 这里用**前缀累计**：向右一次扫完就能得到任意长度的向右膨胀。
   *
   * @param {Uint8Array} bw 二值图
   * @param {number} W 宽
   * @param {number} H 高
   * @param {'h'|'v'} dir 方向
   * @param {number} k 半径
   */
  function closeDirectional(bw, W, H, dir, k) {
    var i, x, y, off;

    /* ===== 膨胀 ===== */
    var dil = new Uint8Array(W * H);
    if (dir === 'h') {
      for (y = 0; y < H; y++) {
        off = y * W;
        // 向右扩 k：用前缀最大（这里有前景就是 1）
        var acc = 0;
        for (x = 0; x < W; x++) {
          acc = bw[off + x] ? k : Math.max(0, acc - 1);
          if (acc > 0) dil[off + x] = 1;
        }
        // 向左扩 k：后缀
        acc = 0;
        for (x = W - 1; x >= 0; x--) {
          acc = bw[off + x] ? k : Math.max(0, acc - 1);
          if (acc > 0) dil[off + x] = 1;
        }
      }
    } else {
      for (x = 0; x < W; x++) {
        // 向下扩 k
        var accV = 0;
        for (y = 0; y < H; y++) {
          accV = bw[y * W + x] ? k : Math.max(0, accV - 1);
          if (accV > 0) dil[y * W + x] = 1;
        }
        // 向上扩 k
        accV = 0;
        for (y = H - 1; y >= 0; y--) {
          accV = bw[y * W + x] ? k : Math.max(0, accV - 1);
          if (accV > 0) dil[y * W + x] = 1;
        }
      }
    }

    /* ===== 腐蚀（逐窗口扫描，不能只看两端）===== */
    var ero = new Uint8Array(W * H);
    if (dir === 'h') {
      for (y = 0; y < H; y++) {
        off = y * W;
        // 用「最近的非前景位置」判断窗口内是否全前景
        var lastZero = -1;
        for (x = 0; x < W; x++) {
          if (!dil[off + x]) lastZero = x;
          // 窗口 [x-k, x+k] 内没有非前景 → 腐蚀后保留
          ero[off + x] = (lastZero < x - k) ? 1 : 0;
        }
      }
    } else {
      for (x = 0; x < W; x++) {
        var lastZeroV = -1;
        for (y = 0; y < H; y++) {
          if (!dil[y * W + x]) lastZeroV = y;
          ero[y * W + x] = (lastZeroV < y - k) ? 1 : 0;
        }
      }
    }

    return ero;
  }

  /**
   * 方向性文字条检测。
   *
   * @returns {{bars: Array<{x,y,w,h,dir}>, ms}}
   */
  function detectTextBars(bin, opts) {
    opts = opts || {};
    var W = bin.W, H = bin.H;
    var t0 = performance.now();

    // 高阈值二值图：只留很黑的笔画，把浅灰网点滤掉
    // （实测 thr<120 比 150 更干净：文字 7~17% 前景，网点 20~30%）
    // 用「只有很黑笔画」的二值图跑形态学（见 binarize 里的说明）
    var bw = bin.bwDark || bin.bw;
    var area = W * H;
    var k = opts.k || Math.max(6, Math.round(Math.min(W, H) * 0.010));

    var results = [];

    // ---- 纵向（竖排日文）----
    var closedV = closeDirectional(bw, W, H, 'v', k);
    var compsV = connectedComponents(closedV, W, H);
    for (var i = 0; i < compsV.length; i++) {
      var c = compsV[i];
      var w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
      if (h < 70 || w < 8 || w > 70) continue;
      if (h / w < 2.5) continue;
      if (w * h > area * 0.10) continue;
      results.push({ x: c.x0, y: c.y0, w: w, h: h, dir: 'v', count: c.n });
    }

    // ---- 横向（横排文字）----
    var closedH = closeDirectional(bw, W, H, 'h', k);
    var compsH = connectedComponents(closedH, W, H);
    for (var j = 0; j < compsH.length; j++) {
      var c2 = compsH[j];
      var w2 = c2.x1 - c2.x0 + 1, h2 = c2.y1 - c2.y0 + 1;
      if (w2 < 70 || h2 < 8 || h2 > 70) continue;
      if (w2 / h2 < 2.5) continue;
      if (w2 * h2 > area * 0.10) continue;
      results.push({ x: c2.x0, y: c2.y0, w: w2, h: h2, dir: 'h', count: c2.n });
    }

    return { bars: results, ms: Math.round(performance.now() - t0), k: k };
  }

  /**
   * 文字条 → 段落（气泡）。
   *
   * 竖排的语义单元是整句（相邻几列一起读），横排是多行。
   * 单列/单行送模型只能翻半句。
   *
   * 合并判据：
   *   · 同方向
   *   · 主方向间距 ≤ 2.5 倍条宽（列间距 / 行间距）
   *   · 副方向有 ≥ 15% 重叠
   *   · 最多合并 6 个条
   */
  function barsToParagraphs(bars) {
    var used = new Array(bars.length);
    var out = [];
    for (var i = 0; i < bars.length; i++) {
      if (used[i]) continue;
      var grp = [bars[i]];
      used[i] = true;
      var grown = true;
      while (grown) {
        grown = false;
        var gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
        for (var a = 0; a < grp.length; a++) {
          var g = grp[a];
          if (g.x < gx0) gx0 = g.x;
          if (g.x + g.w > gx1) gx1 = g.x + g.w;
          if (g.y < gy0) gy0 = g.y;
          if (g.y + g.h > gy1) gy1 = g.y + g.h;
        }
        var mainDir = grp[0].dir;

        for (var j = 0; j < bars.length; j++) {
          if (used[j]) continue;
          var cand = bars[j];
          if (cand.dir !== mainDir) continue;

          var ok = false;
          if (mainDir === 'v') {
            // 竖排：列间距
            var xgap = Math.max(0, Math.max(gx0, cand.x) - Math.min(gx1, cand.x + cand.w));
            var oy = Math.min(gy1, cand.y + cand.h) - Math.max(gy0, cand.y);
            var minH = Math.min(gy1 - gy0, cand.h);
            ok = xgap <= cand.w * 2.5 && oy >= minH * 0.15;
          } else {
            // 横排：行间距
            var ygap = Math.max(0, Math.max(gy0, cand.y) - Math.min(gy1, cand.y + cand.h));
            var ox = Math.min(gx1, cand.x + cand.w) - Math.max(gx0, cand.x);
            var minW = Math.min(gx1 - gx0, cand.w);
            ok = ygap <= cand.h * 2.5 && ox >= minW * 0.15;
          }
          if (!ok) continue;
          if (grp.length >= 6) continue;

          grp.push(cand);
          used[j] = true;
          grown = true;
        }
      }
      out.push(grp);
    }

    // 每组合并成一个 bbox
    var boxes = [];
    for (var m = 0; m < out.length; m++) {
      var gp = out[m];
      var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      var tot = 0;
      for (var b = 0; b < gp.length; b++) {
        var bb = gp[b];
        if (bb.x < bx0) bx0 = bb.x;
        if (bb.x + bb.w > bx1) bx1 = bb.x + bb.w;
        if (bb.y < by0) by0 = bb.y;
        if (bb.y + bb.h > by1) by1 = bb.y + bb.h;
        tot += (bb.count || 1);
      }
      boxes.push({
        x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0,
        count: tot, lines: gp.length, dir: gp[0].dir,
        bars: gp.length
      });
    }
    return boxes;
  }

  /* --------------------------------------- 按译文需要扩张渲染框 */

  /**
   * 把「文字笔画 bbox」扩张成「能放下译文的框」。
   *
   * ## 为什么必须扩张
   *
   * 检测出的是**文字笔画**的范围。日文竖排一列 30 个字只占
   * `28px 宽 × 240px 高`（每字 8px 高 × 28px 宽，竖着叠）。
   *
   * 而中文译文同样 30 个字，**横着排**需要 `240px 宽 × 40px 高`。
   *
   * 塞回 28px 宽的框 → 只能排 8 行、每行 3 个字 → 又窄又长 → 必然超框。
   * **这就是用户截图里「错位 + 超框」的根因，不是渲染 bug。**
   *
   * ## 怎么扩
   *
   * 沿**垂直于文字流**的方向扩（竖排扩宽、横排扩高），因为那是气泡里
   * 空间最富裕的方向。逐步扩（每步 8px），每步检查「亮像素占比」：
   *
   *   · 气泡内部是大片白纸 → 亮像素占比 > 55%
   *   · 一旦扩出气泡边框 → 碰到黑边/网点 → 骤降到 < 40%
   *
   * 掉到阈值以下就停下并回退一步。上限 5 倍原尺寸（再大就不像话了）。
   *
   * ## 为什么不追求「精确气泡框」
   *
   * 试过泛洪（从文字区域向外扩亮像素）—— 气泡边框**有开口**
   * （引线尾巴、尖角），泛洪从开口漏到页面背景，再扩散整页。
   * 试过封口（先膨胀暗掩码 4px 再泛洪）—— 4 个成功 3 个还是漏。
   *
   * 但**根本不需要精确框**：只要框比文字大 3~4 倍就够放中文了。
   * 宁可框大一点（盖掉少量插画），也不要文字挤成一坨看不清。
   */
  function expandBoxForText(box, bin, text) {
    var W = bin.W, H = bin.H;
    var bwDark = bin.bwDark || bin.bw;
    var area = W * H;

    // 原框尺寸
    var x0 = Math.max(0, Math.round(box.x));
    var y0 = Math.max(0, Math.round(box.y));
    var x1 = Math.min(W, Math.round(box.x + box.w));
    var y1 = Math.min(H, Math.round(box.y + box.h));
    var ow = x1 - x0, oh = y1 - y0;
    if (ow < 4 || oh < 4) return { x: x0, y: y0, w: ow, h: oh };

    /** 区域内亮像素占比（亮 = 背景纸） */
    function brightRatio(bx, by, bw2, bh2) {
      var total = 0, bright = 0;
      var stepX = Math.max(1, Math.round(bw2 / 40));
      var stepY = Math.max(1, Math.round(bh2 / 40));
      for (var yy = Math.max(0, by); yy < Math.min(H, by + bh2); yy += stepY) {
        for (var xx = Math.max(0, bx); xx < Math.min(W, bx + bw2); xx += stepX) {
          total++;
          if (!bwDark[yy * W + xx]) bright++;   // 非暗 = 亮
        }
      }
      return total ? bright / total : 0;
    }

    var isVertical = (box.dir === 'v');

    // 原框本身的亮度（如果已经很暗，说明框选错了，不乱扩）
    var baseRatio = brightRatio(x0, y0, ow, oh);
    if (baseRatio < 0.45) return { x: x0, y: y0, w: ow, h: oh };

    /**
     * 扩张步长：按文字块短边取。竖排短边是宽，横排短边是高。
     * 每次扩 1/4 短边，最多 12 步（即最多扩到 4 倍短边）。
     */
    var minor = isVertical ? ow : oh;
    var step = Math.max(4, Math.round(minor / 4));
    var lastGood = { x: x0, y: y0, w: ow, h: oh };
    var maxSteps = 12;
    var MIN_BRIGHT = 0.55;

    for (var s = 1; s <= maxSteps; s++) {
      var grow = step * s;
      var nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
      if (isVertical) {
        // 竖排：往外扩宽（左右对称），给中文腾出横向空间
        nx0 = Math.max(0, x0 - grow);
        nx1 = Math.min(W, x1 + grow);
        // 高度只轻微扩（上下各 1/4 步长），避免把别的内容框进来
        var vg = Math.round(grow / 4);
        ny0 = Math.max(0, y0 - vg);
        ny1 = Math.min(H, y1 + vg);
      } else {
        // 横排：往外扩高（上下对称），给中文腾出纵向空间
        ny0 = Math.max(0, y0 - grow);
        ny1 = Math.min(H, y1 + grow);
        var hg = Math.round(grow / 4);
        nx0 = Math.max(0, x0 - hg);
        nx1 = Math.min(W, x1 + hg);
      }

      // 面积上限：不超过整图 12%（防失控）
      if ((nx1 - nx0) * (ny1 - ny0) > area * 0.12) break;

      // 亮度校验
      var ratio = brightRatio(nx0, ny0, nx1 - nx0, ny1 - ny0);
      if (ratio < MIN_BRIGHT) break;

      lastGood = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
    }

    return lastGood;
  }

  /**
   * 聚类：字形 → **紧邻单元（atom）** → **文字块**。
   *
   * ## 为什么要重写
   *
   * 原实现按「垂直重叠 ≥ 45% + 水平间距 ≤ 1.8 倍字高」横向聚行，
   * 在**横排**文本上工作良好，但在**竖排**（tategaki，日式漫画极常见）
   * 和**网点纸**（screentone）上彻底失效。
   *
   * 实测（真实 nhentai 漫画页 1280×1810）：
   *
   *   一级聚类产出的「行」         真实含义
   *   (355,0)   868×202          胸部插画（网点纸）
   *   (338,243) 885×165          更多网点
   *   (150,495) 1022×256         插画 + 三列竖排文字混在一起
   *
   * 雪球机制：判据是 `oy / min(clusterH, glyphH)`。
   * 簇长到 202px 后 min(202, 28) = 28，于是任何 28px 的字只要和这个
   * 202px 的簇垂直重叠 12.6px 就算「同一行」——簇越胖越容易吸收，
   * 最终 bbox 撑成整块插画。用户看到的「填充问题」（白底盖住插画）
   * 就是这些巨型框造成的。
   *
   * ## 新算法：紧邻图
   *
   * ### 第一步：字形 → atom
   *
   * 用 **union-find** 连接「紧邻」的字形，两个方向都连：
   *
   *   · 水平紧邻：x 间距 ≤ 0.7 字高，且垂直重叠 ≥ 40%
   *   · 垂直紧邻：y 间距 ≤ 0.7 字宽，且水平重叠 ≥ 40%
   *
   * 关键：这是**传递闭包**，所以一列竖排的 5 个假名会连成一个 atom，
   * 一行横排的 6 个汉字也会连成一个 atom。不需要事先知道方向。
   *
   * 实现要点：用空间哈希（cell 网格）只比较邻近 bucket，
   * 避免 O(n²)。实测 1614 个字形只要 **54ms**。
   *
   * ### 第二步：atom → 文字块
   *
   * atom 有两种形态：
   *
   *   · **细长竖直**（宽 ≈ 1 字宽，高 = N 字高）→ 竖排列
   *   · **扁平水平**（高 ≈ 1 字高，宽 = N 字宽）→ 横排行
   *   · **又宽又高** → 网点纸/插画，**丢弃**
   *
   * 判据用 **p90 字形尺寸**（不用中位数 —— 网点会把中位数拉低到 8px，
   * 真字是 23px，用中位数会把真字误判成巨型块）。
   *
   * ### 第三步：同向 atom 合并成段落
   *
   * 竖排的语义单元是整句（2~3 列一起读），单列送模型只能翻半句。
   * 所以要把相邻的同类 atom 合并：
   *
   *   · 竖排列之间：y 范围有重叠 + 水平间距 ≤ 2 倍字宽
   *   · 横排行之间：x 范围有重叠 + 垂直间距 ≤ 2 倍字高
   *
   * 上限 4 个 atom（防再次雪球）。
   */
  function clusterGlyphs(glyphs, W, H) {
    var n = glyphs.length;
    if (!n) return [];

    /* ---------- 统计字形尺寸（用 p90，不用中位数）---------- */
    var hs = [], ws = [];
    for (var q = 0; q < n; q++) { hs.push(glyphs[q].h); ws.push(glyphs[q].w); }
    hs.sort(function (a, b) { return a - b; });
    ws.sort(function (a, b) { return a - b; });
    function pct(arr, p) { return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] || 1; }
    /**
     * p90 = 第 90 百分位。
     *
     * 为什么不用中位数：网点纸贡献了大量 8px 的假"字形"，
     * 把中位数拉到 8px，而真正的假名/汉字是 23px。
     * 用 8px 做基准会把 200px 的插画块判成「25 个字宽」，
     * 又会把真文字列判成「3 个字宽」，双向都会错。
     */
    var charW = Math.max(4, pct(ws, 0.90));
    var charH = Math.max(4, pct(hs, 0.90));

    /* ---------- 第一步：紧邻图 → atom ---------- */
    var parent = new Int32Array(n);
    for (var i0 = 0; i0 < n; i0++) parent[i0] = i0;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    var tolX = Math.max(2, Math.round(charH * 0.7));   // 水平缝隙容忍
    var tolY = Math.max(2, Math.round(charW * 0.7));   // 垂直缝隙容忍

    // 空间哈希：格子边长 = 3 倍字符尺寸，只需比较 4 个相邻格
    var cell = Math.max(8, Math.max(charW, charH) * 3);
    var buckets = new Map();
    for (var bi = 0; bi < n; bi++) {
      var gb = glyphs[bi];
      var cx0 = Math.floor(gb.x0 / cell), cx1 = Math.floor(gb.x1 / cell);
      var cy0 = Math.floor(gb.y0 / cell), cy1 = Math.floor(gb.y1 / cell);
      for (var cx = cx0; cx <= cx1; cx++) {
        for (var cy = cy0; cy <= cy1; cy++) {
          var key = cx * 100000 + cy;
          var arr = buckets.get(key);
          if (!arr) { arr = []; buckets.set(key, arr); }
          arr.push(bi);
        }
      }
    }
    buckets.forEach(function (idxs, key) {
      var cx = Math.floor(key / 100000), cy = key - cx * 100000;
      for (var dx = 0; dx <= 1; dx++) {
        for (var dy = 0; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) {
            other = idxs;
          } else {
            other = buckets.get((cx + dx) * 100000 + (cy + dy));
            if (!other) continue;
          }
          for (var ii = 0; ii < idxs.length; ii++) {
            for (var jj = 0; jj < other.length; jj++) {
              var a = idxs[ii], b = other[jj];
              if (b <= a) continue;
              var ga = glyphs[a], gg = glyphs[b];
              // 水平紧邻
              var xgap = Math.max(0, Math.max(ga.x0, gg.x0) - Math.min(ga.x1, gg.x1) - 1);
              var oy = Math.min(ga.y1, gg.y1) - Math.max(ga.y0, gg.y0);
              var hh2 = Math.min(ga.h, gg.h);
              if (xgap <= tolX && oy > 0 && oy / hh2 >= 0.4) { union(a, b); continue; }
              // 垂直紧邻
              var ygap = Math.max(0, Math.max(ga.y0, gg.y0) - Math.min(ga.y1, gg.y1) - 1);
              var ox = Math.min(ga.x1, gg.x1) - Math.max(ga.x0, gg.x0);
              var ww2 = Math.min(ga.w, gg.w);
              if (ygap <= tolY && ox > 0 && ox / ww2 >= 0.4) { union(a, b); }
            }
          }
        }
      }
    });
    var other;   // 提升（forEach 内部用到）

    var groupsMap = new Map();
    for (var gi = 0; gi < n; gi++) {
      var root = find(gi);
      var list = groupsMap.get(root);
      if (!list) { list = []; groupsMap.set(root, list); }
      list.push(gi);
    }

    var atoms = [];
    groupsMap.forEach(function (mem) {
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var k = 0; k < mem.length; k++) {
        var g2 = glyphs[mem[k]];
        if (g2.x0 < x0) x0 = g2.x0;
        if (g2.x1 > x1) x1 = g2.x1;
        if (g2.y0 < y0) y0 = g2.y0;
        if (g2.y1 > y1) y1 = g2.y1;
      }
      atoms.push({
        x0: x0, y0: y0, x1: x1, y1: y1,
        w: x1 - x0 + 1, h: y1 - y0 + 1,
        count: mem.length, mem: mem,
        dir: 'none'
      });
    });

    /* ---------- 第二步：classify（竖列 / 横排 / 丢弃）---------- */
    /**
     * 用 p90 字符尺寸做判据：
     *
     *   · 宽 ≤ 2.5 字宽、高 ≤ 30 字高 → **竖列**（竖排文字）
     *   · 高 ≤ 2.5 字高、宽 ≤ 30 字宽 → **横排**（横排文字）
     *   · 两者都超 → 网点/插画，**丢弃**
     *
     * 实测数据（真实漫画页）：
     *   真竖排列 33×137 → 宽/p90W = 1.4，高/p90H = 5.7   ✓ 通过
     *   真竖排列 29×353 → 1.3 / 14.7                      ✓ 通过
     *   网点块   478×169 → 20.8 / 7.0                     ✗ 宽度超 2.5 倍
     *   网点块   297×193 → 12.9 / 8.0                     ✗ 丢弃
     */
    var textAtoms = [];
    for (var ai = 0; ai < atoms.length; ai++) {
      var at = atoms[ai];
      if (at.count < 2) continue;                          // 单个字形：标点/噪点

      var wRatio = at.w / charW;
      var hRatio = at.h / charH;

      /**
       * 竖列：窄且长。
       *
       * 上限 30 字高：一列最多 30 个字（再长就是插画边缘）。
       * 下限 1.6 字高：至少 2 个字竖排才算一列。
       */
      if (wRatio <= 2.5 && hRatio >= 1.6 && hRatio <= 30) {
        at.dir = 'v';
        textAtoms.push(at);
        continue;
      }

      /**
       * 横排：扁且宽。
       *
       * 下限 1.6 字宽：至少 2 个字横排。
       */
      if (hRatio <= 2.5 && wRatio >= 1.6 && wRatio <= 40) {
        at.dir = 'h';
        textAtoms.push(at);
        continue;
      }

      /* 剩下的：网点纸 / 插画 / 边框 → 丢弃 */
    }

    /* ---------- 第三步：同向 atom 合并成段落 ---------- */
    /**
     * 竖排的语义单元是整句（多列一起读），横排是一段多行。
     * 单列/单行送模型只能翻半句（实测「ございます」被翻成「谢谢」）。
     *
     * 合并判据：
     *   · 同方向
     *   · 主方向的间距 ≤ 2 倍字符尺寸（列间距 / 行间距）
     *   · 副方向有 ≥ 20% 重叠（并排的列 / 上下行）
     *   · 最多 4 个 atom（防雪球）
     */
    var used = new Array(textAtoms.length);
    var merged = [];

    for (var ti = 0; ti < textAtoms.length; ti++) {
      if (used[ti]) continue;
      var blk = [textAtoms[ti]];
      used[ti] = true;
      var grown = true;

      while (grown) {
        grown = false;
        var mx0 = Infinity, mx1 = -Infinity, my0 = Infinity, my1 = -Infinity;
        var dirCount = { v: 0, h: 0 };
        for (var mk = 0; mk < blk.length; mk++) {
          var m2 = blk[mk];
          if (m2.x0 < mx0) mx0 = m2.x0;
          if (m2.x1 > mx1) mx1 = m2.x1;
          if (m2.y0 < my0) my0 = m2.y0;
          if (m2.y1 > my1) my1 = m2.y1;
          dirCount[m2.dir] = (dirCount[m2.dir] || 0) + 1;
        }
        var mainDir = dirCount.v >= dirCount.h ? 'v' : 'h';

        for (var tj = 0; tj < textAtoms.length; tj++) {
          if (used[tj]) continue;
          var cand = textAtoms[tj];
          if (cand.dir !== mainDir) continue;

          var ok = false;
          if (mainDir === 'v') {
            // 竖排：列间距小，y 范围有重叠
            var xgap2 = Math.max(0, Math.max(mx0, cand.x0) - Math.min(mx1, cand.x1) - 1);
            var oy2 = Math.min(my1, cand.y1) - Math.max(my0, cand.y0);
            var overlapH = Math.min(my1 - my0 + 1, cand.h);
            ok = xgap2 <= charW * 2.2 && oy2 / overlapH >= 0.20;
          } else {
            // 横排：行间距小，x 范围有重叠
            var ygap2 = Math.max(0, Math.max(my0, cand.y0) - Math.min(my1, cand.y1) - 1);
            var ox2 = Math.min(mx1, cand.x1) - Math.max(mx0, cand.x0);
            var overlapW = Math.min(mx1 - mx0 + 1, cand.w);
            ok = ygap2 <= charH * 2.2 && ox2 / overlapW >= 0.20;
          }
          if (!ok) continue;
          if (blk.length >= 4) continue;

          blk.push(cand);
          used[tj] = true;
          grown = true;
        }
      }
      merged.push(blk);
    }

    /* ---------- 输出：每个合并块一个 bbox ---------- */
    var out = [];
    for (var mi = 0; mi < merged.length; mi++) {
      var mb = merged[mi];
      var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      var totalGlyphs = 0, totalAtoms = 0;
      for (var mj = 0; mj < mb.length; mj++) {
        var mm = mb[mj];
        if (mm.x0 < bx0) bx0 = mm.x0;
        if (mm.x1 > bx1) bx1 = mm.x1;
        if (mm.y0 < by0) by0 = mm.y0;
        if (mm.y1 > by1) by1 = mm.y1;
        totalGlyphs += mm.count;
        totalAtoms += mm.mem.length;
      }
      var bw2 = bx1 - bx0 + 1, bh2 = by1 - by0 + 1;

      /**
       * 最终过滤。
       *
       * · 字形总数 ≥ 3：2 个字形多半是标点或噪点组合
       * · 宽度 ≥ 20 / 高度 ≥ 20：再小读不出来
       * · 面积不超过整图 8%：超过就是漏网的插画（允许竖排多列合并后较大）
       * · 宽高比不约束（竖排是窄高的，横排是宽扁的，都要）
       */
      if (totalGlyphs < 3) continue;
      if (bw2 < 20 || bh2 < 20) continue;
      if (bw2 * bh2 > W * H * 0.08) continue;

      out.push({
        x: bx0, y: by0, w: bw2, h: bh2,
        count: totalGlyphs,
        lines: totalAtoms,
        dir: mb[0].dir
      });
    }
    /**
     * 阅读顺序。
     *
     * 横排：从上到下，同行从左到右。
     * 竖排（日式漫画）：从右上往左下 —— 但检测不到页面级布局，
     * 所以统一按「y 优先、x 次之」，让同高度的块挨在一起，
     * 反正 overlay 是按坐标画的，顺序只影响面板列表可读性。
     */
    out.sort(function (a, b) {
      if (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2) return a.y - b.y;
      return a.x - b.x;
    });

    return out;
  }

  /* ------------------------------------------------------- 检测总入口 */

  /**
   * 检测一张图里的文字块。
   * @returns {{ok:true, boxes, W, H, scale, ms} | {ok:false, error}}
   */
  /**
   * 检测一张图里的文字块。
   *
   * 1.9 之后改成 **async**：跨域图需要先走 background 抓一次（见下面 tryLoadCrossOrigin）。
   *
   * @returns {Promise<{ok:true, boxes, W, H, scale, ms} | {ok:false, error}>}
   */
  async function detect(img, opts) {
    opts = opts || {};
    if (!img) return { ok: false, error: '不是图片' };

    // 跨域图：先尝试直接读（同源图会成功），失败就走 background 抓
    var pre = await resolveUsableImage(img);
    if (pre.error) return { ok: false, error: pre.error };

    var t0 = performance.now();
    var bin = binarize(pre.image, opts.maxSide);
    if (!bin) return { ok: false, error: '读不到图片像素' };
    if (bin.error) {
      // 这是最后一道：如果 loader 可用就再试一次
      if (bin.error === 'tainted' && S.imageLoader) {
        var retry = await tryLoadCrossOrigin(img);
        if (retry.error) return { ok: false, error: retry.error };
        var bin2 = binarize(retry.image, opts.maxSide);
        if (!bin2 || bin2.error) return { ok: false, error: (bin2 && bin2.error) || '读不到像素' };
        bin = bin2;
      } else {
        return { ok: false, error: bin.error };
      }
    }
    var tBin = performance.now() - t0;

    var comps = connectedComponents(bin.bw, bin.W, bin.H);
    var tCC = performance.now() - t0 - tBin;

    /**
     * **形态学方向闭运算**（取代了 union-find 聚类）。
     *
     * 为什么换：
     *   · union-find「字形紧邻」在网点纸上失效 —— 网点颗粒本身也紧邻，
     *     所以网点会被聚成大块，最终 bbox 撑成整块插画（用户报的「填充问题」）
     *   · 方向性闭运算对网点天然免疫：
     *       闭运算 = 沿单一方向膨胀 k 再腐蚀 k，**不创造新形状**，
     *       只把「沿该方向距离 < 2k 的两块」桥接起来
     *       竖排日文字符垂直间距 0~5px → 纵向膨胀 12px 就桥接
     *       网点是各向同性点阵 → 不管哪个方向闭运算，出来还是方块
     *       腐蚀回来后竖列恢复原宽（28px）但变成连续长条
     *   · 判据「h/w ≥ 2.5」把网点（长宽比≈1）天然过滤掉
     *
     * 实测（真实漫画页 1280×1810）：
     *   · union-find  → 11 块，其中只有 4 个真文字（漏 3 个气泡）
     *   · 方向闭运算  → 21 个竖条，**18 个是真实文字**，位置精确到像素
     */
    var barResult = detectTextBars(bin, { k: Math.max(6, Math.round(Math.min(bin.W, bin.H) * 0.010)) });
    var boxes = barsToParagraphs(barResult.bars);
    var tBar = barResult.ms;

    // 缩回原图坐标系（overlay 要按原图位置画）
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].x /= bin.scale;
      boxes[i].y /= bin.scale;
      boxes[i].w /= bin.scale;
      boxes[i].h /= bin.scale;
    }

    return {
      ok: true,
      boxes: boxes,
      W: bin.W, H: bin.H,
      naturalW: pre.image.naturalWidth || pre.image.width,
      naturalH: pre.image.naturalHeight || pre.image.height,
      ms: Math.round(performance.now() - t0),
      timings: { bin: Math.round(tBin), cc: Math.round(tCC), morph: tBar },
      barCount: barResult.bars.length,
      canvas: bin.canvas
    };
  }

  /* ------------------------------------------------------ 逐块抠图送翻译 */

  /**
   * 从 canvas 抠一块出来，编码成 JPEG dataURL。
   * 加 8px padding：模型需要一点上下文，贴边裁会让它认不准。
   */
  /** 更直接的版本：用 canvas 自身的 scale 反推 */
  function cropBox(canvas, box, naturalW, naturalH, pad) {
    pad = pad == null ? 8 : pad;
    var sx = canvas.width / naturalW;
    var sy = canvas.height / naturalH;
    var x = Math.max(0, Math.floor((box.x - pad) * sx));
    var y = Math.max(0, Math.floor((box.y - pad) * sy));
    var w = Math.min(canvas.width - x, Math.ceil((box.w + pad * 2) * sx));
    var h = Math.min(canvas.height - y, Math.ceil((box.h + pad * 2) * sy));
    if (w < 4 || h < 4) return null;

    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    // 放大 1.5 倍再送：小字直接送模型认不准（实测 14px 字 1x 会错，
    // 1.5x 后正确率明显提升，代价只是多几百 token）
    var scale = 1.5;
    if (w * scale < 640) {
      var c2 = document.createElement('canvas');
      c2.width = Math.round(w * scale);
      c2.height = Math.round(h * scale);
      var g2 = c2.getContext('2d');
      g2.imageSmoothingEnabled = true;
      g2.imageSmoothingQuality = 'high';
      g2.fillStyle = '#fff';
      g2.fillRect(0, 0, c2.width, c2.height);
      g2.drawImage(c, 0, 0, c2.width, c2.height);
      return c2.toDataURL('image/jpeg', 0.9);
    }
    return c.toDataURL('image/jpeg', 0.9);
  }

  /* ------------------------------------------------------------- 渲染 */

  /** 把译文盖到图上（overlay 模式）：绝对定位的 div 层 */
  function renderOverlay(img, boxes, results) {
    // 容器：包住 img 的定位上下文
    var host = img.parentNode;
    if (!host) return null;
    var pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';

    var layer = document.createElement('div');
    layer.className = 'dsh-imglayer';
    layer.setAttribute('data-dsh-ui', '1');

    var dw = img.clientWidth;
    var dh = img.clientHeight;
    var nw = img.naturalWidth || dw;
    var nh = img.naturalHeight || dh;
    layer.style.width = dw + 'px';
    layer.style.height = dh + 'px';
    layer.style.left = (img.offsetLeft - host.clientLeft) + 'px';
    layer.style.top = (img.offsetTop - host.clientTop) + 'px';

    for (var i = 0; i < boxes.length; i++) {
      var r = results[i];
      // 没有译文 / 被判定为图像描述 → 不盖，保持原图
      if (!r || !r.text || r.skipped) continue;
      var b = boxes[i];

      // 块在**屏幕上的**实际尺寸（overlay 按显示尺寸画，不是原图尺寸）
      var cw = b.w / nw * dw;
      var ch = b.h / nh * dh;

      var d = document.createElement('div');
      d.className = 'dsh-imgcell';
      /**
       * 白底往外扩 2px：检测到的 bbox 只到笔画外沿，
       * 而原图抗锯齿的灰边会漏在框外（截图里能看到原文字残影）。
       */
      var PAD = 2;
      d.style.left = ((b.x / nw * dw) - PAD) + 'px';
      d.style.top = ((b.y / nh * dh) - PAD) + 'px';
      d.style.width = Math.max(12, cw + PAD * 2) + 'px';
      d.style.minHeight = Math.max(10, ch + PAD * 2) + 'px';

      /**
       * 字号自适应：**必须算，不能靠 CSS clamp**。
       *
       * 踩过的坑：CSS 用 `font-size: clamp(9px, 2.4vh, 22px)`，
       * 在 1000px 高的视口里算出 22px —— 而当时最小的块只有 80px 宽。
       * 结果「你好！今天做什么？」（9 个汉字 × 22px = 198px）
       * 在 188px 宽的块里换行溢出，把气泡撑破了。
       *
       * 算法（中文字符近似等宽，可以用几何估算，不用测量）：
       *   每行字数 = floor(块宽 / 字号)
       *   行数     = ceil(字数 / 每行字数)
       *   总高度   = 行数 × 字号 × 1.25
       * 从「块高」开始往下试，第一个能放下的就是答案。
       *
       * 下限 8px：再小就看不清了，那时宁可溢出（让用户放大页面）。
       */
      var fontSize = chooseFontSize(String(r.text || ''), cw, ch);
      d.style.fontSize = fontSize + 'px';
      d.style.lineHeight = '1.25';
      // 块太矮时不要竖直居中，顶部对齐更自然
      d.style.alignItems = ch < fontSize * 1.6 ? 'flex-start' : 'center';

      d.textContent = r.text;
      d.title = r.src || '';
      layer.appendChild(d);
    }
    host.appendChild(layer);
    return layer;
  }

  /**
   * 给一块译文挑字号。
   *
   * 中文字符近似等宽（1em 宽），所以可以纯几何估算，不用先插进 DOM 再量。
   * 英文按 0.55em 估（拉丁字母平均宽度）。
   */
  function chooseFontSize(text, w, h) {
    var s = String(text || '').replace(/\n/g, '');
    if (!s) return 12;
    /**
     * 宽度估算：**全角字符 1em，半角 0.55em**。
     *
     * 踩过的坑：原来只把「汉字」算 1em，中文标点「！」「？」按 0.55em 估。
     * 但中文标点在字体里是**全角**的（同样占 1em），于是
     * `你好！今天做什么？` 被估成 8.1em（实际 9em），
     * 算出 23px 字号 → 渲染出来 207px 塞不进 188px 的块 → 又换行。
     *
     * 判据用码点范围而不是 Unicode Script 属性：只要落在
     * CJK / 假名 / 谚文 / 全角符号 区段里，就是全角。
     */
    var emWidth = 0;
    for (var ci = 0; ci < s.length; ci++) {
      var cp = s.charCodeAt(ci);
      var fullWidth = (cp >= 0x1100 && cp <= 0x115F)      // 谚文字母
        || (cp >= 0x2E80 && cp <= 0xA4CF)                  // CJK 部首 / 汉字 / 假名
        || (cp >= 0xAC00 && cp <= 0xD7A3)                  // 谚文音节
        || (cp >= 0xF900 && cp <= 0xFAFF)                  // CJK 兼容汉字
        || (cp >= 0xFE30 && cp <= 0xFE6F)                  // CJK 兼容标点（！？、。等全角）
        || (cp >= 0xFF00 && cp <= 0xFF60)                  // 全角 ASCII（！？）
        || (cp >= 0xFFE0 && cp <= 0xFFE6);
      emWidth += fullWidth ? 1 : 0.55;
    }
    if (emWidth < 1) emWidth = 1;
    var minFs = 8;
    var maxFs = Math.max(minFs, Math.floor(h));

    /**
     * 优先「**一行放得下**」：字号从大往小试，第一个「单行就能装下」的胜出。
     *
     * 为什么要优先单行：中文没有词间空格，浏览器按字符断行，
     * 会在任意位置切开（实测「你好！今天做什」/「么?」这种读起来很别扭）。
     * 单行放不下时，稍微小一点但读得顺，比大字号但断在词中间好。
     *
     * 单行下限 11px（再小就看不清了），低于它才退让到多行。
     */
    for (var fs1 = maxFs; fs1 >= 11; fs1--) {
      if (emWidth * fs1 <= w) {
        // 单行放得下，且高度不超
        if (fs1 * 1.25 <= h) return fs1;
        // 高度不够（块很扁）：继续试更小的
      }
    }

    // 退让：允许多行，但要求行高能装进块里
    for (var fs2 = maxFs; fs2 >= minFs; fs2--) {
      var emPerLine = w / fs2;
      if (emPerLine < 1) continue;
      var lines = Math.ceil(emWidth / emPerLine);
      var totalH = lines * fs2 * 1.25;
      if (totalH <= h) return fs2;
    }
    return minFs;
  }

  /** 移除所有 overlay */
  function clearOverlays() {
    var all = document.querySelectorAll('.dsh-imglayer');
    for (var i = 0; i < all.length; i++) {
      if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
    }
    if (S.root) {
      S.root.style.display = 'none';
    }
  }

  /* ------------------------------------------------------------- 面板 */

  function ensurePanel() {
    if (S.panel && S.panel.parentNode) return S.panel;
    var p = document.createElement('div');
    p.className = 'dsh-imgpanel';
    p.setAttribute('data-dsh-ui', '1');
    p.innerHTML =
      '<div class="dsh-ip-head">' +
        '<span class="dsh-ip-title">图片翻译</span>' +
        '<span class="dsh-ip-stat">准备中…</span>' +
        '<button type="button" class="dsh-ip-btn dsh-ip-restore">还原</button>' +
        '<button type="button" class="dsh-ip-btn dsh-ip-close">×</button>' +
      '</div>' +
      '<div class="dsh-ip-body"></div>';
    document.documentElement.appendChild(p);
    S.panel = p;

    p.querySelector('.dsh-ip-close').addEventListener('click', function (e) {
      e.stopPropagation();
      closePanel();
    });
    p.querySelector('.dsh-ip-restore').addEventListener('click', function (e) {
      e.stopPropagation();
      restoreAll();
    });
    p.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    return p;
  }

  function closePanel() {
    if (S.panel && S.panel.parentNode) S.panel.parentNode.removeChild(S.panel);
    S.panel = null;
  }

  function setPanelStat(text) {
    if (!S.panel) return;
    var el = S.panel.querySelector('.dsh-ip-stat');
    if (el) el.textContent = text;
  }

  /* -------------------------------------------------- 翻译会话起点 */

  /**
   * 每次开始翻译一张新图前，**彻底清干净上一次的痕迹**。
   *
   * ## 用户报的 bug
   *
   * 「切换第二张图片，文字没有清空、重新读取翻译」
   *
   * 也就是翻第二张图时，第一张图的译文还留在页面上。
   *
   * ## 根因
   *
   * 三个翻译入口（translateImage / translatePage / translateLayout）开头都只做了：
   *
   *   `panel.querySelector('.dsh-ip-body').innerHTML = ''`
   *
   * 只清了**面板列表**，但**没清 overlay 图层**（`.dsh-imglayer`）。
   * 于是：
   *   · 第一张图的 overlay 还挂在那张图的父节点上 → 画面上仍显示旧译文
   *   · `S.curLayer` / `S.curImg` 还指向旧图 → 后续清理逻辑会误操作
   *   · 如果用户翻的是**同一张图**（重新翻译），旧 overlay 会和新的叠在一起
   *
   * ## 为什么必须集中成一个函数
   *
   * 三个入口各写一遍容易漏（这次就漏了 overlay）。
   * 而且还要同时做四件事：
   *   ① 中断正在跑的上一次翻译（S.seq++）
   *   ② 清所有 overlay 图层
   *   ③ 重置 S.curLayer / S.curImg / S.lastImg
   *   ④ 清面板 DOM + 重置状态文案
   *
   * @param {string} [firstStat] 面板上先显示的状态文案
   * @returns {number} 新的 seq（调用方要保存，用于中断检测）
   */
  function beginTranslate(firstStat) {
    // ① 中断上一次（正在跑的循环看到 seq 变了会 return）
    S.seq++;

    // ② 清 overlay（可能有多层：上一次的 + 更早泄漏的）
    var all = document.querySelectorAll('.dsh-imglayer');
    for (var i = 0; i < all.length; i++) {
      if (all[i].parentNode) all[i].parentNode.removeChild(all[i]);
    }

    // ③ 重置状态
    S.curLayer = null;
    S.curImg = null;
    S.lastImg = null;

    // ④ 面板
    var panel = ensurePanel();
    var body = panel.querySelector('.dsh-ip-body');
    if (body) body.innerHTML = '';
    setPanelStat(firstStat || '准备中…');

    return S.seq;
  }

  /* ----------------------------------- 图像重绘模式（终极，出图） */

  /**
   * 图像重绘模式：把原图交给 Qwen-Image-Edit，**直接输出一张替换好文字的图**。
   *
   * ## 为什么这是终极方案
   *
   * 所有其他方案都在跟「bbox 不准」较劲（CV 框碎、Surya 漏检、OCR 没坐标）。
   * Image-Edit 模型**不需要 bbox**：它直接看图理解「这段日文在这个气泡里」，
   * 重绘成中文。位置、字体、气泡形状由模型自己保持一致。
   *
   * ## 流程
   *
   *   ① 整页 OCR（vision）→ 原文列表
   *   ② 整页翻译（translate）→ 译文列表（编号对齐）
   *   ③ 配对成 [{src, zh}]
   *   ④ 提交 Qwen-Image-Edit 异步任务
   *   ⑤ 轮询（60~120 秒）
   *   ⑥ 拿到新图 URL → 显示到页面
   *
   * ## 代价
   *
   *   · 60~120 秒/张（云端 20B 模型）
   *   · 魔搭 magicubes 2 个/次
   *   · 输出图会被缩放到 760x1280（分辨率损失）
   */
  async function translateEdit(img, opts) {
    opts = opts || {};
    if (!img || img.tagName !== 'IMG') return { ok: false, error: '不是图片' };

    var panel = ensurePanel();
    var seq = beginTranslate('准备中…');
    var t0 = performance.now();

    /* 跨域图 → 同源副本 */
    var pre = await resolveUsableImage(img);
    if (pre.error) {
      setPanelStat('无法处理：' + pre.error);
      return { ok: false, error: pre.error };
    }

    var prepared = prepareImage(pre.image, opts.maxSide || 1600);
    if (!prepared) { setPanelStat('图片编码失败'); return { ok: false, error: 'encode' }; }

    /* ---- ① + ② OCR + 翻译（拿 src/zh 对） ---- */
    setPanelStat('识别原文…');
    var pairs;
    try {
      pairs = await S.extractPairs(prepared.dataUrl);
    } catch (e) {
      pairs = { ok: false, error: String((e && e.message) || e) };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };
    if (!pairs || !pairs.ok || !pairs.items || !pairs.items.length) {
      setPanelStat('没识别到文字');
      addPanelHint(panel, (pairs && pairs.error) || '这张图没找到可翻译的文字。');
      return { ok: false, error: (pairs && pairs.error) || 'no text' };
    }

    setPanelStat('识别到 ' + pairs.items.length + ' 段 · 提交重绘任务…');

    /* ---- ③ + ④ 提交 Image-Edit ---- */
    var editR;
    try {
      editR = await S.imageEditor(prepared.dataUrl, pairs.items, function (stage, v) {
        if (stage === 'submitted') setPanelStat('重绘任务已提交 · 等待云端…');
        else if (stage === 'running') setPanelStat('云端重绘中 · ' + v + ' 秒');
      });
    } catch (e) {
      editR = { ok: false, error: String((e && e.message) || e) };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };
    if (!editR || !editR.ok) {
      setPanelStat('重绘失败：' + ((editR && editR.error) || '未知'));
      addPanelHint(panel, (editR && editR.error) || '未知错误');
      /* 失败时把识别结果列出来（用户至少能看到译文） */
      var body0 = panel.querySelector('.dsh-ip-body');
      for (var q = 0; q < pairs.items.length; q++) {
        var row0 = document.createElement('div');
        row0.className = 'dsh-ip-row';
        var s0 = document.createElement('div'); s0.className = 'dsh-ip-src'; s0.textContent = pairs.items[q].src;
        var d0 = document.createElement('div'); d0.className = 'dsh-ip-dst'; d0.textContent = pairs.items[q].zh;
        row0.appendChild(s0); row0.appendChild(d0);
        body0.appendChild(row0);
      }
      return { ok: false, error: (editR && editR.error) || 'unknown', items: pairs.items };
    }

    /* ---- ⑤ 显示新图 ---- */
    var totalMs = Math.round(performance.now() - t0);
    setPanelStat('重绘完成 · ' + Math.round(editR.ms / 1000) + ' 秒 · ' + editR.pairCount + ' 段');

    /* 显示结果：在新标签打开 + 面板里给链接 */
    var body = panel.querySelector('.dsh-ip-body');
    var info = document.createElement('div');
    info.className = 'dsh-ip-hint';
    info.textContent = '重绘图已生成（' + editR.pairCount + ' 段替换）。点击下面的链接查看。';
    body.appendChild(info);

    var link = document.createElement('a');
    link.className = 'dsh-ip-restore';
    link.href = editR.imageUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '打开重绘图';
    link.style.display = 'inline-block';
    link.style.padding = '6px 12px';
    link.style.marginTop = '8px';
    link.style.background = '#2b6cb0';
    link.style.color = '#fff';
    link.style.borderRadius = '6px';
    link.style.textDecoration = 'none';
    body.appendChild(link);

    /* 面板里也列原文/译文（方便对照） */
    for (var i2 = 0; i2 < pairs.items.length; i2++) {
      var row = document.createElement('div');
      row.className = 'dsh-ip-row';
      var sEl = document.createElement('div');
      sEl.className = 'dsh-ip-src';
      sEl.textContent = pairs.items[i2].src;
      var dEl = document.createElement('div');
      dEl.className = 'dsh-ip-dst';
      dEl.textContent = pairs.items[i2].zh;
      row.appendChild(sEl);
      row.appendChild(dEl);
      body.appendChild(row);
    }

    return {
      ok: true,
      imageUrl: editR.imageUrl,
      taskId: editR.taskId,
      pairs: pairs.items,
      pairCount: editR.pairCount,
      ms: totalMs,
      editMs: editR.ms
    };
  }
  /* ------------------------------------- 快速模式（OCR 文本 + CV 位置） */

  /**
   * 快速模式：**整页 OCR 拿文本 + CV 拿位置**。
   *
   * ## 为什么这是当前最优
   *
   * 实测三张连续剧情图（真实 nhentai 页）：
   *
   * | 图 | Surya 框 | CV 块 | **OCR 段** | 覆盖率 |
   * |---|---|---|---|---|
   * | ttest1 | 3 | 9 | **7** | 100% |
   * | ttest2 | 5 | 10 | **6** | 100% |
   * | ttest3 | 3 | 7 | **4** | 100% |
   *
   * Surya 漏的原因：它把「插画 + 文字混排区」判成巨大的 Image 块
   * （ttest3 竟然 93.7% 页面都是 Image），里面的文字就被吞了。
   *
   * ## 速度
   *
   * 1628~2550ms（OCR 1100~1730 + 翻译 500~820）
   * 对比 Surya 逐区模式 ~5000ms —— **快 2 倍**。
   *
   * ## 位置准确度
   *
   * 按阅读顺序 + 比例分配。实测基本对得上（各自落在正确区域）。
   * 不追求像素级完美 —— 文本准确率与覆盖率优先。
   */
  async function translateFast(img, opts) {
    opts = opts || {};
    if (!img || img.tagName !== 'IMG') return { ok: false, error: '不是图片' };

    var panel = ensurePanel();
    var seq = beginTranslate('检测文字位置…');
    var t0 = performance.now();

    /* 跨域图 → 同源副本 */
    var pre = await resolveUsableImage(img);
    if (pre.error) {
      setPanelStat('无法处理：' + pre.error);
      addPanelHint(panel, pre.error === 'tainted' ? '这张图跨域，扩展抓不到像素。' : pre.error);
      return { ok: false, error: pre.error };
    }

    /* ---- ① CV 快速定位 ---- */
    var det = await detect(pre.image, { maxSide: opts.maxSide || 1600 });
    if (!det.ok) {
      setPanelStat('检测失败：' + det.error);
      return { ok: false, error: det.error };
    }
    var cvBoxes = det.boxes || [];
    if (!cvBoxes.length) {
      setPanelStat('没检测到文字位置');
      addPanelHint(panel, '这张图没找到成块的文字。');
      return { ok: true, items: [], cvCount: 0 };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };

    /* ---- ② 整页编码送 OCR ---- */
    var prepared = prepareImage(pre.image, opts.maxSide || 1600);
    if (!prepared) { setPanelStat('图片编码失败'); return { ok: false, error: 'encode' }; }

    setPanelStat('识别中（' + cvBoxes.length + ' 个位置）…');

    /* ---- ③ OCR + 翻译 + 配对（后台做） ---- */
    var r;
    try {
      r = await S.fastTranslator(prepared.dataUrl, cvBoxes, det.naturalW, det.naturalH);
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };
    if (!r || !r.ok) {
      setPanelStat('失败：' + ((r && r.error) || '未知'));
      addPanelHint(panel, (r && r.error) || '未知错误');
      return { ok: false, error: (r && r.error) || 'unknown' };
    }

    /* ---- ④ 面板 + overlay ---- */
    var nw = pre.image.naturalWidth || pre.image.width;
    var nh = pre.image.naturalHeight || pre.image.height;

    var body = panel.querySelector('.dsh-ip-body');
    var results = [];
    for (var i = 0; i < r.items.length; i++) {
      var it = r.items[i];
      if (!it.zh) continue;
      results.push({
        box: it.box ? { x: it.box.x / det.naturalW * nw, y: it.box.y / det.naturalH * nh,
                        w: it.box.w / det.naturalW * nw, h: it.box.h / det.naturalH * nh } : null,
        text: it.zh,
        src: it.src
      });
      var row = document.createElement('div');
      row.className = 'dsh-ip-row';
      var sEl = document.createElement('div');
      sEl.className = 'dsh-ip-src';
      sEl.textContent = it.src || '（无原文）';
      var dEl = document.createElement('div');
      dEl.className = 'dsh-ip-dst';
      dEl.textContent = it.zh;
      row.appendChild(sEl);
      row.appendChild(dEl);
      body.appendChild(row);
    }

    // 渲染：有 box 的盖图，没 box 的只在面板
    if (S.curLayer && S.curLayer.parentNode) S.curLayer.parentNode.removeChild(S.curLayer);
    S.curLayer = renderPairedBoxes(img, results, nw, nh);
    S.curImg = img;

    var totalMs = Math.round(performance.now() - t0);
    if (r.missing > 0) {
      setPanelStat('完成 ' + results.length + ' 处（' + r.missing + ' 段没翻到）· OCR ' +
        r.ocrMs + 'ms + 翻译 ' + r.transMs + 'ms');
    } else {
      setPanelStat('完成 ' + results.length + ' 处 · OCR ' + r.ocrMs + 'ms + 翻译 ' + r.transMs + 'ms');
    }

    return {
      ok: true,
      items: results,
      count: results.length,
      cvCount: r.cvCount,
      ocrCount: r.ocrCount,
      ocrMs: r.ocrMs,
      transMs: r.transMs,
      ms: totalMs
    };
  }

  /** 按配对结果画 overlay（每块字号自适应，框不动） */
  function renderPairedBoxes(img, items, nw, nh) {
    var host = img.parentNode;
    if (!host) return null;
    var pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';

    var layer = document.createElement('div');
    layer.className = 'dsh-imglayer';
    layer.setAttribute('data-dsh-ui', '1');

    var dw = img.clientWidth, dh = img.clientHeight;
    layer.style.width = dw + 'px';
    layer.style.height = dh + 'px';
    layer.style.left = (img.offsetLeft - host.clientLeft) + 'px';
    layer.style.top = (img.offsetTop - host.clientTop) + 'px';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.text || !it.box) continue;

      var b = it.box;
      // 算字号（框不动，只缩字号）
      var rb = computeRenderBoxFromRatio(
        { x: b.x / nw, y: b.y / nh, w: b.w / nw, h: b.h / nh },
        nw, nh, it.text
      );

      var d = document.createElement('div');
      d.className = 'dsh-imgcell';
      var PAD = 2;
      d.style.left = ((rb.x / nw * dw) - PAD) + 'px';
      d.style.top = ((rb.y / nh * dh) - PAD) + 'px';
      d.style.width = Math.max(16, rb.w / nw * dw + PAD * 2) + 'px';
      d.style.height = Math.max(14, rb.h / nh * dh + PAD * 2) + 'px';
      d.style.fontSize = Math.max(7, Math.round(rb.fontSize * (dw / nw) * 0.92 * 10) / 10) + 'px';
      d.style.lineHeight = '1.25';
      d.textContent = it.text;
      d.title = it.src || '';
      layer.appendChild(d);
    }
    host.appendChild(layer);
    return layer;
  }

  /* ------------------------------------------ Surya 布局模式（最准） */  /* ------------------------------------------ Surya 布局模式（最准） */

  /**
   * Surya 布局模式：用 650M 的版面检测模型定位，再逐区域 OCR+翻译。
   *
   * ## 为什么这是最准的
   *
   * 之前两个方案的问题：
   *   · 纯 CV（形态学）→ 网点纸上会框错（「何かただならない」和
   *     「予定まで時間」本来是同一段，被拆成两块）
   *   · 整页 OCR → 不给 bbox，只能列表面板
   *
   * Surya-OCR-2 实测（真实漫画页）：
   *   · 1.7 秒给出 11 个 Text 区 + 4 个 Image 区
   *   · **同一段文字自动合成一个框**（CV 做不到）
   *   · 自动区分 Text / Image（插画天然排除）
   *   · 9/9 区域 OCR+翻译全对
   *
   * ## 关键：渲染框按译文长度算
   *
   * 日文竖排 30 字占 28×240，中文横排需要 240×40。
   * 直接塞回原框必然超框 —— 这就是用户截图里「错位+超框」的根因。
   * 所以每块都调用 computeRenderBox 计算「放得下译文」的框。
   */
  async function translateLayout(img, opts) {
    opts = opts || {};
    if (!img || img.tagName !== 'IMG') return { ok: false, error: '不是图片' };

    var panel = ensurePanel();
    /**
     * 清干净上一次的痕迹（overlay + 面板 + 状态），并返回新的 seq。
     * 详见 beginTranslate() 的注释 —— 用户报的「切图不清空」就是漏了 overlay。
     */
    var seq = beginTranslate('版面检测中…');
    var t0 = performance.now();

    /* 跨域图 → 同源副本 */
    var pre = await resolveUsableImage(img);
    if (pre.error) {
      setPanelStat('无法处理：' + pre.error);
      addPanelHint(panel, pre.error === 'tainted' ? '这张图跨域，扩展抓不到像素。' : pre.error);
      return { ok: false, error: pre.error };
    }

    var nw = pre.image.naturalWidth || pre.image.width;
    var nh = pre.image.naturalHeight || pre.image.height;

    /* 整页编码（Surya 要看到全页才能判断布局） */
    var prepared = prepareImage(pre.image, opts.maxSide || 1600);
    if (!prepared) { setPanelStat('图片编码失败'); return { ok: false, error: 'encode' }; }
    var dataUrl = prepared.dataUrl;
    var imgW = prepared.W, imgH = prepared.H;
    if (seq !== S.seq) return { ok: false, error: 'aborted' };

    /* ---- ① 版面检测 ---- */
    var layout;
    try {
      layout = await S.layoutDetector(dataUrl);
    } catch (e) {
      layout = { ok: false, error: String((e && e.message) || e) };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };
    if (!layout || !layout.ok) {
      setPanelStat('版面检测失败：' + ((layout && layout.error) || '未知'));
      addPanelHint(panel, (layout && layout.error) ||
        'DSH 里没有 layout 角色。请确认 SuiXin 已加载 surya-2 模型。');
      return { ok: false, error: (layout && layout.error) || 'layout failed' };
    }

    /**
     * **互补检测**：Surya 漏的地方用 CV 补。
     *
     * ## 为什么需要
     *
     * 实测（真实漫画页 test.png）：
     *   · Surya 只给 **5 个 Text 框**（全在页面上半 y<500）
     *   · 整页 OCR 却读到 **9 段**，下半页的 4 个气泡明明有文字
     *
     * 原因：Surya 把下半页标成了一个巨大的 Image 块
     * `{"label":"Image","bbox":"0 350 700 1000"}` ——
     * 覆盖左下 70% 宽、65% 高，把里面所有文字都吞了。
     *
     * 试过「裁出该 Image 块再做一次 Surya」：无效。
     * 因为裁出来的内容确实大部分是画面，Surya 还是判成 Image。
     *
     * ## 解法：CV 互补
     *
     * 对**大的 Image 块区域**跑一次 CV 形态学检测（82ms，几乎不要钱），
     * 得到里面的文字条，再过滤掉和已有 Surya 框重叠的部分。
     *
     * 判据：
     *   · Image 块面积 > 整页 15%（小块就是真插图，不用管）
     *   · 且不是整页框（0,0,1000,1000）
     */
    var imgBlocks = (layout.imageBlocks || []).filter(function (b) {
      var frac = b.w * b.h;
      if (frac > 0.95) return false;
      if (frac < 0.15) return false;
      return true;
    });

    if (imgBlocks.length && opts.complement !== false) {
      try {
        setPanelStat('CV 补充检测…');
        var det = await detect(img, { maxSide: opts.maxSide || 1600, maxBoxes: 60 });
        if (det && det.ok && det.boxes && det.boxes.length) {
          /**
           * det.boxes 是**原图坐标**（detect 里已缩回），要归一化再和 Surya 比。
           * 只保留「落在某个大 Image 块内」且「不与已有 Surya 框重叠」的。
           */
          var nw0 = det.naturalW || 1, nh0 = det.naturalH || 1;
          for (var cb = 0; cb < det.boxes.length; cb++) {
            var b0 = det.boxes[cb];
            var cand = { x: b0.x / nw0, y: b0.y / nh0, w: b0.w / nw0, h: b0.h / nh0, label: 'Text' };
            // ① 必须在某个大 Image 块内（中心点判定）
            var cx = cand.x + cand.w / 2, cy = cand.y + cand.h / 2;
            var inImg = imgBlocks.some(function (ib) {
              return cx >= ib.x && cx <= ib.x + ib.w && cy >= ib.y && cy <= ib.y + ib.h;
            });
            if (!inImg) continue;
            // ② 不能和已有 Surya 框重叠（中心点 5% 半径内视为重复）
            var dup = layout.boxes.some(function (b) {
              return Math.abs((b.x + b.w / 2) - cx) < 0.05 &&
                     Math.abs((b.y + b.h / 2) - cy) < 0.05;
            });
            if (dup) continue;
            layout.boxes.push(cand);
          }
          layout.boxes.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
          log('CV 补充: 从 ' + det.boxes.length + ' 个 CV 框中补进 ' +
              (layout.boxes.length) + ' 个总框');
        }
      } catch (e) {
        log('CV 补充失败: ' + ((e && e.message) || e));
      }
    }

    setPanelStat('检测到 ' + layout.boxes.length + ' 个文字区 · 逐区翻译中…');

    /* ---- ② 逐区域 OCR + 翻译 ---- */
    var results = [];
    var done = 0;
    for (var i = 0; i < layout.boxes.length; i++) {
      if (seq !== S.seq) return { ok: false, error: 'aborted' };
      var lb = layout.boxes[i];

      /* 裁出这一区域（用 prepared 的 canvas 坐标） */
      var px = Math.max(0, Math.floor(lb.x * imgW) - 4);
      var py = Math.max(0, Math.floor(lb.y * imgH) - 4);
      var pw = Math.min(imgW - px, Math.ceil(lb.w * imgW) + 8);
      var ph = Math.min(imgH - py, Math.ceil(lb.h * imgH) + 8);
      if (pw < 8 || ph < 8) continue;

      var cropUrl = cropFromCanvas(prepared.canvas, px, py, pw, ph);
      if (!cropUrl) continue;

      setPanelStat('翻译中 ' + done + ' / ' + layout.boxes.length);

      try {
        var r = await S.translateBlock(cropUrl, S.cfg.targetLang || '简体中文');
        if (seq !== S.seq) return { ok: false, error: 'aborted' };
        if (!r || !r.text) continue;   // 无文字/描述 → 跳过

        /**
         * **废块过滤**：丢掉没有实际内容的译文。
         *
         * 实测（ttest2/ttest3 真实页面）：CV 在网点纸上误检出的块，
         * OCR 会返回「」「…」「( )」「鲁鲁达达德」这类无意义内容。
         * 盖到图上就是纯噪音，还占位置。
         *
         * 判据：译文去掉标点/空白后，若**不足 2 个实义字符** → 丢弃。
         * 「对！」「好！」这种 2 字短句保留（有实义）。
         */
        var meaningful = String(r.text).replace(/[\s\p{P}\p{S}]/gu, '');
        if (meaningful.length < 2) {
          log('skip junk block: ' + JSON.stringify(r.text));
          continue;
        }

        /**
         * 渲染框：把 Surya 的 bbox 映射回**原图品牌坐标**，再按译文长度扩张。
         *
         * 注意两套坐标系：
         *   · prepared canvas（最长边 ≤1600）→ 用于裁图
         *   · 原图 nw×nh → 用于 overlay 定位
         * 所以这里把归一化 bbox 直接乘原图尺寸。
         */
        var rb = computeRenderBoxFromRatio(lb, nw, nh, r.text);

        results.push({
          box: { x: lb.x * nw, y: lb.y * nh, w: lb.w * nw, h: lb.h * nh },
          renderBox: rb,
          text: r.text,
          src: r.src || '',
          label: lb.label
        });
        done++;
      } catch (e) { /* 单区失败不影响其他 */ }
    }

    if (seq !== S.seq) return { ok: false, error: 'aborted' };

    /* ---- ③ 面板 + overlay ---- */
    var body = panel.querySelector('.dsh-ip-body');
    for (var k = 0; k < results.length; k++) {
      var it = results[k];
      var row = document.createElement('div');
      row.className = 'dsh-ip-row';
      var sEl = document.createElement('div');
      sEl.className = 'dsh-ip-src';
      sEl.textContent = it.src || '（无原文）';
      var dEl = document.createElement('div');
      dEl.className = 'dsh-ip-dst';
      dEl.textContent = it.text;
      row.appendChild(sEl);
      row.appendChild(dEl);
      body.appendChild(row);
    }

    if (S.curLayer && S.curLayer.parentNode) S.curLayer.parentNode.removeChild(S.curLayer);
    S.curLayer = renderOverlayBoxes(img, results, nw, nh);
    S.curImg = img;

    var totalMs = Math.round(performance.now() - t0);
    setPanelStat('完成 ' + results.length + ' 处 · 版面 ' + layout.ms + 'ms + 翻译 ' + totalMs + 'ms');

    return {
      ok: true,
      items: results,
      count: results.length,
      layoutMs: layout.ms,
      ms: totalMs,
      layoutBoxes: layout.boxes.length
    };
  }

  /** 整图编码（不放大，只缩到 maxSide 内），返回 {dataUrl, W, H, canvas} */
  function prepareImage(img, maxSide) {
    var w0 = img.naturalWidth || img.width;
    var h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    var scale = Math.min(1, maxSide / Math.max(w0, h0));
    var W = Math.round(w0 * scale);
    var H = Math.round(h0 * scale);
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    try { g.drawImage(img, 0, 0, W, H); } catch (e) { return null; }
    try { return { dataUrl: c.toDataURL('image/jpeg', 0.92), W: W, H: H, canvas: c }; }
    catch (e) { return null; }
  }

  /** 从 canvas 抠一块 → JPEG dataURL */
  function cropFromCanvas(canvas, x, y, w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    try { return c.toDataURL('image/jpeg', 0.92); } catch (e) { return null; }
  }

  /**
   * 按译文长度算渲染框（输入是归一化 bbox + 原图尺寸）。
   *
   * 算法跟引擎里的 computeRenderBox 一致，这个是浏览器侧的精简版
   * （不依赖引擎导出，便于模块自包含）。
   */
  /**
   * 算渲染框（放得下中文译文的区域）。
   *
   * ## 核心原则：**不扩框，缩字号**
   *
   * 之前写错的版本有两个严重问题（用户截图实测）：
   *
   *   bug 1：字号爆炸
   *     `font = h0 * 0.7`，而 h0 是多列文字的**整块高度**（300px+）
   *     → 算出 215px 的字，比气泡还大，盖住半屏
   *
   *   bug 2：框无限扩张
   *     「扩到装下译文为止」→ 框越来越大 → 盖住插画 → 互相重叠
   *     （截图里「还有备用食」压在人脸上）
   *
   * ## 正确做法
   *
   * **渲染框 = 原文框**（白底正好盖住日文，不碰画面）。
   * 然后**从大往小试字号**，找到第一个装得下的。
   *
   * 实例（原框 147×307，译文 30 个汉字）：
   * ```
   * font=40 → 每行3字 → 10行 → 10×40×1.25 = 500 > 307  ✗
   * font=30 → 每行4字 →  8行 →  8×30×1.25 = 300 ≤ 307  ✓ 选这个
   * font=20 → 每行7字 →  5行 →  5×20×1.25 = 125 ≤ 307  ✓（但太小）
   * ```
   *
   * 所以框不动、只调字号，画面完美贴合。
   *
   * ## 唯一例外：允许**小幅**扩张
   *
   * 如果字号已经缩到下限（10px）还是放不下，才按 15% 扩一点宽度，
   * 最多扩 2 轮（最大 1.32 倍）。绝不无限扩。
   */
  function computeRenderBoxFromRatio(lb, nw, nh, zhText) {
    var x0 = lb.x * nw, y0 = lb.y * nh;
    var w0 = lb.w * nw, h0 = lb.h * nh;
    var text = String(zhText || '').replace(/\n/g, '');

    /**
     * 中文字符按 1em，其他按 0.55em。
     * 必须把全角标点（！？、。）算 1em，否则会低估 → 字号偏大 → 溢出。
     */
    var emW = 0;
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      var full = (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xFF00 && cp <= 0xFF60) ||
                 (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xFE30 && cp <= 0xFE6F);
      emW += full ? 1 : 0.55;
    }
    if (emW < 1) emW = 1;

    var LINE_H = 1.25;
    var MIN_FONT = 10;

    /** 给定框尺寸，装得下吗 */
    function fits(font, boxW, boxH) {
      var perLine = Math.max(1, Math.floor(boxW / font));
      var lines = Math.ceil(emW / perLine);
      return lines * font * LINE_H <= boxH;
    }

    /** 从大往小找第一个装得下的字号 */
    function pickFont(boxW, boxH) {
      var hi = Math.floor(boxH / LINE_H);   // 单行放一个字的极限
      if (hi < MIN_FONT) hi = MIN_FONT;
      for (var f = hi; f >= MIN_FONT; f--) {
        if (fits(f, boxW, boxH)) return f;
      }
      return MIN_FONT;
    }

    /* ---- 第一轮：原框 + 缩字号 ---- */
    var font = pickFont(w0, h0);
    if (fits(font, w0, h0)) {
      return {
        x: x0, y: y0, w: w0, h: h0,
        fontSize: font, isVertical: false, expanded: 0
      };
    }

    /* ---- 第二轮：字号到下限仍放不下 → 小幅扩宽（最多 2 轮，每轮 +15%）---- */
    var cx = x0, cy = y0, cw = w0, ch = h0;
    for (var g = 0; g < 2; g++) {
      var addW = Math.round(cw * 0.15);
      cx = Math.max(0, cx - Math.round(addW / 2));
      cw = Math.min(nw - cx, cw + addW);
      font = pickFont(cw, ch);
      if (fits(font, cw, ch)) {
        return {
          x: cx, y: cy, w: cw, h: ch,
          fontSize: font, isVertical: false, expanded: g + 1
        };
      }
    }

    /* 兜底：用原框 + 最小字号（宁可小到看不清，也不盖画面） */
    return {
      x: x0, y: y0, w: w0, h: h0,
      fontSize: MIN_FONT, isVertical: false, expanded: 0
    };
  }

  /** 按 renderBox 画 overlay（比 renderOverlay 更精确，因为框是算出来的） */
  function renderOverlayBoxes(img, items, nw, nh) {
    var host = img.parentNode;
    if (!host) return null;
    var pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';

    var layer = document.createElement('div');
    layer.className = 'dsh-imglayer';
    layer.setAttribute('data-dsh-ui', '1');

    var dw = img.clientWidth, dh = img.clientHeight;
    layer.style.width = dw + 'px';
    layer.style.height = dh + 'px';
    layer.style.left = (img.offsetLeft - host.clientLeft) + 'px';
    layer.style.top = (img.offsetTop - host.clientTop) + 'px';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.text) continue;
      var rb = it.renderBox;
      var d = document.createElement('div');
      d.className = 'dsh-imgcell';

      /**
       * 位置和尺寸都按「原图坐标 → 显示坐标」换算。
       *
       * PAD 往外扩 2px，盖住原文的抗锯齿灰边。
       */
      var PAD = 2;
      var cellX = (rb.x / nw * dw) - PAD;
      var cellY = (rb.y / nh * dh) - PAD;
      var cellW = Math.max(16, rb.w / nw * dw + PAD * 2);
      var cellH = Math.max(14, rb.h / nh * dh + PAD * 2);

      d.style.left = cellX + 'px';
      d.style.top = cellY + 'px';
      d.style.width = cellW + 'px';

      /**
       * **显式设高度**，不用 minHeight。
       *
       * 用 minHeight 的话，浏览器实际渲染的换行可能比我们估算的多一行
       * （字体度量差异），div 就会长高，撑出气泡边缘盖到画面上。
       *
       * 设死高度 + overflow:hidden（CSS 里已有）→ 永远不越界。
       *
       * 字号再留 8% 余量：估算用「汉字 1em / 其他 0.55em」是近似值，
       * 实际中文字体宽度可能略大于 1em。
       */
      d.style.height = cellH + 'px';

      var fontPx = rb.fontSize * (dw / nw) * 0.92;
      d.style.fontSize = Math.max(7, Math.round(fontPx * 10) / 10) + 'px';
      d.style.lineHeight = '1.25';

      d.textContent = it.text;
      d.title = it.src || '';
      layer.appendChild(d);
    }
    host.appendChild(layer);
    return layer;
  }

  /* --------------------------------------------------- 整页模式（一步式） */  /* --------------------------------------------------- 整页模式（一步式） */

  /**
   * 整页翻译：**不定位，不盖图**，只把整页文字读出来 + 翻译，列在面板里。
   *
   * ## 为什么需要这个模式
   *
   * 主流程（translateImage）是「CV 定位 → 逐块 OCR + 翻译 → 原位盖译文」。
   * 优点是能原位替换，缺点是**纯 CV 会漏检**：
   * 网点纸背景上的文字，二值化后和网点粘连 → 连通域巨大 → 被面积阈值杀掉。
   *
   * 实测真实漫画页（1280×1810，7 个气泡）：
   *   · CV 定位：只找到 4 个（漏了 3 个网点背景上的）
   *   · 整页 OCR：**8/8 全读到**（模型看图能力比 CV 强）
   *
   * 所以给用户一个「整页模式」：牺牲原位替换，换取 100% 覆盖率。
   *
   * ## 速度
   *
   * 实测：OCR 1300ms + 翻译 750ms = **约 2000ms**（一次 2 个请求）
   * 对比逐块模式：检测 44ms + 11 块 × ~170ms = 1873ms（差不太多）
   *
   * ## 稳定性
   *
   * 关键是提示词必须锁死「一个气泡 = 一行」：
   *   · 模糊的说法（"按阅读顺序逐段"）→ 同一张图两次分别 11 段/19 段
   *   · 明确「一个气泡一行」→ 三次**完全一致**
   */
  async function translatePage(img, opts) {
    opts = opts || {};
    if (!img || img.tagName !== 'IMG') return { ok: false, error: '不是图片' };

    var panel = ensurePanel();
    var seq = beginTranslate('识别整页文字…');
    var t0 = performance.now();

    /* 跨域图：先抓一份同源副本 */
    var pre = await resolveUsableImage(img);
    if (pre.error) {
      setPanelStat('无法处理：' + pre.error);
      addPanelHint(panel, pre.error === 'tainted'
        ? '这张图跨域，扩展抓不到像素。试试右键「复制图片地址」在新标签打开后再翻。'
        : pre.error);
      return { ok: false, error: pre.error };
    }

    /* 整页编码成 dataURL（不缩图，模型要看全） */
    var dataUrl = wholeImageDataUrl(pre.image, opts.maxSide || 1600);
    if (!dataUrl) {
      setPanelStat('图片编码失败');
      return { ok: false, error: 'encode' };
    }

    /* 两次模型调用都在 background 里做（content script 只管 UI） */
    var r;
    try {
      r = await S.pageTranslator(dataUrl, S.cfg.targetLang || '简体中文');
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    }
    if (seq !== S.seq) return { ok: false, error: 'aborted' };
    if (!r || !r.ok) {
      setPanelStat('失败：' + ((r && r.error) || '未知'));
      addPanelHint(panel, (r && r.error) || '未知错误');
      return { ok: false, error: (r && r.error) || 'unknown' };
    }

    /* 面板列表 */
    var body = panel.querySelector('.dsh-ip-body');
    for (var i = 0; i < r.segments.length; i++) {
      var seg = r.segments[i];
      var row = document.createElement('div');
      row.className = 'dsh-ip-row';
      var sEl = document.createElement('div');
      sEl.className = 'dsh-ip-src';
      sEl.textContent = seg.src || '（无原文）';
      var dEl = document.createElement('div');
      dEl.className = 'dsh-ip-dst';
      dEl.textContent = seg.zh || '（没翻到）';
      if (!seg.zh) dEl.classList.add('dsh-ip-dst-empty');
      row.appendChild(sEl);
      row.appendChild(dEl);
      body.appendChild(row);
    }

    var totalMs = Math.round(performance.now() - t0);
    setPanelStat('整页 ' + r.segments.length + ' 段 · 识别 ' + r.ocrMs + 'ms + 翻译 ' + r.transMs + 'ms');

    return {
      ok: true,
      segments: r.segments,
      count: r.segments.length,
      ocrMs: r.ocrMs,
      transMs: r.transMs,
      ms: totalMs
    };
  }

  /**
   * 把整张图编码成 dataURL。
   *
   * 跟 cropBox 不同：这里**不放大**（整页已经够大），
   * 但会缩到 maxSide 以内（模型 ctx 上限约 4096 token，
   * 1280×1810 的图大约 2000 token，1600 是安全上限）。
   */
  function wholeImageDataUrl(img, maxSide) {
    var w0 = img.naturalWidth || img.width;
    var h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return null;
    var scale = Math.min(1, maxSide / Math.max(w0, h0));
    var W = Math.round(w0 * scale);
    var H = Math.round(h0 * scale);
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    try { g.drawImage(img, 0, 0, W, H); } catch (e) { return null; }
    try { return c.toDataURL('image/jpeg', 0.92); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ 主流程 */

  /**
   * 翻译一张图。
   * @param {HTMLImageElement} img
   * @param {object} [opts] { mode: 'overlay'|'panel', maxBoxes }
   */
  async function translateImage(img, opts) {
    opts = opts || {};
    var mode = opts.mode || 'overlay';
    if (!img || img.tagName !== 'IMG') return { ok: false, error: '不是图片' };

    var panel = ensurePanel();
    var seq = beginTranslate('检测文字区域…');

    // ---- ① 检测（async：跨域图要先抓一份同源副本）----
    var det;
    try {
      det = await detect(img, opts);
    } catch (e) {
      det = { ok: false, error: String((e && e.message) || e) };
    }
    if (!det.ok) {
      setPanelStat('无法处理：' + det.error);
      /**
       * 错误提示要能指导用户下一步怎么做。
       *
       * `tainted` 是最常见的情况（nhentai / pixiv / DLsite 的图都在独立域名上），
       * 如果 background 也抓不到（防盗链），只能靠用户自己在新标签打开图。
       */
      if (det.error === 'tainted') {
        addPanelHint(panel, '这张图跨域，扩展抓不到像素。试试：右键图片 →「复制图片地址」→ 在新标签打开 → 在那里按 Alt+点击。');
      } else if (det.hint) {
        addPanelHint(panel, det.hint);
      } else {
        addPanelHint(panel, det.error);
      }
      return det;
    }
    var boxes = det.boxes;
    var maxBoxes = opts.maxBoxes || 40;
    if (boxes.length > maxBoxes) boxes = boxes.slice(0, maxBoxes);

    if (!boxes.length) {
      setPanelStat('没检测到文字');
      addPanelHint(panel, '这张图里没有找到成块的文字（纯图、照片、或文字太少）。');
      return { ok: true, boxes: [], results: [], detectMs: det.ms };
    }

    setPanelStat('检测到 ' + boxes.length + ' 处文字 · 用时 ' + det.ms + 'ms');
    log('detect', det.ms + 'ms', 'boxes', boxes.length, det.timings);

    // ---- ② 逐块裁剪 + 翻译 ----
    var body = panel.querySelector('.dsh-ip-body');
    // seq 已在开头由 beginTranslate() 取得，这里不能再 ++（会自己把自己中断）
    var results = new Array(boxes.length);
    var done = 0;
    var t0 = performance.now();

    for (var i = 0; i < boxes.length; i++) {
      if (seq !== S.seq) return { ok: false, error: 'aborted' };
      var dataUrl = cropBox(det.canvas, boxes[i], det.naturalW, det.naturalH, 8);
      if (!dataUrl) { results[i] = { text: '' }; continue; }

      setPanelStat('翻译中 ' + done + ' / ' + boxes.length);

      var row = document.createElement('div');
      row.className = 'dsh-ip-row dsh-ip-row-pending';
      var src = document.createElement('div');
      src.className = 'dsh-ip-src';
      src.textContent = '……';
      var dst = document.createElement('div');
      dst.className = 'dsh-ip-dst';
      dst.textContent = '翻译中…';
      row.appendChild(src);
      row.appendChild(dst);
      body.appendChild(row);

      try {
        var r = await S.translateBlock(dataUrl, S.cfg.targetLang || '简体中文');
        if (seq !== S.seq) return { ok: false, error: 'aborted' };

        /**
         * 模型返回空 / 被判定为「图像描述」→ **这块不盖**。
         *
         * 实测场景（用户真实漫画页）：检测把插画块误判成文字块，
         * 模型看图说话返回「画面中：山崎说到…」。这类内容盖到图上是纯污染。
         *
         * 处理：results[i] 记为「跳过」，overlay 渲染时跳过它，
         *        原图保持不动（用户至少还能看到原文/原画）。
         */
        /**
         * 没有译文 → 这块**不盖**，而且**不在面板里列出来**。
         *
         * 实测（真实漫画页）：11 个检测块里 7 个是网点纸/插画边缘，
         * OCR 阶段返回「（无文字）」—— 这是**正确**的判断。
         *
         * 但把它们列进面板就是噪音：用户看到 7 条「（这块被跳过）」
         * 会以为翻译失败了，实际上只有 4 块是真文字，全翻对了。
         *
         * 所以：跳过 = 静默忽略（面板不显示），overlay 不盖。
         * 面板只列**真正翻译出来的**块。
         */
        if (!r || !r.text) {
          results[i] = { text: '', skipped: true, raw: (r && r.raw) || '' };
          // 把这个占位行从 DOM 移除（之前已经 append 了）
          if (row.parentNode) row.parentNode.removeChild(row);
          done++;
          continue;
        }

        results[i] = r;
        src.textContent = r.src || '（模型只给译文）';
        dst.textContent = r.text;
        row.classList.remove('dsh-ip-row-pending');
      } catch (e) {
        results[i] = { text: '', error: String((e && e.message) || e) };
        dst.textContent = '失败：' + results[i].error;
        row.classList.remove('dsh-ip-row-pending');
        row.classList.add('dsh-ip-row-err');
      }
      done++;
      // 一边翻一边画 overlay，用户不用等全部完成
      if (mode === 'overlay') {
        var partial = results.map(function (x) { return x || { text: '' }; });
        if (S.curLayer && S.curLayer.parentNode) S.curLayer.parentNode.removeChild(S.curLayer);
        S.curLayer = renderOverlay(img, boxes, partial);
      }
    }

    var totalMs = Math.round(performance.now() - t0);
    var goodCount = results.filter(function (x) { return x && x.text; }).length;
    var skipCount = boxes.length - goodCount;
    setPanelStat('完成 ' + goodCount + ' 处' +
      (skipCount ? '（另有 ' + skipCount + ' 处是画面纹理，已忽略）' : '') +
      ' · 检测 ' + det.ms + 'ms + 翻译 ' + totalMs + 'ms');

    // ---- ③ 最终渲染 ----
    if (mode === 'overlay') {
      if (S.curLayer && S.curLayer.parentNode) S.curLayer.parentNode.removeChild(S.curLayer);
      S.curLayer = renderOverlay(img, boxes, results);
      S.curImg = img;
    }
    return { ok: true, boxes: boxes, results: results, detectMs: det.ms, translateMs: totalMs };
  }

  function addPanelHint(panel, text) {
    var body = panel.querySelector('.dsh-ip-body');
    if (!body) return;
    var h = document.createElement('div');
    h.className = 'dsh-ip-hint';
    h.textContent = text;
    body.appendChild(h);
  }

  /** 还原所有 overlay + 清空面板 */
  function restoreAll() {
    S.seq++;                     // 中断正在跑的翻译
    clearOverlays();
    var body = S.panel ? S.panel.querySelector('.dsh-ip-body') : null;
    if (body) body.innerHTML = '';
    setPanelStat('已还原');
    S.curLayer = null;
    S.curImg = null;
  }

  /* ------------------------------------------ 图片翻译自动模式 */

  /**
   * 自动翻译模式：图片一变化就自动翻译，无需手动点击。
   *
   * ## 用户诉求
   *
   * 「无法做到无论是鼠标还是方向键切换图片自动翻译？」
   *
   * 漫画站的翻页方式千奇百怪：
   *   · 点「下一页」按钮 / 点图左半屏（鼠标）
   *   · 按方向键 ← → / PageUp / PageDown / 空格
   *   · 滚轮翻页
   *   · 无限滚动自动加载
   *
   * 但**殊途同归**：最终都是页面里那张主图换了内容。
   * 所以不需要去监听每种操作，只要监听「主图内容变化」就够了。
   *
   * ## 怎么判断「主图」
   *
   * 用户点过翻译的那张图 = 主图（S.lastImg）。
   * 自动模式下：
   *   · 有 lastImg → 只盯它（翻页时它换 src）
   *   · 没 lastImg → 自动找页面里最大的那张图
   *
   * ## 触发时机
   *
   * 图片 load 完成后**等 320ms** 再翻（防抖）：
   *   · 有些站点换 src → load → 又换一次 src（重定向 CDN），
   *     立刻翻会翻到废弃的中间图
   *   · 320ms 是实测够用的最小值
   *
   * ## 为什么默认关闭
   *
   * 自动翻译一张图要 ~3.5 秒（版面模式）。用户随手滚一下页面
   * 就可能触发翻译，白白烧算力。所以必须用户显式开启。
   */
  var AUTO_DELAY = 320;
  var autoTimer = null;

  /** 找页面里「最大的那张图」作为默认目标 */
  function findMainImage() {
    var best = null, bestArea = 0;
    var all = document.querySelectorAll('img');
    for (var i = 0; i < all.length; i++) {
      var im = all[i];
      var w = im.naturalWidth || im.width;
      var h = im.naturalHeight || im.height;
      if (w < 200 || h < 200) continue;       // 小图（图标/头像）跳过
      if (!im.parentNode) continue;
      var area = w * h;
      if (area > bestArea) { bestArea = area; best = im; }
    }
    return best;
  }

  /**
   * 图片变化后，检查是否需要自动翻译。
   * 由 clearForImage 在清完场之后调用。
   */
  function maybeAutoTranslate(img) {
    /**
     * 开关判据必须和 setAutoTranslate 用同一个字段。
     *
     * 踩过的坑：之前这里读 `S.cfg.imageAutoTranslate`，
     * 而 setAutoTranslate 设的是 `S.autoImgEnabled` ——
     * **两套字段永不相等**，于是自动翻译一次都没触发过。
     * 现在统一用 S.autoImgEnabled（setAutoTranslate 唯一写的那个）。
     */
    if (S.autoImgEnabled !== true) return;
    if (S.enabled === false) return;

    /**
     * 只翻「主图」。
     *
     * 页面里可能有几十张缩略图，全翻会卡死。
     * 判据：面积是最大图的 60% 以上（或者就是上次翻过那张）。
     */
    if (S.lastImg && img !== S.lastImg) {
      // 上次翻过别的图 → 只认那张
      return;
    }
    if (!S.lastImg) {
      var main = findMainImage();
      if (!main || main !== img) return;
    }

    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    autoTimer = setTimeout(function () {
      autoTimer = null;
      // 再确认一次：图还在页面上、尺寸够大
      if (!img.parentNode) return;
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (w < 200 || h < 200) return;
      if (S.busy) {
        // 上一张还在翻 → 排队重试（最多重试 30 次 = 9 秒）
        S.busyRetry = (S.busyRetry || 0) + 1;
        if (S.busyRetry < 30) { maybeAutoTranslate(img); }
        return;
      }
      S.busyRetry = 0;
      S.busy = true;
      log('auto translate triggered');
      translateLayout(img).finally(function () { S.busy = false; });
    }, AUTO_DELAY);
  }

  /** 手动切换自动模式的开关 */
  function setAutoTranslate(on) {
    S.autoImgEnabled = !!on;
    // 同步到 S.cfg（有些诊断/日志会读它）
    if (S.cfg) S.cfg.imageAutoTranslate = !!on;
    if (on) {
      // 开启时，如果当前就有主图，立刻翻一次
      var main = S.lastImg || findMainImage();
      if (main) maybeAutoTranslate(main);
    } else {
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    }
  }

  /* --------------------------------------------- 图片变化自动清理 */  /* --------------------------------------------- 图片变化自动清理 */

  /**
   * 监听页面里所有图片的「内容变化」，变了就清掉它的 overlay。
   *
   * ## 解决什么
   *
   * 用户报：**切换第二张图片，文字没有清空**。
   *
   * 漫画站翻页时，通常是**同一个 `<img>` 元素换 `src`**（或换 `srcset`），
   * 或者 `.src` 不变但内容因为流式加载而变。此时：
   *
   *   · 我们的 overlay 是挂在 **img 的父节点** 上的独立 div 层
   *   · img 的 src 变了，但 overlay **不会自己消失** → 画面上还显示第一页的译文
   *   · 用户看到「第二页的图上盖着第一页的翻译」，非常困惑
   *
   * 之前 `beginTranslate()` 只在**再次点翻译时**才清，
   * 但用户翻页后并不会立刻再点一次 → 旧译文一直挂着。
   *
   * ## 怎么监听
   *
   * 三个信号都要接：
   *
   *   ① `load` 事件（捕获阶段）—— img 换了 src 且加载完成
   *      最可靠，因为图片解码完成才会派发
   *   ② `MutationObserver` 监听 `src` / `srcset` 属性变化
   *      覆盖「换了地址但还没加载完」的空窗期
   *   ③ `error` 事件 —— 加载失败也要清（否则旧译文永远挂着）
   *
   * 清理粒度：**只清「这张图身上的」overlay**，不清别的图的
   * （同页面可能有多张图各自翻译过）。
   *
   * ## 怎么知道哪层 overlay 属于哪张图
   *
   * overlay 是 host 的子节点。所以：
   *   `img.parentNode.querySelector('.dsh-imglayer')` → 这张图的层
   * 多张图在同一个 host 下时（少见），全部清掉是安全的选择。
   */
  function bindImageChangeCleanup() {
    if (S.imgWatchBound) return;
    S.imgWatchBound = true;

    /**
     * 清掉某张图相关的一切痕迹：overlay + 面板列表 + 中断正在跑的翻译。
     *
     * ## 为什么要连面板一起清
     *
     * 只清 overlay 的话，画面上干净了，但右上角面板里还列着
     * 第一张图的 8 条译文 —— 用户会以为「没清空」。
     */
    function clearForImage(img) {
      try {
        var host = img && img.parentNode;

        /* ---- 1. 清这张图所在容器里的 overlay ---- */
        if (host) {
          var layers = host.querySelectorAll ? host.querySelectorAll('.dsh-imglayer') : [];
          for (var i = 0; i < layers.length; i++) {
            if (layers[i].parentNode) layers[i].parentNode.removeChild(layers[i]);
          }
        }
        /**
         * 兜底：如果被清的正是我们追踪的那张图，把**所有** overlay 都清掉。
         * （有些站点会把 img 挪来挪去，parentNode 可能变）
         */
        if (S.curImg === img) {
          var allLayers = document.querySelectorAll('.dsh-imglayer');
          for (var k = 0; k < allLayers.length; k++) {
            if (allLayers[k].parentNode) allLayers[k].parentNode.removeChild(allLayers[k]);
          }
          S.curImg = null;
          S.curLayer = null;

          /* ---- 2. 中断正在跑的翻译（后台循环看到 seq 变了会 return）---- */
          S.seq++;

          /* ---- 3. 清面板列表 + 状态 ---- */
          if (S.panel) {
            var body = S.panel.querySelector('.dsh-ip-body');
            if (body) body.innerHTML = '';
            setPanelStat('图片已切换，请重新翻译');
          }
        }

        log('image changed → cleared overlay + panel');

        /**
         * 清完之后，如果开了「自动翻译」，就在这里触发。
         * 这是「翻页自动翻译」的唯一接入点 —— 监听图片变化已经覆盖了
         * 鼠标点、方向键、滚轮、无限滚动等所有翻页方式。
         */
        if (img && img.tagName === 'IMG') {
          try { maybeAutoTranslate(img); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }

    /* ① load（捕获）：img 换 src 且加载完成 */
    document.addEventListener('load', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'IMG') return;
      clearForImage(t);
    }, true);

    /* ③ error：加载失败也要清 */
    document.addEventListener('error', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'IMG') return;
      clearForImage(t);
    }, true);

    /* ② MutationObserver：监听 src / srcset 属性变化 */
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type !== 'attributes') continue;
          var name = m.attributeName;
          if (name !== 'src' && name !== 'srcset') continue;
          var t = m.target;
          if (!t || t.tagName !== 'IMG') continue;
          clearForImage(t);
        }
      });
      mo.observe(document.documentElement || document, {
        attributes: true,
        attributeFilter: ['src', 'srcset'],
        subtree: true
      });
      S.imgObserver = mo;
    } catch (e) { /* 老浏览器忽略 */ }
  }

  /* --------------------------------------------------------- 事件绑定 */  /* --------------------------------------------------------- 事件绑定 */

  /**
   * 用「Alt + 点图」触发，而不是单击。
   *
   * 为什么不用单击：页面上大量图片是可点的（商品图、头像、缩略图），
   * 单击拦截会直接破坏导航。Alt+点 是用户主动意图，不会误触。
   * 另外提供右键菜单 / 快捷键入口。
   */
  /**
   * Alt + 点击图片的入口。
   *
   * ## 为什么监听 mousedown 而不是 click
   *
   * 踩过的坑：用户反馈「Alt+点击无效」。
   *
   * 原因：**带修饰键的 click 事件在某些情况下不会触发**。
   * 具体是：按住 Alt 点击时，如果页面在 mousedown 里做了 preventDefault
   * （很多图床/漫画站会这么做，防止拖拽保存图片），浏览器就**不再派发 click**。
   *
   * 而 mousedown 一定会派发（它是点击序列的第一环，拦不住）。
   * 所以改监听 mousedown —— 这是唯一可靠的「点击意图」捕捉点。
   *
   * 代价：mousedown 比 click 早 100~200ms 触发（用户还没松手）。
   * 对图片翻译来说这是好事 —— 松手前就开始检测了，感知更快。
   */
  function onDocMouseDown(e) {
    /**
     * 诊断计数器：**每次 mousedown 都先打点**，再走过滤。
     *
     * 为什么要这样：之前只在「全部通过后」才设 lastTrigger，
     * 于是诊断里显示「从未」时，分不清是
     *   (a) 事件根本没到扩展，还是
     *   (b) 到了但被某道过滤 return 掉了。
     *
     * 现在每个 early-return 都记一条 S.altSeen / S.lastSkip 原因，
     * 用户敲 __DSH_IMG_DIAG() 就能看到到底卡在哪一步。
     */
    if (e.altKey) S.altClicks = (S.altClicks || 0) + 1;
    S.lastMouseDown = { alt: !!e.altKey, button: e.button, t: Date.now(), target: (e.target && e.target.tagName) || '?' };

    if (e.button !== 0) { S.lastSkip = '不是左键（button=' + e.button + '）'; return; }
    if (!S.enabled) { S.lastSkip = '开关关着'; return; }
    if (!e.altKey) { S.lastSkip = '没按 Alt（altKey=false）'; return; }

    /**
     * **Alt + Shift + 点击 = 整页模式**（不定位，列表展示）。
     *   适合：网点纸多、CV 漏检严重的页面。
     * **Alt + 点击 = 逐块模式**（原位盖译文）。
     *   适合：清爽背景的页面。
     *
     * 为什么用一个修饰键切换而不是设置项：用户看情况临时切，
     * 不该为这个去开设置页。
     */
    /**
     * 三种模式（用修饰键切换，不用开设置页）：
     *   Alt + 点击          → CV 逐块（最快，原位盖）
     *   Alt + Shift + 点击  → 整页 OCR（覆盖率高，列表）
     *   Alt + Ctrl + 点击   → **版面检测（最准，逐区域原位盖）**
     */
    var wantPage = e.shiftKey;
    var wantLayout = e.ctrlKey && e.shiftKey;

    /**
     * **找真正的那张图**。
     *
     * 踩过的坑（nhentai 实测）：Alt+点击完全没反应，诊断显示
     * `lastTrigger = 0`（handler 根本没执行到）。原因是
     * `e.target.tagName !== 'IMG'`。
     *
     * 漫画阅读器/图床常见三种「点不到 IMG」的情况：
     *
     *   ① 图上盖了一层透明 div —— 做「点左半屏翻上一页 / 右半屏下一页」、
     *      拖拽平移、双击缩放。nhentai 的阅读器就是这种。
     *   ② 图包在 `<a href="图片地址或下一页">` 里，点到的是 `<a>`
     *      （padding / border 区域会命中 a 而不是 img）。
     *   ③ 点在 `<img>` 的父容器上（图的 display 是 inline，周围留白属于父元素）。
     *
     * 所以不能只看 e.target，要：
     *   1. target 本身是 IMG → 直接用
     *   2. target 的祖先里有 IMG → 用那个
     *   3. target 是覆盖层（没有 IMG 祖先）→ 用**坐标命中的图**
     *      （document.elementsFromPoint 拿该点所有元素，找第一个 IMG）
     *   4. 同一个 <a> 或图容器里的兄弟 IMG
     */
    var t = e.target;
    var img = resolveTargetImage(t, e.clientX, e.clientY);
    if (!img) {
      S.lastSkip = '找不到图（点是 ' + t.tagName + '，坐标命中也没 IMG）';
      return;
    }

    var why = '';
    if (!isTranslatableImg(img)) {
      why = '图太小（' + (img.naturalWidth || img.width) + '×' + (img.naturalHeight || img.height) + '，需要 ≥120×80）';
      S.lastSkip = why;
      toast('这张图不翻译：' + why);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (S.busy) { toast('上一张还在翻…'); return; }
    S.busy = true;
    S.lastTrigger = Date.now();
    S.lastSkip = '';
    S.lastImg = img;
    /**
     * 四种模式（**默认 layout** —— Surya+CV 互补，位置准）：
     *   Alt + 点击              → **layout（Surya + CV 互补，位置准，~4s）**
     *   Alt + Shift + 点击      → page（整页 OCR，列表展示，~2s）
     *   Alt + Ctrl + 点击       → CV 逐块（最快 82ms，但可能框碎）
     *   Alt + Ctrl + Shift + 点 → fast（OCR 文本 + CV 位置，文本全但位置可能错）
     */
    var wantAll = e.ctrlKey && e.shiftKey;
    var job;
    if (wantPage && e.ctrlKey) job = translateFast(img);            // Ctrl+Shift → fast
    else if (wantPage) job = translatePage(img);                    // Shift → page
    else if (e.ctrlKey) job = translateImage(img, { mode: S.cfg.imgMode || 'overlay' });  // Ctrl → CV
    else job = translateLayout(img);                                // 默认 → Surya+CV
    job.finally(function () { S.busy = false; });
  }

  /**
   * 从点击目标反查出「用户其实想翻哪张图」。
   *
   * 这是「Alt+点击无效」的核心修复。四种情况：
   *
   *   ① target 是 IMG         → 它就是
   *   ② target 有 IMG 祖先     → 用最近的 IMG 祖先（点在图的内边距 / 边框上）
   *   ③ target 是覆盖层        → 用坐标命中：elementsFromPoint 里找第一个 IMG
   *   ④ 都没有                → 找 target 所在容器里的第一个够大的 IMG
   *
   * 每个分支都要过尺寸检查（小图标不翻），所以最后统一在调用方检查。
   */
  function resolveTargetImage(target, cx, cy) {
    if (!target) return null;

    // ① target 本身
    if (target.tagName === 'IMG') return target;

    // ② 祖先里的 IMG
    try {
      var up = target.closest && target.closest('img');
      if (up) return up;
    } catch (e) { /* ignore */ }

    /**
     * ③ 坐标命中：点上所有元素里找 IMG。
     *
     * 为什么要这一步：漫画阅读器会在图上盖一层 `position:absolute; inset:0`
     * 的透明 div（点它来翻页）。此时 e.target 是那层 div，
     * 但用户视觉上「点的是图」。
     *
     * elementsFromPoint 能拿到该点的**全部**层叠元素（包括被盖住的图），
     * 按 z-order 从上到下。取第一个够大的 IMG 就对了。
     */
    if (typeof document.elementsFromPoint === 'function' && cx != null && cy != null) {
      try {
        var stack = document.elementsFromPoint(cx, cy) || [];
        for (var i = 0; i < stack.length; i++) {
          if (stack[i] && stack[i].tagName === 'IMG') return stack[i];
        }
        // 没有裸 IMG：看看这些元素里有没有「背景图」容器
        // （部分阅读器用 background-image 显示漫画页）
        for (var j = 0; j < stack.length; j++) {
          var el = stack[j];
          if (!el || el.nodeType !== 1) continue;
          try {
            var cs = getComputedStyle(el);
            if (cs.backgroundImage && cs.backgroundImage.indexOf('url(') >= 0) {
              // 有背景图的容器：用它的尺寸和一个伪 IMG 对象表达
              // （translateImage 只用到 naturalWidth/naturalHeight/clientWidth 等）
              if (el.clientWidth >= 120 && el.clientHeight >= 80) {
                return {
                  tagName: 'IMG',
                  isBackground: true,
                  element: el,
                  naturalWidth: Math.round(el.clientWidth * (window.devicePixelRatio || 1)),
                  naturalHeight: Math.round(el.clientHeight * (window.devicePixelRatio || 1)),
                  width: el.clientWidth,
                  height: el.clientHeight,
                  currentSrc: extractCssUrl(cs.backgroundImage),
                  src: extractCssUrl(cs.backgroundImage),
                  clientWidth: el.clientWidth,
                  clientHeight: el.clientHeight
                };
              }
            }
          } catch (e2) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }

    // ④ 容器里找第一张够大的图（点在 <a> 的空白区）
    try {
      var box = target.closest && target.closest('a, figure, picture, div');
      if (box) {
        var cands = box.querySelectorAll('img');
        for (var k = 0; k < cands.length; k++) {
          var ci = cands[k];
          if ((ci.naturalWidth || ci.width) >= 120 && (ci.naturalHeight || ci.height) >= 80) return ci;
        }
      }
    } catch (e) { /* ignore */ }

    return null;
  }

  /** 从 CSS `background-image: url("...")` 里抽地址 */
  function extractCssUrl(bg) {
    var m = String(bg || '').match(/url[\\("']*([^"')]+)/);
    return m ? m[1].replace(/\\/g, '') : '';
  }

  /** 兼容旧名（panel/外部调用可能引用了 onDocClick） */
  var onDocClick = onDocMouseDown;

  function toast(text) {
    try {
      var el = document.createElement('div');
      el.className = 'dsh-toast';
      el.setAttribute('data-dsh-ui', '1');
      el.textContent = text;
      document.documentElement.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2200);
    } catch (e) {}
  }

  function bind() {
    if (S.bound) return;
    S.bound = true;

    /**
     * **原始事件记录器**（只记不处理）。
     *
     * 排查「Alt+点击没反应」时最大的困惑是：不知道事件到底有没有到扩展。
     * 这个记录器挂在 document 的捕获阶段，最先执行，把所有 mousedown /
     * click 的详情记进环形缓冲（最多 20 条），诊断时打出来：
     *
     *   - 事件有没有来
     *   - altKey / button 是什么
     *   - e.target 是什么元素
     *   - 有没有被 resolveTargetImage 找到图
     *
     * 一眼就能看出卡在哪一步。
     */
    var logEvt = function (kind, ev) {
      try {
        var t = ev.target;
        var tag = t ? (t.tagName + (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '')) : 'null';
        S.evtLog.push({
          kind: kind,
          alt: !!ev.altKey,
          ctrl: !!ev.ctrlKey,
          shift: !!ev.shiftKey,
          button: ev.button,
          target: tag,
          x: ev.clientX,
          y: ev.clientY,
          isImg: !!(t && t.tagName === 'IMG'),
          t: Date.now()
        });
        if (S.evtLog.length > 20) S.evtLog.shift();
      } catch (e) { /* ignore */ }
    };
    document.addEventListener('mousedown', function (e) { logEvt('mousedown', e); }, true);
    document.addEventListener('click', function (e) { logEvt('click', e); }, true);
    // Alt 键单独记一下（有些环境 altKey 不跟着传）
    document.addEventListener('keydown', function (e) { if (e.key === 'Alt') S.altSeen = Date.now(); }, true);
    document.addEventListener('keyup', function (e) { if (e.key === 'Alt') S.altSeen = 0; }, true);
    /**
     * **主入口：mousedown**（带修饰键的 click 可能被页面 preventDefault 吞掉）
     * **兜底：click**（某些站点会自己合成 click 而不派发 mousedown）
     *
     * 两个都绑，用 S.lastTrigger 去重（避免同一次点击触发两次）。
     */
    /**
     * 图片内容变化 → 自动清 overlay。
     * 解决「翻页后旧译文还挂在第二页上」的 bug。
     */
    bindImageChangeCleanup();

    document.addEventListener('mousedown', onDocMouseDown, true);   // 见上面 bind() 里的原始记录器
    document.addEventListener('click', function (e) {
      // mousedown 已经处理过这次点击 → 不再重复
      if (S.lastTrigger && Date.now() - S.lastTrigger < 800) return;
      onDocMouseDown(e);
    }, true);
    // Esc 关闭面板
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.panel) closePanel();
    }, true);
  }

  /* ------------------------------------------------------------- 对外 API */

  /**
   * 用户自助诊断：在页面控制台敲 `__DSH_IMG_DIAG()`。
   *
   * 返回一行易懂的结论，不用看一堆内部字段。
   * 排查「Alt+点击没反应」时先敲这个。
   */
  globalThis.__DSH_IMG_DIAG = function (imgOrNothing) {
    var M = globalThis.__DSH_IMG__;
    if (!M) return '❌ imgtranslate 模块没加载（扩展重载后需要刷新页面）';
    var st = M.state();

    var lines = [];
    lines.push('=== 图片翻译诊断 ===');
    lines.push('模块加载    : ✅');
    lines.push('已启用      : ' + (st.enabled ? '✅' : '❌（设置页 → 图片翻译 打开它）'));
    lines.push('事件已绑定  : ' + (st.bound ? '✅' : '❌（配置没加载完，试试刷新页面）'));
    lines.push('翻译器接线  : ' + (st.hasTranslator ? '✅' : '❌（wireImageTranslate 没跑）'));
    lines.push('跨域抓图    : ' + (M.state().hasImageLoader ? '✅' : '❌（background 的 fetchImage 不可用）'));
    lines.push('目标语言    : ' + (st.cfgLang || '(未设)'));
    lines.push('最后触发    : ' + (st.lastTrigger ? (Math.round((Date.now() - st.lastTrigger) / 1000) + ' 秒前') : '从未'));
    lines.push('');
    lines.push('=== 最近一次 Alt+点击 ===');
    if (!st.altClicks) {
      lines.push('Alt+点击次数: 0  ← 一次都没检测到 altKey 的鼠标按下');
      lines.push('');
      lines.push('最近 6 次鼠标事件（不论有没有按 Alt）：');
      var lg = st.evtLog || [];
      if (!lg.length) {
        lines.push('  (一条都没有 —— 说明事件完全没到这个扩展)');
        lines.push('  可能原因：');
        lines.push('  · 扩展重载后没刷新页面（必须 Ctrl+F5）');
        lines.push('  · 点在 iframe 里（扩展只跑主框架，all_frames:false）');
        lines.push('  · 页面在扩展加载前就打开了');
      } else {
        for (var i2 = 0; i2 < lg.length; i2++) {
          var e2 = lg[i2];
          lines.push('  ' + e2.kind + ' alt=' + (e2.alt ? 'Y' : 'N') + ' btn=' + e2.button +
            ' target=' + e2.target + ' isImg=' + (e2.isImg ? 'Y' : 'N') +
            ' (' + Math.round((Date.now() - e2.t) / 1000) + 's前)');
        }
        lines.push('  → 有事件但 alt=N：说明 Alt 键没被记录（试试用右键菜单）');
      }
    } else {
      lines.push('Alt+点击次数: ' + st.altClicks);
      lines.push('最后按下    : ' + (st.lastMouseDown ? ('button=' + st.lastMouseDown.button + ' target=' + st.lastMouseDown.target + ' ' + Math.round((Date.now() - st.lastMouseDown.t) / 1000) + ' 秒前') : '(无)'));
      var _r1 = st.lastSkip ? ('❌ ' + st.lastSkip) : (st.lastTrigger ? '✅ 已触发翻译' : '(未走到触发点)');
      lines.push('最后结果    : ' + _r1);
    }

    var img = imgOrNothing || null;
    if (!img) {
      // 试着找页面上第一张够大的图
      var all = document.querySelectorAll('img');
      for (var i = 0; i < all.length; i++) {
        if (all[i].naturalWidth >= 120 && all[i].naturalHeight >= 80) { img = all[i]; break; }
      }
    }
    if (img) {
      lines.push('');
      lines.push('=== 抽查一张图 ===');
      lines.push('地址        : ' + (img.currentSrc || img.src || '').slice(0, 90));
      lines.push('原始尺寸    : ' + (img.naturalWidth || 0) + '×' + (img.naturalHeight || 0));
      lines.push('判定        : ' + M.whyNot(img));
    } else {
      lines.push('');
      lines.push('页面上没找到 ≥120×80 的图');
    }
    return lines.join('\n');
  };

  globalThis.__DSH_IMG__ = {
    /** 是否开启（由 content.js 根据配置设置） */
    setEnabled: function (on) {
      S.enabled = !!on;
      if (S.enabled) bind();
    },
    setConfig: function (cfg) { S.cfg = cfg || {}; },
    /** 由 content.js 提供：把一块图交给后台翻译 */
    setTranslator: function (fn) { S.translateBlock = fn; },
    /** 由 content.js 提供：跨域图抓取（background fetch → dataURL） */
    setImageLoader: function (fn) { S.imageLoader = fn; },
    /** 由 content.js 提供：整页翻译（background 的 translateImagePage） */
    setPageTranslator: function (fn) { S.pageTranslator = fn; },
    /** 由 content.js 提供：版面检测（background 的 detectImageLayout） */
    setLayoutDetector: function (fn) { S.layoutDetector = fn; },
    /** 由 content.js 提供：快速模式翻译（background 的 translateImageFast） */
    setFastTranslator: function (fn) { S.fastTranslator = fn; },
    /** 由 content.js 提供：提取 src/zh 对（background 的 extractPairs） */
    setPairExtractor: function (fn) { S.pairExtractor = fn; },
    /** 由 content.js 提供：图片重绘（background 的 imageEditTranslate） */
    setImageEditor: function (fn) { S.imageEditor = fn; },
    /** 手动翻某张图（逐块模式，原位盖译文） */
    translate: translateImage,
    /** 整页模式（不定位，只列表展示，覆盖率高） */
    translatePage: translatePage,
    /** 快速模式（OCR 文本 + CV 位置，覆盖率 100%） */
    translateFast: translateFast,
    translateEdit: translateEdit,
    /** Surya 布局模式（给精确 bbox，但漏检多） */
    translateLayout: translateLayout,
    /** 自动翻译开关（图片变化即翻） */
    setAutoTranslate: setAutoTranslate,
    /** 手动触发一次（找主图） */
    autoTranslateNow: function () {
      var main = S.lastImg || findMainImage();
      if (main) { maybeAutoTranslate(main); return true; }
      return false;
    },
    /** 只检测不翻译（调试用，返回耗时和框） */
    detect: detect,
    restore: restoreAll,
    state: function () {
      return {
        enabled: S.enabled,
        busy: S.busy,
        bound: S.bound,
        panelOpen: !!S.panel,
        hasTranslator: typeof S.translateBlock === 'function',
        hasImageLoader: typeof S.imageLoader === 'function',
        lastTrigger: S.lastTrigger || 0,
        cfgLang: S.cfg.targetLang,
        imgMode: S.cfg.imgMode,
        altClicks: S.altClicks || 0,
        lastMouseDown: S.lastMouseDown || null,
        lastSkip: S.lastSkip || '',
        evtLog: (S.evtLog || []).slice(-6)
      };
    },
    /**
     * 按坐标找页面上的图（右键菜单用）。
     *
     * 右键菜单只给 clientX/clientY 和目标 URL，没有 DOM 元素。
     * 这里用 elementsFromPoint 反查 —— 跟 Alt+点击同一套逻辑，
     * 保证两条入口的行为一致。
     */
    findImageAt: function (x, y) {
      return resolveTargetImage(document.elementFromPoint(x, y), x, y);
    },
    /**
     * 按图片 URL 找对应的 <img>。
     *
     * 用途：右键菜单给了 info.srcUrl（浏览器认定的那张图），
     * 用它精确匹配页面里的 <img>，比坐标更准（尤其图有旋转/变换时）。
     *
     * 匹配 currentSrc 和 src 两个字段（图片可能有 srcset，currentSrc 才是实际加载的）。
     */
    findImageByUrl: function (url) {
      if (!url) return null;
      try {
        var all = document.querySelectorAll('img');
        for (var i = 0; i < all.length; i++) {
          var im = all[i];
          if (im.currentSrc === url || im.src === url) return im;
        }
        // 退一步：忽略 query string / 协议差异
        var bare = String(url).split('?')[0].replace(/^https?:/i, '');
        for (var j = 0; j < all.length; j++) {
          var cs = (all[j].currentSrc || all[j].src || '').split('?')[0].replace(/^https?:/i, '');
          if (cs === bare) return all[j];
        }
      } catch (e) { /* ignore */ }
      return null;
    },
    /** 诊断：为什么这张图不能被翻 */
    whyNot: function (img) {
      if (!img || img.tagName !== 'IMG') return '不是 <img>';
      if (!S.enabled) return '图片翻译开关关着（设置页 → 图片翻译）';
      if (!S.bound) return '事件还没绑定（配置没加载完？）';
      if (typeof S.translateBlock !== 'function') return '翻译器没接线（wireImageTranslate 没跑）';
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w < 120 || h < 80) return '图太小（' + w + '×' + h + '，需要 ≥120×80）';
      if (w * h < 20000) return '像素太少（' + (w * h) + ' < 20000）';
      var ar = h ? w / h : 0;
      if (ar < 0.15 || ar > 8) return '长宽比太离谱（' + ar.toFixed(2) + '）';
      return '可以翻';
    }
  };
})();
