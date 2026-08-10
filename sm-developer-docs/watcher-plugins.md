# Watcher 自动模块契约

开发者实验如果需要在每日记忆挖掘完成后自动运行，不得直接向
`scripts/watcher.js` 添加业务分支。模块应在：

```text
src/services/watcher-plugins/dev-<module-id>.js
```

注册一个可发现插件：

```js
module.exports = {
  id: "dev-example",
  enabled: ({ threadConfig }) => threadConfig.watcherModules?.["dev-example"] === true,
  run: context => ({ attempted: true, ok: true, output: "done" }),
};
```

模块开关统一通过正式 CLI 写入，不为插件新增进程管理代码：

```bash
stmem watcher set --thread <id> --dev-example on
stmem watcher set --thread <id> --dev-example off
```

CLI 只修改 `stmem.json` 的 `watcherModules.dev-example`；唯一 supervisor 根据
`watcherEnabled` 管理该记忆体唯一 worker。插件不得 spawn 自己的 watcher，
也不得在前端、HTTP route 或安装脚本里复制 supervisor 启停逻辑。

`context` 提供 `threadId`、`date`、`today`、`force`、`threadConfig` 和
`projectRoot`。插件应遵守以下边界：

- 使用 `watcherModules.<module-id>` 中自己独立、默认关闭的配置开关；
- 所有新增开发者模块 ID 和 CLI flag 必须使用 `dev-` 前缀，例如
  `id: "dev-dream-lab"` 对应 `--dev-dream-lab on`。下划线形式
  `--test_dream` 不采用，CLI 参数统一使用短横线；
- `archive`、`miner`、`compression`、`dream` 是核心保留名，开发者模块不得
  冒用，也不得自行增加新的无前缀顶层开关；
- 不修改当天 feelings/features 的正式挖掘结果；
- 重复执行必须安全，已有结果应直接返回；
- 单个插件失败只记录本插件结果，不得令当天挖掘回滚；
- 正式写入仍复用 Stone Memory 的 CLI/服务，不建立第二套数据库；
- 前端入口必须遵守开发者模块契约，不能把实验开关塞进主设置页。

`dream` 是早期参考实现，为兼容已经存在的 `automaticDream` 配置而保留无前缀
ID；这只是历史兼容例外，不是新模块命名范例。新增插件只需增加自己的插件文件和
独立开发者前端，不再修改 watcher 主循环。
