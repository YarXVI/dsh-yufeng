/* 右键菜单测试。
   Alt+点击在某些页面永远不灵（透明覆盖层 / preventDefault / Alt 被截获），
   所以右键菜单是必须有的可靠入口。
   node test/contextmenu.test.js（静态）+ messagecontext.test.js（真机） */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const bg = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const img = fs.readFileSync(path.join(__dirname, '..', 'src', 'imgtranslate.js'), 'utf8');
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

// ===== 权限 =====
t('manifest 有 contextMenus 权限', mf.permissions.indexOf('contextMenus') >= 0);

// ===== 四项菜单 =====
t('图片翻译菜单', bg.indexOf('dsh-image') >= 0 && bg.indexOf("contexts: ['image']") >= 0);
t('选中文字菜单', bg.indexOf('dsh-selection') >= 0 && bg.indexOf("contexts: ['selection']") >= 0);
t('整页翻译菜单', bg.indexOf('dsh-page') >= 0 && bg.indexOf("contexts: ['page']") >= 0);
t('还原菜单', bg.indexOf('dsh-restore') >= 0);
t('菜单有中文标题', bg.indexOf('用 DSH 翻译这张图的文字') >= 0);

// ===== 幂等注册（这是踩过的坑）=====
t('onInstalled 时注册', bg.indexOf('chrome.runtime.onInstalled.addListener') >= 0);
t('onStartup 时也注册', bg.indexOf('chrome.runtime.onStartup.addListener') >= 0);
t('SW 冷启动时也注册', /try \{ installContextMenus\(\); \}/.test(bg));
t('先试创建，撞车才 removeAll', bg.indexOf('function doCreate') >= 0 && bg.indexOf('dup1') >= 0);
t('检测 duplicate id', bg.indexOf("indexOf('duplicate')") >= 0);
t('重试延时 250ms', bg.indexOf('}, 250)') >= 0);
t('有失败告警', bg.indexOf('[DSH] 右键菜单注册失败') >= 0);

// ===== 点击分发 =====
t('onClicked 分发 4 项', bg.indexOf('dsh-image') >= 0 && bg.indexOf("'dsh-page'") >= 0);
t('图片菜单带 srcUrl', bg.indexOf('info.srcUrl') >= 0);
t('图片菜单带坐标', bg.indexOf('info.clientX') >= 0);

// ===== content 侧处理 =====
t('content 处理 dsh-image', ct.indexOf("case 'dsh-image'") >= 0);
t('content 处理 dsh-page-translate', ct.indexOf("case 'dsh-page-translate'") >= 0);
t('content 处理 dsh-restore-all', ct.indexOf("case 'dsh-restore-all'") >= 0);
t('dsh-image 用坐标反查图', ct.indexOf('findImageAt') >= 0);
t('dsh-image 用 URL 兜底', ct.indexOf('findImageByUrl') >= 0);

// ===== 模块侧 =====
t('模块有 findImageAt', img.indexOf('findImageAt:') >= 0);
t('模块有 findImageByUrl', img.indexOf('findImageByUrl:') >= 0);
t('URL 匹配 currentSrc', img.indexOf('currentSrc === url') >= 0);
t('URL 兜底忽略 query', img.indexOf("split('?')[0]") >= 0);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);