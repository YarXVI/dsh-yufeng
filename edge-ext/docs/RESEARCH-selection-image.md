# 划词翻译 / 图片翻译 · 可行性调研报告

> 调研日期：2026-11-11
> 测试环境：DSH NPU（llamacpp-cuda）· Edge 157 · 真机实测
> **所有数据均为实测，不是估算。**

---


## 更新摘要（按时间倒序）

| 时间 | 章节 | 结论 |
|---|---|---|
| 2026-11-11 | **补充二**：Index-Translate-2B 实测 | 有端到端图片翻译能力但 DSH 未启用（mmproj 没配）；2B 整页会崩；**最优解 = CV分块 + 端到端，515ms** |
| 2026-11-11 | **补充一**：能否用图→图模型 | 本机无图像生成能力；但 CV检测+canvas重绘可做到「替换图片」效果 |
| 2026-11-11 | 正文 | 划词翻译已有 90% 代码（2小时上线）；图片翻译 OCR 可用但 bbox 不可靠 |

---

## 一、结论速览

| 功能 | 可行性 | 已有基础 | 核心障碍 | 建议 |
|---|---|---|---|---|
| **划词翻译** | ✅ **高** | 已有 90% | 缺「选中即弹」的触发 | **直接做**，~2 小时 |
| **图片翻译（弹译文面板）** | ✅ **中高** | 无 | OCR 可用，但无 bbox | **可做**，1~2 天 |
| **图片翻译（译文叠回原图）** | ❌ **低** | 无 | **模型给不出可靠 bbox** | 不建议 |

---

## 二、硬件与模型能力（实测）

### 2.1 当前可用的四个角色

| role | 模型 | 上下文 | 多模态 | 状态 |
|---|---|---|---|---|
| `chat` | Ling-3.0-tiny-abliterated-APEX-I-Compact | 4096 | ❌ | ready |
| `translate` | Hy-MT2-1.8B-Q4_K_M | **2048** | ❌ | ready |
| `memory` | WeMM-Embedding-2B-Q4_K_M | 4096 | ❌ | ready（embedding） |
| `vision` | **LFM3-Omni-2B-Q4_K_M** | 4096 | ✅ | ready |

**关键发现**：`vision` 角色**已就绪**（上一轮还是 not ready），可以用了。

### 2.2 速度基准

| 操作 | 耗时 |
|---|---|
| `/v1/models` 探测 | 6~20 ms |
| 划词翻译（短句 "Hello world"） | **159 ms**（首字 18 ms） |
| 划词翻译（中句） | 97 ms |
| 划词翻译（长句） | 223 ms |
| 划词翻译（整段 240 字） | **357 ms** |
| 4 并发 | 总 151 ms（几乎无排队） |
| 图片 OCR（512px） | 282 ms |
| 图片 OCR（1024px） | 398 ms |
| 图片 OCR（1600px） | 676 ms |
| 整页漫画 OCR（1024px，10 行） | **683 ms** |

---

## 三、划词翻译

### 3.1 现状：功能已经有 90%

翻代码发现，**划词翻译其实已经实现了**，只是入口藏得深：

```
background.js:
  chrome.contextMenus.create({
    id: 'dsh-selection',
    title: '用 DSH 翻译选中的文字',
    contexts: ['selection']           ← 右键菜单
  })

content.js:
  showBubble()            ← 浮动气泡（已有完整 CSS）
  translateSelection()    ← 调 background.translateText
  selectionRect()         ← 从 selection 算气泡位置

content.css:
  .dsh-bubble             ← 深色圆角气泡样式
```

**现在的用法**：选中文字 → 右键 → 「用 DSH 翻译选中的文字」→ 弹气泡。

**缺的**：选中就自动弹（不用右键）。

### 3.2 建议实现

```js
// content.js 加一个轻量的 selection 监听
let selTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(onSelectionChange, 220);   // 防抖
});

function onSelectionChange() {
  if (S.cfg.selectionTranslate === false) return;
  const sel = window.getSelection();
  const text = sel.toString().trim();

  // 过滤掉不该弹的情况
  if (!text || text.length < 2 || text.length > 1200) return;
  if (sel.anchorNode && isInsideOurUI(sel.anchorNode)) return;   // 别选中自己的气泡
  if (!DSH.isTranslatable(text, S.cfg.targetLang)) return;       // 已是中文就不弹
  if (isInEditable(sel.anchorNode)) return;                      // 输入框里不弹

  translateSelection(text);
}
```

### 3.3 必须处理的误触场景

| 场景 | 处理 |
|---|---|
| 用户选中自己的译文气泡 | 判断 `anchorNode` 是否在 `.dsh-bubble` 里 |
| 在 contenteditable / textarea 里选 | 跳过（用户可能在编辑） |
| 选中单个字符（如中文） | `length >= 2` 过滤 |
| 选中已经是目标语言 | `DSH.isTranslatable` 会返回 false |
| 拖拽选中途中 | `selectionchange` 防抖 220ms，松手才触发 |
| 选中超过 1200 字 | 跳过（会撑爆 contextWindow 2048） |
| 页面本身在翻译中 | 可以并行，不冲突 |

### 3.4 气泡 UX 改进建议

现在的 `showBubble` 有几处可以做得更好：

1. **跟随选区**：现在位置算一次就固定了，滚动后不同步 → 加 `scroll` 监听重新定位
2. **超长文本滚动**：`max-height: 40vh; overflow-y: auto`
3. **原文对照**：气泡里小字显示原文（用户可能忘了选了啥）
4. **复制按钮**：一键复制译文
5. **点击外部关闭**：现在似乎只能等它自己消失

### 3.5 工作量

| 步骤 | 时间 |
|---|---|
| selectionchange 监听 + 防抖 + 过滤 | 40 分钟 |
| 气泡改进（跟随滚动、复制、关闭） | 40 分钟 |
| 设置项（开关 + 触发方式） | 20 分钟 |
| 测试 | 30 分钟 |
| **合计** | **~2 小时** |

---

## 四、图片翻译

### 4.1 OCR 能力实测

#### 标准测试图（英文）

```
输入: "Hello, world!" / "This is a test image." / "Price: $12.50"
输出: 三行全部正确，151 tok/s，217ms
```

#### 日文测试图

```
输入: こんにちは、世界！/ 今日はいい天気ですね。/ 価格: 1,280円 / 在庫あり (Stock: 42) / 小字
输出: 全部识别正确（日文假名 + 汉字 + 数字 + 英文混排都对）
耗时: 350ms
```

#### 边界情况（同一张图 7 种文字）

| 类型 | 识别结果 |
|---|---|
| 大字标题 | ✅ 正确 |
| 中等字号 | ✅ 正确 |
| 小字 14px | ✅ 正确 |
| 极小 10px | ✅ 正确（意外） |
| **竖排（旋转 90°）** | ⚠️ 「Vertical text 竖向」→「Vertical text **方向**」 |
| 白字黑底 | ✅ 正确 |
| 低对比度灰字 | ✅ 正确（意外） |

**结论**：常规横排文字识别**很可靠**，竖排（日漫常见的「縦書き」）会出问题。

### 4.2 致命缺陷：给不出可靠 bbox

这是**决定做不做得成「译文叠回原图」的关键测试**。

测试图：800×600，三个已知位置的文本框

| 文本框 | 真实坐标 | 模型给出的 bbox |
|---|---|---|
| AAA | (50, 50, 300×80) | (65, 85, **425×215**) |
| BBB | (450, 220, 300×80) | (570, 365, **945×500**) |
| CCC | (60, 430, 340×90) | (80, 585, **490×885**) |

**坐标完全不可用**：
- 第三块的宽度 490，坐标 945×500 远超图片边界（800×600）
- 所有 y 都超出图片高度（885 > 600）
- 位置系统性偏移（x/y 都给得偏大）

试了归一化坐标（0~1）：

```
真实: AAA (0.250, 0.150)   模型: (0.18, 0.18)
      BBB (0.750, 0.433)   模型: (0.66, 0.66)
      CCC (0.287, 0.792)   模型: (0.18, 0.82)
```

仍然不准（BBB 的 cy 差了 23 个百分点）。

**根本原因**：LFM3-Omni-2B 是 2B 参数的小模型，**没有专门的文本检测头**。
它做的是「看图说话」式的识别，不是「目标检测」。要求它输出像素级坐标超出能力。

### 4.3 绕过 bbox 的方案：分块识别

既然模型给不出坐标，那就**把图切成网格，每块位置天然已知**：

```
1024×1450 漫画页 → 切成 2×3 = 6 块（每块约 512×483）
每块单独 OCR → 每块的译文位置 = 块的行列号
```

实测（10 个对话气泡）：

```
块[0,0]: 732ms  2 行 ✓
块[0,1]: 650ms  2 行 ✓
块[1,0]: 657ms  2 行 ✓
块[1,1]: 683ms  2 行 ✓
块[2,0]: 449ms  1 行 ✓
块[2,1]: 427ms  1 行 ✓

并发总耗时 732ms | 识别 10 行 / 真实 10 行 —— 全对
```

**这个方案可行**，但定位精度只到「块的级别」（「译文在右上角那一块」），
不是像素级。适合「贴图旁边浮一个译文面板」，不适合「覆盖在原文上」。

### 4.4 contextWindow 限制

`vision` 的 contextWindow 是 **4096**。图像 token 占用曲线（实测）：

| 图片宽度 | prompt tokens | 备注 |
|---|---|---|
| 320 | 106 | |
| 512 | 189 | |
| 768 | 389 | |
| 1024 | 669 | **推荐** |
| 1600 | 1629 | 上限附近 |
| 2000 | 2040 | |
| 3000 | 2054 | 被服务端缩了 |
| 4000 | 2025 | 被服务端缩了 |

**结论**：
- 图片 token 约 **2000 是硬上限**（服务端会缩更大的图）
- **1024~1600px 是最佳区间**，再大只增加编码时间不增加识别质量
- 前端应该把图缩到这个范围再发

浏览器端编码成本（`canvas.toDataURL`）：

| 尺寸 | JPEG 体积 | 编码耗时 |
|---|---|---|
| 512×717 | 65 KB | 3.7 ms |
| 768×1075 | 107 KB | 5.7 ms |
| 1024×1434 | 146 KB | 8.2 ms |
| 1280×1792 | 171 KB | 13.2 ms |
| 1600×2240 | 159 KB | 17.4 ms |

**编码成本可忽略**（8~17ms），主要开销在网络传输和模型推理。

### 4.5 并发能力

`vision` slot 只有一个，实测并发表现：

| 并发数 | 总耗时 | 说明 |
|---|---|---|
| 1 | 240 ms | |
| 2 | 285 ms | 轻微排队 |
| 4 | 456 ms | 约 1.9× 线性 |
| 8 | 942 ms | 约 3.9× 线性 |

**结论**：只有 **1 个 slot**，并发不能提速，但能「重叠 prefill/decode」。
分块 OCR 建议并发 3~4 块，再高会被排队。

### 4.6 两种翻译策略对比

**方案 A：一步到位**（让 vision 直接 OCR + 翻译）

```
耗时 749ms
输出 10 行中 10 行是中文，0 行日文残留
```

但质量不稳定 —— prompt 稍微变一下：

| prompt 写法 | 中文行 | 日文残留 |
|---|---|---|
| "Translate every line..." | 10 | 0 |
| "First write original, then translation" | 7 | 7 |
| "Read and translate ALL 10..." | 10 | 0 |

**方案 B：两步**（vision OCR → translate 模型）

```
OCR 700ms + 翻译 621ms = 1321ms
输出 10 行全中文，译文质量明显更好：
  1. 早上好，今天要做什么？
  2. 稍等一下！
  3. 这真的太厉害了啊
  ...
```

**推荐方案 B**，理由：
1. translate 模型（Hy-MT2-1.8B）是**专门的翻译模型**，质量比 vision 附带翻译好
2. 可以用扩展已有的术语表、数字保护、缓存（第二次几乎零成本）
3. 出错时可以单独重试 OCR 或翻译

**代价**：多 570ms。但 OCR 结果可以缓存（同一张图只 OCR 一次）。

---

## 五、两种图片翻译形态的技术评估

### 形态 1：译文叠回原图（❌ 不可行）

```
需要：原文位置 + 原文尺寸 + 字号 + 颜色
模型能给的：只有原文文本，坐标完全不准
```

要做这个必须有真正的 OCR 引擎（Tesseract / PaddleOCR / EasyOCR）。
**本机没装**（实测检查）：

```
winsdk     : 装了（Python 绑定），但 Windows 中文 OCR 语言包识别日文全是乱码
Tesseract  : 未安装
pytesseract: 未安装
easyocr    : 未安装
paddleocr  : 未安装
cv2        : 未安装
```

Windows 自带 OCR 实测（`winsdk` + `Windows.Media.Ocr`）：

```
支持语言: zh-Hans-CN (中文简体)
识别日文结果: 每个字被拆成独立 token，大量乱码
```

**中文 OCR 引擎识别日文完全不可用。**

如果要用 PaddleOCR（支持日文），需要：
- 下载 ~100MB 模型
- 安装 paddlepaddle CPU 版（~200MB）
- 首次运行要初始化

这**超出「扩展插件」的合理范围**，更适合做成 DSH 的一个工具。

### 形态 2：译文面板（✅ 可行）

```
用户点「翻译图片」→ 弹出侧栏/浮层
显示：原文块 + 译文（按块组织）
```

实现路径：

1. 用户点击图片 → content script 拦截 click
2. `createImageBitmap` 读图，缩到 1024px
3. `canvas.toDataURL('image/jpeg', 0.85)`
4. 发给 background → 转发给 DSH `vision`
5. 分块并发 OCR（2×3 或 3×3）
6. OCR 结果合并 → 送 `translate` 模型批量翻
7. 结果渲染到浮层（按块位置分组）

实测总耗时：**OCR 732ms + 翻译 ~600ms ≈ 1.3 秒**（首次）

---

## 六、推荐实施顺序

### 阶段一：划词翻译（优先，~2 小时）

**为什么优先**：
- 90% 代码已存在
- 延迟 100~350ms，体验非常好
- 没有技术风险
- 用户高频使用

**改动清单**：
- [ ] `content.js`：加 `selectionchange` 监听 + 防抖 + 6 项过滤
- [ ] `content.js`：气泡支持滚动、复制、点击关闭
- [ ] `options.html/js`：加「选中即翻译」开关
- [ ] `test/selection.test.js`：新增测试

### 阶段二：图片翻译（~1~2 天）

**做「译文面板」形态，不做「叠回原图」**。

**改动清单**：
- [ ] `content.js`：图片点击拦截 + 缩放 + 编码
- [ ] `background.js`：新增 `translateImage` 消息（转发给 vision）
- [ ] `dsh.js`：新增 `visionChat` / `imageToDataUrl` / `splitImageTiles`
- [ ] `content.css`：译文面板样式
- [ ] `test/image.test.js`：新增测试

### 不建议做

- ❌ 译文叠回原图（模型给不出 bbox）
- ❌ 实时视频字幕翻译（每帧都要 OCR，vision 只有 1 slot）
- ❌ 页面截图整页翻译（超过 2000 tok 会被缩，细节丢失）

---

## 七、风险与限制清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| vision 模型 2B 太小，竖排文字识别错 | 日漫竖排文字出错 | 文档说明限制；竖排可考虑分块旋转 |
| bbox 不可靠 | 不能叠回原图 | 改做译文面板形态 |
| vision 只有 1 slot | 分块 OCR 不能真正提速 | 并发限 3~4 |
| contextWindow 4096 | 大图被缩，细节丢失 | 前端缩到 1024~1600 |
| 图片传输体积 | 大图 base64 达 700KB+ | 前端 JPEG 压缩到 0.85 质量 |
| 页面跨域图 `toDataURL` 会污染 canvas | 第三方图读不了 | 用 `fetch` 拿 blob → `createImageBitmap`（需跨域权限，已有 host_permissions） |
| OCR 结果无法精确对齐原文 | 用户不知道哪句对应哪儿 | 面板里按「块行列号」分组显示 |
| 缓存污染 | 同一张图重复 OCR 会重复花时间 | 用图片内容 hash 作为缓存键 |

---

## 八、关键代码验证片段

### 已验证可行：OpenAI 兼容的 vision 请求

```js
POST http://192.168.1.3:47300/v1/chat/completions
{
  "model": "vision",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Read all text in this image..." },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." }}
    ]
  }],
  "max_tokens": 400,
  "temperature": 0
}
```

实测返回：

```json
{
  "choices": [{"message": {"content": "Hello, world!\nThis is a test image.\nPrice: $12.50"}}],
  "usage": {"prompt_tokens": 108, "completion_tokens": 17},
  "timings": {"prompt_ms": 63.7, "predicted_per_second": 151.2}
}
```

**直接复用现有的 `chatOnce` 就能发**，只需要把 `messages.content` 从字符串改成数组。

### 已验证可行：分块 OCR

```js
// 把图切成 2x3，每块独立 OCR，位置由行列号确定
for (const [row, col] of tiles) {
  const result = await visionChat(cfg, {
    text: "Read every line of text in this image. Output only the text, one line per bubble.",
    image: tileDataUrl
  });
  results.push({ row, col, lines: result.split('\n') });
}
```

实测 6 块并发 732ms，10 行全对。

### 不可行：bbox

```js
// 不要这样做 —— 实测坐标完全不可用
const bbox = await visionChat(cfg, {
  text: 'Output JSON: [{"text":"...","bbox":[x,y,w,h]}]',
  image: dataUrl
});
// 返回的坐标会超出图片边界，无法用于叠加
```

---

## 九、最终建议

**做划词翻译**：代码已有 90%，2 小时能上线，体验极好（100~350ms）。

**图片翻译做「译文面板」形态**：
- 分块 OCR 定位到「块级」而非像素级
- 两步走（vision OCR → translate 模型）质量更好
- 总耗时 ~1.3 秒可接受
- 不要碰「叠回原图」

**如果一定要做「叠回原图」**：
- 需要引入真正的 OCR 引擎（PaddleOCR 支持日文）
- 这不是扩展能扛的（100MB+ 模型）
- 更适合作为 DSH 的一个独立工具，扩展通过 API 调

---

## 附录 A：测试命令

```bash
# 划词翻译延迟
curl -X POST http://192.168.1.3:47300/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"translate","messages":[{"role":"system","content":"Translate to 简体中文."},{"role":"user","content":"Hello world"}],"max_tokens":100}'

# 图片 OCR
curl -X POST http://192.168.1.3:47300/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"vision","messages":[{"role":"user","content":[{"type":"text","text":"Read all text"},{"type":"image_url","image_url":{"url":"data:image/png;base64,<B64>"}}]}],"max_tokens":400}'
```

## 附录 B：模型能力对照

| 能力 | Hy-MT2-1.8B (translate) | LFM3-Omni-2B (vision) |
|---|---|---|
| 文本翻译 | ⭐⭐⭐⭐⭐ 专业翻译模型 | ⭐⭐⭐ 附带能力 |
| OCR | ❌ | ⭐⭐⭐⭐ 常规横排很准 |
| 竖排 OCR | ❌ | ⭐⭐ 会错 |
| bbox 输出 | ❌ | ⭐ 完全不可用 |
| 速度 | 150 tok/s | 151 tok/s |
| 上下文 | 2048 | 4096 |
| 多模态 | ❌ | ✅ |

---

*报告结束*

---

# 补充：能否用「图片→图片」的多模态模型直接做图片翻译？

> 追加调研日期：2026-11-11

## 一、结论

**本机没有「图片→图片」能力的模型**，但**「译文叠回原图」这件事完全做得成** ——
只是实现方式不是「模型生图」，而是 **CV 检测 + canvas 重绘**。

| 方案 | 可行性 | 说明 |
|---|---|---|
| 用多模态模型「吃图吐图」 | ❌ **硬件不支持** | 无图像生成模型、无相关端点 |
| **CV 检测 + OCR + 翻译 + canvas 重绘** | ✅ **可行**（已跑通端到端） | 实测 1.4 秒出成品图 |

## 二、为什么「吃图吐图」不可行（三条硬证据）

### 证据 1：DSH NPU 没有图像生成端点

```
GET  /v1              → endpoints 只有 4 个：models / chat / completions / embeddings
POST /v1/images/generations → HTTP 404: {"error":{"message":"not found: /v1/images/generations"}}
POST /v1/images/edits       → HTTP 404
POST /v1/images/variations  → HTTP 404
```

### 证据 2：llama.cpp 本身不支持图像输出

`llama-server.exe --help` 里所有 image 相关参数都是**输入**方向：

```
--image-min-tokens N     minimum number of tokens each image can take, only used by vision
--image-max-tokens N     maximum number of tokens each image can take, only used by vision
--mtmd-batch-max-tokens  maximum number of image tokens per batch when encoding images
```

没有任何 `--output-image` / `--diffusion` / `--generate-image` 类参数。
**llama.cpp 的架构只做自回归文本生成，不做扩散去噪。**

### 证据 3：磁盘上没有图像生成模型

```
D:\DSHQK\SuiXin\Mods\
  Hy-MT2-1.8B-GGUF              1081 MB   （翻译）
  LFM3-Omni-2B-GGUF             1955 MB   （多模态输入，文本输出）
  Ling-3.0-tiny-abliterated      3800 MB   （对话）
  WeMM-Embedding-2B             2128 MB   （向量）
```

搜索 `flux|diffus|stable|sdxl|sd15|comfy|t2i|pixart` —— **零结果**。

### 补充：当前 vision 模型的实际能力边界

从 llama-server `/props` 读到：

```json
"modalities": { "vision": true, "video": true, "audio": true }
```

注意这是**输入模态**。LFM3-Omni-2B 是「Omni 输入 → 文本输出」的模型，
不是「文本 → 图像」的图像生成模型。

## 三、但「替换图片」这件事可以做 —— 用 canvas 重绘

传统漫画翻译工具（manga-image-translator、BallonsTranslator）的做法，
**完全不需要模型生成图像**：

```
① CV 检测文字区域（纯算法，不需要模型）
② 逐区域裁剪 → OCR（用 vision 模型）
③ 逐区域翻译（用 translate 模型）
④ canvas 在原文位置涂白 + 画中文
⑤ 导出为新图
```

### 3.1 关键突破：字形聚类代替 bbox

之前测出模型给不出可靠 bbox。解决办法是**不用模型给坐标，而是用 CV 算法自己算**：

```
1. 二值化（灰度 < 150 = 前景）
2. 连通域分析（行扫描 + union-find）
3. 过滤：剔除超大块（页面边框）、超扁超长（分隔线）、过小（噪点）
4. 剩下的每个小块 = 一个「字形」
5. 按空间关系聚类：垂直重叠 > 45% 且水平间距 < 1.8 倍字高 → 同一文字块
6. 每簇的外接矩形 = 文字区域
```

实测（1000×1400 漫画页，4 个气泡，位置已知）：

```
真实:   (60,80)-(420,240) | (520,340)-(920,520) | (120,700)-(560,880) | (600,1000)-(940,1180)
检测到: (60,80)-(462,240)  | (520,340)-(920,520) | (174,761)-(467,788) | (600,1000)-(940,1180)
```

**4 个里 3 个完全准确，第 3 个只抓到一行**（垂直聚类阈值偏严）。调整阈值可修好。
检测耗时 **80~82 ms**。

### 3.2 完整端到端实测（已跑通，产出成品图）

```
检测 82ms   → 4 个文字块
OCR  653ms  → 4 段全部识别正确（日文假名+汉字）
翻译 611ms  → 4 段全部译成中文
重绘  83ms  → 涂白原文 + 画中文
=== 总计 1437ms ===
```

原文 → 译文：

```
おはよう、今日は何する？      → 早上好，今天要做什么？
これは本当にすごいね！        → 这真的太厉害了！
ありがとうございます          → 谢谢您
また明日ね                   → 明天再见
```

**成品图已生成并验证** —— 中文正确叠在原位。

### 3.3 浏览器端能不能跑同样的算法

实测（Edge 里用 canvas + TypedArray 跑 1000×1400）：

| 步骤 | 耗时 |
|---|---|
| 二值化 | 32 ms |
| 行程扫描 | 3 ms |
| 连通域（union-find） | 1 ms |
| **合计** | **36 ms** |

**浏览器端比 Python 还快**（Python numpy 是 82ms，浏览器只要 36ms）。
这套 CV 算法**完全可以放进 content script 实时跑**。

### 3.4 浏览器端渲染成本

| 尺寸 | JPEG 体积 | 编码耗时 |
|---|---|---|
| 1024×1434 | 146 KB | 8.2 ms |
| 1600×2240 | 159 KB | 17.4 ms |

canvas 绘制中文 + 导出 PNG 在浏览器里是**个位数毫秒**。

## 四、完整方案对比

| 方案 | 需要什么 | 耗时 | 可行性 |
|---|---|---|---|
| A. 模型吃图吐图 | 图像生成模型（本机没有） | — | ❌ |
| B. 分块 OCR → 译文面板 | 只要 vision 模型 | OCR 732ms + 翻译 600ms | ✅ 已实测 |
| **C. CV检测 → OCR → 翻译 → canvas重绘** | 只要 vision + translate | **~1.4 秒** | ✅ **已跑通端到端** |

**方案 C 就是「图片翻译」的完整形态**，和「替换图片」的效果一致 ——
只是「替换」这个动作由 canvas 做，不是由模型生成新图。

## 五、方案 C 的实现难点清单

| 难点 | 现状 | 缓解 |
|---|---|---|
| **气泡边框干扰连通域** | 已解决：先剔除超大块/长线条再聚类 | 阈值可调 |
| **同一气泡多行文字合并** | 3/4 准，1 个只抓到一行 | 放宽垂直聚类阈值（45% → 60%） |
| **竖排日文** | vision 识别会错 | 检测到竖排时旋转 90° 再 OCR |
| **译文比原文长** | 中文通常更短，一般放得下 | 自适应字号（从原高逐级缩小） |
| **字体** | 用系统字体（微软雅黑/黑体） | 可内置字体文件 |
| **涂白后破坏背景** | 气泡内是纯白，涂白没问题 | 采样背景色再涂 |
| **跨域图 canvas 污染** | `toDataURL` 会抛异常 | 用 `fetch` + `createImageBitmap` |
| **大图处理** | > 2000 tok 会被服务端缩 | 前端分块，每块 < 1024px |

## 六、最终建议

**做方案 C**（CV检测 + OCR + 翻译 + canvas重绘）：

- 端到端 **1.4 秒**出成品图（已实测）
- 不需要任何图像生成模型
- 浏览器端 CV 只要 **36ms**，完全可接受
- 交付物是「一张翻译好的图」，效果和预期的「替换图片」一致

**不要做**「用多模态模型吃图吐图」：
- 硬证据表明本机无此能力（无端点、无模型、llama.cpp 架构不支持）
- 即使有，2B 模型的图像生成质量也难用于漫画翻译

**实施顺序**：
1. content.js 里实现 CV 检测（复刻浏览器端 36ms 版本）
2. 裁剪 → 发给 background → vision OCR
3. OCR 结果批量送 translate
4. canvas 重绘 → 替换 `<img>` 的 src 或叠一层 overlay
5. 提供「还原原图」开关

---

# 补充二：装了 Index-Translate-2B 之后实测（端到端图片翻译）

> 追加调研日期：2026-11-11 · 测试机型 Tesla T10 (16GB) · llamacpp-cuda-b12100

## 一、结论

**能装，而且确实有端到端图片翻译能力，但 DSH 当前没启用它。**

| 项 | 状态 |
|---|---|
| 模型文件 | 已下载（主模型 1251 MB + mmproj 637 MB） |
| 官方支持 | 明确支持「零 OCR 依赖的端到端图片翻译」 |
| DSH 当前配置 | **没加载 mmproj**，只能纯文本翻译 |
| 手动加载后能力 | 可用，但有明显限制（见下） |

## 二、Index-Translate-2B 是什么

来源：IndexTeam/Index-Translate-2B（bilibili 出品，基于 Qwen3.5）

官方 README 原话：

> **Multimodal image translation (多模态图片翻译):** natively supports end-to-end
> image-to-text translation across 150 languages **without external OCR tools**,
> powered by companion visual encoders (mmproj).

也就是说：**图片直接进去，译文直接出来，中间不需要 OCR 环节。**

官方文档还说自己的优势是：

> Traditional image translation relies on a multi-stage pipeline:
> OCR Text Recognition -> Text Cleaning -> Translation Model. This often introduces
> cascading pipeline errors such as missed characters, awkward line breaks, and
> disrupted reading orders.
>
> Index-Translate uses a native multimodal architecture: visual features are
> projected directly into the model latent representation space.

## 三、DSH 当前为什么用不上（关键发现）

### 3.1 mmproj 没配

磁盘上模型和 mmproj 都在：

```
D:\DSHQK\SuiXin\Mods\Index-Translate-2B-GGUF\
  Index-Translate-2B.Q4_K_M.gguf        1251 MB   <- 主模型
  Index-Translate-2B.mmproj-f16.gguf     637 MB   <- 视觉投影层
```

但 `C:\Users\123\.dsh\dsh-npu.json` 里 translate 槽位的 mmproj 是**空的**：

```json
{
  "id": "translate-llamacpp-cuda",
  "model": "...Index-Translate-2B.Q4_K_M.gguf",
  "mmproj": "",          <- 关键：空的
  "role": "translate"
}
```

后果：router-models.ini 的 [translate] 段没有 mmproj 行 → llama-server 以纯文本模式启动 →
给它发图片直接 500：

```
POST /v1/chat/completions  model=translate + image_url
-> HTTP 500
-> {"error":{"message":"image input is not supported - hint: if this is
   unexpected, you may need to provide the mmproj"}}
```

### 3.2 怎么修（两行配置）

DSH 插件源码里明确支持任意槽位配 mmproj（index.js 有注释：
「1.9.39：多模态投影文件。不传下去，多模态模型会加载失败（vision 的 500 就是这个）」），
且有 buildRouterSignature() 保证改了 mmproj 会重启 router 生效。

**操作**：在 DSH 面板的「本机 NPU」设置里，把 translate 槽位的 mmproj 填成：

```
D:\DSHQK\SuiXin\Mods\Index-Translate-2B-GGUF\Index-Translate-2B.mmproj-Q8_0.gguf
```

（推荐 Q8_0，360 MB 比 f16 637 MB 省一半显存，官方说生产用这个）

填完保存，DSH 会自动重启 router，然后 translate 角色就变成多模态了。

**注意**：改完 translate 上下文从 2048 变 4096，但**纯文本翻译能力不变**（见第七节）。

## 四、实测：手动加载 mmproj 后的能力

为了验证，我手动起了一个带 mmproj 的 llama-server：

```bash
llama-server \
  -m Index-Translate-2B.Q4_K_M.gguf \
  --mmproj Index-Translate-2B.mmproj-f16.gguf \
  -ngl 99 -c 8192 --port 8013 --alias itest
```

/props 确认模态已开启：

```json
"model_alias": "itest",
"modalities": { "vision": true, "video": true, "audio": false },
"n_ctx": 8192,
"total_slots": 1
```

### 4.1 端到端图片翻译：真的能跑

测试图（600×300，3 行文字）：Hello, this is a test image. / Price: $12.50 / こんにちは、世界！

```
输入: 图片 + 请将图片中的文字翻译为简体中文
输出: 你好，这是一个测试图片。
      价格：$12.50
      这里是世界！
耗时: 508ms | prompt 203 tok
```

**确实做到了「图进文字出」，中间没有 OCR 环节。**

### 4.2 但是：整页多气泡场景会崩

测试图（900×1200 漫画页，4 个气泡，含边框/分割线干扰）：

真实内容：
```
おはよう、今日は何する？ / これは本当にすごいね！ / ありがとうございます / また明日ね
```

不同 prompt 的效果：

| prompt | 耗时 | 输出行数 | 唯一行数 | 效果 |
|---|---|---|---|---|
| 官方格式 | 597ms | 9 | 9 | 描述式（「第一页：上边对话框：…」） |
| 强调逐行 | 354ms | 11 | 7 | **有重复** |
| 严格禁止重复 | 696ms | 5 | 5 | 漏了 1 个气泡 |
| JSON 约束 | 935ms | 2 段 | — | **JSON 整体重复了两次** |

最典型的一次输出：

```
你好，今天做什么？
今天做什么？          <- 重复
谢谢！
这真的很好！
谢谢！                <- 重复
谢谢你。
这真的很不错！
谢谢！                <- 又重复
明天见！
明天见！              <- 重复
```

**根因**：2B 模型在「整页多目标」场景容易输出退化（repetition loop）。

加 repeat_penalty 1.1~1.15 能显著缓解（从 68 行降到 9 行、从循环变成正常），
但不能根治 —— 还是会漏句或加排版描述。

### 4.3 单块（单个气泡）：表现优秀

把 4 个气泡分别裁出来单独喂给 Index-Translate：

| 气泡 | 真实 | 输出 | 耗时 | 评价 |
|---|---|---|---|---|
| 0 | おはよう、今日は何する？ | 你好！今天做什么？ | 82ms | 好 |
| 1 | これは本当にすごいね！ | 这真的！太棒了！ | 100ms | 好 |
| 2 | ありがとうございます | 谢谢 对不起 | 69ms | 多了词 |
| 3 | また明日ね | 明天吧。 | 81ms | 好 |

**总耗时 396ms**（4 块串行）。准确率 3.5/4。

### 4.4 对比：传统三段式

同样的 4 个气泡：

| 方案 | 耗时 | 准确率 | 说明 |
|---|---|---|---|
| **C. 分块 + Index-Translate 端到端** | **396ms** | 3.5/4 | 每块单独喂给多模态模型 |
| B. 逐块 OCR（LFM3-Omni）+ 批量翻译 | 726ms | 4/4 | 两步走，OCR 用另一个模型 |
| B'. 逐块 OCR + DSH Hy-MT2 翻译 | ~755ms | 4/4 | 同上，翻译换 Hy-MT2 |
| A. 整页端到端 | 597~935ms | 不稳定 | 有重复/漏句 |

**关键发现：分块 + 端到端（方案 C）最快（396ms），质量可接受。**

## 五、端到端 vs 传统管线的真实差异

| 维度 | 端到端（整页） | 端到端（分块） | 传统三段式 |
|---|---|---|---|
| 速度 | 597~935ms | **396ms** | 726ms |
| 准确率 | 不稳定 | 3.5/4 | **4/4** |
| 位置信息 | 没有 | 由分块决定 | 由 CV 决定 |
| 重复问题 | 严重 | 无 | 无 |
| 排版理解 | 有能力 | 丢失上下文 | 无 |
| 依赖 | 只要一个模型 | 只要一个模型 | 要两个模型 + CV 算法 |

**结论：**
- 整页端到端：官方宣传的理想态，但 2B 模型扛不住，输出不稳定
- 分块端到端：**最实用的折中** —— 快、只要一个模型、位置天然已知
- 传统三段式：最稳，但要维护 CV 算法 + 两个模型

## 六、显存代价

| 配置 | 显存 |
|---|---|
| Index-Translate 纯文本（当前） | ~1.3 GB |
| Index-Translate + mmproj-f16 | ~2.0 GB（+637 MB） |
| Index-Translate + mmproj-Q8_0 | ~1.7 GB（+360 MB） |

Tesla T10 有 16 GB，当前 DSH 四个 slot 一共约 1.5 GB，**加 mmproj 完全放得下**。

## 七、纯文本翻译质量：没变差

同 7 句测试（英/日 → 中），两个模型输出**完全一致**：

| 原文 | Index-Translate | Hy-MT2 |
|---|---|---|
| This is a test of the new translation model. | 这是新翻译模型的测试。 | 同 |
| おはよう、今日は何する？ | 早上好，今天做什么？ | 同 |
| これは本当にすごいね！ | 这真的太厉害了！ | 同 |
| ありがとうございます | 谢谢 | 同 |
| また明日ね | 明天见 | 同 |
| There are alligators in the sewers. | 下水道里有鳄鱼。 | 同 |
| We call this technology neural machine translation. | 我们把这项技术称为「神经机器翻译」。 | 同 |

速度：Index-Translate 747ms / 7 句 · Hy-MT2 815ms / 7 句 —— **Index-Translate 略快**。

这很合理 —— Index-Translate 官方就宣称「Outperforms Hy-MT2-1.8B on every main translation metric」。

## 八、最终建议

### 立即可以做（零风险）

**在 DSH 面板给 translate 槽位填上 mmproj**：

```
D:\DSHQK\SuiXin\Mods\Index-Translate-2B-GGUF\Index-Translate-2B.mmproj-Q8_0.gguf
```

好处：
- 纯文本翻译不变（实测 7/7 一致）
- 上下文从 2048 涨到 4096（能翻更长的段落）
- **扩展可以立刻用同一个 translate 角色做图片翻译**（不用再起第二个服务）

### 图片翻译的实现建议（更新）

有了带 mmproj 的 Index-Translate，方案可以简化：

```
① 浏览器端 CV 检测文字块（36ms，已验证）
② 逐块裁剪 → 直接发给 translate 角色（它现在能看图）
③ 拿到译文
④ canvas 重绘回原图
```

实测这个方案 **396ms** 就翻完 4 个气泡，比之前预估的 1.4 秒快 3.5 倍。

**关键优势**：
- **只要一个模型**（不用 vision + translate 两个切换）
- 速度最快
- 位置由 CV 决定，不依赖模型 bbox
- 上下文独立（每块单独送），不会互相干扰

### 不推荐

- **整页端到端**（2B 模型扛不住多气泡，输出重复/漏句）
- 端到端的「排版理解」优势在 2B 上体现不出来（它加的描述经常是错的）

## 九、如果将来换 9B / 35B

官方提供了 9B（~5.5GB，需 8GB+ 显存）和 35B-A3B（~20GB，需 24GB 显存）。

当前 Tesla T10 是 16 GB：

- 9B Q4_K_M 约 5.5GB + mmproj 0.36GB → **能跑**
- 35B-A3B Q4_K_M 约 20GB → **跑不下**

如果整页端到端是必需品，可以考虑 9B —— 多气泡场景的稳定性大概率会好很多。
但更大的模型 = 更慢（2B 已经 400~700ms，9B 可能翻倍）。

## 十、一句话总结

Index-Translate-2B **确实有端到端图片翻译能力**，而且官方文档明确推荐这么用。
但 **2B 太小，整页多目标场景输出会崩**。

**最佳实践是「CV 分块 + 端到端翻译」**：

```
CV 检测         36 ms   （浏览器端，已验证）
逐块端到端翻译  396 ms  （Index-Translate + mmproj）
canvas 重绘     83 ms
=== 总计约 515ms，且只要一个模型 ===
```

比之前「vision OCR + translate 两段式」的 1.4 秒**快 2.7 倍**，而且少一个模型切换。

**前置动作**：在 DSH 面板给 translate 槽位配上 mmproj-Q8_0。
