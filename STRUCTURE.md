# 仓库结构

> 这是一个 DSH 插件仓库，可直接被 `dsh plugin-market` 索引引用。

## 目录

```
dsh-yufeng/
  package.json        包清单（name=dsh-toolbox）
  cordis.patch.yml    装配层（dsh.bundle.patch 指向它）
  index.js            宿主入口：export name / inject / apply
  client.js           浏览器侧（侧边栏 React 面板）
  icon.svg            512×512 图标
  panel.html          独立调试页
  lib/                业务实现（11 个模块）
  edge-ext/           内置的 Edge 翻译扩展（77 文件，892 KB）
  test-*.mjs          自测脚本（不需要依赖，直接 node 跑）
  _index.json         DSH 插件索引（格式 1，含本插件条目）
```

## 安装方式（git）

DSH 插件索引里 source 用 git 时，会按下面方式安装：

```
git+https://github.com/YarXVI/dsh-yufeng.git#<commit>
```

## 本地开发

```bash
# 软链到 profile（DSH 从 profile 的 node_modules 找插件）
mklink /J %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-toolbox <本仓库路径>

# 或用 pnpm
# 在 profile 的 package.json 里加：
#   "dsh-toolbox": "link:./plugins/dsh-toolbox"
```

## 自测

```bash
node test-core.mjs        # 核心逻辑（不依赖模型）
node test-paths.mjs       # 路径解析 + 迁移
node test-ext.mjs         # Edge 扩展准备
node test-provider.mjs    # 多后端配置
node test-lib.mjs         # FFI + 剪贴板 + 热键（需要燧心可用）
```
