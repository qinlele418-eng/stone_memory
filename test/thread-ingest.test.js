const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ingestMessages, parseThreadMessages } = require("../src/services/thread-ingest");
const { MemoryStore } = require("../src/storage/memory-store");

test("shared ingest handles Claude and Codex, deduplicates, and sorts late messages", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
  const text = "长".repeat(2500);
  ingestMessages([{ timestamp: "2026-05-12T01:00:00Z", type: "user", message: { content: text } }], { memoryStore: store });
  assert.equal(store.listMessages({ date: "2026-05-12" })[0].text, text);
});

test("memory_context blocks stay in full backup but never enter the conversation archive", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-ingest-memory-block-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fullDir = path.join(root, "archive", "full");
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => store.close());
  store.insertMessages([{
    timestamp: "2026-07-01T01:00:00Z", sourceDate: "2026-07-01", role: "user",
    text: "<memory_context>\n旧污染\n</memory_context>",
  }]);

  ingestMessages([], { memoryStore: store });
  assert.equal(store.listMessages({ date: "2026-07-01" }).length, 0);
});

test("opening an existing memory store automatically repairs legacy memory_context rows", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-open-memory-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  first.insertMessages([
    { timestamp: "2026-07-01T01:00:00Z", sourceDate: "2026-07-01", role: "user", text: "<memory_context>\n旧污染\n</memory_context>" },
    { timestamp: "2026-07-01T01:00:30Z", sourceDate: "2026-07-01", role: "user", text: "<memory_context>\n被旧版截断、没有闭合标签的污染" },
    { timestamp: "2026-07-01T01:01:00Z", sourceDate: "2026-07-01", role: "user", text: "我在聊天中提到了 <memory_context> 这个标签，但这不是完整记忆块。" },
  ]);
  first.close();

  const reopened = new MemoryStore({ memoryDir: root, threadId: "thread-test" });
  t.after(() => reopened.close());
  assert.equal(reopened.removedInjectedMemoryBlocks, 2);
  assert.deepEqual(reopened.listMessages({ date: "2026-07-01" }).map(row => row.text), [
    "我在聊天中提到了 <memory_context> 这个标签，但这不是完整记忆块。",
  ]);
});
