/* 引擎单测（不需要 NPU）：node test/engine.test.js
   加 --live http://host:47300 会跑真实集成测试 */
'use strict';
var path = require('node:path');
var DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

var pass = 0, fail = 0, failures = [];
function ok(name, cond, extra) { if (cond) { pass++; return; } fail++; failures.push(name + (extra ? '  -> ' + extra : '')); }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function section(t) { console.log('== ' + t + ' ' + '='.repeat(Math.max(0, 50 - t.length))); }

section('编号行解析');
var p1 = DSH.parseNumbered('1. 你好\n2. 再见', 2);
eq('标准编号', p1.parts, ['你好', '再见']);
ok('无缺段', p1.missing.length === 0);
var p2 = DSH.parseNumbered('1) 你好\n3) 第三', 3);
eq('括号编号 + 缺段', p2.parts, ['你好', '', '第三']);
eq('缺段下标', p2.missing, [1]);
var p3 = DSH.parseNumbered('1、甲\n2、乙', 2);
eq('顿号编号', p3.parts, ['甲', '乙']);
var p4 = DSH.parseNumbered('1. 第一段\n还是第一段\n2. 第二段', 2);
eq('编号内可多行', p4.parts, ['第一段\n还是第一段', '第二段']);
ok('行对齐兜底', JSON.stringify(DSH.parseLines('甲\n乙', 2)) === JSON.stringify(['甲', '乙']));
ok('行数不匹配就放弃', DSH.parseLines('甲', 2) === null);

section('标签保护');
// 策略（v2.0）：方括号里的「元数据标签」和「拉丁专名」尽量保护，
// 但如果保护完「剩下的可翻文字太少」，就退回只保护真正的元数据标签 ——
// 否则模型面对几乎空的正文只会原样返回，用户看到「这条没翻」。
var T = '[Asanine Luno] April Fool [English] [Crystallized] [Digital]';
var pt = DSH.protectTags(T);
ok('只保护元数据标签（专名回退）', pt.tags.length === 3, JSON.stringify(pt.tags));
ok('作者名留在可翻文本里', pt.text.indexOf('Asanine') >= 0, pt.text);
ok('往返一致', DSH.restoreTags(pt.text, pt.tags) === T);

var T2 = '[Aoi Hoshi (Sabajiba Gonhachirou)] L-Cup 2 [中文]';
var pt2 = DSH.protectTags(T2);
ok('同样回退（只剩作者名和短正文）', pt2.tags.length === 1, JSON.stringify(pt2.tags));
ok('作者名留在可翻文本里（长标题）', pt2.text.indexOf('Sabajiba') >= 0, pt2.text);
ok('往返一致（作者名）', DSH.restoreTags(pt2.text, pt2.tags) === T2);

// 长副标题的混合标题：保护专名，保留正文
var T3 = '[Nishiki no Yokuen(Shikou Shiki Nishikino Niki)] Lustkreis ~ Saitei Gunjin no Meirei ni Nureru Hibu Kensa [Digital]';
var pt3 = DSH.protectTags(T3);
ok('长标题仍保护专名', pt3.tags.length === 2, JSON.stringify(pt3.tags));
ok('副标题留在可翻文本里', pt3.text.indexOf('Lustkreis') >= 0, pt3.text);

// 不含大写字母的普通括号短语不该被保护（要交给模型翻）
var pt4 = DSH.protectTags('note (see below) here');
ok('普通括号短语不保护', pt4.tags.length === 0, JSON.stringify(pt4.tags));
ok('还原不带占位符', !DSH.restoreTags(pt.text, pt.tags).includes(String.fromCharCode(0xe000)));

section('可译性');
ok('日文标题要翻', DSH.isTranslatable('「[藤のりひろ] 親友の彼女と寝取りセックス～【R版】(1-3)」', '简体中文') === true);
ok('混排要翻', DSH.isTranslatable('[Ramen Rice] Ibuki to Suyasuya | 与伊吹一起 [Chinese]', '简体中文') === true);
ok('纯英文要翻', DSH.isTranslatable("April Fool's Finale [English] [Digital]", '简体中文') === true);
ok('纯中文段落不翻', DSH.isTranslatable('这是一段完全由中文组成的正文内容。', '简体中文') === false);
ok('纯数字不翻', DSH.isTranslatable('22:57:25', '简体中文') === false);
ok('URL 不翻', DSH.isTranslatable('https://example.com/x', '简体中文') === false);
ok('目标英文时中文要翻', DSH.isTranslatable('这是一段中文', 'English') === true);

section('漏翻检测');
ok('原样返回判为漏翻', DSH.looksUntranslated('Hello world', 'Hello world', '简体中文') === true);
ok('只差空格判为漏翻', DSH.looksUntranslated('Hello world', 'Hello  world', '简体中文') === true);
ok('真翻译不算漏翻', DSH.looksUntranslated('Hello world', '你好，世界', '简体中文') === false);
ok('专名密集短标题不误判', DSH.looksUntranslated('[人生負組] NIKKEつR18版 #102', '[人生负组] NIKKEつR18版 #102', '简体中文') === false);

section('预算与工具');
ok('切批不丢段', DSH.splitForBudget({ contextTokens: 2048 }, new Array(60).fill('a long sentence about something, yes.'))
   .reduce(function (a, g) { return a + g.length; }, 0) === 60);
ok('短句不切', DSH.splitForBudget({ contextTokens: 2048 }, ['短句']).length === 1);
eq('baseOf 去 /v1', DSH.baseOf({ endpoint: 'http://127.0.0.1:47300/v1' }), 'http://127.0.0.1:47300');
eq('baseOf 去尾斜杠', DSH.baseOf({ endpoint: 'http://127.0.0.1:47300//' }), 'http://127.0.0.1:47300');
eq('挑 translate', DSH.pickModel(['memory', 'translate', 'chat'], []), 'translate');
eq('没有 translate 挑 chat', DSH.pickModel(['memory', 'chat'], []), 'chat');
eq('clean 去引号', DSH.clean('"你好"'), '你好');
eq('clean 去思维链', DSH.clean('<think>嗯</think>你好'), '你好');
ok('scriptStats 认假名', DSH.scriptStats('親友の彼女と寝取りセックス').kana >= 3,
  String(DSH.scriptStats('親友の彼女と寝取りセックス').kana));

section('并发与批大小');
ok('默认批大小 6', DSH.DEFAULTS.batchSize === 6, String(DSH.DEFAULTS.batchSize));
ok('默认并行 4 批', DSH.DEFAULTS.parallelBatches === 4, String(DSH.DEFAULTS.parallelBatches));
ok('单批不超上下文', (function () {
  var st = DSH.scriptStats('');
  return DSH.DEFAULTS.contextTokens >= 2048;
})());

section('重试护栏');
ok('默认不开启无限制重试', DSH.DEFAULTS.tagProtect === true);

section('提示词');
var pr = DSH.buildPrompt(DSH.DEFAULTS, ['你好', '世界']);
ok('多段带编号', pr.user.indexOf('1. 你好') >= 0 && pr.user.indexOf('2. 世界') >= 0);
ok('system 说明数字保真', pr.system.indexOf('Copy numbers') >= 0);
var pr1 = DSH.buildPrompt(DSH.DEFAULTS, ['hello']);
ok('单段不编号', pr1.user.indexOf('1. ') < 0);

console.log('='.repeat(52));
console.log(pass + ' 通过 / ' + fail + ' 失败');
if (fail) { failures.forEach(function (f) { console.log('  x ' + f); }); process.exit(1); }

if (process.argv.includes('--live')) {
  var ep = process.argv[process.argv.indexOf('--live') + 1] || 'http://127.0.0.1:47300';
  runLive(ep);
}

async function runLive(ep) {
  console.log('== 集成测试 ' + ep);
  var cfg = Object.assign({}, DSH.DEFAULTS, { endpoint: ep });
  var d = await DSH.diagnose(cfg);
  console.log('  自检 ' + (d.ok ? 'OK' : 'FAIL') + ' ' + d.ms + 'ms · ' + d.base + ' · ' + d.model +
    (d.ttft ? (' · 首字 ' + d.ttft + 'ms') : '') + (d.speed ? (' · ' + d.speed + ' tok/s') : ''));
  if (!d.ok) { console.log('  x ' + d.error); process.exit(1); }
  var segs = [
    'Welcome back! Your subscription expires in 3 days.',
    'Click here to renew before it is too late, or you will lose access.',
    '[Digital] [English] This work is licensed under CC BY 4.0.',
    'Token 余额仅剩 $0.0016，版本 v1.12.1 已发布。',
    'この作品は日本語で書かれています。'
  ];
  var t0 = Date.now();
  var events = 0;
  var res = await DSH.translateBatch(cfg, d.base, d.model, segs, function () { events++; });
  console.log('  批量 ' + segs.length + ' 段 ' + (Date.now() - t0) + 'ms，流式事件 ' + events);
  res.forEach(function (r, i) { console.log('    ' + i + ': ' + JSON.stringify(r)); });
  var empty = res.filter(function (r) { return !r; }).length;
  if (empty) { console.log('  x ' + empty + ' 段没翻出来'); process.exit(1); }
  var untranslated = segs.filter(function (s, i) { return DSH.looksUntranslated(s, res[i], '简体中文'); }).length;
  if (untranslated) { console.log('  x ' + untranslated + ' 段原样返回'); process.exit(1); }
  console.log('  OK 集成测试通过');
  process.exit(0);
}
