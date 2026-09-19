# 生活监督与场景注册：调研草案

状态：历史调研草案。日期：2026-09-18。
开发分支：`codex/life-supervision-scenarios`。

后续范围已按用户要求收窄：仅重构通用场景功能，不编写生活监督摘要或挖掘提示词，也不注册生活监督业务场景。当前实现与使用方法见 [场景注册与提示词选择](../scenario-registry.md)；下文的生活监督能力与扩展命令均为调研建议，不代表已实现或已批准的业务需求。

## 建议与范围

把“场景”定义为一份声明式配置：选择提示词、所需参数和挖掘任务。普通用户只选场景并填写少量业务信息；已有任务组合能支持的新场景，只需增加清单与提示词文件。真正新增输出类型时，仍需实现校验、存储和展示，不能靠注册一段提示词假装完成。

首期建议支持生活目标、执行情况、障碍与复盘；跨天目标状态、定时提醒分别作为后续能力。此范围是待用户反馈的建议，不是已确认需求。调研仅检查仓库源码，未读取真实记忆正文、用户配置或密钥，未运行真实 init 或挖掘。

## 当前实现的阻力

| 源码位置 | 当前行为 | 影响 |
| --- | --- | --- |
| `src/services/init-contract.js`、`scripts/stmem-init.js`、`src/web/public/app.js` | schema、交互提示、下拉框分别列出 accompany/coding/study | 新用途需要多处同步 |
| `src/services/thread-setup.js`、`src/config.js` | purpose 参与目录构造，更新已有线程时禁止改变 purpose | 切换行为与搬迁存储耦合；schema 有枚举，但 validateThreadInput 未作同等用途枚举检查 |
| `src/services/memory-miner.js` 的 buildFeelingPrompt/buildFeaturePrompt | 用 purpose 分支构造提示词，未知用途返回空字符串 | 新场景可能初始化后才发现不能挖掘 |
| 同文件 _generatePendingDay、_mineDayWithSubagent、previewMerged、diagnose 等路径 | 提示词在多处选择、拼接；陪伴场景存在专用分支 | 只修改一个入口会造成正式挖掘、预览、自检或执行引擎不一致 |
| 同文件 _readFeatureOperationsPrompt 与连续日期预览 | 单日读取特征文件；连续日期陪伴路径从摘要 ops 构造特征指令 | 新注册器需要覆盖这两条路径，并明确行为兼容测试 |
| `src/web/server.js` 的 mining/prompts 路由 | 页面按 threadId 进入，覆盖文件却写入全局 prompt-overrides；编辑限陪伴场景 | 修改一个记忆体的提示词可能影响其他记忆体；写提示词还未经过 CLI |
| `src/services/memory-miner.js` 的 _loadChunkCache | 缓存复用比较原文指纹与块数 | 切换场景或提示词后可能复用旧分块结果 |

可复用的基础：正式挖掘与候选预览共享 `_generatePendingDay`；现有摘要→特征依赖、分块恢复、`replaceDay` 发布、候选审核和挖掘后 hooks 已存在。拓展挖掘台的 `channel` 主要选择 API/Subagent 引擎，不是任意业务任务注册器。

## 方案取舍

| 方案 | 新场景成本 | 局限 |
| --- | --- | --- |
| 增加 life 的 purpose 分支 | 当次改动直接 | 继续扩散枚举、引擎分支和目录耦合 |
| 只注册提示词 | 已有摘要/特征场景成本低 | 无法描述新增任务、输入依赖、校验和结果去向 |
| 场景清单 + 提示词注册 + 受控任务注册 | 首次收口成本较高，后续低 | 需明确兼容与缓存版本；建议采用，分阶段实现 |
| 任意脚本插件与通用工作流引擎 | 扩展能力大 | 当前没有足够需求支撑其复杂度，不纳入首期 |

## 配置模型

分开三个维度：`scenario` 决定业务语义；任务决定产物及依赖；`minerMode`/runtime 决定如何执行。不要让“生活监督”成为第三种 API/Subagent 通道。

建议线程只新增 `scenario: "life-supervision"` 与 `scenarioOptions`。保留旧 purpose 作为兼容目录字段；已有目录不变。未填 scenario 的旧配置通过显式映射解析为同名旧场景，不写回、不触发历史重挖。新记忆体的 purpose 由共享初始化服务补全为明确的兼容值（建议沿用 accompany），高级输出显示实际目录和 scenario，用户不必填写两套用途。

这个兼容方案应检查全部 purpose 消费方后落地，不能只改 init。长期是否重命名存储字段另行迁移，本期不搬目录。更新已有记忆体时，未提供 scenario/options 必须保留原值。

建议内置布局：

```text
src/scenarios/<id>/manifest.json
src/scenarios/<id>/prompts/summary.md
src/scenarios/<id>/prompts/features.md
src/services/scenario-registry.js
src/services/prompt-resolver.js
src/services/mining-task-registry.js
```

示意清单（不是现有可执行格式）：

```json
{
  "id": "life-supervision",
  "version": 1,
  "label": "生活监督",
  "optionsSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "focusAreas": { "type": "array", "items": { "type": "string" } },
      "reviewStyle": { "type": "string", "enum": ["gentle", "direct"], "default": "gentle" }
    }
  },
  "prompts": {
    "summary": "prompts/summary.md",
    "features": "prompts/features.md"
  },
  "tasks": ["feelings", "features"],
  "optionalTasks": ["life-review"]
}
```

首期只发现随发行版交付的清单；不自动执行外部目录中的 JS。清单引用的任务必须已注册，ID 唯一、版本受支持、相对路径限制在场景包内。init schema、CLI 选项和 Web 场景列表都消费同一个注册结果。非法场景、缺失提示词、未知变量与依赖环在调用模型前报错。

## 提示词解析与切换

共享解析器产出任务定义：最终文本、来源、场景版本、输出契约版本和内容哈希。API 与 Claude/Codex Subagent 消费同一份解析结果；文件型 system prompt 也写入已解析文本，避免占位符处理分叉。单日、跨日、审核候选、自检和自动挖掘均走该服务。

优先级：记忆体内该场景的任务覆盖 > 场景默认。覆盖文件按 threadId/scenario/task 隔离，切换场景不会带入另一场景的覆盖。实验 overlay 仅对当前候选运行生效，按任务指定，不默认追加到所有任务。

旧全局 override 作为明确标记的兼容来源，只用于仍走旧场景解析的用户，并保留原有适用范围；不能静默让生活监督继承陪伴提示词。界面展示来源及影响范围，提供预览后迁移到记忆体局部覆盖的 CLI。新编辑入口统一经 CLI 写入。

缓存标识包含输入指纹、任务 ID、最终提示词哈希、契约版本、场景版本、执行配置与分块策略版本；不包含密钥。任务指纹不匹配则不复用缓存。运行开始时冻结解析结果，中途修改配置对下一次运行生效。

切换场景默认只影响后续运行。旧已完成日期标记为“由旧方案生成”或“来源未知”，不能直接改成失败并让 watcher 自动全量重挖。历史更新使用显式日期范围的候选预览与采用流程，沿用现有锚点保护、备份和冲突检查。若历史产物尚无方案来源字段，应增加带版本的运行元数据并明确旧值为 unknown。

## 生活监督的最小能力

摘要记录用户明确表达的目标、发生的行为、时间、遇到的障碍以及同意采取的下一步。必须区分计划、自述完成、取消和未知，不把“明天跑步”写成“今天跑过步”，也不把未提及视作失败。

特征继续复用 sleep/eat/body/habit/work 等现有类别；单次行为进事件摘要，持续偏好或多次确认的模式才进入长期特征。不新增一个笼统的 life 类别。

初始化可选择关注领域与复盘语气，均可跳过。具体目标从有证据的对话抽取，避免要求用户维护一份配置目标列表和一份对话目标列表。生活监督的对话行为指令与 miner 的抽取提示词分别注册；新记忆体可生成建议的 rules 模板，已有 rules 只提供差异预览，不覆盖用户手写内容。

可选 `life-review` 任务建议读取选定范围的清洗消息与摘要，生成带原文引用的复盘候选。引用由程序对照真实消息 ID 校验；摘要缺失不能作为“没有执行”的证据。候选存入隔离的模块存储，暂不写进 feelings/features，不自动注入线程；这样可先验证复盘价值，再决定是否增加正式结构化状态。

如果用户需要跨天目标追踪，另行定义 goal identity、目标变更/取消/重复周期及完成事件契约，并用真实样本验证。主动提醒还需要时间区、调度、通知渠道、安静时段和停用规则；提示词注册本身不能提供这些能力。

## 任务执行与 CLI

任务注册只允许受控实现声明输入、依赖、提示词槽位、输出校验器和发布方式。首期保持 feelings ← messages、features ← feelings 两阶段，避免先构建通用 DAG 引擎。

feelings/features 保持现有整日原子发布：任意必需阶段失败不得发布部分正式结果。life-review 是独立候选任务，失败单独记录并可重试，不把已成功的正式挖掘标记失败；不能让 hook 吞错后显示“全部成功”。

拟增加的命令接口（尚未实现）：

```text
stmem scenario list
stmem scenario inspect <id>
stmem init --template --scenario life-supervision
stmem init --batch-file <file> --validate
stmem scenario set --thread <id> --scenario <id> --dry-run
stmem scenario set --thread <id> --scenario <id> --apply
stmem prompt show --thread <id> --task feelings --resolved
stmem prompt set --thread <id> --task feelings --file <path> --validate
stmem prompt set --thread <id> --task feelings --file <path> --apply
```

复盘优先扩展既有 mine review 的候选流程；确需独立模块时，再确定模块 CLI，不另造挖掘后端。Web 负责选择场景、按 schema 展示业务字段与预览最终设置，写操作调用 CLI。引擎密钥及模型配置沿用现有设置，不随场景重复配置。

## 实施与验证

1. 统一旧场景解析：注册 accompany/coding/study，抽离提示词选择，覆盖所有生成入口；先用夹具固定当前行为，对已发现的跨日特征提示词差异单独评审，不夹带语义更改。
2. 打通 scenario 与 init/schema/Web，保留目录、旧参数和旧覆盖兼容；加入作用域隔离、缓存版本与来源展示。
3. 注册生活监督提示词与可选 rules 模板，用两阶段正式挖掘验证；在需求确认后实现 life-review 候选任务。
4. 用样本决定是否继续做跨天结构化目标与主动提醒，避免为尚未确认的需求建状态机。

验收样例：

- 同一句“明天准备跑步”只能生成计划；次日说“没去，膝盖不舒服”记录未执行及障碍；后日未提及保持未知。
- “这周不跑步了”是计划变更，不继续按旧目标判失败；“晚上散步了”不能自动视为完成跑步目标。
- 同线程从陪伴切生活监督，目录、原文、历史摘要、锚点不变；两记忆体的提示词覆盖互不影响。
- 新场景在已有任务范围内只新增清单和提示词；CLI、schema、Web 自动出现，无新增 purpose 分支。
- API/Claude/Codex、单日/跨日、正式/候选/自检解析得到一致的任务提示词及契约。
- 修改提示词后旧分块缓存不可复用；仅修改显示名称不应触发无必要的重挖。
- features 失败不发布半天结果；life-review 失败不丢失已经发布的正式记忆。
- 旧配置无 scenario、存在全局覆盖、已有自定义 rules、旧已完成状态无版本，均有明确兼容结果。

实现测试必须在启动进程前设置临时 HOME/USERPROFILE，使用临时数据库、假线程和执行器 stub。运行相关测试及仓库要求的完整 npm test；不调用真实模型、不使用真实本地数据。

本次只有调研文档，无配置或数据库迁移。实现阶段的回滚分两类：场景配置切回不会还原历史重挖；已采用的新产物需按已有备份恢复。若增加运行元数据或模块表，须提供独立迁移和旧版本兼容说明后再上线。
