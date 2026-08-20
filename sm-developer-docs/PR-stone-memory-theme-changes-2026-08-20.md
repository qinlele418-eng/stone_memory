# Stone Memory 主题工作台升级

## 修改内容

- 新增 `theme-tokens.css`，统一页面背景、表面、文字、强调色、状态色、日历花色、圆角、阴影、间距和字体变量。
- 将主工作区、开发者工具、Dream Lab、Review Lab 和主题工作台统一到 `--stone-theme-*` 语义契约与 `stone-theme-enabled` 状态类。
- 主题契约升级为 version 3，增加 `calendarBloom` 和完整状态色编辑项；保留 version 1/2 自定义主题导入兼容，并统一导出格式。
- 保留 Stone Memory Original 与松烟青，清理已退休的内置方案；历史内置主题会自动恢复默认值。
- 主题工作台通过单个 bootstrap script 挂载，可独立移除，不侵入主 `app.js`、server 或业务数据层。
- 优化移动端导航、挖掘布局、窄屏字段、Logo 控件、阴影编辑器和主题预览。
- 增加主题集成回归测试，并兼容没有本地根 `AGENTS.md` 的干净 checkout。

## 修改入口

- [ ] 仅文档
- [ ] CLI
- [x] 前端开发者模块
- [ ] MCP
- [ ] Watcher
- [ ] Claude rebuild
- [ ] Codex rebuild
- [ ] SQLite 或数据迁移

正式能力及使用说明：

- 只读：主题工作台读取主题契约、当前主题和开发者模块语义快照。
- 写入：保存、导入和导出只操作浏览器主题存储，不写入 SQLite、线程文件或记忆数据。
- 兼容：version 1/2 主题导入后合并当前默认值，并保存为 version 3。
- 主题模块：完整使用方法见 `src/web/public/theme-studio/使用说明.md`。

开发者模块接入说明：

- 当前为可拆卸的前端实验模块，入口是 `src/web/public/theme-studio/bootstrap.js`。
- 主页面只保留一个 bootstrap script；模块页面、样式和契约均位于 `src/web/public/theme-studio/`。
- 开发者工具通过 `developer-kit/runtime.js` 消费语义快照，不读取主题持久化数据。
- 移除 bootstrap script 即可停用；删除模块目录即可完整回滚。

## 验证

- [x] 已新增/更新主题集成回归测试
- [x] 已运行相关测试
- [x] 已运行完整 `npm run test`
- [x] 不包含 API Key、私人对话、数据库、线程文件或环境变量

测试结果：

- `node test/theme-studio-integration.test.js`：6/6 通过。
- `node test/developer-module-kit.test.js`：4/4 通过。
- `node test/web-server.test.js`：31/31 通过。
- `npm run test`：336 项中 332 项通过；4 项既有 MCP/Watcher 测试失败，主题相关测试全部通过。
- `git diff --check`：通过。

完整测试中的失败项为 `deep-search-mcp`、`dream-mcp`、`watcher-runtime-state` 和 `watcher-supervisor-integration`，均与本次前端主题改动无关。

## 数据与回滚

本次改动不修改配置、SQLite、archive/full、活动线程或长期记忆状态。浏览器主题偏好继续使用既有存储键。

回滚方式：

1. 回滚本 PR，或移除 `src/web/public/theme-studio/`。
2. 删除 `src/web/public/index.html` 中的主题 bootstrap script。
3. 主工作区、业务 API 和其他模块不受影响。

## 素材说明

- 无外部图片、字体或 CDN 依赖。
- 主题预览、Logo 控件和状态示例均由模块内 HTML/CSS/JS 生成。
- 使用说明已放在主题模块目录中，便于随模块一起分发。
