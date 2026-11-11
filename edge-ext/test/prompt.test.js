/* 提示词卫生测试：参考材料（术语表/旧译）绝不能进 user 消息 ——
   模型会把 user 里的英文说明当成要翻的内容，译成中文输出到页面上。
   真实截图为证：页面上冒出「本页面已使用的术语（重复相同渲染方式，不再翻译）：- 3小时27分钟前…」
   node test/prompt.test.js */
'use strict';
const path = require('node:path');
const DSH = require(path.join(__dirname, '..', 'src', 'dsh.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

// 1. 参考材料必须在 system 里，不能在 user 里
const cfg = { targetLang: '简体中文', pageTerms: [{ src: 'big breasts', dst: '大胸' }] };
const p1 = DSH.buildPrompt(cfg, ['ahegao']);
t('术语参考在 system', p1.system.indexOf('Terminology already used') >= 0);
t('术语参考不在 user', p1.user.indexOf('Terminology already used') < 0);
t('user 里只有要翻的文本', p1.user.indexOf('ahegao') >= 0 && p1.user.indexOf('大胸') < 0);

// 2. 垃圾术语（中文→中文、identity）不许进参考
const cfg2 = {
  targetLang: '简体中文',
  pageTerms: [
    { src: '3小时27分钟前', dst: '3小时27分钟前' },      // 中文→中文
    { src: '2026年11月10日', dst: '2026年11月10日' },  // 中文→中文
    { src: 'big breasts', dst: '大胸' }              // 真术语
  ]
};
const p2 = DSH.buildPrompt(cfg2, ['x']);
t('垃圾术语被过滤（中文源）', p2.system.indexOf('3小时27分钟前') < 0, p2.system.slice(-150));
t('真术语保留', p2.system.indexOf('big breasts = 大胸') >= 0);

// 3. 旧译参考也在 system
const cfg3 = { targetLang: '简体中文', prevTranslations: ['这是一段旧译文'] };
const p3 = DSH.buildPrompt(cfg3, ['some text']);
t('旧译参考在 system', p3.system.indexOf('Reference drafts') >= 0);
t('旧译参考不在 user', p3.user.indexOf('Reference drafts') < 0);
t('旧译内容不在 user', p3.user.indexOf('这是一段旧译文') < 0);

// 4. 没有任何参考时，system 干净
const p4 = DSH.buildPrompt({ targetLang: '简体中文' }, ['hello']);
t('无参考时 system 不含术语块', p4.system.indexOf('Terminology') < 0);
t('无参考时 system 不含旧译块', p4.system.indexOf('Reference drafts') < 0);

// 5. user 消息永远是「要翻的文本 + 指令」
const p5 = DSH.buildPrompt({ targetLang: '简体中文' }, ['a', 'b']);
t('多段时 user 含编号行', p5.user.indexOf('1. a') >= 0 && p5.user.indexOf('2. b') >= 0);
t('多段时 user 不含参考', p5.user.indexOf('Terminology') < 0);

console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
