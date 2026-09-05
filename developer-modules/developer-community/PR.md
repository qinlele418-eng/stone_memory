# 建议合并：琢石坊（developer-community）

## 改动范围

- 新增 global 开发者模块 `developer-modules/developer-community/`；
- Core 通用模块 CLI 增加受限 JSON `--batch-file`；
- Core Web 通用模块桥支持 global 作用域和 POST，经 0600 临时文件调用 CLI；
- 未修改核心 `app.js`、根 MCP、Core SQLite 或 watcher。

## 权限与数据

- `process:spawn`：受控调用 `gh` 与 `git`；
- `generation:use`：可选 PR 阅读 API；
- 数据：global `module.sqlite`、`settings.json`、自定义 Prompt；
- GitHub Device Flow 不使用 Client Secret；OAuth token 与 API Key 仅存 0600 模块设置文件，不进入浏览器、argv、SQLite或日志。当前私有 Core 协作需要 OAuth `repo` scope，授权页会明确提示其范围。

## 风险与回滚

- 合并 PR 只操作用户配置的本地仓库和当前目标分支；脏工作区或分支不符时拒绝；
- 删除对应改动使用可追溯的 revert commit，不重写历史；
- 快速更新只 fetch 官方默认分支并合入当前本地分支，不 push；冲突时先自动 abort，再提供全部采用官方、逐文件选择官方/本地或不合并；
- 应用改动助手按文件影响给出前端刷新、自动重载、迁移或进程重启建议，并允许通过正式 CLI 在页面控制 watcher supervisor；
- 删除模块代码即可停用，Core 不依赖模块表；数据默认保留；
- 回滚 Core 通用桥时同时移除模块，避免留下不可调用入口；不迁移或删除用户数据。

## 为什么建议合并

模块业务仍保持可拆卸，但安全的结构化 CLI 输入与 global POST 桥属于所有开发者模块需要的公共基础设施。把它们留给每个独立模块重复实现，会诱发 companion server、URL 泄密和旁路写入。

官方维护通用模块调度、batch 安全、作用域验证和错误净化；琢石坊维护 GitHub 工作流、页面、Prompt、SQLite schema 与交互。CI 通过只代表基础技术规范通过，不代表官方背书、安全认证或无限期维护承诺。
