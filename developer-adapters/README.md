# Developer adapters

这里是 Stone Memory 开发者适配器的规范与代码根目录。适配器面向没有稳定线程文件、由网关维护“常驻系统提示词 + 最近若干条滚动对话”的宿主，例如手机端 harness。

适配器与插件不是同一种扩展：

- 插件扩展 Stone Memory 内部能力，放在 `developer-modules/<module-id>/` 并使用 `module.json` 注册；
- 适配器连接外部 harness 与 Stone Memory，放在 `developer-adapters/<adapter-id>/`，由宿主自己的后台任务按计划调用；
- 适配器不要求手机运行 Stone Memory watcher，也不得另起 supervisor 或 companion server；
- 对话导入、摘要挖掘和正式记忆读取必须经过 Stone Memory 的公开 CLI/API，不得直写 `memory.sqlite` 或 `archive/full`。

开始开发前请完整阅读 [DEVELOPMENT.md](./DEVELOPMENT.md)，并复制 [contract.json](./contract.json) 所定义的目录和验收边界。
