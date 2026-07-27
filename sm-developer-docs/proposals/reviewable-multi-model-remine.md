# 可审阅的多模型重挖与按日替换

> 实现状态（2026-07-27）：第一阶段 CLI 核心已经接入，正式命令采用
> `stmem mine-review preview|list|mix|apply|discard`。在原提案基础上，当前实现增加了
> 显式 thread、同日 apply 互斥、候选重验，以及锚点/人工 coarse/hidden 状态存在时
> fail closed。多模型批量编排、HTTP 适配与并排审阅前端现已作为开发者实验接入：
> 页面可并发生成独立候选、逐条混选、编辑和查看附近原文；所有候选变更与正式发布
> 仍以这些 CLI 为唯一写入口，页面和 route 不复制正式写入逻辑。

## 真实问题

当前 `stmem mine --force` 可以重新挖掘某一天，但正式结果会直接替换当天的
feelings 与 features。用户无法在写入前：

- 比较不同模型在相同原文上的遗漏、重复和情感质量；
- 查看某次临时规则组合实际生成了什么；
- 从多个候选中逐条选择，而不是整份二选一；
- 在替换前确认 archive 是否已经变化；
- 得到一份明确关联本次替换的数据库备份。

这在历史多窗口、跨入口或情绪密度较高的对话中尤其明显。模型可能都能输出合法
JSON，但分别遗漏不同事件，或者把一次局部感受错误提升为长期 feature。直接
`--force` 会把模型比较、人工复核和正式写入压缩成同一个不可见步骤。

## 当前系统为什么无法完整解决

现有矿工已经具备以下重要基础：

- 只读取 SQLite 中清洗后的 messages；
- 按完整消息和对话空档安全分块；
- API / Subagent 共用任务定义与输出约束；
- `MemoryStore.replaceDay()` 原子替换一天；
- mining job 与 day state 审计。

缺少的是位于“模型输出”和“正式发布”之间的候选审阅层。这个层不能只在前端
实现，否则会形成绕过 CLI 的第二套写入逻辑；也不应把候选直接写进 feelings /
features，因为尚未确认的模型输出不是数据库真相。

## 最小能力

建议为 `stmem mine` 增加一组 review 子流程。命令名称可在实现时调整，但语义应
保持稳定：

```text
stmem mine --review-preview --thread <id> --date <date> --batch-file <json> --json
stmem mine --review-list --thread <id> [--date <date>] --json
stmem mine --review-mix --thread <id> --batch-file <json> --json
stmem mine --review-apply --thread <id> --candidate <id> --json
stmem mine --review-discard --thread <id> --candidate <id> --json
```

### Preview

1. 从 SQLite 读取指定日期的纯对话。
2. 记录 messages 的 archive fingerprint。
3. 使用作者原版任务定义，并按本次 batch file 叠加可选规则。
4. 每个模型独立生成候选；模型之间不互相读取结果。
5. 规范化 importance、category、event time 与顺序。
6. 把候选保存到线程私有数据目录，不写 feelings / features。

### Mix

1. 只接受同一线程、同一日期、同一 archive fingerprint 的待审候选。
2. 由用户逐条引用候选中的 feelings / features。
3. 完全相同的 content 去重，但不自动改写原文。
4. 保存每条所选内容的来源模型、来源候选和原始序号。
5. 生成新的 hybrid 候选，仍不写 SQLite。

### Apply

1. 重新读取当天 messages 并复核 fingerprint。
2. 使用 SQLite backup API 创建一致性备份并计算 SHA-256。
3. 创建正式 mining job。
4. 通过共享服务调用 `MemoryStore.replaceDay()`，原子替换当天结果。
5. 更新 day state 与 job；候选标为 applied，同日其余待审候选标为 discarded。
6. 返回备份文件名、哈希、写入条数与 job ID。

前端、MCP 与自动任务只能通过以上 CLI 完成确认写入。只读候选查询可复用
reader；HTTP 层只负责安全临时文件、CLI 调用和结果格式化。

## 模型选择

不建议把上游模型名永久写死在核心算法中。可以在现有 provider 配置之上增加
本地 model profiles，每个 profile 只包含：

```json
{
  "id": "local-profile-id",
  "label": "页面显示名",
  "channel": "api-or-subagent",
  "provider": "configured-provider",
  "model": "exact-upstream-model-name",
  "reasoning": "optional"
}
```

Key 继续只保存在现有本机配置中，不进入 batch file、候选、日志或 PR。前端可以
多选可用 profile，让每个模型生成一份相互独立的候选。若某个 profile 失败，其余
候选仍可供审阅，但状态必须明确显示为“部分失败”。

## 可选规则与组合

作者原版提示词始终是底稿。规则是单次任务 overlay，不覆盖
`operations/memory-miner-operations.md`，也不为某个用户硬编码称呼或关系。

建议提供七项互相独立的通用规则：

1. 多窗口来源感知：避免仅凭时间相邻拼接并行窗口。
2. 同一关系与平台降噪：证据确认同一关系时减少平台词，不删除真实情绪。
3. 私人记忆与情感优先：避免写成画像、周报或咨询报告。
4. 冷淡、冲突与吃醋归因：局部体验不自动升级为稳定 feature。
5. 亲密内容事实提取：不因表达露骨而跳过真实、成年、自愿的亲密事实；不续写、
   不补全、不虚构。
6. 每日 8–20 条：20 为硬上限；证据不足时允许少于 8，禁止凑数。
7. 严格 importance 与 features：importance 只用 2 / 3 / 5，features 宁缺毋滥。

建议的快捷组合：

- 作者原版：不叠加任何规则；
- 日常亲密：情感优先＋亲密事实提取＋严格边界；
- 历史全增强：七项全部启用；
- 自定义：用户任意组合。

页面可以展示最终 system prompt，并允许填写仅本次生效的附加说明；不得借此直接
修改正式 operations 文件。候选必须保存 overlay 哈希与规则选择，便于审计，但
不保存 API Key。

## 前端流程

在现有“记忆挖掘”页增加一个可折叠的“候选审阅重挖”板块：

1. 选择一个已有对话日期；
2. 多选可用模型；
3. 选择快捷组合或细化七项规则；
4. 创建后台 preview job；
5. 按短请求轮询 queued / running / completed / failed；
6. 并排查看各模型候选；
7. 逐条勾选并查看可能重复、可能冲突提示；
8. 生成 hybrid 预览；
9. 二次确认后调用 CLI apply。

重复与冲突提示只能辅助复核，不能自动改写模型内容。“智能去重”最多取消后出现的
完全重复或高置信近似项，用户仍可重新勾选。

长模型调用不得由一个 Cloudflare 或反向代理请求持续等待。HTTP start 应尽快返回
202 与 job ID；页面只轮询短请求。网络中断时应先刷新候选和 job 状态，避免重复
调用模型与浪费 token。

## 候选数据

候选建议保存在每个线程的私有运行目录中，权限与其他 Stone 私有数据一致。候选
至少包含：

- candidate ID、线程、日期、模型 profile；
- archive fingerprint、message count、chunk count；
- rules / preset 与 prompt hash；
- 规范化后的 feelings / features；
- 既有当天结果条数；
- review 状态与创建、应用、丢弃时间；
- hybrid 来源追踪；
- apply 后的 backup 文件名、SHA-256 与 mining job ID。

候选不保存完整原始对话。候选是可删除的审阅工件，不应新增 SQLite 永久字段，也
不参与 rebuild，除非已经通过 CLI apply 发布。

## 可能误伤的数据与回滚

唯一会修改正式数据的动作是 `review-apply`：

- 修改指定线程、指定日期的 feelings 与 features；
- 更新对应 mining day state；
- 新增一条 mining job 审计记录。

它不得修改 messages、archive/full、锚点、规则文档、活动线程 JSONL 或 watcher
开关。apply 前的 SQLite 备份是回滚依据；实现时还应提供或复用明确的 `stmem db`
恢复说明。preview、list、mix 和 prompt 查看均不得修改正式结构化记忆。

## 验证样本

实现前后至少覆盖：

1. 单日普通对话，作者原版候选与现有 miner 结果等价；
2. 多窗口并行对话不会仅凭时间相邻错误合并；
3. 单次“冷淡”抱怨不会生成长期稳定 feature；
4. 亲密规则只提取原文证据，不因内容类别跳过，也不续写；
5. 8–20 规则在不足 8 条时不凑数，超过 20 条时前后端均拒绝；
6. 两模型逐条混选保留来源，完全重复项稳定去重；
7. 候选生成后 messages 变化，mix / apply 均因 fingerprint 不一致拒绝；
8. apply 前备份失败时不写 SQLite；
9. replaceDay 失败时 job 标记失败，旧结果保持一致；
10. HTTP preview 在长模型调用时快速返回 202，代理超时不会触发重复模型任务；
11. Claude 与 Codex 线程共用相同候选和写入语义；
12. 完整 `npm test` 通过，提交物不含 Key、私人对话、真实线程 ID 或敏感路径。

## 尚需作者确认

1. model profiles 应扩展现有 `apiKeys` 配置，还是作为独立、可选的本地配置段；
2. review CLI 采用 `stmem mine --review-*` 参数，还是独立的
   `stmem mine-review` 命令；
3. 候选默认保留期限，以及 applied / discarded 候选是否自动清理；
4. 数据库备份恢复应复用哪个正式 `stmem db` 入口；
5. 首版是否同时接 MCP，或只交付 CLI＋本地 Web。
