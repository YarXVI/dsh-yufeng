/* 两阶段图片翻译流水线测试。
   vision OCR → translate 翻译。
   为什么必须两阶段：实测 translate 兼职 OCR 时，竖排日文识别全错。
   node test/twostage.test.js */
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
const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

console.log('=== 两阶段流水线的静态契约 ===');
t('导出 visionTwoStage', dsh.includes('visionTwoStage: visionTwoStage'));
t('导出 chatText', dsh.includes('chatText: chatText'));
t('导出 buildTextTranslatePrompt', dsh.includes('buildTextTranslatePrompt'));
t('OCR 提示词明确「不翻译」', dsh.includes('不要翻译'));
t('OCR 提示词明确「不描述画面」', dsh.includes('不要描述画面'));
t('OCR 提示词有无文字兜底', dsh.includes('（无文字）'));
t('两阶段先 OCR 后翻译', dsh.indexOf('chatVision') < dsh.indexOf('chatText(base'));
t('OCR 失败时退一步到位', dsh.includes('return await visionTranslateBlock(base, cfg, dataUrl, opts)'));
t('OCR 空结果返回 skipped', dsh.includes('ocrMs') && dsh.includes('skipped: true'));
t('翻译结果再过滤一次', dsh.includes('extractUsableImageText(transRes.content'));
t('返回 ocrMs / transMs 分项耗时', dsh.includes('ocrMs: ocrMs') && dsh.includes('transMs: transMs'));

console.log('');
console.log('=== background 接线 ===');
t('background 走两阶段', bg.includes('DSH.visionTwoStage'));
t('可用 oneShot 强制一步到位', bg.includes('msg.oneShot'));
t('twoStage 可配关闭', bg.includes('cfg.twoStage !== false'));

console.log('');
console.log('=== 提示词内容 ===');
const prompt = DSH.buildTextTranslatePrompt('こんにちは', '简体中文');
t('文本翻译 prompt 含原文', prompt.includes('こんにちは'));
t('文本翻译 prompt 含目标语言', prompt.includes('简体中文'));
t('文本翻译 prompt 要求只输出译文', prompt.includes('只输出译文'));

console.log('');
console.log('=== 配置 ===');
t('DEFAULTS.twoStage = true', DSH.DEFAULTS.twoStage === true);
t('DEFAULTS.ocrModel = vision', DSH.DEFAULTS.ocrModel === 'vision');

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);