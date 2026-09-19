# Developer modules

这里是 Stone Memory 开发者模块的唯一代码注册根目录。一个模块一个目录，并必须提供 `module.json`。

开工前完整阅读 [DEVELOPMENT.md](./DEVELOPMENT.md)。这份文档是模块目录、数据、CLI、Prompt、数据库和 Watcher 的正式接入规范；CI 按同一套边界执行审计。

编码 Agent 还须遵守本目录的 [AGENTS.md](./AGENTS.md)。模块 MCP 工具必须通过
`module.json.entry.mcp` 注册；最小示例、权限、启停和验收见规范第 17 节。
不得为新模块修改根 MCP 服务或 Core 工具路由，也不需要单独配置客户端服务。

- 新模块的前端、Prompt、命令实现都放在自己的目录内。
- 模块运行数据统一写入 `~/.stone_memory/developer-module-data/<thread-id>/<module-id>/`。
- 全局模块写入 `~/.stone_memory/developer-module-data/_global/<module-id>/`。
- 模块不得直接修改 `src/web/public/app.js`，不得另造 Web 写入通道或独立 watcher。
- 模块写入统一经 `stmem module <id> <action>`；当前历史模块先以 `legacy` 登记，迁移期间旧命令保持可用。
- `scripts/` 与 `src/services/` 只接收已经晋升为 Stone Memory Core 的通用能力，不作为社区模块的默认落点。

提交前运行：

```bash
npm run audit:developer-modules
```

审计错误会阻止 CI；历史迁移项暂时只提示，不破坏现有模块与用户数据。
