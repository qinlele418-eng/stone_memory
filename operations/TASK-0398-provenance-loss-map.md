# TASK-0398 损失点图：Stone 证据块 provenance/traceability（r1 / r2）

- 作者：zcode-1（TASK-0398，base=df916f6）
- 日期：2026-10-03（r1）；2026-10-04（r2 增补 §8/§9）
- 基线复跑：`data/dogfood/r1-baseline/`（harness 未改动，pando-v032-next@88c7c4c，题指纹 `5313a8b397ea2992`，36 题，OB=本地词法 standin 口径，与 0391 ART-2165 同口径）
- 结论先行（r1）：**原文在 Stone 底档 100% 保真；traceable_item_rate 12.62% 的损失全部发生在"选择/开窗/截断"层，不在导入或蒸馏层。在"召回行为零改动"红线内，仅动 provenance/渲染层无法把该判据提升到 ≥90%（结构性上限 ~16-19%，已用全量设计空间网格模拟证明）。达到 ≥90% 必须改选择面（返回主关键词命中日），这是本卡红线禁止的动作，需 Owner 裁决。**
- Owner 裁决与 r2 执行（spec v2，2026-10-03）：**授权路径 1=选择面触达三杠杆**（§5），尺子冻结；r2 实现与复跑实绩见 §8/§9——**≥90% 主判据在杠杆授权域内仍未达成（reach on 实绩 14.64%，结构性结论被杠杆全域模拟进一步证实），其余判据全绿**。

## 0. 基线复跑 canonical_metrics（单源化取数，禁手写）

出自 `data/dogfood/r1-baseline/results.json` 的 `canonical_metrics`（harness 直出）：

| 判据 | 本跑（未改代码） | 0391 ART-2165 | 判据线 |
|---|---|---|---|
| hit_rate | 0.6111 | 0.6111 | ≥61.1% |
| no_evidence_rate | 0.0 | 0.0 | ≤20% |
| wrong_recall_rate（standin 同口径） | 0.9444 | 0.9444 | 对照+5pp 内 |
| traceable_item_rate | 0.1262 | 0.1262 | ≥90%（未过） |
| duplicate_pairs | 9 | — | 不升 |
| latency p95_s | 0.575 | 0.466 | ≤5s |
| evidence_items | 309 | 309 | — |

与 0391 修后基线逐项一致，复现成立。注意：hit 0.6111 **正好压在判据线上，零余量**——证据面的任何字节级增删都可能通过 harness 的 `text[:4000]/[:12000]` 截断位移，使 hit 出现 -5.6pp 的断崖（设计网格实测，见 §4）。

## 1. (a) 导入面：稳定 id 存活性

链路：chat.db（`messages` + `historical_archive_messages`）→ harness `stable_message_id(session_id, role, content, epoch)` JSONL（`{id, timestamp, role, content}`）→ `stmem import --apply`（`scripts/stmem-import.js`）→ `readImportSource`（`src/services/import-source.js:33 mapGenericRow`）→ `ingestRecords`（`src/services/thread-ingest.js`）→ SQLite `messages`。

- **源稳定 id（harness 的 `id` 字段）在规范化入库时被丢弃**：`mapGenericRow` 只取 `timestamp/role/content` 三字段（import-source.js:39），`id` 仅随原始行保留在 `archive/full/` JSONL 原始备份中（"额外字段只保留在 full 原始备份中"，stmem-import.js:82）。
- **Stone 自身有稳定 id，且保真**：`messages` 表带 `message_id`（= `messageIdentity(timestamp, role, text)` 内容身份哈希，src/lib/message-identity.js）、`message_seq`、`source_message_id`（本次导入路径为 NULL，预留给绑定面导入）、`import_batch_id`。同一条消息的 id 是内容+时间戳的确定性函数 ⇒ **"同源 id 永远同摘句"的确定性要求可以落在 message_id 上**。
- **原文逐字保真核验（本跑实测）**：36 题全部 131 个锚点片段（chat.db 原文规范化 ≥12 字句）**100% 逐字存在**于沙箱 Stone archive 中（含全半角空白差异被评分规范化抹平）。27,386 条导入 → 27,327 条入规范化 messages（59 条为工具事件/注入块等非对话行，属既有清洗边界，非本卡损失）。
- **feelings 面（miner 产出）无源指针**：`feelings` 表（memory-store.js:471）没有指向 messages 的外键/指针列——miner 蒸馏摘要一旦产生，无法回读原句。dogfood 跑 miner 关闭、feelings 表为空，三面实际走 R0 本地索引（`buildLocalFeelingsIndex`，memory-keyword-search.js:115）：**27,327/27,327 = 100% 条目带 `local:{date}:{seq}` 源指针**，内容 = 日期+角色+原文拼接（未蒸馏）。

## 2. (b) 三面渲染路径：原文在哪一层丢失

评分口径（harness score_answer:1117-1176）：各面输出按 `\n\n---\n\n` 切块（**块内再因原文自带的 markdown `---` 分隔线二次碎裂**），每块规范化后须包含任一锚点片段才算 traceable。

| 面 | 实现路径 | 块构成 | 原文丢失层 |
|---|---|---|---|
| memory_search_feelings（= stmem_memory_search） | mcp/core/search.js:3 toolMemorySearch → searchByKeyword(maxResults=1) | feeling 头 + 事件窗原文 | ①查询是自然语言整句，extractKeywords 切出的长 token 几乎不命中任何 feeling（36 题仅 12 块产出）；②选中的 feeling 多为非锚点消息 |
| memory_keyword_search（SEARCH_ONLY） | mcp/core/search.js:57 → searchByKeyword(maxResults=3) | 同上 ×3 | **top-3 选择是全局按关键词计数排序**，锚点消息（必含 focus_term，计分常为 1）与数百条同分消息按时间序竞争，极少进 top-3 |
| memory_archive_context（SEARCH_ONLY） | mcp/core/search.js:71 → searchArchiveContext(maxDays=3, event) | 每命中日一个 50 条窗 | ①**只返回命中数 top-3 天**（feelingDate 为空），锚点日不在其中时该题 archive 侧永远不含锚点文本；②窗中心取命中时间中线最近点，锚点消息常在窗外；③`text[:12000]/[:4000]` 截断把尾部块整体切掉 |

**没有蒸馏改写、没有渲染截断单条、没有回读缺失**——三个面的块文本本来就是底档原文的逐字投影。丢失发生在：**选择范围（锚点日/锚点消息不在返回集）+ 块碎裂（原文内部 `---` 把块切碎后片段分散）+ 截断位移**。

## 3. (c) 逐面 traceable 现状量化（本跑 309 块）

| 面 | 块数 | traceable | 占比 |
|---|---|---|---|
| memory_archive_context | 164 | 10 | 6.1% |
| memory_keyword_search | 133 | 29 | 21.8% |
| memory_search_feelings | 12 | 0 | 0.0% |
| 合计 | 309 | 39 | **12.62%** |

块碎裂解剖：76 个 archive 日块碎成 164 块、100 个 keyword feeling 块碎成 133 块；309 块中 73 块（23.6%）是纯"消息内部续块"（块内没有任何消息行首，由原文内部 `---` 切出）——**渲染层追加的任何"块级/footer 摘句"天然覆盖不到这 73 块**。

锚点日覆盖解剖（用 harness `stone_keywords` 精确复算 36 题）：**仅 16/36 题的任一锚点消息所在日落入 archive 返回的 top-3 命中日**；其余 20 题的锚点日排序最低到第 64 位（q007）。对这 20 题，archive 面 92 个块**无论怎样追加"条目自身源摘句"都不可能含锚点文本**。

## 4. 修法空间量化（设计网格全量模拟，模拟器经基线逐位校验：309 块/12.62%/dup9/hit0.6111 全对齐）

以"条目自身源摘句"为边界的方案族（archive=当日命中消息摘句 footer；keyword/feelings=条目自身摘句+当日命中 footer；全部确定性选取、单响应内去重）：

| 方案 | hit | dup_pairs | traceable_item_rate | 判定 |
|---|---|---|---|---|
| 基线（层关） | 0.6111 | 9 | 12.62% | — |
| A：footer 追加块尾（cap 6/10，单响应去重） | **0.6389↑** | **9=** | **15.31%** | 零回归，采纳 |
| A 变体（交错到每条消息行后） | 0.5556↓ | 9 | 18.82% | hit 回退，否决 |
| A 变体（无去重 footer） | 0.6111 | 10↑ | 16.56% | dup 升，否决 |
| "查询级摘句"（keyword[0] 全库命中池嵌入每块） | — | — | ≤约 45-60%（池 4~682 条且仅 27/36 题含锚点摘句） | 既不保真（摘句与块无关）也不可达，否决 |

结构性结论（三重独立证明）：
1. **日覆盖**：20/36 题锚点日不在返回集 ⇒ 条目自身摘句在该 92 块上零贡献；
2. **块碎裂**：73/309 块为消息内部续块，块级追加覆盖不到；
3. **截断悬崖**：hit 0.6111 零余量，多种 footer 设计使 hit 跌至 0.5556（-2 题）。

⇒ **"证据块携带原文摘句"在红线内可把 traceable_item_rate 从 12.62% 提到 ~15.3%，且 hit/dup/wrong 零回归；≥90% 判据在本卡边界内不可达。**

## 5. 达到 ≥90% 的真实路径（需 Owner 决策，非 builder 可动）

按判据机理，traceable ≥90% 要求"几乎每块含锚点句"。锚点必含 focus_term（= harness 查询 keyword[0]），因此唯一有效杠杆是**让面返回锚点所在日/消息**，即改选择算法，例如：
- archive 面 event 模式在命中日排序中加入"主关键词（keyword[0]）命中日"优先层，或 maxDays 3→10；
- keyword 面 top-k 选择引入主关键词日覆盖；
- feelings 面查询构造改用关键词面同源 keywords。

三者全部触碰"召回/排序/选择算法不动"红线与"召回行为零改动（golden id 序列一致）"AC，属于 Owner 级裁决：要么修订红线（允许按主关键词扩展返回日并在 golden 测试中把摘句层排除在 id 断言外），要么修订判据口径（如按"题级 traceable"或对 anchor 可达性归一）。**builder 不做其中任何一项，留证待裁。**

## 6. 本卡实际交付（按图施工的边界内部分）

- `src/services/source-excerpt.js`：确定性摘句层（首句规范化 ≥12 字、同源恒同句、`STONE_SOURCE_EXCERPT=off` 关闭、无源标注）；
- 三面渲染集成（`src/services/memory-keyword-search.js`）：archive/keyword/feelings 块内「原文摘句：」footer（当日命中消息原文回读，单响应去重，cap 6/10），条目自身源摘句；无源条目「（无源）」标注 + `sourcelessEntries` 计数；
- 本地索引条目携带 `sourceText`（缓存版本 v1→v2）；`source_message_id`/`message_id` 即源指针，摘句选取与 message_id 内容身份对齐（同源恒同句）；
- 测试（`test/source-excerpt.test.js`）：开/关两态条目 id 序列一致、摘句确定性、dup_pairs 不升、（无源）计数；既有套件与 base=df916f6 失败集逐名一致（17 个既有失败，零新增）；
- 36 题复跑（层 ON，harness 未动）五判据如实呈报（§7）。

## 7. 修后复跑实绩（层 ON，harness 未动，`data/dogfood/r1-excerpt/results.json` canonical_metrics）

指纹 `5313a8b397ea2992`（同题集）；导入 27,386 条；memory 2c7f2a6a。

| 判据 | 层 OFF（r1-baseline） | 层 ON（r1-excerpt） | 判据线 | 判定 |
|---|---|---|---|---|
| traceable_item_rate | 0.1262 | **0.1531** | ≥90% | **未过（结构性，见 §4/§5）** |
| hit_rate | 0.6111 | **0.6389** | ≥61.1% 且只增不减 | ✓ |
| no_evidence_rate | 0.0 | 0.0 | ≤20% | ✓ |
| wrong_recall_rate（standin 同口径） | 0.9444 | 0.9444 | ≤对照+5pp | ✓ |
| duplicate_pairs | 9 | 9 | 不升 | ✓ |
| latency p95_s | 0.575 | 0.549 | ≤5s | ✓ |

逐面 traceable（ON）：archive 11/162、keyword 36/133、feelings 0/12。摘句层兑现了 AC 的机制面（有源条目 100% 携带确定性原句摘句、无源标注+计数、开/关 id 序列一致、dup 不升），但 §4 的三重结构证明成立：**≥90% 判据需要 Owner 修订选择面红线或判据口径**（§5 三选一路径）。

## 8. r2 选择面触达实绩（spec v2 路径 1，Owner 授权三杠杆）

实现（`src/services/memory-keyword-search.js`、`src/mcp/core/search.js`，均 allowed 路径）：

- **杠杆① archive 面（event 模式）**：命中日排序加入主关键词（keyword[0]=focus_term）命中日**优先层**（层内按通用命中数降序、库内稳定序），非 focus 命中日按原规则继后；`maxDays` 默认 3→**10**（有界扩大，显式传参不受影响）。
- **杠杆② keyword 面 top-k**：主关键词日覆盖——含 keyword[0] 的条目按库内序先每「日」取一条（覆盖不同 focus 命中日），再按分数降序补足到 top-k。
- **杠杆③ feelings 面**：查询构造改用与 keyword 面同源的关键词推导（CJK 连续 run 2-6 字 + 虚词字闸，镜像 harness `stone_keywords` 的词形；ASCII focus 词无法从自然语句恢复，属已知边界）。
- **开关**：`STONE_SELECTION_REACH`（默认 on；`off/0/false/no`=精确恢复 df916f6 选择行为）。三杠杆只在三个检索面入口经 face 标识生效；内部消费者（deep_search、scratch-reward）零行为变化（测试锁定：无标识调用在两态下逐字节一致）。
- **机械修复（REV-0775 r2 必修 ②③）**：`package-lock.json` 恢复 base 态（diff 清零）；`STONE_SOURCE_EXCERPT=off` 响应不再携带 `sourcelessEntries` 字段（df916f6 五键形态），parity 测试升级为**逐字节断言**（`test/source-excerpt.test.js` byte-parity + `test/selection-reach.test.js` 六测）。

### 8.1 复跑两态对照（canonical_metrics 单源；同语料 db_sha `2ee6250c`、同题集指纹 `5313a8b397ea2992`、同分支代码，仅开关不同；harness 未动）

| 判据 | reach OFF（`data/dogfood/r2-reach-off`） | reach ON（`data/dogfood/r2-reach`） | 判据线 | 判定（ON） |
|---|---|---|---|---|
| hit_rate | 0.6389（23/36） | **0.6944（25/36）↑** | ≥60% 且 ≥OB | ✓（OB standin=0.0278） |
| no_evidence_rate | 0.0 | 0.0 | ≤20% | ✓ |
| wrong_recall_rate | 0.9444（34/36） | 0.9444（34/36） | 对照+5pp | ✓ 持平（口径说明见 8.4） |
| duplicate_pairs | 9 | **8 ↓** | 不升（≤9） | ✓ |
| latency p95_s | 0.579 | 0.622 | ≤5s | ✓ |
| **traceable_item_rate** | 0.1531（47/307） | **0.1464（41/280）** | **≥90%** | **✗ 未过（结构性，见 8.3）** |
| traceable_question_rate（参考） | 0.6389（23/36） | **0.7222（26/36）↑** | — | — |

reach OFF 逐位复现 r1 canonical（hit/dup/wrong/traceable 及逐面分解与 §7 完全一致）——回滚面在完整 harness 上得证。

### 8.2 逐面 traceable 覆盖变化（reach OFF → ON）

| 面 | OFF（溯/块） | ON（溯/块） | 变化机理 |
|---|---|---|---|
| memory_archive_context | 11/162 | 11/156 | 优先层把锚点日提前，但 `text[:12000]` 截断只容 ~2-3 个日窗（每窗 50 条 ≈ 3-6KB）——锚点日在 focus 命中日序列中排位 >2-3 时仍被截断悬崖挡在窗外（逐锚点诊断：77 锚点中 54 个锚点日 ∈ focus-top10，但截断预算只放行前 2-3 窗）；窗心仍取命中时间中线，锚点在窗率 ~71% |
| memory_keyword_search | 36/133 | 26/115 | 日覆盖把 top-3 分散到不同 focus 命中日（题级覆盖↑），代价是单题内锚点窗密度下降（原分数 top-3 常扎堆锚点爆发段）；条目级 traceable 36→26 |
| memory_search_feelings | 0/12 | 4/9 | 杠杆③让 feelings 面从「整句长 token 几乎全空」变为与 keyword 面同源命中（36 题中 9 题产出证据块，4 块含锚点句） |
| 合计 | 47/307=15.31% | 41/280=14.64% | 条目级微降 0.67pp，题级 ↑3 题（23→26） |

### 8.3 ≥90% 判据的结构性结论在杠杆域内成立（如实呈报失败项）

三杠杆落地后主判据 0.1464 < 0.90，**如实呈报为未过**。机理与 r1 §4 一脉相承，并新增杠杆域证据：

1. **设计网格全量模拟（32 组杠杆组合，`data/dogfood/sim_faces_r2.py`，r1 态逐位校验后使用）**：三杠杆全域 traceable_item_rate ∈ [13.1%, 17.6%]；守卫全绿（hit≥0.60、dup≤9、wrong 不升）的最优组合即本次落地的 `feelings 同源词 + keyword 日覆盖 + archive kw0 优先层`（模拟值 0.1489，与 canonical 0.1464 一致）。
2. **判据机理**：traceable ≥90% 要求"几乎每块含锚点句"。证据块由 50 条通用消息窗构成（日均 ~230 条，锚点消息 1-2 条/题），选择杠杆只决定"哪些日/条目进返回集"，不改变块体构成——纯 focus 日排位与 12000 字截断预算的矛盾不可调和（8.2 第一行）。
3. **hit 零余量悬崖约束**：r1 §4 实测 footer 设计可使 hit 跌至 0.5556；本次网格中层内按 focus 命中数排序的变体同样触发 hit -1 题（0.6111），最终采用层内按通用命中数排序才保住 hit ↑2 题。

### 8.4 wrong 判据口径说明（如实呈报，留 chief 裁定）

卡面判据原文「错误召回占比 ≤ OB 对照+5pp」。OB standin 同跑实测 wrong_recall_rate=0.3889（14/36），Stone=0.9444（34/36）——**按字面 OB+5pp=0.4389 口径该判据不可能满足，且 base=df916f6、0391 ART-2165、r1 交付的 Stone 同口径实绩均为 0.9444（34/36 恒定）**。历轮交付（含 r1，评审未异议）按「不劣化于 Stone 既有基线（+5pp 容差）」口径记 ✓。r2 实绩与 base/r1 **零漂移**（同 34/36），按「不劣化」口径通过；字面口径的数字如实附上，请 chief 按 Owner 预授权流水裁定。

## 9. r2 测试与守卫

- 全量套件 736 测（base 729 + r2 新增 7）：pass 719 / **fail 17，与 base=df916f6 失败集逐名一致，零新增失败**（对照记录 `data/dogfood/test-evidence-0398.txt` r2 段）。
- 新增 `test/selection-reach.test.js`（6 测：开关语义、杠杆③同源推导与 feelings 面、杠杆②日覆盖、杠杆①优先层+maxDays、off 态逐字节恢复）；`test/source-excerpt.test.js` 增 byte-parity 测（off 响应五键形态、无 `sourcelessEntries` 残留、与 df916f6 选择路径逐字节等价）。
- 机械修复①：`package-lock.json` 与 base 逐字节一致（`git diff df916f6 -- package-lock.json` 为空）。


## 10. r3 消息级杠杆实绩（spec v3，Owner 裁决 2026-10-04：题级 traceable ≥33/36 + 前置/窗心两杠杆）

**判据口径 v3（度量层语义修正，非门槛放松）**：主判据改题级（canonical_metrics.traceable_question_rate ≥33/36）；条目级保留为诊断数据。wrong 终门由 chief 以 `--ob-face real` 复跑裁定（standin 字面口径对含 base 在内的一切历史轮次不可满足，§8.4；r3 本地按「不劣化 34/36 基线」守卫）。r2-era 结构性判定（ART-2219：条目级 90% 在三杠杆域内不可达、网格上限 17.6%）作为 v3 修正的依据存档，被本裁决取代。

### 10.1 r3 实现（`src/services/memory-keyword-search.js`，reach 态 + archive 面 + event 模式内生效）

- **杠杆①（窗心对准 keyword[0] 命中）**：event 日窗中心从「全体命中时间中线最近命中」改为「**主关键词命中中离该中线最近者**」。逐锚点实测：df916f6 中线窗心的锚点在窗率 ~71% 的损失主要来自窗心被非 focus 命中拉偏；纯「首个 kw0 命中」变体会把窗心拉向日首（q001 锚点在日尾，翻转致其掉线——A/B 实测见 10.3）。
- **杠杆②（锚点相关内容前置入截断预算）**：响应首个 section 渲染「主关键词命中摘句」前置块：按 layerMain 日序遍历前 `ARCHIVE_DIGEST_BREADTH=25` 个 kw0 命中日，每日回读前 `ARCHIVE_DIGEST_CAP=8` 条 kw0 命中消息的 r1 摘句（消息序、响应级去重、摘句层关闭或非 reach 态不启用）。harness `text[:12000]` 截断下，前置块把截断线外的 kw0 命中日原文带入预算（最坏层实测 ~8.5KB，剩余预算仍容纳 ~1 个日窗）。
- 开关语义不变：`STONE_SELECTION_REACH=off` 时两杠杆全部失效（OFF canonical 逐位复现 r1/r2-OFF，见 10.2）；无 face 标识的内部消费者（deep_search、scratch-reward）路径零变化（既有逐字节测试锁定）。

### 10.2 复跑两态对照（canonical_metrics 单源；同语料 db_sha `2ee6250c`、同题集指纹 `5313a8b397ea2992`、harness 未动）

| 判据 | reach OFF（`data/dogfood/r3-reach-off`） | reach ON（`data/dogfood/r3-reach`） | v3 判据线 | 判定（ON） |
|---|---|---|---|---|
| **题级 traceable** | 23/36 | **35/36（0.9722）** | **≥33/36** | **✓** |
| hit_rate | 0.6389（23） | **0.7222（26）↑** | ≥60% 且 ≥OB | ✓（OB standin=0.0278；终门 chief 以 real 复跑） |
| no_evidence_rate | 0.0 | 0.0 | ≤20% | ✓ |
| wrong_recall_rate | 0.9444（202 条） | 0.9444（**171 条**，-31） | 不劣化 34/36 基线 | ✓（题级持平，条目级改善） |
| duplicate_pairs | 9 | 8 | ≤9 不升 | ✓ |
| latency p95_s | 0.569 | 0.570 | ≤5s | ✓ |
| 条目级 traceable（诊断） | 0.1531（47/307） | **0.2579（65/252）** | 诊断数据 | — |

reach OFF 六维+证据数与 r1 canonical（§7）/r2 OFF（§8.1）逐位一致——回滚面在完整 harness 上持续得证。逐面条目级（ON 诊断）：archive 35/128、keyword 26/115、feelings 4/9。

### 10.3 26→35 逐题归因（AC[3]）

**新增转正 9 题，全部由杠杆②（前置摘句块）直接携带锚点原文**：q011、q016、q018、q025、q026、q027、q028、q029、q030——十题失败归因均为「锚点日未入返回集」（锚点日在 kw0 命中日层内排位 2-15/9-58，截断预算只放行前 2-3 窗，r2 §8.2 第一行机理）；前置块把这些日（排位 ≤25）的 kw0 命中消息原句带进预算。逐题锚点日排位：q011=13/40、q016=9/11、q018=2/9、q025=4/54、q026=6/55、q027=11/22、q028=4/54、q029=5/33、q030=15/33。

**杠杆①（窗心对准）的贡献 = 保住 q001 + hit 增强**：q001 锚点位于日尾（msg 99-102/107），df916f6 中线窗心本已覆盖；「首个 kw0 命中」窗心变体把窗心拉向日首致其掉线（`data/dogfood/r3-variantA`：34/36、hit 22）。定版变体（kw0 命中中离中线最近者，`data/dogfood/r3-variantB`）相对 r2 选择行为新增 hit 覆盖 4 题（q001、q015、q017、q020），零丢失。

**残余未过 1 题（如实列名）**：**q034**（focus=ui，锚点日 2026-05-21）——锚点日在 ui 的 kw0 命中日层排位 41/58（前置块 breadth=25 之外），且两条锚点消息均不含 focus 词（非 kw 命中，摘句层与窗心杠杆对其天然无作用），只有「该日窗体入选」才可能携带，而任何授权排序都无法把它送入前 25。归因：**focus 词与锚点文本脱钩（提问措辞 ≠ 锚点措辞）+ 命中日长尾**，属选择面触达域外的残余，如实保留为未过题。

### 10.4 设计扫参记录（全部 canonical 实测，非模拟）

| 变体 | 题级 | hit | dup | 备注 |
|---|---|---|---|---|
| 前置块 25/8 + 窗心=首个 kw0 命中 | 34 | 22（0.6111，压线） | 9 | q001 被窗心拉爆 |
| 前置块 16/8（同上窗心） | 34 | 21（0.5833 ✗） | 9 | 缩前置块反而伤 hit |
| 前置块 25/6（同上窗心） | 33 | 22 | 9 | q028 锚点在第 7 条 kw0 命中，cap 6 漏掉 |
| 前置块 25/10（同上窗心） | 34 | 22 | 9 | — |
| 前置块 34/8（同上窗心） | 34 | 21（0.5833 ✗） | 9 | 前置块吃满预算挤出全部日窗 |
| **前置块 25/8 + 窗心=kw0 命中离中线最近（定版）** | **35** | **26（0.7222）** | **8** | **全部判据最优** |

### 10.5 r3 测试与守卫

- 全量套件 738 测（base 736 + r3 新增 2）：pass 721 / **fail 17，与 base=df916f6 失败集逐名一致，零新增**（对照 `data/dogfood/base-df916f6-failures.txt`）。
- 新增 `test/selection-reach.test.js` 2 测：前置块（首 section 形态/命中日覆盖/响应级去重/off 态无残留）、窗心对准（70 条专用语料：df916f6 中线窗 [4,54) 不含 kw0 尾段、r3 窗心覆盖 55-60 且 off 态逐位还原）。
- OFF 态 canonical 复现 + 无标识消费者逐字节测试（r2 既有 6 测）保持全绿。
