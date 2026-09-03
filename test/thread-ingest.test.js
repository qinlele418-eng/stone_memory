const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ingestMessages, parseThreadMessages, stripCodexForkSnapshot } = require("../src/services/thread-ingest");
const { MemoryStore } = require("../src/storage/memory-store");
const { saveToolEventPolicy } = require("../src/services/tool-event-policy");

test("Codex fork ingestion drops the rewritten parent snapshot", () => {
  const rows = [
    { type: "session_meta", timestamp: "2026-08-31T05:47:55.000Z", payload: { session_id: "child", forked_from_id: "parent" } },
    { type: "event_msg", timestamp: "2026-08-31T05:47:56.000Z", payload: { type: "task_started", started_at: Date.parse("2026-08-30T10:00:00Z") / 1000 } },
    { type: "response_item", timestamp: "2026-08-31T05:47:56.001Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "inherited" }] } },
    { type: "event_msg", timestamp: "2026-08-31T05:48:38.000Z", payload: { type: "task_started", started_at: Date.parse("2026-08-31T05:48:38Z") / 1000 } },
    { type: "response_item", timestamp: "2026-08-31T05:48:39.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] } },
  ];
  const result = stripCodexForkSnapshot(rows);
  assert.equal(result.skipped, 3);
  assert.deepEqual(result.messages, rows.slice(3));
});

test("shared ingest handles Claude and Codex, deduplicates, and sorts late messages", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-"));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const messages = [
    { timestamp: "2026-05-12T02:00:00Z", type: "assistant", message: { content: [{ type: "text", text: "later" }] } },
    { timestamp: "2026-05-12T01:00:00Z", type: "user", message: { content: "earlier" } },
    { timestamp: "2026-05-12T16:30:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "next day" }] } },
  ];
  const first = ingestMessages(messages, { memoryStore: store, fullDir });
  const second = ingestMessages([...messages].reverse(), { memoryStore: store, fullDir });
  assert.deepEqual([first.imported, first.fullBacked, second.imported, second.fullBacked], [3, 3, 0, 0]);

  const day = store.listMessages({ date: "2026-05-12" });
  assert.deepEqual(day.map(row => row.text), ["earlier", "later"]);
  assert.equal(store.listMessages({ date: "2026-05-13" }).length, 1);
  assert.equal(fs.existsSync(path.join(root, "archive", "2026", "05", "2026-05-12.jsonl")), false);
});

test("thread parser accepts newline and adjacent JSON objects", () => {
  assert.deepEqual(parseThreadMessages('{"a":1}\n{"b":2}{"c":3}'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("native thread ingest preserves conversation text longer than 2000 characters", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-long-"));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const text = "长".repeat(2500);
  ingestMessages([{ timestamp: "2026-05-12T01:00:00Z", type: "user", message: { content: text } }], { memoryStore: store });
  assert.equal(store.listMessages({ date: "2026-05-12" })[0].text, text);
});

test("native Claude transport records are backed up but excluded from conversation ingest", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-claude-internal-"));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const rows = [
    { type: "queue-operation", timestamp: "2026-07-16T08:00:00.000Z", content: "同一句用户消息" },
    { type: "user", timestamp: "2026-07-16T08:00:00.004Z", message: { content: "同一句用户消息" } },
  ];
  const result = ingestMessages(rows, { memoryStore: store, fullDir });
  assert.equal(result.filtered, 1);
  assert.equal(result.fullBacked, 2);
  assert.deepEqual(store.listMessages({ date: "2026-07-16" }).map(row => row.text), ["同一句用户消息"]);
});

test("memory_context blocks stay in full backup but never enter the conversation archive", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-memory-block-"));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const block = "<memory_context>\n## 7月1日\n- 一条旧摘要\n</memory_context>";
  const result = ingestMessages([
    { timestamp: "2026-07-01T01:00:00Z", type: "user", message: { content: block } },
    { timestamp: "2026-07-01T01:01:00Z", type: "user", message: { content: "真正的对话" } },
  ], { memoryStore: store, fullDir });

  assert.equal(result.fullBacked, 2);
  assert.deepEqual(store.listMessages({ date: "2026-07-01" }).map(row => row.text), ["真正的对话"]);
});

test("ingest removes memory_context blocks left by older archive versions", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-memory-cleanup-"));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  store.insertMessages([{
    timestamp: "2026-07-01T01:00:00Z", sourceDate: "2026-07-01", role: "user",
    text: "<memory_context>\n旧污染\n</memory_context>",
  }]);

  ingestMessages([], { memoryStore: store });
  assert.equal(store.listMessages({ date: "2026-07-01" }).length, 0);
});

test("opening an existing memory store automatically repairs legacy memory_context rows", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-open-memory-cleanup-"));
  const first = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  first.insertMessages([
    { timestamp: "2026-07-01T01:00:00Z", sourceDate: "2026-07-01", role: "user", text: "<memory_context>\n旧污染\n</memory_context>" },
    { timestamp: "2026-07-01T01:00:30Z", sourceDate: "2026-07-01", role: "user", text: "<memory_context>\n被旧版截断、没有闭合标签的污染" },
    { timestamp: "2026-07-01T01:01:00Z", sourceDate: "2026-07-01", role: "user", text: "我在聊天中提到了 <memory_context> 这个标签，但这不是完整记忆块。" },
  ]);
  first.close();

  const reopened = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  assert.equal(reopened.removedInjectedMemoryBlocks, 2);
  assert.deepEqual(reopened.listMessages({ date: "2026-07-01" }).map(row => row.text), [
    "我在聊天中提到了 <memory_context> 这个标签，但这不是完整记忆块。",
  ]);
});

test("selected conversation cleaning rules affect future ingest and leave a local audit record", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-cleaning-policy-"));
  fs.writeFileSync(path.join(root, "tool-event-policy.json"), JSON.stringify({
    cleaning: {
      exactDuplicates: [{ id: "repeat", text: "这是一段被用户确认需要去重的完整重复文本" }],
      customRuleHeaders: ["[EXTERNAL RULE]"],
    },
  }));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const result = ingestMessages([
    { timestamp: "2026-08-31T01:00:00Z", type: "user", message: { content: "这是一段被用户确认需要去重的完整重复文本" } },
    { timestamp: "2026-08-31T01:01:00Z", type: "user", message: { content: "这是一段被用户确认需要去重的完整重复文本" } },
    { timestamp: "2026-08-31T01:02:00Z", type: "user", message: { content: "[EXTERNAL RULE]\n不要入库" } },
  ], { memoryStore: store });
  assert.equal(result.imported, 1);
  assert.equal(result.conversationFiltered, 2);
  const filterLog = store.listConversationFilterLog();
  assert.equal(filterLog.total, 2);
  assert.deepEqual(filterLog.groups.map(item => [item.category, item.count]), [
    ["rule_header", 1],
    ["exact_duplicate", 1],
  ]);

  saveToolEventPolicy(root, {});
  const replay = ingestMessages([
    { timestamp: "2026-08-31T01:01:00Z", type: "user", message: { content: "这是一段被用户确认需要去重的完整重复文本" } },
    { timestamp: "2026-08-31T01:03:00Z", type: "user", message: { content: "这是一段被用户确认需要去重的完整重复文本" } },
  ], { memoryStore: store });
  assert.equal(replay.imported, 1, "the removed historical occurrence stays suppressed, but a future occurrence is allowed");
  assert.equal(store.listMessages({ date: "2026-08-31" }).length, 2);
});

test("role-scoped duplicate rules do not treat the other speaker as an existing duplicate", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-role-cleaning-"));
  fs.writeFileSync(path.join(root, "tool-event-policy.json"), JSON.stringify({
    cleaning: {
      exactDuplicates: [{ id: "user-repeat", role: "user", text: "同一句话", enabled: true }],
    },
  }));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  store.insertMessages([{
    timestamp: "2026-08-31T00:59:00Z", sourceDate: "2026-08-31", role: "assistant", text: "同一句话",
  }]);

  const result = ingestMessages([
    { timestamp: "2026-08-31T01:00:00Z", type: "user", message: { content: "同一句话" } },
    { timestamp: "2026-08-31T01:01:00Z", type: "user", message: { content: "同一句话" } },
  ], { memoryStore: store });

  assert.equal(result.imported, 1);
  assert.equal(result.conversationFiltered, 1);
  assert.deepEqual(store.db.prepare(
    "SELECT role, text FROM messages WHERE thread_id=? ORDER BY timestamp",
  ).all(store.threadId).map(row => [row.role, row.text]), [
    ["assistant", "同一句话"],
    ["user", "同一句话"],
  ]);
});
