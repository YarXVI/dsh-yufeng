/* 下拉框统一样式测试。
   问题：原生 <select> 的展开面板由系统绘制，浅色主题跟暗色界面完全不搭。
   方案：appearance: base-select（Chromium 135+）让面板也能自绘；
        旧版走自绘收起态 + color-scheme: dark 降级。
   node test/select.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.css'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
const optHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');

// 1. 两个 select 都套了统一 class
t('popup 的 select 有 ui-select', popupHtml.includes('class="ui-select"'));
t('设置页的 select 有 ui-select', optHtml.includes('class="ui-select"'));

// 2. color-scheme: dark（让系统面板也用深色）
t(':root 声明 color-scheme: dark', /:root[^}]*color-scheme:\s*dark/.test(css));
t('.ui-select 声明 color-scheme: dark', /.ui-select[^}]*color-scheme:\s*dark/.test(css));

// 3. base-select 渐进增强
t('用 @supports 包裹 base-select', css.includes('@supports (appearance: base-select)'));
t('select 和 picker 都设 base-select', css.includes('.ui-select,\n  .ui-select::picker(select) {\n    appearance: base-select;'));
t('有 ::picker(select) 面板样式', css.includes('.ui-select::picker(select)'));
t('面板是深色卡片', /::picker\(select\)[^}]*background:\s*var\(--panel-2\)/s.test(css));
t('面板有圆角', /::picker\(select\)[^}]*border-radius/s.test(css));
t('面板有阴影', /::picker\(select\)[^}]*box-shadow/s.test(css));

// 4. 箭头
t('自绘箭头（SVG data URI）', css.includes("data:image/svg+xml"));
t('base-select 下用 ::picker-icon', css.includes('.ui-select::picker-icon'));
t('展开时箭头旋转', css.includes('.ui-select:open::picker-icon'));

// 5. 选中项
t('隐藏原生勾（避免双勾）', css.includes('.ui-select option::checkmark'));
t('自绘勾只有一份', (css.match(/content: "✓"/g) || []).length === 1);
t('选项 hover 高亮', css.includes('.ui-select option:hover'));

// 6. focus 可达性
t('focus 有可见轮廓', css.includes('.ui-select:focus') && css.includes('box-shadow'));

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
