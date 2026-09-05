# Automatic Dream：NSFW 隔离与「绮梦」改造交接

> 接手对象：Codex / 后续开发 Agent  
> 工作目录：`/root/stone_memory_pr/.worktrees/automatic-dream-controls`  
> 分支：`feature/automatic-dream-controls`  
> 当前 HEAD：`63ca2f726634b305967d80f7c108e66d8e2a80c1`  
> 状态：**当前 worktree 有重要未提交 WIP，不允许 reset / checkout 覆盖。**

## 0. 最重要的接手说明

本 worktree 不是干净分支。现有未提交修改不是垃圾现场，而是 2026-08-16 继续开发的 Automatic Dream Policy v2，核心方向已经形成：

- 将五类最终梦境的扁平权重改回 **两阶段概率树**；
- 第一重决定基础梦向：美梦 / 噩梦 / erotic；
- 第二重仅在美梦、噩梦分支中决定是否进入 erotic overlay；
- 将旧的 `guard: boolean` 升级为 `excludedTypes: []`，允许排除任意最终梦境类型；
- 前端概率预览改为复用后端 canonical `planDreamDistribution()`，不再复制概率公式；
- preferences 已从 schema v1 向 v2 演化，并包含旧 `guard` 数据迁移；
- Dream Lab 当前 UI 已有较完整的安梦守护、梦谱调律、梦向牵引、梦境档案和 Prompt 编辑。

接手后第一步必须执行并阅读：

```bash
git status --short
git diff -- scripts/stmem-dream.js \
  src/services/dream-policy.js \
  src/services/dream-preferences.js \
  src/web/public/dream-lab/README.md \
  src/web/public/dream-lab/app.js \
  src/web/public/dream-lab/styles.css \
  src/web/server.js \
  test/dream-config-cli.test.js \
  test/dream-policy.test.js \
  test/dream-preferences.test.js
```

**不要执行：**

```bash
git reset --hard
git checkout -- .
git restore .
```

也不要从当前 upstream/main 重新起一棵干净分支后“重写一遍”。本次任务要求在这里已有的 Policy v2 WIP 上继续演化。

当前未提交文件共 10 个：

```text
M scripts/stmem-dream.js
M src/services/dream-policy.js
M src/services/dream-preferences.js
M src/web/public/dream-lab/README.md
M src/web/public/dream-lab/app.js
M src/web/public/dream-lab/styles.css
M src/web/server.js
M test/dream-config-cli.test.js
M test/dream-policy.test.js
M test/dream-preferences.test.js
```

当前 WIP 约为：`656 insertions / 255 deletions`。

---

## 1. 本次产品目标

Automatic Dream 原本将亲密主题梦境作为默认可见能力。现在需要调整为：

> **默认只向普通用户提供美梦与噩梦。**  
> 亲密主题梦境变为默认关闭、深层隐藏、主动开启后才可使用的 NSFW 能力。

这次不是删除亲密梦境，也不是大幅削弱 Prompt，而是做：

1. 默认关闭；
2. 能力隔离；
3. 可见术语去敏感化；
4. 后端策略层强制不可达；
5. 旧数据保留且可恢复。

---

## 2. 已确定的产品决策

### 2.1 增加 NSFW 开关

新增 thread 级正式偏好：

```js
nsfwEnabled: false
```

默认必须为 `false`。

建议 preferences schema 从当前 WIP 的 v2 升级为：

```js
schemaVersion: 3
```

建议结构：

```json
{
  "schemaVersion": 3,
  "nsfwEnabled": false,
  "multipliers": {
    "beautiful": 1,
    "nightmare": 1,
    "erotic": 1,
    "beautiful_erotic": 1,
    "nightmare_erotic": 1
  },
  "excludedTypes": [],
  "oneShot": null
}
```

### 2.2 开关位置必须深层隐藏

用户路径：

```text
织梦调律
  → 安梦守护
    → 高级设置（默认折叠）
      → NSFW 内容 [关闭]
```

不要：

- 在 Automatic Dream 首页直接展示 NSFW；
- 在「织梦调律」首页新增一个醒目的 NSFW 卡片；
- 在主 Stone Memory 设置页增加该开关。

推荐文案：

```text
高级设置

NSFW 内容
启用后解锁含成年亲密主题的绮梦及相关调律。
[ 开关 ]
```

设置名称使用正确拼写 **NSFW**。

### 2.3 开关必须是后端真实策略，不是前端 `display:none`

`nsfwEnabled=false` 时必须从 canonical policy 层保证：

- 自动织梦不会生成 `erotic`；
- 自动织梦不会生成 `beautiful_erotic`；
- 自动织梦不会生成 `nightmare_erotic`；
- 旧的 erotic multiplier 不得暗中改变安全模式概率；
- 旧 erotic exclusions 不得改变安全模式概率；
- erotic one-shot 不得被执行。

即使绕过前端直接调用 CLI / API，默认关闭状态也不能随机进入亲密梦境。

---

## 3. 术语改造：对用户统一使用「绮梦」

当前 Prompt 和前端中所有用户可见的「春梦」术语需要替换。

### 3.1 用户可见名称

推荐最终文案：

| 内部 ID | 用户可见名称 |
|---|---|
| `beautiful` | 美梦 |
| `nightmare` | 噩梦 |
| `erotic` | 绮梦 |
| `beautiful_erotic` | 美梦·绮染 |
| `nightmare_erotic` | 噩梦·绮染 |

相关术语：

```text
春梦          → 绮梦
纯春梦        → 纯绮梦
春意浸染      → 绮意浸染
染春          → 绮染 / 绮意浸染（按语境）
美梦染春梦    → 美梦·绮染
噩梦染春梦    → 噩梦·绮染
```

### 3.2 Prompt 资产也要改术语

需要检查：

```text
operations/dream/common-core.md
operations/dream/beautiful.md
operations/dream/nightmare.md
operations/dream/erotic.md
operations/dream/beautiful_erotic.md
operations/dream/nightmare_erotic.md
```

Prompt 当前总体尺度可保留：其内容是成年、自愿、关系导向、避免粗俗和机械色情描写。本次 **不要为了降低前端敏感度而大幅删改 Prompt 语义**。

重点做术语替换，例如：

```text
纯春梦体系 → 绮梦体系
纯春梦 → 纯绮梦
春梦 → 绮梦
```

现有亲密、安全、边界规则不要删除。

### 3.3 内部 ID / 文件名不要改

**这是硬约束。**

以下内部 ID 继续保留：

```text
erotic
beautiful_erotic
nightmare_erotic
```

以下文件名也保留：

```text
erotic.md
beautiful_erotic.md
nightmare_erotic.md
```

原因：

- 兼容旧梦境档案；
- 兼容旧 Prompt override；
- 兼容 DreamStore；
- 避免数据库 / 文件迁移；
- 避免已有测试和旧记录失效。

本次是 **presentation naming + policy gating**，不是内部 enum rename。

---

## 4. NSFW OFF：完整产品行为

当 `nsfwEnabled === false` 时，用户眼中的 Automatic Dream 应像一个从来没有亲密梦境设计的普通功能。

### 4.1 梦境类型只剩两种

用户只看到：

```text
美梦
噩梦
```

不能出现：

```text
绮梦
美梦·绮染
噩梦·绮染
绮意浸染
双判定
第一重 / 第二重
```

### 4.2 织梦秘典

NSFW OFF 时只显示 3 份：

```text
common-core
beautiful
nightmare
```

隐藏：

```text
erotic
beautiful_erotic
nightmare_erotic
```

首页类似「6 份秘典」的计数必须改为基于**当前可见 Prompt 项**计算，不能关掉 NSFW 后仍写 6 份。

已有 erotic Prompt override 不删除，只隐藏；重新打开 NSFW 后应恢复原 override 状态。

### 4.3 梦向牵引

NSFW OFF 时选项只能是：

```text
美梦
噩梦
```

不能通过 Web 选择三个 erotic 类型。

后端 / CLI 也必须防守：若 `nsfwEnabled=false`，尝试 one-shot 到 NSFW 类型应拒绝。建议错误码：

```text
DREAM_NSFW_DISABLED
```

### 4.4 安梦守护

主区域只展示美梦、噩梦的排除选择。

NSFW 设置藏在安梦守护下方的：

```text
高级设置
```

默认折叠。

安全模式下不要把三个 hidden NSFW 类型作为「已排除三类」显示给用户；它们不是 guard exclusions，而是 capability gating。

### 4.5 梦谱调律

这是最容易写错的部分。

NSFW OFF 时 **不要展示当前 WIP 的两阶段树**。

UI 只展示：

```text
美梦倍率
噩梦倍率
```

说明可类似：

```text
调整美梦与噩梦在随机织梦中的相对倾向。
```

不要出现：

```text
基础梦向
绮梦
绮意浸染
第二重
最终五类概率
```

### 4.6 NSFW OFF 的概率算法

安全模式必须直接从：

```text
beautiful base = 80
nightmare base = 10
```

计算。

默认倍率：

```text
beautiful = 1
nightmare = 1
```

得到：

```text
美梦：80 / 90 = 88.888...%
噩梦：10 / 90 = 11.111...%
```

如果：

```text
beautiful = 2
nightmare = 1
```

得到：

```text
美梦：160 / 170 ≈ 94.12%
噩梦：10 / 170 ≈ 5.88%
```

**禁止**以下隐藏配置参与安全模式：

```text
erotic multiplier
beautiful_erotic multiplier
nightmare_erotic multiplier
```

例如用户历史上有：

```text
beautiful_erotic = 3
```

关掉 NSFW 后，它必须完全冻结、完全不参与概率。

同理，旧的 erotic exclusions 在 safe mode 中只作为被保存的隐藏配置存在，不应改变安全模式的两类概率。

### 4.7 Safe mode + exclusions

在 NSFW OFF 下，`excludedTypes` 对当前可达类型的影响只有：

```text
beautiful
nightmare
```

行为：

- 排除 beautiful → nightmare 100%；
- 排除 nightmare → beautiful 100%；
- 两者都排除 → `DREAM_NO_CANDIDATE`；
- erotic 系列 exclusions 不参与 safe mode 计算。

---

## 5. NSFW ON：恢复完整 Automatic Dream

当 `nsfwEnabled === true` 时，恢复现有 WIP 的两阶段模型。

### 5.1 两阶段概率树

第一重：

```text
美梦 80
噩梦 10
绮梦 10
```

第二重：

```text
美梦：普通 80 / 绮染 20
噩梦：普通 90 / 绮染 10
```

默认最终分布必须继续是：

```text
beautiful           64%
nightmare             9%
erotic               10%
beautiful_erotic     16%
nightmare_erotic      1%
```

用户可见：

```text
美梦 64%
噩梦 9%
绮梦 10%
美梦·绮染 16%
噩梦·绮染 1%
```

### 5.2 NSFW ON 的调律 UI

开启后，梦谱调律才显示：

```text
第一重 · 基础梦向
第二重 · 绮意浸染
最终梦谱
```

其中：

- `beautiful` / `nightmare` / `erotic` multiplier 控制第一重；
- `beautiful_erotic` / `nightmare_erotic` multiplier 控制对应第二重绮染子权重；
- 继续复用后端 canonical `planDreamDistribution()`；
- 前端不要复制概率公式。

### 5.3 开启后恢复历史设置

关闭 NSFW 时不得删除：

- erotic multipliers；
- erotic exclusions；
- erotic Prompt overrides；
- 已保存的 erotic 梦境档案。

重新打开后继续使用用户之前保存的值。

---

## 6. 打开 / 关闭 NSFW 时的状态语义

### 6.1 新增正式 CLI 写入口

遵循 Stone Memory 的「CLI 是唯一正式写入口」规则，建议新增：

```bash
stmem dream nsfw --thread <id> on
stmem dream nsfw --thread <id> off
```

并将 `nsfw` 加入 `SUBCOMMANDS`。

Web 不直接写 preferences 文件，而是调用 CLI。

建议新增 Web route：

```text
PUT /api/libraries/:threadId/dreams/nsfw
```

body：

```json
{ "enabled": true }
```

### 6.2 关闭时清理 NSFW one-shot

若当前存在：

```js
oneShot.dreamType === "erotic"
// or beautiful_erotic / nightmare_erotic
```

用户关闭 NSFW 后必须清除这个 one-shot。

安全类型 one-shot（beautiful / nightmare）可以保留。

### 6.3 Defensive policy

即使旧文件或手工修改导致：

```text
nsfwEnabled=false
oneShot=erotic
```

`resolveDreamType()` 也不能执行。

建议显式抛：

```text
DREAM_NSFW_DISABLED
```

而不是静默生成。

---

## 7. Preferences schema 迁移

建议 v3。

### v1 → v3

旧：

```json
{
  "schemaVersion": 1,
  "guard": true,
  "multipliers": {},
  "oneShot": null
}
```

现有 WIP 已定义：

```text
guard=true  → excludedTypes=[nightmare, nightmare_erotic]
guard=false → excludedTypes=[]
```

继续保留这个迁移，然后追加：

```text
nsfwEnabled=false
```

### v2 → v3

现有：

```json
{
  "schemaVersion": 2,
  "multipliers": {},
  "excludedTypes": [],
  "oneShot": null
}
```

迁移后默认：

```text
nsfwEnabled=false
```

如果旧 v1/v2 中存在 NSFW one-shot，最终不能留下会在 safe mode 被执行的隐藏 one-shot。

### v3

只有显式：

```text
nsfwEnabled === true
```

才开启；其他所有值一律 false。

---

## 8. Canonical Policy 推荐接口

当前 WIP 已有：

```js
planDreamDistribution({ multipliers, excludedTypes })
resolveDreamType({ prefs, randomInt })
```

建议扩展为：

```js
planDreamDistribution({
  multipliers,
  excludedTypes,
  nsfwEnabled = false,
})
```

也可以改为接完整 prefs，但必须保持一个唯一 canonical 算法源。

推荐返回结构尽量兼容。例如 safe mode 仍可返回完整 shape：

```js
{
  mode: "safe",
  nsfwEnabled: false,
  firstStage: {
    beautiful: 0.888888,
    nightmare: 0.111111,
    erotic: 0
  },
  overlays: {
    beautiful: { plain: 1, erotic: 0, reachable: false },
    nightmare: { plain: 1, erotic: 0, reachable: false }
  },
  final: {
    beautiful: 0.888888,
    nightmare: 0.111111,
    erotic: 0,
    beautiful_erotic: 0,
    nightmare_erotic: 0
  }
}
```

建议增加：

```js
mode: "safe" | "nsfw"
```

供 UI 明确选择展示结构。

前端 safe mode **不要因为返回 shape 中仍有 erotic 字段就展示它们**。

---

## 9. 梦境档案的隐藏规则

NSFW OFF 时，前端梦境档案也不能展示 NSFW 梦境。

需要隐藏的历史类型：

```text
erotic
beautiful_erotic
nightmare_erotic
```

行为要求：

- 不删除文件；
- 不修改 DreamStore；
- 只在当前 NSFW OFF 的展示 / reader API 结果中隐藏；
- 重新开启 NSFW 后历史绮梦重新出现；
- 首页「已保存梦境」「最近一场」「档案计数」等用户可见统计应基于当前可见 entries，而不是把隐藏梦计入后又露出类型；
- 直接访问某个隐藏 NSFW 梦境详情路由时，NSFW OFF 必须 fail closed，不显示正文。

后端最好提供经过 prefs 过滤的 archive 列表与详情，而不是只靠前端过滤，避免直接 API 泄露。

旧梦仍必须保留在磁盘上。

---

## 10. Web / UI 具体改造点

重点文件：

```text
src/web/public/dream-lab/app.js
src/web/public/dream-lab/styles.css
src/web/public/dream-lab/README.md
src/web/server.js
```

### 10.1 不要再用固定 TYPE_ORDER 直接渲染所有地方

当前顶部：

```js
const TYPE_ORDER = ["beautiful", "nightmare", "erotic", "beautiful_erotic", "nightmare_erotic"];
```

建议保留完整内部顺序，同时增加：

```js
const SAFE_TYPE_ORDER = ["beautiful", "nightmare"];
const NSFW_TYPE_ORDER = ["erotic", "beautiful_erotic", "nightmare_erotic"];

function visibleTypeOrder() {
  return prefs?.nsfwEnabled ? TYPE_ORDER : SAFE_TYPE_ORDER;
}
```

Prompt items、Guard groups、Pin options、Archive visible entries、Final preview 都应基于 capability 过滤，而不是散落多个 `if`。

### 10.2 Prompt items

完整内部列表可以保留，但页面渲染使用：

```text
NSFW OFF → common-core + beautiful + nightmare
NSFW ON  → all prompt items
```

### 10.3 Guard 高级设置

建议使用可折叠原生 `<details>` 或现有风格的折叠组件：

```html
<details class="advanced-settings">
  <summary>高级设置</summary>
  ...NSFW switch...
</details>
```

默认折叠。

开启 / 关闭成功后：

- `await loadAll()`；
- 重新 render 当前 Guard 页面；
- 重新计算 preview；
- 不刷新整个浏览器。

### 10.4 首页状态不要泄露隐藏类型

例如当前：

```text
下一场梦：已牵引至「春梦」
最近一场 · 春梦
```

NSFW OFF 时不能出现这种状态。

如果 migration / legacy 数据里残留 NSFW one-shot，应先在 backend normalize / disable 逻辑处理掉。

---

## 11. Prompt 文案扫描要求

完成后执行类似：

```bash
grep -RIn --exclude-dir=node_modules -E '春梦|染春|春意浸染|美梦染春梦|噩梦染春梦' \
  operations/dream src/web/public/dream-lab sm-developer-docs test
```

目标：

- 用户可见文案和 Prompt 文本中不再出现旧「春梦」命名；
- 测试描述可以改成绮梦；
- 内部 `erotic` ID 可以继续存在，这是预期行为。

不要粗暴全局替换 `erotic`。

---

## 12. 推荐测试矩阵

至少补齐以下测试。

### 12.1 preferences

1. 新 thread 默认 `nsfwEnabled=false`；
2. v1 migrate → `nsfwEnabled=false`；
3. v2 migrate → `nsfwEnabled=false`；
4. v3 true 能 round-trip；
5. 关闭 NSFW 不清空 erotic multipliers；
6. 关闭 NSFW 不清空 erotic exclusions；
7. 关闭 NSFW 不清空 Prompt overrides；
8. 关闭 NSFW 时清除 erotic one-shot；
9. 关闭 NSFW 时保留 beautiful/nightmare one-shot。

### 12.2 policy safe mode

默认：

```text
beautiful  = 8/9
nightmare  = 1/9
all erotic = 0
```

再测：

- beautiful ×2 → 160/170；
- hidden erotic ×3 不改变结果；
- hidden erotic overlay ×3 不改变结果；
- erotic exclusion 不改变结果；
- exclude beautiful → nightmare=1；
- exclude nightmare → beautiful=1；
- exclude both → DREAM_NO_CANDIDATE。

### 12.3 policy NSFW mode

保留当前 Policy v2 WIP 测试：

```text
64 / 9 / 10 / 16 / 1
```

并继续验证：

- first-stage multiplier；
- overlay multiplier；
- branch pruning；
- arbitrary exclusions；
- one-shot 优先级。

### 12.4 one-shot

- OFF + erotic pin → `DREAM_NSFW_DISABLED`；
- OFF + beautiful pin → 正常；
- ON + erotic pin → 正常；
- ON 设 erotic pin 后切 OFF → pin 被清除。

### 12.5 CLI

新增测试：

```bash
stmem dream preferences --thread ...
stmem dream nsfw --thread ... on
stmem dream nsfw --thread ... off
```

`preferences` summary 必须包含：

```json
{
  "nsfwEnabled": false,
  "distribution": { ... }
}
```

### 12.6 Web / reader

至少验证：

- OFF 时 Prompt 列表不含 erotic；
- OFF 时 pin 只两项；
- OFF 时 spectrum 只两项；
- OFF 时 guard 主区只两类；
- OFF 时 archive 隐藏 erotic 历史；
- OFF 时直接请求 erotic archive detail 不返回正文；
- ON 后全部恢复。

---

## 13. 现有 Prompt 的产品判断

现有亲密向 Prompt **不需要大幅重写**。

目前它们强调：

- 成年角色；
- 双方自愿；
- 信任与明确边界；
- 关系和情绪作为亲密的来源；
- 避免粗俗词汇；
- 避免机械动作清单；
- 禁止强迫 / 胁迫 / 把拒绝当同意；
- 避免纯模板色情。

因此本次主要风险来自：

1. 默认开启 / 默认参与随机；
2. 产品 UI 明显展示「春梦 / erotic / 染春」；
3. 普通用户没有主动 opt-in。

解决方式是能力隔离和术语调整，不是把 Prompt 改成失去亲密主题。

---

## 14. 需要遵守的项目架构规范

参考：

```text
sm-developer-docs/frontend-modules.md
sm-developer-docs/watcher-plugins.md
src/web/public/dream-lab/README.md
```

必须继续遵守：

- Dream Lab 业务不硬编码进主 `src/web/public/app.js`；
- 正式写入走 `stmem` CLI；
- Web route 不直接改 preferences 文件；
- policy preview 必须只读；
- watcher 主循环不新增 dream 专用分支；
- 继续使用现有 dream watcher plugin / post-mining hooks；
- 不新增第二套数据库；
- 不新增独立 companion server；
- 不硬编码 HOME、端口、threadId 或模型。

---

## 15. 建议开发顺序

不要先大改 UI。推荐顺序：

### Phase A：Preferences / migration

1. schema v3；
2. `nsfwEnabled=false`；
3. v1/v2 migration；
4. `setNsfwEnabled()`；
5. 关闭时 one-shot cleanup。

### Phase B：Canonical policy

1. safe mode 两类型算法；
2. NSFW mode 保留当前两阶段算法；
3. `resolveDreamType()` defensive check；
4. preview 同源。

### Phase C：CLI / Web adapter

1. `stmem dream nsfw`；
2. preferences summary；
3. `/dreams/nsfw` route；
4. policy-preview 传递 `nsfwEnabled`。

### Phase D：Dream Lab UI

1. 术语映射为「绮梦」；
2. 高级设置开关；
3. safe-mode Prompt 隐藏；
4. safe-mode Pin 隐藏；
5. safe-mode Spectrum 简化；
6. safe-mode Guard 简化；
7. archive 隐藏。

### Phase E：Prompt 术语

修改 `operations/dream/*.md` 的用户语义名称，不改内部文件名 / enum。

### Phase F：Tests + docs

补测试并更新 Dream Lab README。

---

## 16. 验收标准

以下全部满足才算完成。

### 默认新用户

- [ ] `nsfwEnabled=false`；
- [ ] Automatic Dream UI 看不到任何「绮梦 / 绮染」；
- [ ] 梦向牵引只有美梦 / 噩梦；
- [ ] 织梦秘典只显示 3 份；
- [ ] 梦谱调律只有美梦 / 噩梦倍率；
- [ ] 不出现两阶段概率树；
- [ ] 自动生成绝不进入 erotic 系列；
- [ ] 默认概率约为 88.89% / 11.11%。

### 开启 NSFW

- [ ] 高级设置里可显式开启；
- [ ] UI 显示绮梦 / 美梦·绮染 / 噩梦·绮染；
- [ ] 显示两阶段调律；
- [ ] 默认恢复 64/9/10/16/1；
- [ ] Prompt 编辑恢复 6 项；
- [ ] erotic one-shot 可用；
- [ ] 历史绮梦重新出现在档案。

### 再次关闭 NSFW

- [ ] erotic 内容重新完全隐藏；
- [ ] erotic multipliers 被保留但不参与算法；
- [ ] erotic exclusions 被保留但不参与 safe 算法；
- [ ] Prompt override 保留；
- [ ] 历史梦不删除；
- [ ] NSFW one-shot 被清理；
- [ ] 后端直接调用也无法随机出 erotic。

### 工程检查

- [ ] `node --check` 通过相关 JS；
- [ ] `git diff --check` 通过；
- [ ] dream 相关定向测试通过；
- [ ] 完整 `npm test` 通过；
- [ ] 不破坏现有 dirty WIP 中的 Policy v2 设计；
- [ ] 不把内部 `erotic*` enum 改名。

---

## 17. 最后提醒 Codex

这次改造的核心不是「把 erotic 换成一个更隐晦的词」。真正目标是：

```text
Default product = 美梦 + 噩梦
Optional NSFW capability = 绮梦体系
```

NSFW OFF 必须同时满足：

```text
不可见
不可选
不可随机到
不影响概率
不泄露历史内容
```

NSFW ON 才恢复完整的两阶段绮梦体系。

请优先保证 **后端策略正确性和兼容性**，再做 UI 隐藏。不要以仅前端隐藏作为完成标准。
