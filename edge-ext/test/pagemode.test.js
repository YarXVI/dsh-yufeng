/* 整页模式测试（不定位，只列表展示，覆盖率高）。
   node test/pagemode.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const dsh = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');
const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

console.log('=== 引擎 ===');
t('导出 visionPageTranslate', dsh.includes('visionPageTranslate: visionPageTranslate'));
t('整页 OCR 提示词锁死「一个气泡一行」', dsh.includes('一个气泡里的文字合并成一行'));
t('整页 OCR 禁止编号/翻译/描述', dsh.includes('不要编号，不要翻译，不要描述画面'));
t('OCR 结果去重', dsh.includes('var seen = {}'));
t('翻译用编号对齐', dsh.includes('必须保留每行开头的编号'));
t('剥掉行首编号', dsh.includes("replace(/^\\d+\\s*[.、)）]"));
t('返回 ocrMs / transMs 分项', dsh.includes('ocrMs: ocrMs,') && dsh.includes('transMs: transMs,'));
t('返回 missing 统计', dsh.includes('missing: Math.max(0'));

console.log('');
console.log('=== 模块 ===');
t('导出 translatePage', img.includes('translatePage: translatePage'));
t('setPageTranslator', img.includes('setPageTranslator'));
t('S.pageTranslator 字段', img.includes('pageTranslator: null'));
t('整页图片编码 wholeImageDataUrl', img.includes('function wholeImageDataUrl'));
t('Alt+Shift 切整页模式', img.includes('var wantPage = e.shiftKey'));
t('整页模式不盖 overlay', img.indexOf('translatePage') > 0 && img.includes('不定位，不盖图'));

console.log('');
console.log('=== 接线 ===');
t('background 有 translateImagePage', bg.includes("msg.t === 'translateImagePage'"));
t('content 有 setPageTranslator 注入', ct.includes('M.setPageTranslator'));
t('右键菜单有 dsh-image-page', bg.includes('dsh-image-page'));
t('右键菜单文案「整页识别」', bg.includes('整页识别这张图的文字'));
t('content 支持 mode=page', ct.includes("mode === 'page'"));

console.log('');
console.log('=== 提示词稳定性关键 ===');
const src = dsh.slice(dsh.indexOf('var OCR_PAGE_PROMPT'), dsh.indexOf('var OCR_PAGE_PROMPT') + 400);
t('提示词含「对话气泡」', src.includes('对话气泡'));
t('提示词含「合并成一行」', src.includes('合并成一行'));
t('提示词含「不要按物理换行拆开」', src.includes('不要按物理换行拆开'));

console.log('');
console.log('=== Surya 布局模式 ===');
t('引擎导出 suryaLayout', dsh.includes('suryaLayout: suryaLayout'));
t('引擎导出 parseSuryaLayout', dsh.includes('parseSuryaLayout: parseSuryaLayout'));
t('引擎导出 suryaTranslateRegions', dsh.includes('suryaTranslateRegions: suryaTranslateRegions'));
t('引擎导出 computeRenderBox', dsh.includes('computeRenderBox: computeRenderBox'));
t('引擎导出 chatVision', dsh.includes('chatVision: chatVision'));
t('只保留 Text 类 label', dsh.includes('Text|Page-Header|Page-Footer|Section-Header|Caption|Footnote|ListItem|Title'));
t('正则只匹配 Text 类（Image 自然排除）', dsh.includes('/^(Text|Page-Header|Page-Footer|Section-Header|Caption|Footnote|ListItem|Title)$/i'));
t('bbox 正则逐条抽取（不 JSON.parse）', dsh.includes('"label"\\s*:\\s*"([^"]+)"'));
t('坐标除以 1000 归一化', dsh.includes('parts[0] / 1000'));
t('模块导出 translateLayout', img.includes('translateLayout: translateLayout'));
t('模块有 setLayoutDetector', img.includes('setLayoutDetector'));
t('模块有 layoutDetector 字段', img.includes('layoutDetector: null'));
t('模块有 prepareImage', img.includes('function prepareImage'));
t('模块有 cropFromCanvas', img.includes('function cropFromCanvas'));
t('模块有 computeRenderBoxFromRatio', img.includes('function computeRenderBoxFromRatio'));
t('模块有 renderOverlayBoxes', img.includes('function renderOverlayBoxes'));
t('★ 新算法不区分竖排横排（统一缩字号）', !img.includes('h0 > w0 * 1.5'));
t('★ 扩张用固定 15%（不再按方向）', img.includes('Math.round(cw * 0.15)'));
t('★ 字号按「装得下」算，不按框高比例', img.includes('function pickFont(boxW, boxH)'));
t('background 有 detectImageLayout', bg.includes("msg.t === 'detectImageLayout'"));
t('content 注入 layoutDetector', ct.includes('M.setLayoutDetector'));
t('右键菜单有 dsh-image-layout', bg.includes('dsh-image-layout'));
t('ctrl+shift 切布局模式', img.includes('e.ctrlKey && e.shiftKey'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);