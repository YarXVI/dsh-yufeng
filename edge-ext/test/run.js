/* 一键跑全部离线测试：node test/run.js
   加 --live http://host:47300 会连真实 DSH 一起跑 */
'use strict';
var cp = require('node:child_process');
var path = require('node:path');

var live = process.argv.includes('--live');
var ep = live ? (process.argv[process.argv.indexOf('--live') + 1] || 'http://127.0.0.1:47300') : '';

var cases = [
  ['引擎单测', ['engine.test.js']],
  ['内容脚本', ['content.smoke.js']],
  ['富文本解析', ['richparse.test.js']],
  ['语言判定', ['langdetect.test.js']],
  ['数字保护', ['numbers.test.js']],
  ['站点规则', ['siterules.test.js']],
  ['缓存键', ['cache.test.js']],
  ['术语表', ['glossary.test.js']],
  ['稳定性', ['stability.test.js']],
  ['缓存卫生', ['cachehygiene.test.js']],
  ['翻译判定', ['detection.test.js']],
  ['提示词卫生', ['prompt.test.js']],
  ['缓存界面', ['cacheui.test.js']],
  ['数字阈值', ['numberthreshold.test.js']],
  ['自动翻译白名单', ['autosite.test.js']],
  ['下拉框样式', ['select.test.js']],
  ['划词翻译', ['selection.test.js']],
  ['图片翻译', ['image.test.js']],
  ['右键菜单', ['contextmenu.test.js']],
  ['图像描述过滤', ['caption.test.js']],
  ['两阶段流水线', ['twostage.test.js']],
  ['整页模式', ['pagemode.test.js']],
  ['形态学检测', ['morphology.test.js']],
  ['渲染框字号', ['renderbox.test.js']],
  ['翻页清场', ['pageflip.test.js']],
  ['自动翻译', ['autoimg.test.js']],
  ['DC 元信息跳过', ['dcmeta.test.js']],
  ['反向翻译', ['reverse.test.js']],
  ['设置页', ['options.smoke.js']],
  ['自动发现', ['discover.test.js']]
];
if (live) {
  cases.push(['浏览器端到端', ['e2e.browser.js']]);
  cases.push(['富文本格式', ['rich.browser.js']]);
  cases.push(['Discord 富文本', ['richtags.browser.js']]);
  cases.push(['图标与侧栏', ['icons.browser.js']]);
  cases.push(['特殊文本格式', ['formats.browser.js']]);
  cases.push(['Discord 结构', ['discord.browser.js']]);
  cases.push(['nhentai 标签页', ['nhentai.browser.js']]);
  cases.push(['划词翻译（浏览器）', ['selection.browser.js']]);
  cases.push(['图片翻译（浏览器）', ['image.browser.js']]);
  cases.push(['跨域图片翻译', ['crossorigin.browser.js']]);
  cases.push(['透明覆盖层目标', ['overlaytarget.browser.js']]);
  cases.push(['引擎集成', ['engine.test.js', '--live', ep]]);
  cases.push(['后台冒烟', ['background.smoke.js', ep]]);
}

var failed = 0;
cases.forEach(function (c) {
  console.log('');
  console.log('### ' + c[0]);
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, c[1][0])].concat(c[1].slice(1)), { stdio: 'inherit' });
  if (r.status !== 0) failed++;
});
console.log('');
console.log(failed ? ('FAILED ' + failed + ' 组') : 'ALL TESTS PASSED');
process.exit(failed ? 1 : 0);
