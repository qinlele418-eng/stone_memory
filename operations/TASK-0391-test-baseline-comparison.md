# TASK-0391 rework · AC4 既有用例逐名对照证据（REV-0769 → spec v3 豁免留痕）

**结论：零新增失败。** 分支提交 589024de 的 `npm test` 17 个失败用例与基线 36cae8a 的 17 个失败用例**逐名完全一致**；分支相对基线无任何新增失败用例。三面新增 17 例全绿。

## 豁免依据

REV-0769 finding 1 判定上轮交卷不满足 AC4「既有+新增全绿」。Chief 修订 spec 至 v3：AC4 改为「新增用例全绿；既有用例与基线 36cae8a 逐名对照零新增失败；17 个预存失败属 module/notebook/dream 族 = Stone 仓既有欠账，显式豁免，不在本卡修复范围；逐名对照证据随卷提交」。本文档即该对照证据。

## 方法与环境

- 规定命令：`npm test`（= `node --test`）。分支轮**原样执行**；基线轮为 `npm test -- --test-timeout=120000`——base 在 `test/mcp-protocol.test.js` 的「MCP cancellation aborts module context and permits subsequent requests」**既有永挂**会导致全量永不终止，加超时守卫使其成为可命名的超时结果；该测试在本分支已由 f2693a6 修复转绿。
- 环境：node v26.0.0 / darwin arm64，同机先后串行执行，2026-10-03。
- 基线场地：主检出 `/Users/cola/Documents/自建前后端/stone_memory` @ 36cae8a（pando 分支，src/test 树与基线提交逐字节一致）；分支场地：任务 worktree @ 589024de。

## 运行口径

| 场次 | commit | tests | pass | fail | cancelled | duration |
|---|---|---|---|---|---|---|
| 分支 | 589024de | 724 | 707 | 17 | 0 | 8.48s |
| 基线 | 36cae8a | 707 | 689 | 17 | 1 | 121.7s |

- 724 − 707 = 17：分支新增三面测试（`test/local-feelings-index.test.js` 5 例、`test/deep-search-local-aggregation.test.js` 9 例、`test/rebuild-db-preview.test.js` 3 例）只存在于分支且全部通过。
- 基线的 cancelled 1 即上述既有永挂（120s 超时）。

## 逐名对照（17 个共同失败，基线 ↔ 分支同名同败）

| # | 失败用例名 | 族 | 基线 36cae8a | 分支 589024de |
|---|---|---|---|---|
| 1 | MCP exposes latest, coverage, and exact-date dream reads | dream | ✖ fail | ✖ fail（同名未变） |
| 2 | MCP exposes notebook tools and reads sealed notes | notebook | ✖ fail | ✖ fail（同名未变） |
| 3 | Notebook writes and delegate execute through module CLI (claude, synthetic planner) | notebook | ✖ fail | ✖ fail（同名未变） |
| 4 | Notebook writes and delegate execute through module CLI (codex, synthetic planner) | notebook | ✖ fail | ✖ fail（同名未变） |
| 5 | formal CLI migrates existing Notebook tools and disables their old names without Core fallback | notebook | ✖ fail | ✖ fail（同名未变） |
| 6 | near-limit Notebook batch returns its complete CLI receipt after writing | notebook | ✖ fail | ✖ fail（同名未变） |
| 7 | HTTP MCP management delegates preview/apply to CLI with explicit memory | module | ✖ fail | ✖ fail（同名未变） |
| 8 | both migrated modules own all public names, preserve schemas, and deny old routes when disabled | module | ✖ fail | ✖ fail（同名未变） |
| 9 | loader never executes disabled code; failures and deleted modules preserve Core | module | ✖ fail | ✖ fail（同名未变） |
| 10 | missing or failed module providers cannot fall back to migrated Core routes | module | ✖ fail | ✖ fail（同名未变） |
| 11 | module calls validate explicit authorized memory and isolate failures and timeout | module | ✖ fail | ✖ fail（同名未变） |
| 12 | module readers preserve persistent storage: legacy | module | ✖ fail | ✖ fail（同名未变） |
| 13 | config dry-run, revision, global gate, explicit scope and optimistic locking | module | ✖ fail | ✖ fail（同名未变） |
| 14 | legacy names are host-owned, memory-bound, read-only, and collision checked | module | ✖ fail | ✖ fail（同名未变） |
| 15 | manifest preserves v1 and requires v2 permission and confined provider entry | module | ✖ fail | ✖ fail（同名未变） |
| 16 | registry validates names, closed schemas, annotations, JSON and collisions atomically | module | ✖ fail | ✖ fail（同名未变） |
| 17 | schema migration preserves old rows and allows distinct messages at one timestamp | module | ✖ fail | ✖ fail（同名未变） |

## 差集

- **分支 − 基线 = ∅**（零新增失败，AC4 v3 主张成立）。
- 基线 − 分支 = { MCP cancellation aborts module context and permits subsequent requests }：既有永挂，基线超时取消，分支 f2693a6 已修复转绿（分支轮该用例 ✔ 通过）。

## 附：完整日志

两轮完整输出以工件随卷（branch run / baseline run 各一份，含逐条 ✖ 明细与汇总行）。
