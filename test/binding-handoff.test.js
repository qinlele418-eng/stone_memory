const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const { addBinding } = require("../src/services/memory-bindings");
const {
  CONTEXT_NOTICE,
  buildHandoff,
  matches,
  hookSpec,
  run,
} = require("../developer-modules/continuity-lab/backend/commands/claude-hook");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-handoff-"));
  const transcript = path.join(root, "claude.jsonl");
  fs.writeFileSync(transcript, "");
  const store = new MemoryStore({ memoryDir: path.join(root, "memory"), threadId: "memory-handoff" });
  const binding = addBinding(store, {
    provider: "claude_code",
    externalThreadId: "claude-session",
    threadFile: transcript,
  }).binding;
  const insert = store.db.prepare(`INSERT INTO feelings
    (id,thread_id,source_date,event_time,order_key,content,summary_mode,coarse_summary,importance,source,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = new Date().toISOString();
  insert.run("older", store.threadId, "2026-08-20", null, "1", "8月20日，较早但重要。", "daily", null, 4, "manual", now, now);
  insert.run("coarse", store.threadId, "2026-08-21", null, "1", "冗长原文", "coarse", "8月21日，精简摘要。", 3, "manual", now, now);
  insert.run("low", store.threadId, "2026-08-22", null, "1", "低重要度内容", "daily", null, 2, "manual", now, now);
  insert.run("hidden", store.threadId, "2026-08-23", null, "1", "隐藏内容", "hidden", null, 5, "manual", now, now);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, binding, transcript };
}

test("Claude handoff uses recent visible evidence without hard-coded categories", t => {
  const { store, binding } = fixture(t);
  const context = {
    core: {
      getBinding: () => binding,
      listFeelings: () => store.listFeelings(),
    },
  };
  const output = buildHandoff(context, store.threadId, binding.id);
  assert.equal(output.feelingCount, 2);
  assert.match(output.context, new RegExp(CONTEXT_NOTICE));
  assert.match(output.context, /较早但重要/);
  assert.match(output.context, /精简摘要/);
  assert.doesNotMatch(output.context, /低重要度|隐藏内容|冗长原文/);
  assert.ok(output.context.indexOf("较早但重要") < output.context.indexOf("精简摘要"));
});

test("Claude hook matching requires an exact enabled Binding", t => {
  const { binding, transcript } = fixture(t);
  assert.equal(matches(binding, { session_id: "claude-session" }), true);
  assert.equal(matches(binding, { transcript_path: transcript }), true);
  assert.equal(matches(binding, { session_id: "another" }), false);
  assert.equal(matches({ ...binding, enabled: false }, { session_id: "claude-session" }), false);
});

test("Claude hook emits current contract and fails open", async () => {
  const binding = { id: "binding-a", enabled: true, provider: "claude_code", externalThreadId: "session-a", capabilities: {} };
  const context = { core: {
    listMemoryIds: () => ["memory-a"],
    listBindings: () => [binding],
    getBinding: () => binding,
    listFeelings: () => [{ source_date: "2026-08-20", event_time: null, order_key: "1", content: "一段近期证据", summary_mode: "daily", importance: 4 }],
  } };
  const found = await run(context, { action: "hook", stdin: { hook_event_name: "SessionStart", session_id: "session-a" } });
  assert.equal(found.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(found.hookSpecificOutput.additionalContext, /一段近期证据/);
  assert.deepEqual(await run(context, { action: "hook", stdin: { hook_event_name: "SessionStart", session_id: "missing" } }), {});
  assert.deepEqual(await run(context, { action: "hook", stdin: { hook_event_name: "PostCompact" } }), {});
  const spec = hookSpec();
  assert.equal(spec.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
  assert.equal(spec.hooks.PostCompact, undefined);
});
