# 琢石坊

琢石坊是面向 Stone Memory 项目协作者的 global 开发者模块，产品构想与贡献来自 **@wanyu445**。它把 GitHub PR 称为“精矿”、Issue 称为“采石场”，让协作者可以读矿、讨论、安排工作，并把 PR 放进自己的本地分支试炼。

## 当前实验能力

- 通过 GitHub Device Flow 在官方页面登录，显示一次性验证码、轮询授权结果并展示 GitHub ID/头像；
- 展示仓库链接、Star 状态并通过正式模块命令点星；
- 可选 Chat Completions 阅读配置与可覆盖 PR 阅读 Prompt；
- 展示 PR/Issue、提交者、文件、提交历史、讨论与 CI；
- 无 API 时忠实展示 PR/Issue 原文、文件和 CI；
- 回复 GitHub 讨论、维护本地工作台并复制给 Agent 的任务说明；
- 在当前分支吻合时，用 `--no-ff` 把 PR 合入协作者自己的本地分支；无关的未提交文件和独立插件可以保留。真实冲突会先 abort，再允许全部采用 PR 版本、逐文件选择 PR/本地版本或取消；确认前复核分支、本地 HEAD 与 PR head；
- 跟踪已经合入的 PR head 变化；通过 `git revert -m 1` 创建反向提交来移除对应改动，不重写 Git 历史；
- 快速 fetch 官方仓库默认分支并合入协作者当前分支；无关本地文件不会拦截，真实内容冲突会先自动 abort 并弹出文件清单，可选择全部采用官方版本、逐文件选择采用官方版本（未选文件保留本地版本），或不合并；
- “应用改动助手”读取当前工作区与最近一次琢石坊合并涉及的文件，区分前端刷新、Web 自动重载、Web 管理器重启、数据库迁移、依赖更新、CLI 下次调用生效及 watcher supervisor 重启；只显示实际需要的最小操作。
- 前端可通过正式模块 CLI 直接启动、停止或重启 watcher supervisor。Web 不能在自己的 HTTP 响应中安全杀死自身，因此涉及 Web 管理器自身的改动仍复制 `stmem web restart` 到终端执行。

## 配置与登录

点击“通过 GitHub 登录”后，琢石坊会打开 `https://github.com/login/device`，复制一次性验证码并轮询授权结果，不再要求用户打开终端。OAuth Client ID 是公开应用标识，代码中不包含 Client Secret。

当前 Core 可能是私有仓库，因此实验版申请 OAuth `repo` scope。页面会在跳转前明确提示：该 scope 可访问登录账号有权访问的仓库。得到的 access token 只保存在 global 模块私有 `settings.json`（`0600`），不会返回浏览器、写入 SQLite、argv 或日志；所有 `gh` 调用只通过子进程环境变量接收它。

官方仓库固定为 `stone-memory-empire/stmem_core`，协作者无需填写。分支试炼默认自动使用当前 Stone Memory Core 代码目录；只有需要在另一份 clone/fork 中试验时，才在高级设置中覆盖本地仓库路径。该路径只保存在模块私有数据目录，不进入源码或日志。

PR/Issue 阅读 Prompt 是模块实现的一部分，普通用户无需配置。页面只提供可选的 API 接口、模型与 Key，并明确说明 API 仅用于阅读正文、文件、提交记录和 CI 后生成解释与建议；不配置时继续显示原始材料。

## 正式写入边界

全部写操作登记在 `module.json.entry.commands`，统一形式为：

```bash
stmem module developer-community <action> --batch-file <json>
```

Web 只把 JSON 写入权限为 `0600` 的临时文件并调用上述 CLI。模块没有 companion server，不直接修改 Core 配置或 `memory.sqlite`，也没有独立 watcher/supervisor；页面上的 supervisor 控制仍由 `stmem module developer-community supervisor-control` 回到正式 `stmem supervisor` 命令。

GitHub/Git 写操作包括 Star、回复、合并到本地分支、拉取官方新版、冲突决议和反向提交。它们都要求页面确认。PR 合并和官方更新依靠 Git 精确判断同路径覆盖与内容冲突，不会因无关 Markdown、未跟踪文件或独立插件而拒绝；移除改动仍要求干净工作区，避免 revert 混入用户修改。快速更新只合并到当前本地分支，不自动 push；发生内容冲突会先撤销自动 merge，再由协作者选择全部采用官方版本、逐文件选择官方/本地版本，或取消。确认前会复核分支、本地 HEAD 和官方引用，状态变化后必须重新拉取。

## 持久数据

作用域为 global，数据位于 Core 分配的：

```text
<module-data-dir>/
├── module.sqlite
└── settings.json
```

`module.sqlite` 保存工作台、PR 合并追踪、远端快照和操作回执。`settings.json` 可能包含用户主动配置的 API Key 和 GitHub OAuth token，权限为 `0600`；秘密不进入 argv、SQLite、浏览器存储、日志或测试。更成熟的官方版本应迁移到 Core/系统统一密钥引用。

迁移只由 `migrations/` 执行。本模块不读取或迁移 `sm_dashboard/.sm-dashboard` 原型数据。

## MCP 与 Watcher

现有 MCP 没有 GitHub 工具，本实验版不修改根 MCP，也不伪造复用。工作台通过按钮生成一条可复制给 Agent 的明确任务。

本版不声明 watcher。PR 更新在打开“我的改动”或点击“检查动态”时读取，避免另养常驻进程。未来若 Core 提供 global `dev-*` 插件与通知契约，再接统一 supervisor。

## 停用、卸载和清理

- 停用或删除模块代码：Core 继续运行，GitHub 与 Git 已发生的效果不会被自动撤销；
- 模块数据默认保留，重新安装后可继续读取；
- 手工清理模块数据会丢失工作台和追踪回执，但不会删除 Core 记忆数据；
- 不提供“卸载时自动撤销 Star/评论/提交”，以免产生隐式远端破坏。

## 测试

```bash
node --test developer-modules/developer-community/test/community.test.js
npm run audit:developer-modules
node --test test/developer-module-contract.test.js
```

## 提交意图：建议合并

建议合并至 Stone Memory 官方主线。琢石坊页面和协作者业务可以保持为可拆卸模块，但其验证需要两项所有写型模块都会复用的 Core 能力：通用 `--batch-file` 输入，以及 global 模块 POST → CLI 的安全桥。若模块各自搭 HTTP 服务或把正文塞进 URL，会形成秘密泄露和第二条写入链。

官方长期维护范围应限于模块调度、私密 batch 文件、global/memory 作用域校验和错误净化；GitHub 工作流、Prompt、模块 schema、交互和缓存由琢石坊模块维护。CI 通过仅代表满足基础技术规范，不代表官方背书、安全认证或无限期维护承诺。
