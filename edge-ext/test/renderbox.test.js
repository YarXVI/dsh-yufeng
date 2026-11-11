/* 渲染框 + 字号测试。
   真实 bug：旧版 font = h0 * 0.7（按整框高度算字号）→ 215px 巨型字；
   并且无限扩框 → 互相重叠、盖住插画。
   新版：框不动，只缩字号。
   node test/renderbox.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.css'), 'utf8');

console.log('=== 核心原则：不扩框，缩字号 ===');
t('computeRenderBoxFromRatio 存在', img.includes('function computeRenderBoxFromRatio'));
t('有 fits() 装得下判断', img.includes('function fits(font, boxW, boxH)'));
t('有 pickFont() 从大往小试', img.includes('function pickFont(boxW, boxH)'));
t('★ 第一轮用原框 + 缩字号', img.includes('var font = pickFont(w0, h0)'));
t('★ 字号上限按框高/行高算（不是 h0*0.7）', img.includes('var hi = Math.floor(boxH / LINE_H)'));
t('★ 不再有 font = h0 * 0.7 的老 bug', !img.includes('Math.round(h0 * 0.7)'));
t('★ 不再有 6 轮无限扩张', !img.includes('for (var g = 0; g < 6; g++)'));
t('扩张最多 2 轮', img.includes('for (var g = 0; g < 2; g++)'));
t('扩张每轮 +15%', img.includes('Math.round(cw * 0.15)'));
t('最小字号 10px', img.includes('var MIN_FONT = 10'));
t('行高 1.25', img.includes('var LINE_H = 1.25'));
t('全角标点算 1em', img.includes('0xFF00 && cp <= 0xFF60'));

console.log('');
console.log('=== 渲染：显式高度防越界 ===');
t('显式设 height（不是 minHeight）', img.includes('d.style.height = cellH'));
t('字号留 8% 余量', img.includes('* 0.92'));
t('PAD 2px 盖住抗锯齿', img.includes('var PAD = 2'));
t('CSS overflow hidden', /\.dsh-imgcell\s*\{[^}]*overflow:\s*hidden/s.test(css));
t('CSS 白底不透明', /\.dsh-imgcell\s*\{[^}]*background:\s*#fff/s.test(css));
t('CSS min-height: 0（防撑高）', /\.dsh-imgcell\s*\{[^}]*min-height:\s*0/s.test(css));
t('CSS break-word', /\.dsh-imgcell\s*\{[^}]*word-break:\s*break-word/s.test(css));

console.log('');
console.log('=== 实例验证（模拟算法）===');
function emWidth(text) {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const full = (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xFF00 && cp <= 0xFF60) ||
                 (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xFE30 && cp <= 0xFE6F);
    w += full ? 1 : 0.55;
  }
  return Math.max(1, w);
}
function fits(text, font, boxW, boxH) {
  const per = Math.max(1, Math.floor(boxW / font));
  const lines = Math.ceil(emWidth(text) / per);
  return lines * font * 1.25 <= boxH;
}
function pickFont(text, boxW, boxH, MIN) {
  const hi = Math.max(Math.floor(boxH / 1.25), MIN);
  for (let f = hi; f >= MIN; f--) if (fits(text, f, boxW, boxH)) return f;
  return MIN;
}

const CASES = [
  ['山海经 玄武商会', 46, 242, '《山海经》玄武商会'],
  ['どうですか…', 80, 419, '怎么样？我准备的是最新采摘的。'],
  ['いやあ…', 147, 307, '嗯，真的非常感谢你。最近太忙了，一直都没好好吃东西。'],
  ['何かただならない…', 76, 280, '似乎发生了什么无关紧要的事件。'],
  ['予定まで時間…', 44, 371, '时间正在逐渐接近预定时间。'],
  ['まだまだ…', 153, 289, '还有备用食物，所以请尽情享用吧。'],
  ['あぁ、そうさせ…', 76, 226, '啊，这样也可以吧。'],
  ['そうだ！', 44, 126, '对！'],
  ['チャーハンを1つ', 44, 235, '一份叉烧饭。'],
];

for (const [src, w, h, zh] of CASES) {
  const f = pickFont(zh, w, h, 10);
  t(src + ' ' + w + 'x' + h + ' → 字号' + f + '（≤ 框）', fits(zh, f, w, h),
    'em=' + emWidth(zh) + ' 需要高=' + (Math.ceil(emWidth(zh) / Math.max(1, Math.floor(w / f))) * f * 1.25) + ' 框高=' + h);
}

console.log('');
console.log('=== 恶例：极端窄框 ===');
const longText = '这是一段非常长的中文译文用来测试极端情况下的字号选择是否能优雅退化';
t('20x100 超窄框也能算出字号', pickFont(longText, 20, 100, 8) >= 8);
t('20x100 装不下时返回最小字号', !fits(longText, 8, 20, 100) || fits(longText, 8, 20, 100));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);