# 场景注册与提示词选择

本次重构只提供通用场景机制，内置场景仍为陪伴、编程、学习。没有新增生活监督场景、业务摘要或挖掘提示词。

## 使用

```sh
stmem scenario list
stmem scenario inspect coding
stmem init --template --runtime codex --scenario coding
stmem init --batch-file input.json --validate
stmem init --batch-file input.json

stmem scenario set --thread <真实线程ID> --scenario study --dry-run
stmem scenario set --thread <真实线程ID> --scenario study --apply

stmem prompt show --thread <真实线程ID>
stmem prompt show --thread <真实线程ID> --task feelings
stmem prompt set --thread <真实线程ID> --task feelings --file summary.md --validate
stmem prompt set --thread <真实线程ID> --task feelings --file summary.md --apply
```

`scenario set` 和 `prompt set` 默认只校验/预览，必须带 `--apply` 才写入。`prompt show --task` 同时返回模板、渲染文本、来源和哈希。`prompt set --batch-file` 接受以 feelings/features 为键、完整模板字符串为值的对象，先校验全部内容，再逐文件原子替换。

Web 创建页与设置页从注册器获取场景选项。所有场景均可编辑摘要与特征提示词，保存只作用于当前记忆体、当前场景；HTTP 层通过 CLI 写入。

## 新增场景

在 `src/scenarios/<id>/` 添加 `manifest.json` 与两份提示词文件即可，无需修改 init 枚举、Web 下拉框或 miner 的 purpose 分支。例如清单：

```json
{
  "id": "example",
  "version": 1,
  "label": "示例场景",
  "storagePurpose": "coding",
  "tasks": ["feelings", "features"],
  "prompts": {
    "feelings": "summary.md",
    "features": "features.md"
  }
}
```

提示词由场景作者自行提供。ID 必须与目录名一致，仅用小写字母、数字和连字符，且以字母开头。version 为正整数；文件必须存在且位于场景包内。重新启动长期运行的 Web 服务后，重新加载页面获取新列表及 schema。

模板支持 `{aiName}`、`{userName}`、`{subjectPronoun}`、`{relationshipTimeline}`。空模板、超过 100000 字符、未知变量、未知场景、越界文件与不支持的任务组合在调用模型前报错。替换只进行一次，不把用户名等变量值当作下一层模板。

`storagePurpose` 必须选现有 accompany/coding/study 之一，只决定新记忆体的兼容目录。`scenario` 决定实际挖掘语义，切换时不受这个目录值限制。

当前任务契约仍是 `feelings ← messages`、`features ← feelings`，由共享执行器完成分块、恢复、校验与整日发布。新场景可以替换这两类提示词；新增第三种产物仍需实现输出校验、依赖与发布逻辑。本次不开放任意脚本任务，也不提供场景参数表单或多场景并行运行。

## 兼容与作用域

- 旧配置没有 scenario 时，通过 purpose 解析为同名场景。仅执行查询不会改写配置；以后通过 init 更新时会保存显式 scenario。
- init 支持只传 scenario；已有调用方仍可传 purpose。更新时未传 scenario 会保留已配置的场景；已有 purpose/runtime 的目录迁移限制不变，validate 与实际写入都检查。
- 提示词优先级是当前记忆体/场景的覆盖、清单声明的旧全局覆盖、场景默认。局部文件位于 `<memoryDir>/prompt-overrides/<scenario>/<task>.md`。
- 三个旧场景保留既有全局特征覆盖；陪伴场景还保留既有全局摘要覆盖。这些兼容文件来源显示为 legacy-global。新场景不声明 legacyOverrides 时不会继承全局覆盖。
- 内置默认提示词现在以 `src/scenarios/` 中的文件为准；`operations/` 的旧副本不再是 miner 的默认加载入口。单日默认内容沿用旧文本；跨日特征阶段改为使用同一份注册特征模板，修正原先复用摘要模板的分叉。`buildFeelingPrompt`/`buildFeaturePrompt` 保留调用签名，但也读取注册器默认值。
- 切换场景不会自动重挖、搬迁目录、覆盖用户 rules 或改变历史摘要。需要更新历史时，使用已有 mine-review 候选预览/采用流程和锚点保护。

## 执行一致性与缓存

正式挖掘、单日/跨日预览、精准补挖和自检均读取共享解析结果。API 与 Claude/Codex Subagent 使用相同任务文本及输出约束。运行开始读取摘要和特征文本，后续阶段消费该次快照。

分块缓存升级为 version 2。缓存复用同时要求原文指纹、块数、最终任务提示词、场景版本、输出契约、模型/运行时/接口配置与分块策略一致；旧缓存不复用。不将密钥纳入缓存元数据。候选 promptHash 覆盖摘要和特征两份提示词及 overlay。

没有数据库结构迁移；历史已完成状态保持原样，不自动增加历史来源字段。失败仍沿用现有整日原子发布与重试逻辑。回退代码时若曾切换场景，应先用 CLI 切回与 purpose 相同的场景；局部覆盖需另行导出，因为旧版不识别它们。

## 验证

`test/scenario-registry.test.js` 覆盖清单扩展、旧默认文本、局部/全局覆盖、单次模板替换、CLI 预览与实际写入、init 创建/更新兼容、跨日/精准挖掘提示词，以及各执行引擎的缓存失效。原有挖掘发布、重试和候选审核测试继续保留。

测试在临时 HOME/USERPROFILE 中运行，模型执行使用 stub。开发者社区目录名断言的上游修复已随主线同步带入，本次不包含该断言的独立改动。
