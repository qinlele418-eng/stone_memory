const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { readImportSource, mapGenericRow } = require("../src/services/import-source");
const { ingestRecords } = require("../src/services/thread-ingest");

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "stmem-import-")); }

test("generic mapping creates only canonical conversation fields", () => {
  const raw = { created_at: "2026-05-12T10:00:00Z", sender: "human", body: "hello", rating: 5, vector: [1, 2] };
  const result = mapGenericRow(raw);
  assert.deepEqual(result.message, { timestamp: raw.created_at, type: "user", text: "hello" });
  assert.deepEqual(Object.keys(result.message), ["timestamp", "type", "text"]);
});

test("generic mapping preserves conversation text longer than 2000 characters", () => {
  const text = "长".repeat(2500);
  const result = mapGenericRow({ timestamp: "2026-05-12T10:00:00Z", role: "user", content: text });
  assert.equal(result.message.text, text);
});

test("plain type fields use role normalization instead of native-format assumptions", () => {
  const root = tempDir();
  const sourceFile = path.join(root, "plain.jsonl");
  fs.writeFileSync(sourceFile, JSON.stringify({ timestamp: "2026-05-12T10:00:00Z", type: "human", text: "hello" }) + "\n");
  const source = readImportSource({ filePath: sourceFile });
  assert.equal(source.records[0].message.type, "user");
});

test("Claude internal transport records stay in full but never enter normalized messages", () => {
  const root = tempDir();
  const sourceFile = path.join(root, "claude.jsonl");
  const fullDir = path.join(root, "archive", "full");
  const store = new (require("../src/storage/memory-store").MemoryStore)({ memoryDir: root, threadId: "thread-claude" });
  const rows = [
    { type: "queue-operation", timestamp: "2026-07-16T08:00:00.000Z", content: "示例用户消息" },
    { type: "system_template", timestamp: "2026-07-16T08:00:00.002Z", content: "内部模板" },
    { type: "user", timestamp: "2026-07-16T08:00:00.004Z", message: { content: "示例用户消息" } },
  ];
  fs.writeFileSync(sourceFile, rows.map(JSON.stringify).join("\n") + "\n");
  try {
    const source = readImportSource({ filePath: sourceFile });
    assert.equal(source.preview.valid, 1);
    assert.equal(source.preview.filtered, 2);
    assert.deepEqual(source.preview.filteredReasons, {
      claude_queue_operation: 1,
      claude_system_template: 1,
    });
    const result = ingestRecords(source.records, { memoryStore: store, fullDir, format: "claude" });
    assert.equal(result.imported, 1);
    assert.equal(result.filtered, 2);
    assert.equal(result.fullBacked, 3);
    assert.deepEqual(store.listMessages({ date: "2026-07-16" }).map(row => row.text), ["示例用户消息"]);
    const full = fs.readFileSync(path.join(fullDir, "2026", "07", "2026-07-16.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(full, rows);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("JSON import preserves extras only in full and is idempotent", () => {
  const root = tempDir();
  const sourceFile = path.join(root, "source.json");
  const archiveDir = path.join(root, "archive");
  const fullDir = path.join(archiveDir, "full");
  const store = new (require("../src/storage/memory-store").MemoryStore)({ memoryDir: root, threadId: "thread-test" });
  const raw = { timestamp: "2026-05-12T10:00:00Z", role: "user", content: "hello", rating: 5, vector: [1, 2] };
  fs.writeFileSync(sourceFile, JSON.stringify([raw]));
  const source = readImportSource({ filePath: sourceFile });
  const first = ingestRecords(source.records, { memoryStore: store, fullDir });
  const second = ingestRecords(source.records, { memoryStore: store, fullDir });
  assert.equal(first.imported, 1);
  assert.equal(first.fullBacked, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.fullBacked, 0);
  const archive = store.listMessages({ date: "2026-05-12" })[0];
  const full = JSON.parse(fs.readFileSync(path.join(fullDir, "2026", "05", "2026-05-12.jsonl"), "utf8"));
  assert.equal(archive.text, "hello");
  assert.equal(archive.rating, undefined);
  assert.deepEqual(full, raw);
  store.close();
});

test("SQLite source auto-selects a single table and maps explicit fields", () => {
  const root = tempDir();
  const dbPath = path.join(root, "chat.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE chats (when_at TEXT, who TEXT, payload TEXT, score INTEGER)");
  db.prepare("INSERT INTO chats VALUES (?, ?, ?, ?)").run("2026-05-13T01:00:00Z", "bot", "reply", 9);
  db.close();
  const source = readImportSource({ filePath: dbPath, timeField: "when_at", roleField: "who", contentField: "payload" });
  assert.equal(source.preview.table, "chats");
  assert.equal(source.preview.valid, 1);
  assert.deepEqual(source.records[0].message, { timestamp: "2026-05-13T01:00:00Z", type: "assistant", text: "reply" });
  assert.equal(source.records[0].raw.score, 9);
});

test("SQLite requires --table when multiple business tables exist", () => {
  const root = tempDir();
  const dbPath = path.join(root, "multi.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE a (text TEXT); CREATE TABLE b (text TEXT)");
  db.close();
  assert.throws(() => readImportSource({ filePath: dbPath }), /--table/);
});

test("ChatGPT official mapping imports only the current conversation branch", () => {
  const root = tempDir();
  const sourceFile = path.join(root, "conversations.json");
  const node = (id, parent, role, content, createTime) => ({
    id, parent, children: [],
    message: { id: `message-${id}`, author: { role }, create_time: createTime, content: { content_type: "text", parts: [content] } },
  });
  const conversation = {
    id: "conversation-1", title: "Current branch", current_node: "assistant-new",
    mapping: {
      root: { id: "root", parent: null, children: ["user-1"], message: null },
      "user-1": node("user-1", "root", "user", "hello", 1_700_000_000),
      "assistant-old": node("assistant-old", "user-1", "assistant", "old branch", 1_700_000_001),
      "assistant-new": node("assistant-new", "user-1", "assistant", "chosen branch", 1_700_000_002),
    },
  };
  fs.writeFileSync(sourceFile, JSON.stringify([conversation]));
  const source = readImportSource({ filePath: sourceFile });
  assert.equal(source.preview.format, "chatgpt");
  assert.equal(source.preview.valid, 2);
  assert.deepEqual(source.records.map(record => record.message.text), ["hello", "chosen branch"]);
  assert.equal(source.records[0].raw._source.conversation_id, "conversation-1");
});

test("Claude.ai official export flattens chat_messages across conversations", () => {
  const root = tempDir();
  const sourceFile = path.join(root, "claude-conversations.json");
  fs.writeFileSync(sourceFile, JSON.stringify([
    { uuid: "conv-a", name: "A", chat_messages: [
      { uuid: "a1", sender: "human", created_at: "2026-05-12T10:00:00Z", text: "question" },
      { uuid: "a2", sender: "assistant", created_at: "2026-05-12T10:00:01Z", text: "answer" },
    ] },
    { uuid: "conv-b", name: "B", chat_messages: [
      { uuid: "b1", sender: "human", created_at: "2026-05-13T10:00:00Z", content: [{ type: "text", text: "another question" }] },
    ] },
  ]));
  const source = readImportSource({ filePath: sourceFile });
  assert.equal(source.preview.format, "claude_ai");
  assert.equal(source.preview.valid, 3);
  assert.deepEqual(source.records.map(record => record.message.type), ["user", "assistant", "user"]);
  assert.deepEqual(source.records.map(record => record.message.text), ["question", "answer", "another question"]);
});
