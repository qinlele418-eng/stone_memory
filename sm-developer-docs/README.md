# Stone Memory 开发者文档

这里是 Stone Memory 邀请制内测期间的开发入口，供希望修复问题、补充文档或提交功能建议的协作者使用。

开始前请先阅读：

1. [AGENTS.md](./AGENTS.md)：给开发者与编码 Agent 的架构边界、设计理念与取舍原因。
2. [architecture.md](./architecture.md)：核心数据流与模块职责。
3. [contributing.md](./contributing.md)：Issue、文档与代码 PR 的提交方式。
4. [frontend-modules.md](./frontend-modules.md)：开发者模式前端的可拆卸接入、统一卡片与主题契约。
5. [test-reports/](./test-reports/)：社区模型对比、挖掘效果与真实使用测试。
6. [proposals/](./proposals/)：尚未进入正式实现的新功能建议。

## 最重要的原则

Stone Memory 已经提供初始化、导入、挖掘、压缩、线程重建和修复工具链。遇到问题时，应先定位现有正式入口为何失败，不要另写一套脚本绕过系统。

任何会修改配置、SQLite、archive/full、锚点或线程文件的功能，都必须先落实为 `stmem` CLI，再由前端、MCP或自动任务调用。

## 适合参与的内容

- 补充安装与使用说明。
- 整理真实用户遇到的 bad case。
- 修复可以稳定复现的错误。
- 改善跨平台兼容性与前端体验。
- 在 `test-reports/` 中提交脱敏后的模型挖掘与压力测试报告。
- 在 `proposals/` 中记录尚未验证的新想法。

未经验证的方案不要直接写成正式规则；涉及记忆生命周期、摘要压缩、线程重建和数据迁移的修改，必须提供 dry-run、测试与回滚说明。
