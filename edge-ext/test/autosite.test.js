/* 自动翻译白名单测试。
   需求：默认不自动翻；只有明确加进白名单的站才自动翻。
   踩过的坑：原来是黑名单（autoOffSites），等于「默认全开」——
   没列过的站全都自动翻，浪费 NPU 算力，还可能在用户不想翻的站上乱翻。
   node test/autosite.test.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const dshSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'dsh.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8');
const optHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.html'), 'utf8');

// 1. 配置项
t('DEFAULTS 有 autoOnSites', dshSrc.includes('autoOnSites: []'));
t('DEFAULTS 有 autoOffSites', dshSrc.includes('autoOffSites: []'));
t('默认 autoTranslate 关闭', /autoTranslate:\s*false/.test(dshSrc));

// 2. content.js 的白名单判定
t('maybeAuto 读 autoOnSites', contentSrc.includes('cfg.autoOnSites'));
t('不在白名单就不翻', contentSrc.includes('if (on.indexOf(origin) < 0) return;'));
t('黑名单优先', contentSrc.includes('var off = Array.isArray(cfg.autoOffSites)') && contentSrc.indexOf('off.indexOf(origin) >= 0') < contentSrc.indexOf('on.indexOf(origin) < 0'));

// 3. background 消息
t('有 getSiteAuto 消息', bgSrc.includes("msg.t === 'getSiteAuto'"));
t('有 setSiteAuto 消息', bgSrc.includes("msg.t === 'setSiteAuto'"));
t('setSiteAuto 支持开/关', bgSrc.includes('if (msg.enabled)') && bgSrc.includes('} else {'));
t('开时从黑名单移除（互斥）', bgSrc.includes('if (oi >= 0) off.splice(oi, 1)'));
t('开时顺带打开总开关', bgSrc.includes('if (msg.enabled) next.autoTranslate = true'));
t('设置后广播到页面', bgSrc.includes('await broadcast(merged)'));

// 4. 弹窗 UI
t('弹窗有 autoSite 开关', popupHtml.includes('id="autoSite"'));
t('弹窗有说明文字', popupHtml.includes('id="autoSiteHint"'));
t('开关是 checkbox', popupHtml.includes('type="checkbox" id="autoSite"'));
t('弹窗读取站点状态', popupJs.includes("t: 'getSiteAuto'"));
t('弹窗写入站点状态', popupJs.includes("t: 'setSiteAuto'"));
t('本地/内置页面禁用开关', popupJs.includes('file:|chrome-extension:|edge:|about:'));
t('打开时顺带翻当前页', popupJs.includes("sendTab({ t: 'dsh-toggle' })"));

// 5. 设置页 UI
t('设置页有白名单输入框', optHtml.includes('data-key="autoOnSites"'));
t('设置页说明是白名单机制', optHtml.includes('只有列在这里的站会自动翻'));

// 6. 行为模拟：白名单判定
function shouldAuto(cfg, origin) {
  if (!cfg.autoTranslate) return false;
  var off = cfg.autoOffSites || [];
  if (off.indexOf(origin) >= 0) return false;
  var on = cfg.autoOnSites || [];
  return on.indexOf(origin) >= 0;
}
t('总开关关 → 不翻', shouldAuto({ autoTranslate: false, autoOnSites: ['https://a.com'] }, 'https://a.com') === false);
t('在白名单 → 翻', shouldAuto({ autoTranslate: true, autoOnSites: ['https://a.com'] }, 'https://a.com') === true);
t('不在白名单 → 不翻（默认全关）', shouldAuto({ autoTranslate: true, autoOnSites: ['https://a.com'] }, 'https://b.com') === false);
t('在两个名单里 → 黑名单优先', shouldAuto({ autoTranslate: true, autoOnSites: ['https://a.com'], autoOffSites: ['https://a.com'] }, 'https://a.com') === false);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
