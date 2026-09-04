# 琢石坊（developer-community）公开契约缺口提案

状态：Accepted for developer experiment（作者确认补齐最小通用契约后继续试验）  
贡献人：@wanyu445  
提交意图：建议合并  
作用域：global

实现进展：实验版已经补齐通用 module `--batch-file` 与 global POST → CLI 桥，并在 `developer-modules/developer-community/` 落地。细粒度 GitHub 权限、Core 统一密钥引用、自动 MCP 注册和 global watcher 通知仍作为正式化前的后续契约工作。

## 1. 目标

“琢石坊”面向 Stone Memory 项目协作者，而非 maintainer。它希望在统一的开发者模块页面中完成：

- 登录 GitHub，查看项目仓库并为项目 Star；
- 查看 PR（精矿）与 Issue（采石场），阅读提交者、正文、文件、提交历史、讨论和 CI；
- 使用用户显式选择的生成配置生成 PR/Issue 阅读报告与修改建议；
- 回复讨论、把条目加入本地工作台、把 PR 合并到协作者自己的分支；
- 跟踪已经拉取的 PR 及其新动态，并可确认后移除对应本地改动；
- 通过 Stone Memory 正式 CLI 重启 Web 与 watcher supervisor，以应用已确认的改动。

本模块不负责维护官方主线、替代 GitHub 权限模型、直接修改 Stone Memory 记忆数据库，也不自行运行 GitHub companion server 或第二套 supervisor。

## 2. 已审计并可复用的能力

| 能力 | 当前正式入口 | 读写属性 | 结论 |
|---|---|---:|---|
| 模块发现与入口 | `/api/developer-modules` + `entry.frontend` | 只读 | 可直接复用 |
| 页面壳与返回入口 | `/developer-kit/runtime.js` + `<stone-module-page>` | 只读 | 可直接复用 |
| 主题与移动端外壳 | `--stone-theme-*` + 共享 runtime | 浏览器视觉状态 | 可直接复用 |
| global 模块数据目录 | `context.moduleDataDir` / `resolveDataPath()` | 模块私有写 | 可直接复用 |
| 模块 SQLite | `storage.database: module.sqlite` + `migrations/` | 模块私有写 | 可直接复用 |
| 模块命令调度 | `stmem module <id> <action>` | 正式写入口 | 骨架可复用，但输入契约不足 |
| Web 生命周期 | `stmem web restart` | 正式进程写操作 | 可复用，必须单独确认 |
| watcher 生命周期 | `stmem supervisor restart` | 正式进程写操作 | 可复用，必须单独确认 |

README 当前列出的 13 个 MCP 工具均面向记忆、挖掘、搜索、审计、梦境或线程重建。与本模块可能相关的工具只有通用的 `stmem_memory_status`（只读），但它不提供 GitHub 或项目协作数据。现有 MCP 没有 GitHub PR、Issue、CI、评论、Star、分支合并或模块工作台工具，因此琢石坊首版不应伪称复用了 GitHub MCP 能力。

Watcher 已提供统一 supervisor 和 `dev-*` 插件登记原则，但当前没有供 global 模块声明“定时轮询 GitHub 并发送前端通知”的公开上下文与状态契约。首版应采用用户打开页面或点击刷新时检查；常驻提醒另行扩展契约后再做。

## 3. 阻塞施工的公开契约缺口

### 3.1 模块命令缺少安全的结构化输入

`scripts/stmem-module.js` 当前只把固定的 `threadId`、`bindingId`、`summaryLimit`、`minImportance` 和 `maxChars` 交给模块命令；除特殊 `hook` 外不读取 stdin，也没有通用 `--batch-file`。

因此下列正式写操作无法通过唯一 CLI 通道表达：

- 保存仓库选择、阅读 Prompt 和非秘密生成设置；
- 保存或更新 GitHub 登录引用；
- Star 仓库、回复评论、记录工作台；
- 选择目标 fork/分支并合并 PR；
- 删除某个 PR 对应的本地改动；
- 选择需要重启的正式服务。

需要为所有模块提供通用 `--batch-file <json>`，由 CLI 读取、限制大小、解析后传为 `input.payload`。秘密不得进入 argv 或普通日志。

### 3.2 Web 模块命令桥不支持 global 模块和写入

当前 `/api/developer-modules/:id/commands/:action` 只接受 GET，并强制要求 `thread`。琢石坊是 global 模块，不能虚构或默认选择第一个记忆体；登录、评论、合并等操作也不能塞进查询字符串。

需要通用的模块 Web 适配：

- GET 仅用于 manifest 标记为只读的命令；
- POST 接收受限 JSON，写入权限为 `0600` 的临时 batch 文件，再调用 `stmem module <id> <action> --batch-file ...`；
- global 模块不要求 thread，memory 模块仍须验证真实 thread；
- 统一限制 body 大小、净化错误，不向前端回显 token、命令 stderr 或本机路径；
- 支持幂等键或 expected revision，避免 Star、评论和合并因重复点击重复执行。

### 3.3 缺少 GitHub 权限与凭据契约

现有权限词汇没有 GitHub 读写、Git 凭据或秘密引用。直接声明 `process:spawn` 并调用任意 `gh` 会把权限放得过宽，也无法让用户从 manifest 看懂远端影响。

建议增加最小权限：

- `github:read`：仓库元信息、PR/Issue、提交、讨论、CI；
- `github:star`：仅改变当前用户对目标仓库的 Star；
- `github:comment`：回复指定 PR/Issue；
- `github:branch-write`：fetch 并写入用户明确选择的本地/远端分支；
- `generation:use`：调用 Core 统一生成服务；
- `process:restart`：仅允许调用登记的 `stmem web restart` / `stmem supervisor restart`。

登录应由 Core 的受控 GitHub adapter 完成，优先复用 GitHub CLI 的系统凭据或设备授权；模块数据库只保存账号 login、授权方式、scope 摘要和最后验证时间，不保存 token。API Key 必须交给 Core 密钥/生成配置能力，模块只保存不含秘密的配置引用及用户 Prompt 覆盖。

### 3.4 缺少受控 Git/GitHub 与 generation 上下文

当前 `createModuleContext()` 只提供记忆体列表、binding 和 feelings 读取。需要公开的受控能力，而不是让模块自行推断 Core 仓库路径或任意 spawn：

```text
context.github.repository()
context.github.authStatus()
context.github.listPullRequests()/listIssues()
context.github.readPullRequest()/readIssue()
context.github.star()/comment()
context.github.mergeIntoBranch()
context.github.removeAppliedChangePreview()/apply()
context.generation.generate({ profileRef, prompt, input })
context.process.restart({ services })
```

这些只是建议的能力形状；正式命名和返回 schema 应由 Core 契约测试固定。所有变更仍由模块命令经 `stmem` CLI 发起，MCP 或 Web 不复制实现。

## 4. 数据与迁移设计

公开契约补齐后，模块声明：

```json
{
  "storage": {
    "database": "module.sqlite",
    "files": ["prompts/custom-pr-review.md"]
  }
}
```

`module.sqlite` 仅保存：

- repository：稳定仓库标识、显示 URL、最近刷新时间；
- workbench_item：PR/Issue 标识、加入时间和排序；
- tracked_change：PR、目标分支、应用时 commit、最近远端 head、提醒状态；
- remote_snapshot：可过期的 PR/Issue/CI 元数据缓存，不保存 token；
- operation_receipt：Star、评论、合并、移除和重启的幂等回执与脱敏错误码；
- settings：生成 profile 引用、Prompt 覆盖路径、刷新偏好。

建表与升级放在 `developer-modules/developer-community/migrations/`，数据库路径只通过 `context.resolveDataPath("module.sqlite")` 获得。不读取或修改 Core `memory.sqlite`。

本模块没有旧版正式数据需要迁移。`sm_dashboard/.sm-dashboard` 属于另一个本地原型，不自动读取、移动或删除；未来若导入，必须另做只读探测、备份、数量验证、兼容期与回滚。

## 5. 危险操作语义

- “合并入自己的分支”必须明确仓库、目标分支、PR head SHA、策略和是否推送；默认只生成预览，不等于合并官方主线。
- “删除 PR 对应更改”不能按文件列表反向覆盖。必须基于模块记录的 apply commit 与当前分支状态生成 preview；工作区不干净、提交已分叉或无法证明归属时拒绝。正式 apply 前确认并创建可恢复引用。
- “一键重启以应用改动”应展示 Web 与 supervisor 两项计划并逐项报告结果。Core 应提供组合 CLI（含部分失败语义）后才能做一个按钮；在此之前只能分别调用已有正式命令，不能由模块自行实现 all-restart。
- Star、评论、合并、删除改动和重启均为正式写操作，必须弹窗确认、返回真实结果并记录幂等回执。

## 6. MCP 边界

首版建议只增加模块只读 MCP：

- 当前工作台列表；
- 已缓存的 PR/Issue 报告；
- tracked PR 的远端更新提醒。

这些工具只读 `module.sqlite`。任何 Star、评论、合并、移除改动或重启必须调用对应 `stmem module developer-community <action>`，不得在 MCP 中实现 Git/GitHub 写逻辑。若 Core 尚未支持模块自动注册 MCP 工具，应先单独设计通用注册契约，不在根 `mcp-server.js` 为本模块硬编码。

## 7. 卸载、数据保留与清理

- 停用：停止入口和可选轮询，不改变 GitHub、Git 分支或 Core。
- 删除代码：Core 正常启动；`module.sqlite` 与 Prompt 覆盖默认保留。
- 清理数据：未来通过显式 `stmem module developer-community purge --batch-file ...` 执行，先预览再确认；不得隐式撤销 Star、删除远端评论或改写分支。
- 已产生的 GitHub/Git 远端效果不因卸载自动回滚。

## 8. 为什么建议合并，以及官方维护范围

建议合并不是因为模块无法独立存放代码，而是因为它依赖的安全能力必须由官方 Core 提供：通用 global 模块 POST/CLI batch 通道、凭据托管、细粒度 GitHub 权限、受控 Git 操作、统一 generation 和进程重启策略。若每个社区模块各自实现这些能力，会重复产生 token 泄露、任意命令执行、错误分支合并和不可验证回滚风险。

官方长期维护范围应限定为：

1. 稳定上述通用模块契约与 schema；
2. 维护跨平台 GitHub/Git adapter、秘密处理和错误净化；
3. 维护 CLI 唯一写入口、权限校验、幂等与审计回执；
4. 维护 Web/MCP 的通用适配，不为琢石坊硬编码业务页面；
5. 对 GitHub API/CLI 变化、Windows/Linux/macOS 路径和进程行为做兼容测试。

琢石坊模块自身继续负责页面交互、协作者工作流、Prompt、模块数据库 schema、缓存与提醒规则。CI 通过只表示满足基础技术规范，不代表官方背书、安全认证或无限期功能承诺。

## 9. 验收门槛

Core 契约补齐并发布后再开始模块代码，至少覆盖：

- 正常流程、无记忆体的 global 使用、未登录/接口失败、重复点击幂等；
- GitHub 权限不足、CI 缺失、PR 多次提交和分页讨论；
- 脏工作区、目标分支分叉、删除预览失效和可恢复引用；
- Windows/Linux/macOS 路径；
- 桌面、移动端、自定义主题；
- 模块停用、代码删除、数据保留与显式清理；
- `npm run audit:developer-modules`、`node --test test/developer-module-contract.test.js`、模块测试与可行的 `npm test`。
