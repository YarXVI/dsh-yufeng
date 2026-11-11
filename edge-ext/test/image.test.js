/* 图片翻译测试（静态契约）。
   覆盖：算法结构、过滤规则、字号自适应、overlay/panel、还原。
   浏览器行为由 test/image.browser.js 覆盖。
   node test/image.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.css'), 'utf8');
const dsh = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const optHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');

// ===== 模块接入 =====
t('manifest 加载了 imgtranslate.js', mf.content_scripts[0].js.some(function (f) { return f.indexOf('imgtranslate') >= 0; }));
t('content.js 接线到模块', ct.includes('wireImageTranslate'));
t('后台有 translateImageBlock', bg.includes("msg.t === 'translateImageBlock'"));
t('引擎有 visionTranslateBlock', dsh.includes('function visionTranslateBlock'));
t('配置项 imageTranslate', dsh.includes('imageTranslate: true'));
t('配置项 imgMode', dsh.includes("imgMode: 'overlay'"));

// ===== CV 算法四步 =====
t('① 灰度二值化', img.includes('function binarize'));
t('  加权灰度（BT.601）', img.includes('0.299') && img.includes('0.587') && img.includes('0.114'));
t('  阈值默认 150（可配）', img.includes('threshold == null ? 150 : threshold'));
t('② 连通域（行扫描）', img.includes('function connectedComponents'));
t('  union-find', img.includes('function find(a)'));
t('③ 字形过滤', img.includes('function pickGlyphs'));
t('  剔除超大块', img.includes('area * 0.10'));
t('  剔除横线/竖线', img.includes('w > 150 && h < 20'));
t('  中空形状过滤（气泡边框）', img.includes('fill < 0.02'));
t('字形过滤 superseded by 形态学（pickGlyphs 保留）', img.includes('function pickGlyphs'));
t('④ 形态学方向闭运算（取代 union-find）', img.includes('closeDirectional'));
t('  膨胀用前缀累计（O(W*H)）', img.includes('acc = bw[off + x] ? k'));
t('  腐蚀逐窗口（不能只看两端）', img.includes('lastZero < x - k'));
t('  双阈值二值化', img.includes('bwDark'));
t('  形态学用 120 阈值', img.includes('y < 120 ? 1 : 0'));
t('  竖条判据 h/w ≥ 2.5', img.includes('h / w < 2.5'));
t('  横条判据 w/h ≥ 2.5', img.includes('w2 / h2 < 2.5'));
t('  竖条最小高度 70', img.includes('h < 70 || w < 8'));
t('  面积上限 10% 兜底', img.includes('area * 0.10'));
t('  bars 合并成段落', img.includes('barsToParagraphs'));
t('  竖排合并判据（列间距 2.5x）', img.includes('xgap <= cand.w * 2.5'));
t('  横排合并判据（行间距 2.5x）', img.includes('ygap <= cand.h * 2.5'));

// ===== 渲染 =====
t('overlay 层', img.includes("className = 'dsh-imglayer'"));
t('单块 cell', img.includes("className = 'dsh-imgcell'"));
t('字号自适应', img.includes('function chooseFontSize'));
t('全角字符按 1em', img.includes('0xFE30') && img.includes('0xFF00'));
t('优先单行放得下', img.includes('单行放得下'));
t('白底外扩 2px 盖住抗锯齿', img.includes('PAD = 2'));
t('面板（panel 模式）', img.includes("className = 'dsh-imgpanel'"));
t('还原按钮', img.includes('dsh-ip-restore'));
t('还原函数', img.includes('function restoreAll'));

// ===== 触发 =====
t('Alt + 点图触发（不拦截普通点击）', img.includes('e.altKey'));
t('★ 覆盖层反查：resolveTargetImage', img.includes('function resolveTargetImage'));
t('  祖先里有 IMG 也能找到', img.includes("target.closest && target.closest('img')"));
t('  坐标命中：elementsFromPoint', img.includes('document.elementsFromPoint'));
t('  容器里找大图（兜底）', img.includes("box.querySelectorAll('img')"));
t('  支持 background-image 容器', img.includes('isBackground'));
t('原始事件记录器（排查用）', img.includes('logEvt'));
t('每个过滤点都记 skip 原因', img.includes('S.lastSkip'));
t('小图标不翻', img.includes('w < 120 || h < 80'));
t('跨域图有明确错误', img.includes("error: 'tainted'"));
t('跨域图走 background 抓取', img.includes('resolveUsableImage') && img.includes('tryLoadCrossOrigin'));
t('background 有 fetchImage', bg.includes("msg.t === 'fetchImage'"));
t('background 有 blobToDataUrl', bg.includes('function blobToDataUrl'));
t('content 注入了 imageLoader', ct.includes('setImageLoader'));
t('用户诊断入口 __DSH_IMG_DIAG', img.includes('__DSH_IMG_DIAG'));
t('mousedown 触发（click 可能被吞）', img.includes("addEventListener('mousedown', onDocMouseDown"));
t('click 兜底 + 去重', img.includes('S.lastTrigger'));
t('busy 防重入', img.includes('S.busy'));
t('可中断（seq 比对）', img.includes('seq !== S.seq'));

// ===== 引擎侧 =====
t('图片 prompt 禁止输出原文', dsh.includes('不要输出原文'));
t('图片 prompt 禁止重复', dsh.includes('不要重复'));
t('★ prompt 定性为 OCR 任务', dsh.includes('OCR）与翻译任务'));
t('★ prompt 禁止描述画面', dsh.includes('不要描述画面内容'));
t('★ prompt 无文字兜底', dsh.includes('（无文字）'));
t('★ **没有 few-shot 示例**（2B 模型会照抄）', dsh.includes('绝对不要给示例输出'));
t('图像描述识别 looksLikeCaption', dsh.includes('function looksLikeCaption'));
t('★ 两阶段流水线 visionTwoStage', dsh.includes('function visionTwoStage'));
t('  OCR 提示词（逐字照抄不翻译）', dsh.includes('逐字照抄原文'));
t('  OCR 用 vision 模型', dsh.includes("'vision'") && dsh.includes('ocrModel'));
t('  翻译用 translate 模型', dsh.includes("cfg.model) || 'translate'"));
t('  纯文本翻译通道 chatText', dsh.includes('async function chatText'));
t('  OCR 空结果时静默跳过', img.includes('跳过 = 静默忽略'));
t('  配置 twoStage', dsh.includes('twoStage: true'));
t('  配置 ocrModel', dsh.includes("ocrModel: 'vision'"));
t('可用译文提取 extractUsableImageText', dsh.includes('function extractUsableImageText'));
t('repeat_penalty 1.22', dsh.includes('repeat_penalty: 1.22'));
t('enable_thinking: false', dsh.includes('enable_thinking: false'));
t('pickTranslationOnly 剥双段落', dsh.includes('function pickTranslationOnly'));
t('dedupeLines 去重复', dsh.includes('function dedupeLines'));
t('叠词保护（心啊/好好好）', dsh.includes('中文叠词保护'));

// ===== CSS =====
t('overlay 层绝对定位', /\.dsh-imglayer\s*\{[^}]*position:\s*absolute/s.test(css));
t('overlay 不吃鼠标事件', /\.dsh-imglayer\s*\{[^}]*pointer-events:\s*none/s.test(css));
t('cell 白底黑字', /\.dsh-imgcell\s*\{[^}]*background:\s*#fff/s.test(css));
t('cell 无固定字号（由 JS 算）', !/\.dsh-imgcell\s*\{[^}]*font-size:\s*clamp/s.test(css));
t('面板深色浮层', /\.dsh-imgpanel\s*\{[^}]*position:\s*fixed/s.test(css));
t('面板可滚动', /\.dsh-ip-body\s*\{[^}]*overflow-y:\s*auto/s.test(css));

// ===== 设置页 =====
t('设置页有图片翻译开关', optHtml.includes('data-key="imageTranslate"') || optHtml.includes('imageTranslate'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
