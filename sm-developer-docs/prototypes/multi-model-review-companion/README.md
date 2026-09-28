# Multi-model review companion prototype

这是已经通过真实原型验证的多模型候选审阅界面与配套 HTTP 参考实现，供 Stone Memory
开发者模式接入使用。它保留了原型中的完整交互：

- 一次勾选一个或多个模型，分别生成独立候选；
- 作者原版、历史增强和六项可组合规则；
- 候选并排比较、逐条选择、近似重复提示与人工去重；
- 摘要页面内编辑、取消、恢复模型原版；
- 按候选事件时间查看附近原文；
- 生成 hybrid 候选后二次确认应用；
- 长模型请求使用后台 job 与轮询，避免代理超时造成重复提交。

## 边界

此目录是供适配的完整可运行原型，不会被主 Web 服务自动加载。正式接入时必须遵守：

1. 正式写入继续经过 `stmem mine-review apply`；不得由前端直接修改 SQLite。
2. preview / list / mix / discard 应复用正式 `mine-review` CLI 语义。
3. 所有请求必须显式携带真实 `threadId`，禁止默认选择第一个记忆体。
4. API Key 只从现有 Stone 配置读取，不进入浏览器、候选、日志或提交记录。
5. 原型中的 HTTP 实现用于展示完整交互契约；接入主 Web 时应替换为 CLI adapter，
   不复制核心候选、混选和正式写入算法。

## 独立运行原型

```bash
STONE_REPO=/path/to/stmem_core \
STONE_MEMORY_DIR=$HOME/.stone_memory \
node sm-developer-docs/prototypes/multi-model-review-companion/server.js
```

默认仅监听 `127.0.0.1:4175`。该原型不会自动启动 watcher，也不会自动挖掘、应用候选
或 rebuild；只有页面二次确认后的 apply 操作会修改正式记忆。
