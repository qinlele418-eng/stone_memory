# 自动织梦开发者模块

贡献人：`@fengyincheng`

入口、开关、手动生成和最近梦境均封装在本目录。删除主前端对
`/dream-lab/bootstrap.js` 的加载及本目录后，Stone Memory 基础前端仍可运行。

后端写入只调用正式的 `stmem dream` CLI；自动执行通过 watcher 的可发现
`post-mining` 插件注册，不在 watcher 主流程中硬编码梦境业务。
