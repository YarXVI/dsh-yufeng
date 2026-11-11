# 御风 · YuFeng

> DSH Windows 工具箱：系统级划词转译 + Edge 扩展引导安装。
> 通过 DSH 自带的 koffi（FFI）直调 Win32 —— 无需独立 exe，无需 Python。

## 安装（第三方用户）

### 推荐：从插件索引安装

```
DSH → 插件 → 实验性插件 → 自定义插件索引（打开）
    → 发现 → 添加索引源
    → 粘贴: https://yarxvi.github.io/dsh-yufeng/market/index.json  ← 仓库名是 yufeng，装出来是 dsh-toolbox
    → 搜索「御风」→ 安装 → 重启 DSH
```

### 或者：直接从 git 装

```
DSH → 插件 → 添加插件
    → 填: https://github.com/YarXVI/dsh-yufeng
    → 安装 → 重启 DSH
```

### 依赖

| 需要 | 说明 |
|---|---|
| DSH >= 0.2.2-rc.1 | 宿主 |
| Node >= 20 | DSH 自带 |
| **燧心（dsh-npu）** | 可选。没有的话用任意 OpenAI 兼容服务替代（面板可配） |
| Edge | 可选。用浏览器扩展翻译功能时才需要 |

> 御风**不需要 Python、不需要独立 exe** —— FFI 走的是 DSH 打包的 koffi。

## 快速上手

1. 装完重启 DSH
2. 侧边栏出现「御风」，点开
3. 默认热键 `Ctrl+Shift+F`（可在面板改）
4. 任意应用里划词选中 → 按热键 → 就地转译

翻译后端默认走**燧心**（`http://127.0.0.1:47300`）。
没有燧心就在面板里点「+ 添加云端服务」，填任意 OpenAI 兼容地址/模型/Key。

---
## 为什么是独立插件

- dsh-npu（燧心）的职责是「本机推理」，Windows 工具是另一类东西
- 混在一起会让燧心越做越胖，且工具功能出问题会连累推理
- 独立插件可以单独卸载，不影响推理服务

两者通过 **HTTP** 解耦：御风只调 `/v1/chat/completions`，
不 import dsh-npu 任何东西 —— 模型随时可以换。

## 功能一：划词转译

```
1. 在 QQ / 微信 / Edge / 记事本 / 编辑器里划词选中要翻译的中文
2. 按 Ctrl+Shift+F（可在面板改）
3. 原中文就地变成外语（Ctrl+V 已自动完成）
```

剪贴板会被临时占用，**之后自动恢复**（全格式备份，连图片/文件都保）。

支持 10 种语言：英语 · 日语 · 韩语 · 葡萄牙语 · 法语 · 德语 · 西班牙语 · 俄语 · 意大利语 · 繁體中文

### 为什么不需要单独 exe

DSH 自带 **koffi**（FFI），dsh-npu 已经在用它做 Windows Job Object。
插件直接 `koffi.load('user32.dll')` 就能调 Win32，不用起子进程、
不用装 .NET、不用打第二个包。

## 功能二：浏览器扩展安装

御风内置了 Edge 版翻译扩展（`edge-ext/`，4.2.0，892 KB）。

面板上点「① 准备扩展文件」→「② 打开扩展页」，然后按 3 步操作。

### 为什么不是「静默安装」

Edge 的扩展列表存在 `User Data\Default\Secure Preferences`，
每条记录都带**机器绑定的 HMAC 签名**。第三方程序写进去，
浏览器重启时校验不过 → 判定配置被篡改 → **重置用户所有扩展配置**。

这个代价不能承担（用户可能有十几个扩展）。

CDP `Extensions.loadUnpacked` 也不可靠：需要浏览器带 `--remote-debugging-port` 启动，
普通用户的 Edge 没有这个参数。

所以走 Chrome/Edge 官方支持的唯一安全路径：**开发者模式加载解压扩展**。
用户操作约 20 秒，零风险。

## 技术实现的关键点（都是踩出来的）

### 坑 1：必须 AttachThreadInput

SendInput 把按键投进**当前线程的输入队列**。插件跑在 DSH 后台线程，
不挂到前台窗口线程上时按键会被丢弃。

| 方式 | 耗时 | 结果 |
|---|---|---|
| 不挂接 | 6037ms | null（完全失效） |
| 挂接 | 33ms | 成功 |

### 坑 2：按下和抬起必须分两批发

一次 SendInput 发 `Ctrl↓ C↓ C↑ Ctrl↑` 时，Chromium 系应用约一半概率忽略 ——
它的输入处理按「事件批次」走，同批内按下-抬起太快会被当成自动重复。

| 方式 | 耗时 | 轮次 |
|---|---|---|
| 一次发完 | 410ms | 2（一半概率第一轮失效） |
| 拆两批（间隔 8ms） | 47ms | 1（一次成功） |

### 坑 3：剪贴板序列号变了 ≠ 数据可读

Ctrl+C 的瞬间序列号就变，但文本要再过几十毫秒才真正写入。

### 坑 4：SendInput 的参数类型不能写 void*

`koffi.func('uint SendInput(uint n, void *p, int cb)')` 会报
`Cannot pass ambiguous value to void *, use koffi.as()`。
必须声明成具体结构指针。

### 坑 5：剪贴板备份不能简单包装

原 IDataObject 的生命周期绑在剪贴板上，必须**按格式逐个深拷贝**。

### 坑 6：不用 RegisterHotKey

它需要一个窗口收 `WM_HOTKEY`，插件在 Node 线程没有消息循环。
改用 `GetAsyncKeyState` 轮询（30ms）。

### 坑 7：`edge://` 不能用 ShellExecute 打开

用户截图：「获取打开此 'edge' 链接的应用」。

原因：`edge://` 是浏览器**私有 scheme**，没在 Windows 注册表注册处理器，
ShellExecute 找不到关联程序就会弹这个系统对话框。

修法：用 `msedge.exe` 带参数启动（Edge/Chrome 会复用已运行实例，只开新标签）：

```js
ShellExecuteW(null, 'open', 'C:\\...\\msedge.exe', '"edge://extensions/"', null, 1)
```

Edge 路径查找顺序：注册表 App Paths → 常见安装位置。

### 坑 8：热键别用 Ctrl+Shift+T

`Ctrl+Shift+T` 在 Edge/Chrome 里是「重新打开关闭的标签页」。
系统级热键会抢在浏览器前面 —— 用这个键就再也打不开关闭的标签页了。

**默认改为 `Ctrl+Shift+F`**（冲突少，且可在面板改）。

### 坑 9（最严重）：Atomics.wait 会让 DSH host 崩溃

**症状**：每次按热键，DSH 桌面端弹「应用无法启动或已意外停止」，
错误码 `3221226356` = `0xC0000374` = **STATUS_HEAP_CORRUPTION**（堆损坏）。

**根因**：第一版用 `Atomics.wait(SharedArrayBuffer, 0, 0, ms)` 做 sleep。

这在**主线程**会把整个 Node 事件循环堵死：

```
DSH host 主线程
  ├── 我的热键轮询（setInterval 30ms）
  │     └── runOnce() 里几十次 Atomics.wait(25ms)
  │           → 累计阻塞 300~900ms
  ├── DSH HTTP 服务（含燧心 47300）  ← 一起卡住
  └── llm-deepseek-account 请求        ← 超时 → 重试 → 再超时
```

崩溃日志里那种**高频重复**的
`[llm-deepseek-account] model listing ... loaded 2 model(s)`
正是请求卡住后不断重试的特征。

**修法**：全部改成 `await delay(ms)`（`setTimeout` 包装），让出事件循环。

```js
// 错
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 对
const delay = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));
```

连带把 `clipboard.mjs` / `input.mjs` 的所有导出函数从同步改成了 `async`，
`service.mjs` 里的调用点全部加 `await`。

**性能没变差**：抓取仍是 45~48ms，完整流程平均 248ms（和改之前一样）。

### 坑 10：剪贴板不能枚举所有格式

**症状**：同上——按热键崩 host。

**根因**：第一版「枚举所有剪贴板格式，逐格式 `GlobalLock` + `GlobalSize` 深拷贝」。

但剪贴板里不同格式存的是**不同类型的句柄**：

| 格式 | 句柄类型 | 能 GlobalLock |
|---|---|---|
| CF_UNICODETEXT (13) | HGLOBAL | ✅ |
| CF_BITMAP (2) | **HBITMAP** | ❌ |
| CF_METAFILEPICT (3) | **HMETAFILEPICT** | ❌ |
| CF_PALETTE (9) | **HPALETTE** | ❌ |
| CF_ENHMETAFILE (14) | **HENHMETAFILE** | ❌ |

对 GDI 句柄调 `GlobalLock` 等于把对象头当内存块读 → 堆损坏。

**为什么独立 node 里测 10 轮没崩**：那时剪贴板里只有文本（测试脚本自己写的），
没有图片/调色板格式。用户真实使用复制截图就崩。

**修法**：只备份文本。代价是「复制的是图片时，用热键后原图片不恢复」——
可接受，因为图片恢复本身就脆弱（HDROP 要重建 DLIST 结构）。

### 坑 11：测试脚本会污染真实配置

调 `saveConfig()` 的测试（test-paths / test-panel）会把 `D:\DSHQK\YuFeng\config.json`
写成测试用的值 —— 结果我改的热键被写回 `Ctrl+Shift+T`，
用户按 `Ctrl+Shift+F` 完全没反应，排查了半天。

**修法**：两个测试文件在启动时备份真实配置，`process.on('exit')` 时恢复。

## 实测数据

```
lib 自测 30 项全过
记事本真机：抓 47ms + 翻 219ms，粘贴生效，剪贴板恢复
稳定性 10 轮：10/10 成功，平均 241ms
面板 API 12 项全过
扩展准备：77 个文件 → %LOCALAPPDATA%\dsh-toolbox\edge-ext
ShellExecute：edge://extensions/ 打开成功
```

## 翻译后端（多 provider）

默认走**燧心**（本机 NPU）。没有燧心时可以加任意 OpenAI 兼容的云端服务。

### 配置结构

```json
{
  "providers": [
    { "id": "suxin", "kind": "local", "name": "燧心 · 本机 NPU",
      "baseUrl": "http://127.0.0.1:47300", "model": "translate", "apiKey": "" },
    { "id": "cloud1", "kind": "cloud", "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat",
      "apiKey": "sk-..." }
  ],
  "activeProvider": "suxin"
}
```

### 为什么用数组而不是两组固定字段

- 用户可以加**多个**云端服务，随时切换（DeepSeek / 智谱 / 硅基流动…）
- 每个 provider 的地址/key/model 独立，切回来不用重填
- 将来要「按语言选不同服务」也有地方放

### 面板操作

1. 点「+ 添加云端服务」→ 出现「云端 1」并自动切过去
2. 填 API 地址（如 `https://api.deepseek.com/v1`）
3. 填模型名（如 `deepseek-chat`）
4. 填 API Key
5. 点「测试连接」验证
6. 点「保存并应用」

### API Key 的处理

**面板永远看不到明文 key**：`publicConfig()` 只返回 `hasKey: true/false`。

保存时面板单独提交 `providerKeys: { cloud1: "sk-..." }`，
后端合并进 `providers[].apiKey`。规则：

- 传了 key → 覆盖
- **没传 → 保留原有**（这条很关键，否则改个模型名就会把 key 清空）

### 旧配置自动迁移

第一版的 `{ baseUrl, model, apiToken }` 会变成 `providers[0]`，
旧字段无条件删除（在 `normalize()` 里，不在迁移函数里 —— 否则会反复写回磁盘）。

## 数据目录

```
D:\DeepSeek Harness\        ← DSH 本体
D:\DSHQK\                  ← 插件数据根（与 DSH 安装目录同级）
  ├─ SuiXin\               ← 燧心（dsh-npu）
  │   ├─ mods\  runtimes\  logs\
  ├─ LengJing\             ← 棱镜（companion-memory）
  └─ YuFeng\               ← 御风（本插件）
      ├─ config.json
      ├─ edge-ext\         ← 内置 Edge 扩展（77 个文件）
      └─ logs\
```

**路径规则**：默认 `<DSH 安装目录的父目录>\DSHQK\YuFeng`，
即 `D:\DeepSeek Harness` → `D:\DSHQK\YuFeng`。目录不存在会自动创建。

也支持覆盖：
- 环境变量 `DSH_YUFENG_DATA`
- 配置里写 `dataRoot`（绝对路径）

**第一版的位置会自动迁移**（`~/.dsh/dsh-toolbox.json` → `<dataRoot>/config.json`，
`%LOCALAPPDATA%/dsh-toolbox/edge-ext` → `<dataRoot>/edge-ext`），
且**只在目标不存在时迁**，不覆盖新数据。

## 配置（`D:\DSHQK\YuFeng\config.json`）

```json
{
  "hotkey": "Ctrl+Shift+F",
  "lang": "en",
  "mode": "replace",
  "baseUrl": "http://127.0.0.1:47300",
  "model": "translate"
}
```

## 面板 API

```
GET  /plugins/dsh-toolbox/panel                  调试页（浏览器直开）
GET  /plugins/dsh-toolbox/panel/state            状态 + 配置 + 语言表 + 扩展状态
POST /plugins/dsh-toolbox/panel/config           改配置
POST /plugins/dsh-toolbox/panel/run              手动跑一次
POST /plugins/dsh-toolbox/panel/grab             只抓取（诊断）
POST /plugins/dsh-toolbox/panel/toggle           启停热键
POST /plugins/dsh-toolbox/panel/extension/prepare  准备扩展文件
POST /plugins/dsh-toolbox/panel/extension/open     打开 edge://extensions/
```

## 文件结构

```
index.js              宿主入口
client.js             侧边栏 React 面板（order=45）
cordis.patch.yml      装配
panel.html            独立调试页
edge-ext/             内置的 Edge 翻译扩展（4.2.0）
lib/koffi-loader.mjs  FFI 加载
lib/win32.mjs         Win32 绑定（所有 P/Invoke）
lib/clipboard.mjs     剪贴板 + 全格式备份
lib/input.mjs         键盘注入 + 抓取 + 热键轮询
lib/translate.mjs     语言表 + HTTP 翻译
lib/service.mjs       主流程编排
lib/config.mjs        配置存储
lib/panel-api.mjs     HTTP 路由
lib/edge-ext.mjs      Edge 扩展安装引导
```

## 图标

`icon.svg`（512×512，深色圆角底 #0B0C0F，与燧心视觉体系一致）。

**图形含义**：

```
┌─────────┬──────────────┐
│   ▄▄▄   │  ▬▬▬▬▬▬▬     │
│   ▄▄▄   │  ▬▬▬▬        │  左：中文的「方块字」
│         │  ▬▬▬▬▬       │  右：外语的「横排字」
└─────────┴──────────────┘
        ↑ 中间的空白 = 转换
```

**为什么不画箭头**：测过 4 版（上下条+双向箭头、风形折线、单向箭头），
512×512 缩到侧边栏的 18px 是 **28:1**，任何细笔画都会被压成 1px 以下糊成一团。
「左方块 + 右三横」两块主结构在 18px 下仍然可分，这是唯一耐得住缩放的方案。

配色走**青蓝**（#7DE2D1 → #38BDF8 → #1D4ED8），与燧心的红橙（#FF7A6E → #E5484D）区分。

导出：`package.json` 里 `"./icon": "./icon.svg"`。

## 侧边栏

和燧心一样挂在 DSH 侧边栏，order=45（排在 NPU 43、灾备 44 之后）。

```js
ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelBody)
ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: () => '御风' }, Glyph)
```

## 发布（Git 方式）

包名 **dsh-toolbox**。**不走 npm** —— 索引直接指向 Git 仓库的 commit。
> 仓库名是 `YarXVI/dsh-yufeng`（GitHub 仓库名），包名仍是 `dsh-toolbox`，两者不必一致。

```
git+https://github.com/YarXVI/dsh-yufeng.git#<40位commit>
```

详细步骤见 [PUBLISH.md](./PUBLISH.md)。三步：

```bash
git init && git add -A
git commit -m "御风 0.6.1"
git push -u origin main
# 然后把 git rev-parse HEAD 填进 _index.json 的 source.commit
```

### 为什么走 git

- 不需要 npm 账号
- 没有包名冲突（`dsh-toolbox` 已被别人占用）
- 发布就是 push

### 目录名 / 路由为什么不变

| | 值 |
|---|---|
| 包名 | `dsh-toolbox` |
| 本地目录 | `plugins/dsh-toolbox`（目录名未改） |
| cordis id | `toolbox` |
| 面板路由 | `/plugins/dsh-toolbox/panel` |
| 数据目录 | `D:\\DSHQK\\YuFeng` |

改了路由/数据目录会让**已装的 Edge 扩展路径失效、旧配置读不到**。

## 诚实的限制

| 限制 | 影响 | 能否解决 |
|---|---|---|
| 用户必须手动划词 | 不能自动识别输入框内容 | ❌ 技术上无解 |
| 剪贴板被临时占用 | 极端情况会残留 | ✅ 已做全格式备份 |
| Edge 扩展不能静默装 | 需用户点 3 次 | ❌ 会损坏用户扩展配置 |
| 管理员权限窗口 | 收不到按键 | ⚠️ 需提权 |
| 游戏/反作弊窗口 | 屏蔽 SendInput | ❌ 无解 |
