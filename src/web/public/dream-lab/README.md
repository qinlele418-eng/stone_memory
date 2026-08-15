# 自动织梦开发者模块

贡献人：大司空歪（GitHub：`@fengyincheng`）

首页提供当前状态概览（含「立即织梦」轻量生成区），以及三个二级入口：**织梦秘典**
（管理当前记忆体的织梦 Prompt override，可恢复 Stone Memory 内置默认）、**织梦调律**
（梦向牵引 / 安梦守护 / 梦谱调律）与**梦境档案**（按月目录浏览每一场已保存的梦，点击
进入纯阅读详情页，正文保留 Markdown / 换行语义）。

入口、页面、样式与交互均封装在本目录。删除主前端对 `/dream-lab/bootstrap.js` 的
加载及本目录后，Stone Memory 基础前端仍可运行。

后端写入只调用正式的 `stmem dream` CLI（`preferences` / `pin` / `unpin` / `guard` /
`multiplier` / `prompt` 子命令）；策略解析与 one-shot 消费统一在 `DreamService`
内完成，自动生成通过 watcher 的可发现 `post-mining` 插件注册，不在 watcher 主流程
中硬编码梦境业务，也不在 Web 层直接写 Prompt 文件或 `stmem.json`。
