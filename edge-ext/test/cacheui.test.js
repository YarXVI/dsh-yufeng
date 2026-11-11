/* 设置页缓存卡片测试：按钮必须绑定、状态必须能读出来。
   踩过的坑：wireCache() 定义了但从来没被调用，
   结果缓存区永远显示「读取中…」，清空按钮点了没反应。
   node test/options.smoke.js 的一部分（独立出来更清楚） */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');

// 1. DOM 元素存在
t('options.html 有 #cacheStat', html.includes('id="cacheStat"'));
t('options.html 有 #clearCacheBtn', html.includes('id="clearCacheBtn"'));

// 2. 关键函数都有调用（不是只定义）
function countCalls(code, name) {
  return (code.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
}
t('wireCache 被调用（不只看定义）', countCalls(src, 'wireCache') >= 2, '出现 ' + countCalls(src, 'wireCache') + ' 次');
t('paintCache 被调用', countCalls(src, 'paintCache') >= 2, '出现 ' + countCalls(src, 'paintCache') + ' 次');
t('refreshCache 被调用', countCalls(src, 'refreshCache') >= 2, '出现 ' + countCalls(src, 'refreshCache') + ' 次');

// 3. wireCache 里绑了 click
const wi = src.indexOf('function wireCache');
const wblock = src.slice(wi, wi + 400);
t('清空按钮绑了 click', wblock.includes("addEventListener('click'"));
t('清空发 clearCache 消息', wblock.includes("t: 'clearCache'"));
t('清空后刷新显示', wblock.includes('refreshCache'));

// 4. 读取失败要有提示（不能卡在「读取中…」）
t('有读取失败的兜底显示', src.includes('读取失败'));

// 5. background 的 cacheClearAll 要取消待写定时器
const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const ci = bg.indexOf('async function cacheClearAll');
const cblock = bg.slice(ci, ci + 700);
t('清空时取消 flush 定时器', cblock.includes('clearTimeout(S.diskTimer)'));
t('清空时重置统计', cblock.includes('S.hits = 0'));
t('清空时清术语参考', cblock.includes('S.recentTerms = []'));
t('清空时通知页面', cblock.includes('broadcastRaw('));

// 6. content script 响应 cacheCleared
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
t('content 响应 cacheCleared', ct.includes("case 'cacheCleared'"));

console.log('');

console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
