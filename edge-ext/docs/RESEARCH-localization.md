# 图片定位模型调研（2026-11-11）

## 问题

图片翻译需要**精确的文字 bbox** 才能原位替换译文。
现有方案：
  · CV（纯算法）→ 44ms，但网点背景上漏检（4/7 气泡）
  · VLM（vision / translate）→ 能读字，但**给不出可用 bbox**

实测 VLM 的 bbox 输出（真实漫画页）：
```
山海経     真实 (1195,80)-(1225,310)   模型 (1168,50)-(1256,358)   ← 宽了 3 倍
どうですか  真实 (945,33)-(1010,440)    模型 (938,438)-(1017,474)   ← y 差 400px
あので、    ——                          模型 (1015,981)-(1004,999)  ← x1>x2 非法
```

## 用户提议：加 Florence-2 / Grounding DINO Tiny

思路完全正确 —— 用专门的 detection 模型补上定位能力。

### 为什么这两个不行

llama.cpp b12100 的 `mtmd.dll` 支持的视觉架构（实测扫描，30+）：
```
clip, cogvlm, conformer, deepseek4v, deepseekocr, deepseekocr2,
dots3note, dotsocr, exaone4_5, gemma4v, glm4v, granite4-vision,
internvl, kimik25, lfm3vl, ling3vl, llama4, llava, mimo-audio,
mimovl, minicpmv, minimax-m3, mobilenetv5, mtmd-audio,
nemotron-omni, nemotron-transcribe, nemotron-v2-vl, paddleocr,
pixtral, pockettts-gen, qwen2vl, qwen3a, qwen3tts-gen,
qwen3tts-spkenc, qwen3vl, sensenova-u1, siglip, step3vl,
voxtral-rt, whisper-enc, yasa2, youtuvl
```

**没有** BART（Florence-2 的文本侧）、**没有** DETR（Grounding DINO 的解码器）。

结论：这两个只能走 Python 生态（torch + transformers，约 2~3 GB）。
本机 Python 3.12 只有 numpy/PIL，torch/transformers 都没装。

## 实测了能跑的两个替代（都下载了 GGUF）

### PaddleOCR-VL-1.6（936 MB + 882 MB mmproj）

| prompt | 耗时 | 结果 |
|---|---|---|
| `OCR` | 1232ms | ✓ 19 段，读得准 |
| `<|grounding|>OCR` | 3612ms | ✗ 退化（重复「チーハンを1つ」无数次） |
| `grounding markdown` | 3554ms | ✗ 退化（重复「かん」无数次） |

**不给 bbox。** chat template 里也没有 `<bbox>` / `<ref>` / `<loc>` 之类特殊 token。

### GLM-OCR 0.9B（906 MB + 462 MB mmproj）

| prompt | 耗时 | 结果 |
|---|---|---|
| `OCR` | 18.8s（冷）/ 2.1s | ✓ 7 段，读得准 |
| `<|grounding|>OCR` | 2118ms | ✗ 同样没 bbox |
| `OCR markdown` | 2150ms | ✗ 分段更细但没 bbox |

**也不给 bbox。**

## 关键结论

llama.cpp 生态里的 OCR 模型都是「**图 → 文本**」，不是「文字检测器」。
ggml 官方博客提到的 `<|grounding|>OCR` 只对**部分模型**有效（如 DeepSeek-OCR），
PaddleOCR-VL / GLM-OCR 都不支持。

## 那怎么办

### 已落地的替代（不需要新模型）

| 方案 | 耗时 | 覆盖率 | 能否原位替换 |
|---|---|---|---|
| CV 检测 + 逐块翻译 | 44ms + 1873ms | 4/7 | ✓ |
| 整页 OCR + 整页翻译 | 1119ms + 709ms | **7/7** | ✗ 列表展示 |

两条路互补，用户按场景选（右键菜单两项 + Alt/Alt+Shift）。

### 如果要真正的精确 bbox（两条路）

**A. 装 Python 版 PaddleOCR（PP-OCRv4）**
  · 老版本有专门的**文字检测网络**（DBNet），输出每个字的四点坐标
  · 代价：`pip install paddlepaddle paddleocr`，约 1.5 GB
  · 收益：精确 bbox，竖排/网点都能定位
  · 优点：中文/日文 OCR 业界最强

**B. 装 Florence-2 或 Grounding DINO（用户提议的方案）**
  · 代价：torch + transformers，约 2~3 GB
  · 收益：通用 grounding（不只是文字，可以是任何物体）
  · 缺点：需要另起一个 Python 推理服务

两者都需要**新增一个 Python HTTP 服务**（SuiXin 已经有 `oga-server.py` 的架子可以复用）。

## 建议

如果只是要修「图片翻译的定位」→ 选 A（PaddleOCR 老版本），更专一、更准。
如果还想做「图里所有的东西都标注」这类功能 → 选 B。

## 已下载的模型（可留可删）

```
D:\DSHQK\SuiXin\mods\PaddleOCR-VL-1.6-GGUF\   1733 MB
D:\DSHQK\SuiXin\mods\GLM-OCR-GGUF\              1368 MB
```

这两个都只能做纯文本 OCR（不给坐标），对图片翻译的定位问题**没有帮助**。