const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/storage/memory-store");
const { ensureDateFile } = require("../src/lib/archive-paths");
const { saveToolEventPolicy, loadToolEventPolicy } = require("../src/services/tool-event-policy");
const { buildUnfilterPlan, applyUnfilter, buildUnfilterBatchPlan, applyUnfilterBatch } = require("../scripts/stmem-tool-policy");

test("cancelling a filtering rule restores affected SQLite text from raw full", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-unfilter-"));
  const threadId = "thread-unfilter";
  const store = new MemoryStore({ memoryDir, threadId });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  const timestamp = "2026-08-31T10:00:00.000Z";
  const injection = "这是一整段被用户选中过滤、但之后又决定取消过滤的重复注入内容。";
  const original = `${injection}\n\n真正的用户对话`;
  const fullDir = path.join(memoryDir, "archive", "full");
  fs.writeFileSync(ensureDateFile(fullDir, "2026-08-31"), `${JSON.stringify({ timestamp, type: "user", message: { content: original } })}\n`);
  store.insertMessages([{ timestamp, sourceDate: "2026-08-31", role: "user", text: "真正的用户对话" }]);
  store.logConversationFilters([{ timestamp, category: "injection_fragment", ruleId: "rule-a", originalText: injection, retainedText: "真正的用户对话" }]);
  const policy = saveToolEventPolicy(memoryDir, { cleaning: { injectionFragments: [{ id: "rule-a", sample: injection, normalized: injection }] } });

  const preview = buildUnfilterPlan(store, policy, memoryDir, "injection_fragment", "rule-a");
  assert.equal(preview.recoverable, 1);
  const result = applyUnfilter(store, policy, memoryDir, "injection_fragment", "rule-a", preview.token);

  assert.equal(result.restored, 1);
  assert.equal(store.listMessages({ date: "2026-08-31" })[0].text, original);
  assert.equal(store.listConversationFilterLog().total, 0);
  assert.deepEqual(loadToolEventPolicy(memoryDir).cleaning.injectionFragments, []);
});

test("batch cancellation restores one conversation once when several rules stripped the same message", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-unfilter-batch-"));
  const threadId = "thread-unfilter-batch";
  const store = new MemoryStore({ memoryDir, threadId });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive: true, force: true }); });
  const timestamp = "2026-08-31T11:00:00.000Z";
  const first = "第一段被旧检测器从同一份完整文档中拆成了独立规则。";
  const second = "第二段也被旧检测器从同一份完整文档中拆成了独立规则。";
  const original = `${first}\n\n${second}\n\n真正的用户对话`;
  const fullDir = path.join(memoryDir, "archive", "full");
  fs.writeFileSync(ensureDateFile(fullDir, "2026-08-31"), `${JSON.stringify({ timestamp, type: "user", message: { content: original } })}\n`);
  store.insertMessages([{ timestamp, sourceDate: "2026-08-31", role: "user", text: "真正的用户对话" }]);
  store.logConversationFilters([
    { timestamp, category: "injection_fragment", ruleId: "rule-a", originalText: first, retainedText: "真正的用户对话" },
    { timestamp, category: "injection_fragment", ruleId: "rule-b", originalText: second, retainedText: "真正的用户对话" },
  ]);
  const policy = saveToolEventPolicy(memoryDir, { cleaning: { injectionFragments: [
    { id: "rule-a", sample: first, normalized: first },
    { id: "rule-b", sample: second, normalized: second },
  ] } });
  const rules = [
    { category: "injection_fragment", ruleId: "rule-a" },
    { category: "injection_fragment", ruleId: "rule-b" },
  ];

  const preview = buildUnfilterBatchPlan(store, policy, memoryDir, rules);
  assert.deepEqual([preview.logged, preview.recoverable], [2, 1]);
  const result = applyUnfilterBatch(store, policy, memoryDir, rules, preview.token);

  assert.deepEqual([result.removedRules, result.restored], [2, 1]);
  assert.equal(store.listMessages({ date: "2026-08-31" })[0].text, original);
  assert.equal(store.listConversationFilterLog().total, 0);
  assert.deepEqual(loadToolEventPolicy(memoryDir).cleaning.injectionFragments, []);
});
