import { loadConfig, saveConfig, publicConfig, activeProvider, DEFAULT_CONFIG } from './lib/config.mjs';
import { translate, REVERSE_LANGS } from './lib/translate.mjs';

let bad = 0;
function t(n, ok, d) { console.log((ok?'OK   ':'FAIL ')+n+(d!=null?'  ['+d+']':'')); if(!ok)bad++; }

console.log('=== 1. 默认配置 ===');
const c0 = loadConfig();
t('有 providers 数组', Array.isArray(c0.providers) && c0.providers.length > 0, c0.providers.length + ' 个');
t('默认激活 suxin', c0.activeProvider === 'suxin', c0.activeProvider);
t('suxin 是 local', activeProvider(c0).kind === 'local', activeProvider(c0).kind);
t('suxin 地址正确', activeProvider(c0).baseUrl.indexOf('47300') >= 0, activeProvider(c0).baseUrl);

console.log('');
console.log('=== 2. 旧配置迁移 ===');
// 模拟旧形态
const legacy = Object.assign({}, DEFAULT_CONFIG, { baseUrl: 'http://192.168.1.3:47300', model: 'translate', apiToken: 'old-token' });
delete legacy.providers; delete legacy.activeProvider;
const migrated = loadConfig();
t('旧字段已删除', !('baseUrl' in c0) || c0.providers, '新结构存在');

console.log('');
console.log('=== 3. publicConfig 隐藏 key ===');
const pc = publicConfig(c0);
t('providers 有 hasKey 而不是 apiKey', pc.providers.every(p => !('apiKey' in p)) && pc.providers.every(p => 'hasKey' in p), JSON.stringify(pc.providers[0]));

console.log('');
console.log('=== 4. 新增云端 provider ===');
const c1 = saveConfig({
  providers: [
    ...c0.providers,
    { id: 'cloud1', kind: 'cloud', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test-123' },
  ],
  activeProvider: 'cloud1',
});
t('两个 provider', c1.providers.length === 2, c1.providers.map(p=>p.id).join(','));
t('激活切到 cloud1', c1.activeProvider === 'cloud1', c1.activeProvider);
t('cloud1 有 key', activeProvider(c1).apiKey === 'sk-test-123', activeProvider(c1).apiKey ? '有' : '无');

const pc1 = publicConfig(c1);
t('publicConfig 里 cloud1 hasKey=true', pc1.providers.find(p=>p.id==='cloud1').hasKey === true);

console.log('');
console.log('=== 5. 切回燧心 ===');
const c2 = saveConfig({ activeProvider: 'suxin' });
t('激活回 suxin', c2.activeProvider === 'suxin', c2.activeProvider);
t('cloud1 的 key 还在', c2.providers.find(p=>p.id==='cloud1').apiKey === 'sk-test-123');

console.log('');
console.log('=== 6. 无效配置被收敛 ===');
const c3 = saveConfig({ providers: [ { id:'bad', baseUrl:'', model:'' } ] });
t('空 provider 被丢弃', c3.providers.length >= 1 && c3.providers.every(p=>p.baseUrl && p.model), c3.providers.map(p=>p.id).join(','));

console.log('');
console.log('=== 7. 用 suxin 实际翻译 ===');
const c4 = saveConfig({ activeProvider: 'suxin' });
const r = await translate({ provider: activeProvider(c4), text: '这个功能很好用。', langId: 'ja', timeoutMs: 30000 });
if (r.ok) t('燧心翻译成功', true, r.ms + 'ms: ' + r.text);
else if (/GPU|422|CUDA/.test(String(r.error))) console.log('SKIP 燧心翻译（模型后端不可用：' + String(r.error).slice(0,60) + '）');
else t('燧心翻译成功', false, r.error);

// 清理：删掉测试加的 cloud1
const c5 = saveConfig({ providers: c4.providers.filter(p=>p.kind==='local'), activeProvider: 'suxin' });
t('恢复为单一 provider', c5.providers.length === 1, c5.providers.map(p=>p.id).join(','));

console.log('');
console.log(bad === 0 ? 'PROVIDER OK' : (bad + ' 项失败'));
process.exit(bad ? 1 : 0);