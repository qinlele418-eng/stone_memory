# Stone Memory Gateway Adapter 开发规范

> 适用于手机端 harness、网关 Agent 和其他没有稳定线程文件的宿主。适配器负责协议转换与任务编排，不负责复制 Stone Memory 的存储、挖掘或 watcher。

## 1. 适配器解决什么问题

网关型宿主通常只保留一段常驻系统提示词与最近若干条滚动对话，不存在可持续监听的 Claude/Codex 线程文件。标准 Binding watcher 因而不是它的接入方式。

一个适配器需要完成四段明确的链路：

1. 将宿主对话转换成 Stone Memory 可导入的规范记录；
2. 将 Stone Memory 导出的对话转换回宿主协议，供迁移、恢复或核验；
3. 由宿主后台任务每天一至两次批量提交增量对话；
4. 在导入成功后按计划调用 Stone Memory 的正式摘要挖掘入口；
5. 按声明的提取策略生成记忆块，并原子写入宿主指定的系统提示词文件。

适配器不是常驻 watcher。调度器属于手机端/harness，Stone Memory 只提供可重复调用、可诊断的命令或接口。

## 2. 目录与清单

每个适配器使用独立目录：

```text
developer-adapters/<adapter-id>/
├── adapter.json
├── README.md
├── protocol/
│   ├── ingress.schema.json
│   ├── egress.schema.json
│   └── memory-block.schema.json
├── src/
│   ├── import-converter.*
│   ├── export-converter.*
│   └── run-sync.*
├── fixtures/
└── test/
```

`adapter.json` 至少声明：

```json
{
  "id": "example-gateway",
  "title": "Example Gateway",
  "version": "0.1.0",
  "adapterVersion": 1,
  "host": "mobile-harness",
  "schedule": { "syncPerDay": 2, "mineAfterImport": true },
  "protocol": {
    "ingress": "protocol/ingress.schema.json",
    "egress": "protocol/egress.schema.json",
    "memoryBlock": "protocol/memory-block.schema.json"
  }
}
```

不得使用 `module.json` 冒充插件，也不得依赖 `/api/developer-modules` 自动注册。

## 3. 对话协议转换

进入 Stone Memory 前，每条消息至少应形成以下稳定语义：

| 字段 | 要求 |
|---|---|
| `externalId` | 宿主侧稳定消息 ID；没有时由稳定字段计算指纹 |
| `conversationId` | 宿主会话或逻辑频道 ID |
| `timestamp` | 带时区的 ISO 8601 时间，内部统一换算为 UTC |
| `role` | 明确映射为 `user`、`assistant`、`system` 或工具事件 |
| `content` | 原始文本；不得混入常驻提示词或上次回传的记忆块 |
| `metadata` | 可选的模型、附件、工具名等可解释字段 |

转换器必须区分真实对话、工具事件、常驻系统提示词和 SM 回传记忆块，避免把后两者反复导入并污染摘要库。字段丢失、未知 role、非法时间与超大附件要有明确的拒绝或降级结果。

对话导出使用独立的 egress schema，把 SM 的规范消息映射回 harness 能识别的字段；无法无损表达的字段必须保留在扩展元数据或明确报告，不能静默丢失。导入后再导出的 fixture 应保住消息身份、角色、顺序、时间与正文语义。

批量导入必须保存宿主游标或已提交指纹；同一批次重复执行不得制造重复消息。正式写入复用 `stmem import` 或届时公开的等价 API，不直接操作 SQLite 或 `archive/full`。

## 4. 定时任务与失败恢复

推荐默认每天同步一至两次，但由宿主配置实际时区和频率。一次任务按以下顺序执行：

```text
读取上次成功游标
  -> 导出宿主新增对话
  -> 转换并校验协议
  -> 导入 Stone Memory
  -> 提交新游标
  -> 按配置触发 stmem mine
  -> 生成并投递新记忆块
```

只有导入成功才能推进游标。挖掘或记忆块投递失败不能让已导入对话再次重复写入；每个阶段都应有独立状态、可重试错误和最近成功时间。设备离线、进程被系统终止、跨时区与夏令时变化必须进入测试。

## 5. 记忆块提取与投递

适配器可以定义自己的提取策略，例如：

- 最近 N 天内按重要度筛选最多 X 条；
- 保留锚点记忆，再对其余候选按可配置概率抽样；
- 在字符预算内按类别配额组合规则、摘要与时间线。

策略必须声明候选范围、数量/字符上限、排序方式、随机种子或稳定抽样规则以及空结果行为，并提供 dry-run 预览。不能用不可复现的随机结果直接覆盖宿主提示词。

输出由 `memory-block.schema.json` 定义，至少包含协议版本、生成时间、来源记忆体、选择策略、内容和源记录引用。目标文件路径由宿主配置传入，禁止在源码中硬编码用户目录。写入必须使用同目录临时文件 + 原子替换，保留文件权限，并避免覆盖宿主维护的其他系统提示词内容。

如果 Stone Memory 还没有满足需要的正式记忆读取/导出入口，应先提交 Core capability proposal；不得为赶工直接查询 Core 数据库。

## 6. 权限与秘密

- 只申请目标记忆体的导入、挖掘和记忆读取权限；
- API Key、设备令牌和真实路径通过宿主安全配置传入，不进入 argv、日志、fixture 或 PR；
- 日志只记录批次 ID、数量、阶段、耗时和脱敏错误；
- 不得获得任意 shell、任意文件写入或全库访问权限；
- 写入目标必须经过允许目录校验，符号链接与目录穿越默认拒绝。

## 7. 验收清单

提交适配器时至少验证：

1. harness → SM 与 SM → harness 的对话双向 fixture，以及独立的记忆块输出 fixture；
2. 重复批次、乱序消息、相同时间戳和断点续传；
3. 常驻提示词及旧记忆块不会被重新导入；
4. 导入成功、挖掘失败、投递失败可分别恢复；
5. 提取策略在固定输入下可预览、可复现并遵守字符预算；
6. 目标文件原子替换、权限保持、路径拒绝和回滚；
7. Android/iOS 类后台限时、离线、跨时区与低电量场景；
8. 卸载适配器不破坏 Stone Memory 正式数据，游标与缓存可单独清理。
