# Notebook / Dream MCP 路由迁移验收

- 日期：2026-09-18
- 基线：`5b4a434`，开发分支 `codex/module-mcp-provider`
- 用户授权：Notebook 旧工具迁移验证后，继续迁移当前有 MCP 的模块注册路由。
- 本地：Windows / Node 22.23.2；HOME、数据库、Binding 和正文均使用合成夹具。
- 无真实模型调用、无用户配置或笔记迁移、无自动合并。

## 路由归属

| 模块 | Provider 拥有的原有公共工具 |
|---|---|
| notebook-lab | stmem_notebook_status/query/read/topic_manage/write/delegate |
| dream-lab | stmem_dream_latest/status/get |

Core 删除上述九个工具的定义和分派，不留关闭后的回退入口，不增加重复命名。
其余记忆重建、挖掘、搜索、审计、状态、触发检查属于 Core，其他开发者模块尚无
旧 MCP 路由，不在本轮臆造新工具。内部 Deep Search / Notebook Steward 受限
模式的列表与调用上限保留。

## 实现与兼容

- 旧名称由宿主兼容表绑定模块；新模块仍按命名空间自动注册，无须改该表。
- 九个旧名称均使用必填 thread，默认关闭，必须显式启用全局与记忆体并重连。
  其余业务 schema 和成功返回格式保留；错误经过净化。
- Notebook 写调用：MCP → Provider → 私有 batch → 模块 CLI → 共享服务 →
  正式 Notebook CLI。原有管家规划/校验/receipt/审计流程从 Core adapter 移至
  CLI 所有的共享服务。payload 不得覆盖 thread/threadId/memoryId。
- 保留规划器 120 秒预算，delegate 的 Provider/CLI 超时为 180 秒；其他工具
  30 秒。MCP/CLI 支持取消；已开始的写操作不承诺事务回滚，同进程 Provider
  也不构成不可信代码沙箱。
- Dream coverage 改用只读 Store，不再因查询注册线程或清理消息。缺库返回空
  coverage，旧库明确要求正式 CLI 升级；正文 reader 仍复用 DreamReader。

## 回归证据

| 验证 | 结果 |
|---|---|
| 完整 node --test | 539 项：538 通过，0 失败，1 跳过 |
| node scripts/verify-mcp-contract.js | 43/43 通过 |
| 旧 Core 与新 Provider 进程对照 | 13/13 完整成功响应相同，主数据库哈希不变 |
| module audit --strict --json | 0 错误，24 项既有迁移提醒 |
| diff check | 通过 |

旧版对照使用检查点 `7861a20` 的独立 checkout，命令：

```text
node scripts/verify-module-migration.js <pre-migration-checkout>
```

Notebook 的 7 项读取加 Dream 的 6 项读取包含目录、关键词、标签/主题、封存
笔记、缺失笔记、空记忆体、latest、coverage、指定日期与缺失梦境。

真实 stdio tools/list/tools/call 与模块 CLI 测试覆盖：

- 九个旧名称仅注册一次；除 thread 必填外的业务 schema 与旧快照一致。
- 两级关闭、未授权记忆体、缺失/损坏 Provider 都不可通过旧 Core 路由访问。
- 未授权写请求使用完整合法业务参数，返回 MCP_MEMORY_DISABLED，数据库和
  规划器回执均未创建；不是用 schema 不合法代替权限验证。
- Notebook 创建/更新主题、创建笔记、错误 revision 不覆盖原文。
- Claude/Codex 两条路径分别通过本地合成规划器完成 delegate 创建与追加；
  正文不进入规划器 prompt/argv；非法计划不修改笔记；batch 文件清理。
- Dream 缺库、旧库、现有库只读检查；messages/schema/主库哈希保持不变。
- 接近 1 MiB 的合法笔记 batch 可返回完整收据；宿主 CLI 输出限额保留 Notebook
  原有 5 MiB，避免写入成功后因正文加元数据超过 1 MiB 被误报失败。
- 原有协议分帧、取消、超时、rebuild preview 会话与两种受限模式回归通过。

规划器测试覆盖的是正式进程与 CLI 链路，不是实际模型质量/远端鉴权验收。
Linux/macOS 与 Node 25 由现有 CI 矩阵执行，本地未声称运行这些组合。

## 提交安排

本轮作为扩展迁移提交追加到本地开发分支，纯重构 PR #191 不混入行为变化。
后续按既定依赖顺序提审；没有自动推送其他检查点或合并 PR。
