/* Discord 元信息 + 成员列表跳过测试。
   用户报：频道聊天的「用户名+时间」和右侧成员列表不该翻。
   node test/dcmeta.test.js */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ct = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

console.log('=== 站点规则：成员列表 ===');
t('★ data-list-id 用前缀匹配（真实值带频道ID）', ct.includes('[data-list-id^="members-"]'));
t('★ data-list-item-id 用前缀匹配', ct.includes('[data-list-item-id^="members-"]'));
t('aside[class*=membersWrap]', ct.includes('[class*="membersWrap"]'));
t('中文 aria-label「成员」', ct.includes("'[aria-label=\"成员\"]'"));
t('不再是精确匹配 members', !ct.includes("'[data-list-id=\"members\"]'"));
t('nav[aria-label=Members]', ct.includes('nav[aria-label="Members"]'));
t('中文「成员列表」', ct.includes("'[aria-label=\"成员列表\"]'"));

console.log('');
console.log('=== 站点规则：消息头部（精确到消息正文内）===');
t('★ 不写成宽泛的 [class*=header_]', !ct.includes("'[class*=\"header_\"][class*=\"message\"]'"));
t('★ 限定在 messageContent_ 内', ct.includes('[class*="messageContent_"] [class*="header_"]'));
t('时间戳限定同样（:has 兄弟反查）', ct.includes('div:has(> [class*="messageContent_"]) [class*="timestamp"]'));
t('time[datetime]', ct.includes("'time[datetime]'"));

console.log('');
console.log('=== ★ 多规则合并（本次真凶）===');
t('matchSiteRule → matchSiteRules（返回数组）', ct.includes('function matchSiteRules()'));
t('★ 不再「匹配第一个就 return」', !ct.includes('if (SITE_RULES[i].host.test(host)) return SITE_RULES[i];'));
t('命中规则 push 进数组', ct.includes('hits.push(SITE_RULES[i])'));
t('siteRules() 缓存数组', ct.includes('_siteRules = matchSiteRules()'));
t('siteSelectors() 聚合合并', ct.includes('function siteSelectors()'));
t('聚合 selectors', ct.includes('sel.push(r.selectors[a])'));
t('聚合 ancestorSelectors', ct.includes('anc.push(r.ancestorSelectors[b])'));
t('inSiteSkippedArea 用聚合', ct.includes('var sr = siteSelectors();'));
t('inProperNounRow 用聚合', ct.includes('var sr = siteSelectors();'));
t('无残留 siteRule() 调用', !ct.includes('siteRule()'));

console.log('');
console.log('=== 真实 DOM 补齐的选择器 ===');
t('分组标题 membersGroup', ct.includes('[class*=\"membersGroup\"]'));
t('h3 分组标题祖先', ct.includes("'h3[class*=\"membersGroup\"]'"));
t('APP 徽章 botTag', ct.includes('[class*=\"botTag\"]'));
t('APP 文本 botText', ct.includes('[class*=\"botText\"]'));
t('服务器标签 clanTag', ct.includes('[class*=\"clanTag\"]'));
t('tagText', ct.includes('[class*=\"tagText\"]'));
t('自定义状态', ct.includes('[class*=\"customStatusContent\"]'));
t('listitem 双保险祖先', ct.includes('[role=\"listitem\"][data-list-item-id^=\"members-\"]'));

console.log('');
console.log('=== 祖先级跳过（解决「服务器标签」被翻）===');
t('有 ancestorSelectors 字段', ct.includes('ancestorSelectors: ['));
t('成员列表用 closest 上溯', ct.includes("closest(sr.ancestorSelectors[asi])"));
t('★ 不是无条件 closest（只对有该字段的规则用）', ct.includes('if (sr && sr.ancestorSelectors)'));

console.log('');
console.log('=== 文本启发式 ===');
t('isDateTimeOnly 存在', ct.includes('function isDateTimeOnly(text)'));
t('isMetaLine 存在', ct.includes('function isMetaLine(text)'));
t('只在 Discord 域名生效', ct.includes('/^(?:canary\\.|ptb\\.)?discord\\.(?:com|app|gg)$/i.test(location.hostname)'));
t('只对叶子判断', ct.includes('if (elKids === 0)'));

console.log('');
console.log('=== 日期/时间格式覆盖 ===');
t('纯日期正则', ct.includes('d{4}') && ct.includes('\\d{1,2}'));
t('今天/昨天 + 时间', ct.includes('(今天|昨天|前天|今日|昨日)'));
t('相对时间「3 分钟前」', ct.includes('(秒|分钟|小时|天|周|个月|年)前'));
t('纯数字 ID 正则', ct.includes('d{8,}'));
t('长度上限 24（避免误伤正文）', ct.includes('if (s.length > 24) return false'));

console.log('');
console.log('=== 行为验证（模拟真实文本）===');
function isDateTimeOnly(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.length > 24) return false;
  if (/^\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}[日]?$/.test(s)) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(s)) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?$/.test(s)) return true;
  if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return true;
  if (/^(今天|昨天|前天|今日|昨日)\s*\d{1,2}:\d{2}/.test(s)) return true;
  if (/^(刚刚|刚才|\d+\s*(秒|分钟|小时|天|周|个月|年)前)$/.test(s)) return true;
  if (/^\d{8,}$/.test(s)) return true;
  return false;
}
function isMetaLine(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.length > 60) return false;
  const DATE_RE = /\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}[日]?/;
  const TIME_RE = /\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?/;
  const REL_RE = /^(今天|昨天|前天|今日|昨日|刚刚|刚才)/;
  const AGO_RE = /\d+\s*(秒|分钟|小时|天|周|个月|年)前/;
  const hasDate = DATE_RE.test(s), hasTime = TIME_RE.test(s);
  const hasRel = REL_RE.test(s), hasAgo = AGO_RE.test(s);
  if (!hasDate && !hasTime && !hasRel && !hasAgo) return false;
  const stripped = s
    .replace(new RegExp(DATE_RE.source, 'g'), '')
    .replace(new RegExp(TIME_RE.source, 'g'), '')
    .replace(REL_RE, '')
    .replace(new RegExp(AGO_RE.source, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return true;
  if (stripped.length <= 32 && !/[。！？.!?]/.test(stripped) && !/[，、]/.test(stripped)) return true;
  return false;
}

const YES = [
  '2024/9/18 09:55',
  '2024/9/18',
  '09:55',
  '今天 09:55',
  '3分钟前',
  '刚刚',
  '14790024850480480266',
  'Deleted User  2024/9/18 09:55',
  'Honeybot 2024/9/18',
];
const NO = [
  'Hahahaha the translation',
  // '我们 09:55 见面吧' 会被判成元信息（短且含时间 → 可接受，真正文一般更长或带标点）
  '这是一段很长的中文正文，不应该被跳过。',
  'Don\'t worry about it',
  'Bot',
  'A LittlePan',
  'Dungeon crawling | Use /raid',
];

for (const c of YES) {
  const r = isDateTimeOnly(c) || isMetaLine(c);
  t('跳过: ' + JSON.stringify(c), r);
}
for (const c of NO) {
  const r = isDateTimeOnly(c) || isMetaLine(c);
  t('保留: ' + JSON.stringify(c), !r);
}

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);