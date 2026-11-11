import * as edgeExt from './lib/edge-ext.mjs';

let bad = 0;
function t(n, ok, d) { console.log((ok?'OK   ':'FAIL ')+n+(d!=null?'  ['+d+']':'')); if(!ok)bad++; }

console.log('=== Edge 扩展安装引导 ===');

t('自带扩展存在', true, edgeExt.bundledDir());

// 幂等：先清掉上次的安装，验证「未准备」状态
const fsPre = await import('node:fs');
if (fsPre.existsSync(edgeExt.installDir())) fsPre.rmSync(edgeExt.installDir(), { recursive: true, force: true });
const st0 = edgeExt.status();
t('初始状态未准备', st0.installed === false, st0.path);

const prep = edgeExt.prepareExtension();
t('准备成功', prep.ok, prep.ok ? (prep.files + ' 个文件 -> ' + prep.path) : prep.error);
t('扩展名正确', prep.name && prep.name.indexOf('DSH') >= 0, prep.name);
t('版本已读到', !!prep.version, prep.version);
t('ID 已固定', prep.idNote && prep.idNote.indexOf('已固定') >= 0, prep.idNote);

const st1 = edgeExt.status();
t('准备后状态已准备', st1.installed === true, 'v' + st1.version);

// 校验关键文件
const fs = await import('node:fs');
const path = await import('node:path');
const dst = edgeExt.installDir();
for (const f of ['manifest.json','src/dsh.js','src/content.js','src/imgtranslate.js','src/background.js','src/content.css']) {
  const p = path.join(dst, f);
  t('  ' + f, fs.existsSync(p), fs.existsSync(p) ? Math.round(fs.statSync(p).size/1024)+' KB' : 'MISSING');
}

console.log('');
console.log(bad === 0 ? 'EXT OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);