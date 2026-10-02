"use strict";

// R0：provider=pando 且无 miner 产出时，memory_search 检索面回退到本地确定性索引；
// claude/codex 生产路径零变化；有 miner 产出时优先 miner（与现状一致）。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// src/config.js 在 require 时固化 CONFIG_PATH —— 必须先重定向 HOME 再加载源码。
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-local-feelings-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { searchByKeyword } = require("../src/services/memory-keyword-search");

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeLegacyThread(threadId, runtime) {
  const stmemFile = path.join(home, ".stone_memory", "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config[threadId] = { ai: "小鱼", user: "旭乐", runtime, purpose: "accompany" };
  fs.mkdirSync(path.dirname(stmemFile), { recursive: true });
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
}

function seedMessages(threadId) {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const store = new MemoryStore({ memoryDir, threadId });
  store.insertMessages([
    { timestamp: "2026-06-17T11:58:00.000Z", sourceDate: "2026-06-17", role: "user", text: "归栖的部署方案定了吗" },
    { timestamp: "2026-06-17T12:02:00.000Z", sourceDate: "2026-06-17", role: "assistant", text: "归栖这条线今天敲定了，用 SQLite 落盘" },
    { timestamp: "2026-06-18T09:10:00.000Z", sourceDate: "2026-06-18", role: "user", text: "昨晚熬夜调归栖的导入器" },
  ]);
  store.close();
  return memoryDir;
}

/** memory-v1（dogfood 形态）：memories 注册表 + pando primary binding。 */
function writeMemoryV1Pando(memoryId) {
  const stoneRoot = path.join(home, ".stone_memory");
  const root = path.join(stoneRoot, "memories", memoryId);
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const now = "2026-10-02T17:00:00.000Z";
  fs.writeFileSync(path.join(root, ".layout-v1.json"), JSON.stringify({
    schemaVersion: 1, status: "complete", memoryId, origin: "created", completedAt: now,
  }), "utf8");
  fs.writeFileSync(path.join(root, "memory.json"), JSON.stringify({
    schemaVersion: 1, memoryId, label: "本地索引记忆体", status: "draft",
    purpose: null, ai: "小鱼", user: "旭乐", userGender: "unspecified",
    relationshipTimeline: [], mcpModules: [], mcpModuleConfigVersion: 1,
    miner: { mode: "off", apiProfile: null },
    rebuild: { windowDays: 1, keepToolPairs: 15, contextWindowTokens: null, mcpRebuildDefaultsEnabled: false, mcpSummaryLimit: 0, mcpMinImportance: 0 },
    createdAt: now, updatedAt: now,
  }), "utf8");
  fs.writeFileSync(path.join(root, "bindings.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, primaryBindingId: `binding_${memoryId}`,
    bindings: [{
      id: `binding_${memoryId}`, memoryId, provider: "pando", externalThreadId: `ext-${memoryId}`,
      sessionRoot: null, resolvedThreadFile: null, mode: "import_only", enabled: true,
      createdAt: now, updatedAt: now,
    }],
  }), "utf8");
  fs.writeFileSync(path.join(root, "watcher.json"), JSON.stringify({
    schemaVersion: 1, enabled: false, modules: { archive: false, miner: false },
  }), "utf8");
  const stmemFile = path.join(stoneRoot, "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config.memories = { ...(config.memories || {}), [memoryId]: { memoryId, label: "本地索引记忆体", status: "draft", createdAt: now, updatedAt: now } };
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
  return { memoryDir, root };
}

const LEGACY_PANDO = "thread-local-index-pando";
const LEGACY_CLAUDE = "thread-local-index-claude";

test("pando thread without miner output searches a deterministic local message index", () => {
  writeLegacyThread(LEGACY_PANDO, "pando");
  seedMessages(LEGACY_PANDO);

  const first = searchByKeyword("归栖的部署方案", { maxResults: 3, threadId: LEGACY_PANDO });
  const second = searchByKeyword("归栖的部署方案", { maxResults: 3, threadId: LEGACY_PANDO });

  assert.ok(first.hits.length >= 1, "本地索引应非空命中");
  assert.deepEqual(first, second, "同输入同输出（确定性）");
  for (const hit of first.hits) {
    assert.match(hit.id, /^local:\d{4}-\d{2}-\d{2}:/);
    assert.ok(hit.utcTime, "派生条目携带消息时间戳");
    assert.match(hit.content, /^\d{1,2}月\d{1,2}日，/);
  }
  assert.match(first.text, /归栖/);
  assert.match(first.text, /window:/, "命中应带 archive 原文窗口");
});

test("memory-v1 pando binding resolves the same local index fallback", () => {
  const memoryId = "mem-local-index-v1";
  const { memoryDir } = writeMemoryV1Pando(memoryId);
  const store = new MemoryStore({ memoryDir, threadId: memoryId });
  store.insertMessages([
    { timestamp: "2026-09-01T05:00:00.000Z", sourceDate: "2026-09-01", role: "user", text: "蓝湖的交互稿更新到哪一版了" },
  ]);
  store.close();

  const result = searchByKeyword("蓝湖 交互稿", { maxResults: 2, threadId: memoryId });
  assert.equal(result.hits.length, 1);
  assert.match(result.hits[0].content, /蓝湖的交互稿/);
  assert.equal(result.hits[0].date, "2026-09-01");
});

test("claude thread without miner output stays unchanged (No matching memories found.)", () => {
  writeLegacyThread(LEGACY_CLAUDE, "claude");
  seedMessages(LEGACY_CLAUDE);

  const result = searchByKeyword("归栖的部署方案", { maxResults: 3, threadId: LEGACY_CLAUDE });
  assert.deepEqual(result.hits, []);
  assert.equal(result.matchCount, 0);
  assert.equal(result.text, "No matching memories found.");
});

test("pando thread with miner output prefers miner feelings over the local index", () => {
  writeLegacyThread("thread-local-index-mined", "pando");
  const memoryDir = seedMessages("thread-local-index-mined");
  const store = new MemoryStore({ memoryDir, threadId: "thread-local-index-mined" });
  store.replaceDay("2026-06-17", {
    feelings: [{
      id: "feeling-mined-1",
      eventTime: "2026-06-17T12:00:00.000Z",
      content: "6月17日，晚上八点。归栖部署敲定。",
      importance: 4,
    }],
    features: [],
    source: "manual",
  });
  store.close();

  const result = searchByKeyword("归栖", { maxResults: 5, threadId: "thread-local-index-mined" });
  assert.ok(result.hits.length >= 1);
  for (const hit of result.hits) {
    assert.doesNotMatch(hit.id, /^local:/, "有 miner 产出时不得混入本地派生条目");
    assert.equal(hit.id, "feeling-mined-1");
  }
  assert.equal(result.hits[0].importance, 4);
});

test("local index cache invalidates when the message stamp moves", () => {
  writeLegacyThread("thread-local-index-cache", "pando");
  const memoryDir = seedMessages("thread-local-index-cache");
  const cacheFile = path.join(memoryDir, "local-feelings-index.json");

  const before = searchByKeyword("归栖", { maxResults: 5, threadId: "thread-local-index-cache" });
  assert.ok(before.hits.length >= 1);
  assert.ok(fs.existsSync(cacheFile), "本地索引缓存应落盘于线程 memory 目录");

  const store = new MemoryStore({ memoryDir, threadId: "thread-local-index-cache" });
  store.insertMessages([
    { timestamp: "2026-06-19T10:00:00.000Z", sourceDate: "2026-06-19", role: "user", text: "新话题青枫上线了" },
  ]);
  store.close();

  // 模拟新进程（MCP 每次调用都是新进程）：清模块级 60s 记忆缓存，走戳记失效路径。
  delete require.cache[require.resolve("../src/services/memory-keyword-search")];
  const fresh = require("../src/services/memory-keyword-search");
  const after = fresh.searchByKeyword("青枫", { maxResults: 5, threadId: "thread-local-index-cache" });
  assert.equal(after.hits.length, 1, "新增消息后本地索引必须可见（戳记失效生效）");
  assert.match(after.hits[0].content, /青枫上线了/);
});
