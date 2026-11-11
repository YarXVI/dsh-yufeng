# 御风（dsh-yufeng）发布说明 · Git 方式

> **不走 npm**。DSH 插件索引支持 `source.type = "git"`，直接指向 Git 仓库的某个 commit。

## 为什么走 git 而不是 npm

| | npm | git |
|---|---|---|
| 需要注册 npm 账号 | 要 | 不要 |
| 包名冲突 | `dsh-toolbox` 已被占用 | 无限制（用 GitHub 仓库路径） |
| 发布流程 | login + publish | git push |
| 版本管理 | npm version | git tag |

git 方式下 DSH 会这样安装：

```
git+https://github.com/YarXVI/dsh-yufeng.git#<40位commit>
```

## 一、建仓库并推送

```bash
cd C:\Users\123\.dsh\profiles\desktop\plugins\dsh-toolbox

git init
git add -A
git commit -m "御风 0.6.1：划词转译 + Edge 扩展引导安装 + 多后端配置"

# 关联远程（先在 GitHub 建空仓库 YarXVI/dsh-yufeng）
git remote add origin https://github.com/YarXVI/dsh-yufeng.git
git branch -M main
git push -u origin main
```

## 二、拿到 commit SHA 填进索引

```bash
git rev-parse HEAD
# 输出 40 位十六进制，例如：
# 3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4
```

把这个值填进 `_index.json` 的 `versions[0].source.commit`。

> ⚠ commit 必须是**精确的 40 位小写十六进制**，短 SHA 校验不过。
> 而且**一旦填了就不能再改那个 commit** —— 改代码要发新 commit + 新版本号。

## 三、托管索引

索引文件 `_index.json` 放到任意 HTTPS 静态主机。最省事的是 GitHub Pages：

```bash
# 1. 把 _index.json 复制到 docs/
mkdir docs
copy _index.json docs\index.json

# 2. 提交推送
git add docs
git commit -m "add plugin index"
git push

# 3. GitHub 仓库 Settings -> Pages
#    Source: Deploy from a branch
#    Branch: main  /docs
```

索引 URL 就是：

```
https://YarXVI.github.io/dsh-yufeng/index.json
```

## 四、在 DSH 里添加索引源

1. 打开 **插件** 页
2. 「实验性插件」下找到 **自定义插件索引**，打开开关
3. 「已安装」旁边出现 **发现** 标签页
4. 点「添加索引源」，填上面的 URL
5. 搜索「御风」或「YuFeng」，卡片上会显示来源：

```
Git 仓库  YarXVI/dsh-yufeng
提交    3f9c2e1d8a4b...
```

## 五、发新版本

```bash
# 1. 改代码
# 2. 改 package.json 的 version（如 0.6.1 -> 0.6.2）
# 3. 提交
git add -A
git commit -m "0.6.2: ..."
git push

# 4. 拿新 commit
git rev-parse HEAD

# 5. 在 _index.json 的 versions 数组**前面**加一条新版本：
#    {
#      "version": "0.6.2",
#      "publishTimestamp": <当前 Unix 秒>,
#      "source": { "type": "git", "url": "...", "commit": "<新SHA>" },
#      "engines": { "dsh": ">=0.2.2-rc.1" }
#    }
# 6. 提交 docs/index.json 并推送
```

> 旧版本条目**保留**，用户可以装历史版本。
> `versions` 数组顺序不要求，客户端会按 SemVer 降序自己排。

## 六、子目录情况（可选）

如果插件放在 monorepo 的子目录里，`source` 要加 `path`：

```json
{
  "type": "git",
  "url": "https://github.com/YarXVI/dsh-plugins",
  "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
  "path": "packages/yufeng"
}
```

御风现在是**独立仓库**，不需要 `path`。

## 七、自检清单

```bash
# 1. commit 格式对不对（必须 40 位小写 hex）
#    在 _index.json 里搜 "commit"

# 2. 索引 JSON 合法
node -e "const j=require('./_index.json'); console.log('format', j.format, 'plugins', j.plugins.length)"

# 3. 用 DSH 官方验证器校验
node -e "
  import('file:///D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js')
    .then(m => m.parseMarketIndex(require('./_index.json'), 'https://YarXVI.github.io/dsh-yufeng/index.json'))
    .then(p => console.log('OK', p.plugins[0].name, p.plugins[0].versions[0].version))
"

# 4. 仓库能 clone
git clone https://github.com/YarXVI/dsh-yufeng.git /tmp/test-clone
```

## 八、注意事项

- **不要**把 `node_modules/`、`.plugin-market-cache/` 提交上去（.gitignore 已配）
- **不要**提交本地配置文件（`D:\DSHQK\YuFeng\config.json` 不在仓库里，对）
- `edge-ext/`（892 KB）**要**提交 —— 用户装完就有内置扩展
- `test-*.mjs` **要**提交 —— 维护者能直接跑自测
