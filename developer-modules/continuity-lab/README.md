# 连续性实验室

Claude Code Hook 接续能力源自 `@echozfwoodcrafts-del` 提交的 PR #113 / 恢复 PR #132。本模块保留其 SessionStart 接续与失败放行思路，并改为通过 Binding 精确定位记忆体；不会回退到第一个记忆体，也不会另建候选存储。

当前 Hook 配置覆盖 `startup | resume | clear | compact`。识别不到唯一 Binding 时输出空对象，不阻断 Claude Code 启动；注入内容是近期证据，不替代人格、当前对话或用户最新意图。

用于验证“记忆体不再等于单个线程”的 Binding 架构。

当前阶段只提供：

- 为当前记忆体登记 Claude Code、Codex 或官端导入来源；
- 使用正式清洗边界预览来源文件；
- 用户确认后，将纯对话写入 Core `messages`，并保存 Binding 与导入批次溯源；
- 在尚未基于该批次重新挖掘时，安全撤销本批真正新增的消息。

当前阶段不会自动注入、自动重建、启动独立 Watcher，也不会写入 archive/full。所有正式写操作均通过 `stmem binding` 完成。

回滚模块代码不会删除 Core Binding 数据；用户应先在实验室撤销导入、停用 Binding，再移除模块。Schema v14 仅增加可空字段与通用表，旧数据和旧流程保持不变。
