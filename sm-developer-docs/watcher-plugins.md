# Watcher 自动模块契约

开发者实验如果需要在每日记忆挖掘完成后自动运行，不得直接向
`scripts/watcher.js` 添加业务分支。模块应在：

```text
src/services/watcher-plugins/<module-id>.js
```

注册一个可发现插件：

```js
module.exports = {
  id: "example",
  enabled: ({ threadConfig }) => threadConfig.automaticExample === true,
  run: context => ({ attempted: true, ok: true, output: "done" }),
};
```

`context` 提供 `threadId`、`date`、`today`、`force`、`threadConfig` 和
`projectRoot`。插件应遵守以下边界：

- 使用自己独立、默认关闭的线程配置开关；
- 不修改当天 feelings/features 的正式挖掘结果；
- 重复执行必须安全，已有结果应直接返回；
- 单个插件失败只记录本插件结果，不得令当天挖掘回滚；
- 正式写入仍复用 Stone Memory 的 CLI/服务，不建立第二套数据库；
- 前端入口必须遵守开发者模块契约，不能把实验开关塞进主设置页。

`automatic-dream` 是第一份参考实现。新增插件只需增加自己的插件文件和
独立开发者前端，不再修改 watcher 主循环。
