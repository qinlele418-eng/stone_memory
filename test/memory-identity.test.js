const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listMemoryIds, canonicalMemoryDir, resolveMemoryIdentity,
} = require("../src/services/memory-identity");

test("legacy configured threads become stable memory identities without moving data", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { "thread-old": { label: "旧记忆", runtime: "claude", purpose: "coding" } };
  assert.deepEqual(listMemoryIds(config), ["thread-old"]);
  const resolved = resolveMemoryIdentity(config, root, "thread-old");
  assert.equal(resolved.memoryId, "thread-old");
  assert.equal(resolved.layout, "legacy-runtime-v0");
  assert.equal(resolved.root, path.join(root, "runtimes", "claude", "coding", "thread-old"));
});

test("an external thread key can resolve the stable memory id stored above it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    memories: { "memory-1": { memoryId: "memory-1", label: "记忆" } },
    "external-thread": { memoryId: "memory-1", runtime: "codex", purpose: "accompany" },
  };
  assert.deepEqual(listMemoryIds(config), ["memory-1"]);
  const byMemory = resolveMemoryIdentity(config, root, "memory-1");
  const byLegacyAlias = resolveMemoryIdentity(config, root, "external-thread");
  assert.equal(byMemory.memoryId, "memory-1");
  assert.equal(byLegacyAlias.memoryId, "memory-1");
  assert.equal(byMemory.root, path.join(root, "runtimes", "codex", "accompany", "external-thread"));
  assert.equal(byLegacyAlias.root, byMemory.root);
});

test("canonical layout is selected only after a complete migration receipt", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { "memory-1": { label: "记忆", runtime: "claude", purpose: "coding" } };
  const canonical = canonicalMemoryDir(root, "memory-1");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, ".layout-v1.json"), JSON.stringify({ status: "copying", memoryId: "memory-1" }));
  assert.equal(resolveMemoryIdentity(config, root, "memory-1").layout, "legacy-runtime-v0");
  fs.writeFileSync(path.join(canonical, ".layout-v1.json"), JSON.stringify({ status: "complete", memoryId: "memory-1" }));
  const resolved = resolveMemoryIdentity(config, root, "memory-1");
  assert.equal(resolved.layout, "memory-v1");
  assert.equal(resolved.root, canonical);
});

test("draft memories have canonical paths without pretending to be configured threads", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { memories: { "draft-1": { memoryId: "draft-1", label: "新建记忆体", status: "draft" } } };
  const resolved = resolveMemoryIdentity(config, root, "draft-1");
  assert.equal(resolved.configured, false);
  assert.equal(resolved.layout, "memory-v1");
  assert.equal(resolved.root, path.join(root, "memories", "draft-1"));
});

test("unsafe memory ids cannot escape the managed data root", () => {
  assert.throws(() => resolveMemoryIdentity({ memories: {} }, "/tmp/data", "../escape"), /memoryId/);
  assert.throws(() => canonicalMemoryDir("/tmp/data", "a/b"), /memoryId/);
});
