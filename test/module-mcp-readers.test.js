const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function scenario(mode) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const Database = require("better-sqlite3");
  const { openDatabase, SCHEMA_VERSION } = require("./src/storage/database");
  const { NotebookStore } = require("./src/storage/notebook-store");
  const { MemoryStore } = require("./src/storage/memory-store");
  const { getThreadDir } = require("./src/config");
  const { createContext } = require("./src/mcp/context");
  const { Registry } = require("./src/mcp/registry");
  const memoryId = "synthetic-reader";
  const memoryDir = path.join(getThreadDir(memoryId), "memory");
  const root = path.join(memoryDir, "notebook");
  const manifest = { id: "reader-fixture", scope: "memory", permissions: ["core:read", "mcp:tools"], entry: {} };
  const reader = () => createContext(manifest, { memoryId }).core;
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(process.env.STMEM_DB_PATH)).digest("hex");
  if (mode === "missing") {
    const core = reader();
    assert.deepEqual(core.listFeelings(), []);
    assert.deepEqual(core.listBindings(), []);
    assert.throws(() => core.getBinding("absent"), /BINDING_NOT_FOUND/);
    assert.deepEqual(core.notebook.catalog(), { threadId: memoryId, topicCount: 0, entryCount: 0, defaultTopicId: null, topics: [] });
    assert.deepEqual(core.notebook.search({ query: "synthetic" }), { threadId: memoryId, query: "synthetic", topicId: null, tags: [], matchCount: 0, matches: [] });
    assert.equal(core.notebook.read("absent"), null);
    assert.equal(core.dream.latest(), null);
    assert.equal(core.dream.get("2026-01-01"), null);
    assert.deepEqual(core.dream.status(), { threadId: memoryId, from: null, to: null, availableDates: [], missingDates: [] });
    assert.throws(() => core.notebook.search({}), /query/);
    assert.deepEqual(fs.readdirSync(process.env.HOME), []);
    return;
  }
  fs.mkdirSync(path.dirname(process.env.STMEM_DB_PATH), { recursive: true });
  if (mode === "legacy") {
    const db = new Database(process.env.STMEM_DB_PATH);
    db.exec("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(1); CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('synthetic')");
    db.close();
    const before = hash();
    for (const operation of [core => core.listFeelings(), core => core.listBindings(), core => core.getBinding("absent"), core => core.notebook.catalog(), core => core.notebook.search({ query: "synthetic" }), core => core.notebook.read("absent"), core => core.dream.status()]) {
      assert.throws(() => operation(reader()), /MCP_STORAGE_UPGRADE_REQUIRED/);
    }
    const registry = new Registry();
    registry.registerModule(manifest, {
      tools: () => [{ name: "read", description: "read fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }],
      call: context => context.core.listFeelings(),
    }, { memoryIds: [memoryId], state: { globalEnabled: true, memories: { [memoryId]: true } } });
    const result = await registry.call("stmem_reader_fixture_read", { memoryId });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /MCP_STORAGE_UPGRADE_REQUIRED.*stmem CLI/);
    assert.equal(hash(), before);
    return;
  }
  const notebook = new NotebookStore({ memoryDir, root, threadId: memoryId });
  const topic = notebook.createTopic({ name: "Synthetic topic" });
  const note = notebook.writeEntry({ topicId: topic.id, title: "Synthetic note", body: "synthetic body" });
  const expectedCatalog = notebook.status();
  const expectedSearch = notebook.query({ query: "synthetic" });
  const expectedRead = notebook.readEntry(note.id);
  notebook.close();
  const db = openDatabase(memoryDir);
  const now = "2026-01-01T00:00:00Z";
  db.prepare("INSERT INTO messages(thread_id,message_id,timestamp,source_date,role,text,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(memoryId, "synthetic-message", now, "2026-01-01", "user", "<memory_context>\nsynthetic historical pollution\n</memory_context>", now);
  db.prepare("INSERT INTO memory_bindings(id,memory_id,provider,mode,capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run("binding-fixture", memoryId, "codex", "parallel", "{}", now, now);
  const beforeRows = db.prepare("SELECT * FROM messages").all();
  const beforeSchema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const beforeHash = hash();
  const core = reader();
  assert.deepEqual(core.notebook.catalog(), expectedCatalog);
  assert.deepEqual(core.notebook.search({ query: "synthetic" }), expectedSearch);
  assert.deepEqual(core.notebook.read(note.id), expectedRead);
  assert.equal(core.listBindings().length, 1);
  assert.equal(core.getBinding("binding-fixture").memoryId, memoryId);
  assert.deepEqual(core.listFeelings(), []);
  assert.deepEqual(core.dream.status(), { threadId: memoryId, from: null, to: null, availableDates: [], missingDates: [] });
  // Even a configured memory with no row must not be auto-registered by a read.
  const other = createContext(manifest, { memoryId: "synthetic-other" }).core;
  assert.deepEqual(other.listBindings(), []);
  assert.deepEqual(other.listFeelings(), []);
  assert.equal(other.notebook.catalog().entryCount, 0);
  assert.equal(other.notebook.read(note.id), null);
  for (const Store of [MemoryStore, NotebookStore]) {
    const store = new Store({ memoryDir, root, threadId: memoryId, readonly: true });
    assert.throws(() => store.db.prepare("DELETE FROM messages").run(), /readonly/i);
    store.close();
  }
  const check = new Database(process.env.STMEM_DB_PATH, { readonly: true });
  assert.deepEqual(check.prepare("SELECT * FROM messages").all(), beforeRows);
  assert.deepEqual(check.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), beforeSchema);
  assert.equal(check.prepare("SELECT COUNT(*) n FROM threads WHERE id='synthetic-other'").get().n, 0);
  assert.equal(check.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, SCHEMA_VERSION);
  check.close();
  assert.equal(hash(), beforeHash);
}

for (const mode of ["missing", "legacy", "current"]) {
  test(`module readers preserve persistent storage: ${mode}`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-reader-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ["-e", `(${scenario.toString()})(${JSON.stringify(mode)}).catch(error => { console.error(error); process.exitCode = 1; });`], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(home, "data", "fixture.db") }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
