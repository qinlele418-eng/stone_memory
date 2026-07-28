# 架构概览

Stone Memory既管理长期记忆，也管理对话线程的生命周期。

## 主数据流

```text
Claude / Codex 活动线程
          │
          ├── 原始记录 ─────────────→ archive/full
          │
          └── 规范化纯对话 ─────────→ SQLite messages
                                           │
                                           ├── miner → feelings
                                           └── miner → features

rules + feelings + 原文锚点 + 近期对话 + 工具链
                         │
                         └── stmem rebuild → 新活动线程
```

## 组件职责

### `bin/stmem`

统一命令入口。前端、MCP与自动任务需要修改状态时，都必须经过这里。

### `src/storage`

SQLite读写与共享数据结构。所有记录按 `thread_id`归属；不要创建与正式库并行的第二套状态源。

### `src/services`

可复用的业务逻辑，包括导入、挖掘、压缩、时间证据、重建选择、完整性检查和修复。

### `scripts`

CLI命令的运行时实现与Claude/Codex格式适配。运行时脚本不应成为前端专属接口。

### `src/web`

本地单用户前端。HTTP路由可以直接执行只读查询，但写入操作必须转交 `stmem`命令。

开发者模式提供通用模块插槽与当前记忆体上下文。实验前端以独立目录和 `bootstrap.js` 注册，不在主 `app.js` 中硬编码；所有模块共享 `--stone-tide-*` 视觉契约。详见 [前端实验模块规范](frontend-modules.md)。

### `mcp-server.js`

向Agent暴露受控能力。MCP不能拥有一套独立于CLI的配置、导入或重建实现。

## 数据安全边界

- `messages`只保存user/assistant纯文本。
- `full`保存原始记录，包括必要的工具与线程结构。
- 记忆块和规则块是注入结果，不能再次被归档为用户对话。
- rebuild、裁剪、修复和迁移都必须有备份或可验证的恢复路径。
- 前端默认只在本地运行，不应假定存在云端账号或多租户服务。

## 修改前需要回答

每项新功能至少回答：

1. 它对应哪个 `stmem`命令？
2. 正式数据源在哪里？
3. Claude与Codex是否都受影响？
4. 是否会修改用户数据？
5. 如何dry-run、测试和恢复？

答不出来时，应先完善设计或提交proposal。
