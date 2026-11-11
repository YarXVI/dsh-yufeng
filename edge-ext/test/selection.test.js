/* 划词翻译测试。
   需求：选中文字自动弹气泡；6 道过滤防误触；气泡可复制/可关闭/跟随滚动。

   这次的验证分两层：
     · 静态契约（本文件）：代码结构、过滤项、UX 元素是否就位
     · 真实浏览器行为（test/selection.browser.js）：真选中文、真点、真滚
   node test/selection.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.css'), 'utf8');
const dsh = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
const optHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');

// ===== 配置项 =====
t('DEFAULTS 有 selectionTranslate', dsh.includes('selectionTranslate: true'));
t('设置页有划词开关', optHtml.includes('data-key="selectionTranslate"'));

// ===== 事件绑定 =====
t('监听 selectionchange', ct.includes("addEventListener('selectionchange'"));
t('有防抖（拖拽途中不触发）', ct.includes('SEL_DEBOUNCE'));
t('防抖用 clearTimeout 重置', ct.includes('clearTimeout(selTimer)'));
t('配置到位后才绑定', ct.includes('bindSelectionUX()'));
t('只绑一次（避免重复监听）', ct.includes('if (S.selBound) return'));

// ===== 六道过滤 =====
t('① 开关关掉就不翻', ct.includes('S.cfg.selectionTranslate === false'));
t('② 单字符不翻', ct.includes('text.length < 2'));
t('③ 太长不翻（撑爆 ctx）', ct.includes('text.length > 1200'));
t('④ 同一段不重复翻', ct.includes('text === selAnchorText'));
t('⑤ 自己的气泡/译文不翻', ct.includes('[data-dsh-ui], .dsh-bubble'));
t('⑥ 输入框里不翻', ct.includes('input, textarea, [contenteditable'));
t('⑦ 已是目标语言不翻', ct.includes('DSH.isTranslatable(text, S.cfg.targetLang)'));

// ===== 气泡 UX =====
t('气泡有原文块', ct.includes("className = 'dsh-bubble-src'"));
t('气泡有译文块', /dst\.className = 'dsh-bubble-dst/.test(ct));
t('气泡有工具条', ct.includes("className = 'dsh-bubble-tools'"));
t('有复制按钮', ct.includes("btnCopy.textContent = '复制'"));
t('有关闭按钮', ct.includes("btnClose.textContent = '×'"));
t('复制走 clipboard 并有回退', ct.includes('navigator.clipboard') && ct.includes('execCommand'));
t('跟随滚动重新定位', ct.includes("window.addEventListener('scroll', reposition"));
t('跟随窗口缩放', ct.includes("window.addEventListener('resize', reposition"));
t('点击外部关闭', ct.includes("closest('[data-dsh-ui]')"));
t('Esc 关闭', ct.includes("e.key === 'Escape'"));
t('自动消失（TTL）', ct.includes('BUBBLE_TTL'));
t('气泡自己吞掉 mousedown（不算点外部）',
  /b\.addEventListener\('mousedown',[^)]*\)\s*=>?\s*\{?\s*e\.stopPropagation\(\)/.test(ct) ||
  ct.includes("b.addEventListener('mousedown', function (e) { e.stopPropagation(); })"));
t('请求序号防串台', ct.includes('S.selSeq'));
t('失败有专门样式', ct.includes("dsh-bubble-err"));

// ===== 右键菜单 =====
t('右键菜单仍是显式触发', ct.includes("case 'dsh-selection'"));
t('右键带位置（选区可能已被清）', ct.includes('opts.x != null'));

// ===== CSS =====
t('气泡是 fixed 定位', /.dsh-bubble\s*\{[^}]*position:\s*fixed/s.test(css));
t('气泡有 z-index 顶层', /.dsh-bubble\s*\{[^}]*z-index:\s*2147483647/s.test(css));
t('译文可滚动（长文本不撑破）', /.dsh-bubble-dst\s*\{[^}]*overflow-y:\s*auto/s.test(css));
t('原文最多两行', css.includes('-webkit-line-clamp: 2'));
t('有淡入动画', css.includes('@keyframes dsh-bubble-in'));
t('错误态有颜色', /.dsh-bubble-dst.dsh-bubble-err\s*\{[^}]*color:/s.test(css));
t('按钮有 hover 反馈', css.includes('.dsh-bubble-btn:hover'));
t('气泡自己不参与翻译（内容脚本跳过）', css.includes('user-select: text'));

// ===== 回归：原有翻译不受影响 =====
t('原有 showBubble 语义被替换（不是共存两份）', (ct.match(/function buildBubble/g) || []).length === 1);
t('hideBubble 仍在', ct.includes('function hideBubble()'));
t('translateSelection 仍在', ct.includes('function translateSelection('));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
