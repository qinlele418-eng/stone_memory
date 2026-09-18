# 模块 MCP Provider 实施与验收

## 基本信息

- 日期：2026-09-18
- 基线：`origin/main`，`b296596`
- 开发分支：`codex/module-mcp-provider`
- 本地环境：Windows，Node 22.23.2
- 通道：MCP stdio、正式 CLI、本地 HTTP；全部使用合成数据
- 无模型调用、无真实记忆体迁移、无客户端配置修改

## 实施范围

| 检查点 | 交付 |
|---|---|
| A | 根 MCP 薄启动器；protocol/server/registry；七个 Core 领域文件；三种模式完整工具快照 |
| B–D | SDK v2 manifest、权限与审计；两级开关、dry-run、revision、原子配置；按启用状态加载、命名冲突、schema 校验、脱敏异常、超时与取消；CLI batch 写桥 |
| E–F | 工坊通用管理入口；HTTP → CLI；迁移原有 Notebook status/query/read；端到端启停与旧版结果对照 |

按三个稳定检查点提交：A `27918f8`（`codex/refactor-mcp-core`）、
B–D `7861a20`（`codex/module-mcp-controls`）、E–F（`codex/module-mcp-provider`）。
先将 A 提交至主线 PR；后续两个检查点保留在本地，待依赖按序合并后再提 PR。
不自动合并。A 不含 Provider、只读存储或协议行为修复；这些变化属于 B–D。

本次将三个旧 Notebook 只读工具从 Core 迁入 Provider，保留旧名称，删除对应
Core 定义、处理函数与分派分支。没有用户笔记迁移、watcher 状态或客户端 MCP
配置修改，不增加每模块端口。Notebook Provider 默认关闭。

## 契约决定与边界

- 所有 Module Provider（含官方 Canary）默认关闭。
- 普通 memory 工具由宿主追加必填 `memoryId`，不自动选择第一项。
  三个迁移工具通过宿主兼容表保留旧 `thread` 参数，但改为必填，逐次验证授权。
- 两级开关独立：memory enable/disable 只修改该记忆体；`--global` 显式操作
  全局门闩但仍需明确记忆体，保留各记忆体选择。关闭全局后启用其他记忆体，
  不会恢复任何记忆体的工具访问。
- Provider 返回标准 `CallToolResult`，不隐式包装业务对象。
- 单次调用 30 秒，支持取消；同进程代码须合作响应 AbortSignal。
  同步死循环与不合作代码无法强制中止，不构成安全沙箱。
- 只读 Provider 禁止直接写缓存；写工具须额外声明 `mcp:write`，使用宿主
  `runCommand` → 正式模块 CLI，正文只进入 0600 临时 batch。
- schema 使用显式支持的受限子集；不支持关键字拒绝加载。详见模块开发规范。
- `const/enum` 按 JSON 结构比较，对象键顺序无关，数组顺序有关。
  memory 工具拒绝顶层 `const/enum`，避免与宿主追加的 `memoryId` 冲突；嵌套继续支持。
- 模块 Core reader 使用 SQLite 只读连接，跳过初始化、迁移、线程注册与历史
  消息清理。缺库返回空查询结果，不建文件；旧库明确要求由正式 CLI 升级。
- 静态审计不 require 关闭模块；导出与工具定义动态验证仅在显式启用后执行。
- 协议分帧使用 UTF-8 字节长度，修正旧实现将字符数当字节数的情况；异步响应
  保留各自请求的 Content-Length/JSONL 编码模式。

## 测试方法

所有测试在进程启动前设置临时 HOME 和 USERPROFILE；HTTP 使用随机临时端口。
不统一覆盖 `STMEM_DB_PATH`：现有数据库测试各自选择临时库，全局覆盖会让
本应隔离的夹具共享一个库并制造失败。首次测试设置该覆盖产生的结果已废弃，
随后在新的临时 HOME 下按原测试隔离方式重新运行。

```text
node scripts/verify-mcp-contract.js
npm test
node bin/stmem module audit --strict --json
git diff --check
```

另外，从同一个基线创建未修改的临时 worktree，使用独立临时 HOME 运行完整
`npm test`，区分本次回归与已有失败。

临时 worktree 曾通过 Windows junction 共享依赖；清理时 Git 沿链接删除了
工作区 `node_modules`。已用 `npm ci --ignore-scripts` 按当前主线锁文件恢复，
SQLite 预编译绑定与分词库加载正常，随后重新运行专项和完整测试，结果与下表
一致。未修改 package.json/package-lock.json 或用户数据。此类基线验证后续
应使用独立依赖或 NODE_PATH，避免给待删除 worktree 创建目录链接。

## 结果

| 检查 | 结果 |
|---|---|
| MCP 专项 | 39 通过，0 失败 |
| 完整测试 | 535 项：534 通过，0 失败，1 跳过 |
| A 独立检查点 | 517 项：516 通过，0 失败，1 跳过；审计 0 错误 |
| B–D 独立检查点 | 531 项：530 通过，0 失败，1 跳过；专项 35 通过；审计 0 错误 |
| 未修改基线 | 514 项：512 通过，1 项相同失败，1 跳过 |
| 模块严格审计 | 0 错误，24 项已登记的历史迁移提醒 |
| 三种模式工具快照 | A 完整相等；E 普通 Core 仅移除三个迁移项；两种受限模式完整相等 |
| 旧 Core → Provider 对照 | 7 项完整成功响应相同，包含格式；新调用前后主数据库哈希不变 |
| diff 与前端语法 | 通过 |

原有失败位于 `developer-modules/developer-community/test/community.test.js`：
断言仓库目录名以 `stone_memory` 结尾，在名为 `stmem_core` 的 checkout 上失败。
主线副本复现相同错误；现已改为验证实际仓库根目录，只修测试，不改变社区模块行为。

复审确认原方案存在三项问题：reader 打开可写 Store 并清理历史消息、单记忆体
启用隐式打开全局开关、对象常量依赖键顺序。均已修复并加入回归。合成库读调用
前后 messages、schema 和主数据库文件哈希保持不变，未新增线程；只读连接拒绝
DELETE；缺库无文件产生；旧库不迁移；CLI 关闭全局后启用 beta，alpha/beta
都不可访问。A 中 40 个提取函数体与基线逐一比对一致（仅归一化导入/项目根路径）。

一次全量运行中 HTTP 测试出现未复现的 fetch 连接失败，单独与后续全量复跑通过。
已补充 cause/子进程错误诊断，并将服务关闭安排在临时 HOME 清理之前；不据此
宣称已确认该偶发错误的根因。

## Notebook 迁移纠偏

最初 Canary 新增了 `stmem_notebook_lab_catalog/search/read` 并保留旧 Core 工具，
只能证明新增工具注册，不能证明旧工具迁移。现已撤销该并行入口方案，迁移
`stmem_notebook_status/query/read` 的原定义和调用到 Notebook 模块，原 Core 路由
彻底移除。保留旧名称、业务参数和成功返回格式；明确的契约变化是 thread 必填、
两级显式启用、错误净化与真正只读连接。查询上限维持原来的 50。

`scripts/verify-notebook-migration.js` 使用迁移前检查点 `7861a20` 的真实 MCP
进程与当前进程比较：目录、关键词、精确标签/主题、无匹配、封存笔记精读、
不存在笔记、空记忆体共 7 个完整响应一致。最初一次对照夹具把 Markdown 放错
目录导致双方读取失败；已按正式 getThreadDir 路径重建夹具，断言旧版成功后
才比较结果，失败运行不计入验收。原 Notebook MCP 回归也改为正式 CLI 启用后，
继续调用旧名称验证封存读取、主题写入后读取与精确标签查询。

额外验证：没有新旧重复名称，关闭/缺失/加载失败不回落 Core，不同模块无法
冒领兼容名，旧名称不能注册为 global 或写工具，未授权记忆体和宿主参数冲突
被拒绝。写工具、delegate 与受限 Notebook Steward 不在本轮迁移范围。

新增覆盖包括路径穿越和目录链接、未声明权限、非法工具定义、原子整组拒绝
命名冲突、显式记忆体与作用域、默认关闭、dry-run 无文件、revision 冲突、
禁用代码不执行、模块删除后的 Core 生存、异常净化、非 Error 抛出、非法返回、
异步超时恢复、协议取消、分块中文/emoji 字节帧、混合协议异步返回、CLI batch
权限/清理、Canary 正式启停和 HTTP → CLI 预览/应用。

已有 CI 的 Node 22/25 × Windows/Linux/macOS 六组合已新增隔离 MCP 专项步骤。
本地只实际执行 Windows Node 22；其他五组合尚待远端 CI。前端使用原有主题与
响应式卡片，已检查语法和 HTTP 路径，尚无真实浏览器截图验收。

## 迁移与回滚

无数据库或历史文档迁移。新增配置仅经用户执行 CLI `--apply` 产生，修改后
必须重新连接 MCP。关闭 Provider 后，新会话不再列出三个已迁移的旧名称，其他
Core 工具仍可用。回滚到迁移前检查点可恢复旧 Core 入口；关闭配置本身不会恢复
旧路由。用户数据不受影响。
