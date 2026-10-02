"use strict";

// R1：provider=pando / subagent 能力缺位时，deep_search 走本地确定性聚合
//（keyword_search + archive_context 合并、模板化叙事、逐条来源标注、无证据如实声明）；
// claude/codex subagent 路径零变化；mcp 工具入口与 service 入口行为一致。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-deep-local-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const {
  runLocalDeepSearch,
  runDeepSearchWithLocalFallback,
  runConfiguredDeepSearch,
  subagentRuntimeSupported,
  localDeepSearchKeywords,
} = require("../src/services/deep-search-service");

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

const PANDO_THREAD = "thread-deep-local-pando";

function seedPandoThread() {
  const stmemFile = path.join(home, ".stone_memory", "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config[PANDO_THREAD] = { ai: "小鱼", user: "旭乐", runtime: "pando", purpose: "accompany" };
  fs.mkdirSync(path.dirname(stmemFile), { recursive: true });
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
  const memoryDir = path.join(getThreadDir(PANDO_THREAD), "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const store = new MemoryStore({ memoryDir, threadId: PANDO_THREAD });
  store.insertMessages([
    { timestamp: "2026-06-17T11:58:00.000Z", sourceDate: "2026-06-17", role: "user", text: "归栖的部署方案定了吗" },
    { timestamp: "2026-06-17T12:02:00.000Z", sourceDate: "2026-06-17", role: "assistant", text: "归栖这条线今天敲定了，用 SQLite 落盘" },
  ]);
  store.close();
}

seedPandoThread();

test("pando runtime is not subagent-capable; claude runtime is", () => {
  assert.equal(subagentRuntimeSupported(PANDO_THREAD), false);
  assert.equal(subagentRuntimeSupported("thread-unknown-claude-default"), true,
    "无 runtimes 配置的未知线程按默认 claude 处理（零变化面）");
});

test("local aggregation merges keyword + archive evidence with per-item source tags", () => {
  const first = runLocalDeepSearch({ threadId: PANDO_THREAD, query: "归栖的部署方案是怎么定的？" });
  const second = runLocalDeepSearch({ threadId: PANDO_THREAD, query: "归栖的部署方案是怎么定的？" });

  assert.equal(first, second, "同输入同输出（确定性）");
  assert.match(first, /^# 深度搜索（本地聚合）：/);
  assert.match(first, /memory_keyword_search#/);
  assert.match(first, /memory_archive_context@/);
  assert.match(first, /归栖这条线今天敲定了/);
  assert.doesNotMatch(first, /isError/);
});

test("local aggregation honestly declares no evidence instead of inventing", () => {
  const narrative = runLocalDeepSearch({ threadId: PANDO_THREAD, query: "量子纠缠实验室的最新结论" });
  assert.match(narrative, /证据不足说明/);
  assert.match(narrative, /未检索到与该问题直接相关的记忆证据/);
  assert.match(narrative, /0 命中/);
});

test("degradation path: unsupported runtime skips subagent entirely", () => {
  let subagentCalled = 0;
  const result = runDeepSearchWithLocalFallback(
    { threadId: PANDO_THREAD, query: "归栖部署" },
    { runSubagentDeepSearchImpl: () => { subagentCalled += 1; return "不应被调用"; } },
  );
  assert.equal(subagentCalled, 0);
  assert.match(result, /^# 深度搜索（本地聚合）：归栖部署/);
});

test("claude runtime with a working subagent keeps the existing behavior byte-for-byte", () => {
  const result = runDeepSearchWithLocalFallback(
    { threadId: "thread-deep-local-claude", query: "任意问题" },
    { runSubagentDeepSearchImpl: () => "SUBAGENT_NARRATIVE" },
  );
  assert.equal(result, "SUBAGENT_NARRATIVE");
});

test("claude runtime with a failing subagent degrades to local aggregation instead of throwing", () => {
  const result = runDeepSearchWithLocalFallback(
    { threadId: "thread-deep-local-claude", query: "归栖部署" },
    { runSubagentDeepSearchImpl: () => { throw new Error("subagent boom"); } },
  );
  assert.match(result, /^# 深度搜索（本地聚合）：归栖部署/);
});

test("runConfiguredDeepSearch api mode is untouched; subagent mode shares the degradation path", async () => {
  let apiCalls = 0;
  const apiResult = await runConfiguredDeepSearch(
    { threadId: "thread-deep-local-api", query: "问题", searchTerms: "检索词" },
    {
      resolveModeImpl: () => "api",
      runConfiguredGenerationImpl: async () => { apiCalls += 1; return "API_NARRATIVE"; },
      searchByKeywordImpl: () => ({ hits: [], text: "" }),
    },
  );
  assert.equal(apiCalls, 1);
  assert.equal(apiResult, "API_NARRATIVE");

  const degraded = await runConfiguredDeepSearch(
    { threadId: PANDO_THREAD, query: "归栖部署" },
    { resolveModeImpl: () => "subagent", runSubagentDeepSearchImpl: () => { throw new Error("no runtime"); } },
  );
  assert.match(degraded, /^# 深度搜索（本地聚合）：归栖部署/);
});

test("mcp tool entry and service entry produce the same narrative for the same query", async () => {
  const core = require("../src/mcp/core");
  const query = "归栖的部署方案是怎么定的？";
  const toolOutcome = core.call("stmem_memory_deep_search", { query, memoryId: PANDO_THREAD });
  assert.equal(toolOutcome.isError, false, `工具入口不得报错：${toolOutcome.content[0].text}`);
  const serviceResult = runLocalDeepSearch({ threadId: PANDO_THREAD, query });
  assert.equal(toolOutcome.content[0].text, serviceResult);
});

test("local keyword refinement emits ordered deterministic keywords with stopword bigrams filtered", () => {
  const keywords = localDeepSearchKeywords("归栖的部署方案是怎么定的？");
  assert.deepEqual(keywords, localDeepSearchKeywords("归栖的部署方案是怎么定的？"));
  assert.ok(keywords.length >= 1);
  for (const keyword of keywords) {
    assert.ok(keyword.length >= 2);
    if (keyword.length === 2 && /^[\u4e00-\u9fff]{2}$/u.test(keyword)) {
      assert.doesNotMatch(keyword, /^(的|了|是在|和跟)/, "纯停用字二元组不入选");
    }
  }
});
