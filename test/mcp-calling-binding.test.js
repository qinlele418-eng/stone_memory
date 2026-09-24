const test = require("node:test");
const assert = require("node:assert/strict");
const { pendingStmemCall, resolveCallingBinding } = require("../src/services/mcp-calling-binding");
const { resolveMcpThread } = require("../src/services/mcp-thread-resolution");

test("detects an in-flight Claude Stone Memory call before its tool result is appended", () => {
  const now = Date.parse("2026-09-22T13:51:47.000Z");
  const rows = [
    { type: "assistant", timestamp: "2026-09-22T13:51:46.000Z", message: { content: [{ type: "tool_use", id: "call-1", name: "mcp__stmem__stmem_memory_deep_search", input: { query: "x" } }] } },
  ];
  assert.deepEqual(pendingStmemCall(rows, "claude", now), { callIds: ["call-1"], timestamp: Date.parse("2026-09-22T13:51:46.000Z") });
  rows.push({ type: "user", timestamp: "2026-09-22T13:51:46.500Z", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } });
  assert.equal(pendingStmemCall(rows, "claude", now), null);
});

test("detects Codex calls and ignores stale unfinished calls", () => {
  const now = Date.parse("2026-09-22T13:51:47.000Z");
  const current = [{ type: "response_item", timestamp: "2026-09-22T13:51:46.000Z", payload: { type: "function_call", call_id: "call-2", name: "mcp__stmem__stmem_memory_search" } }];
  assert.equal(pendingStmemCall(current, "codex", now)?.callIds[0], "call-2");
  assert.equal(pendingStmemCall(current, "codex", now + 180_000), null);
});

test("maps one calling Binding to its memory and rejects concurrent memories", () => {
  const cfg = { memories: { one: {}, two: {} } };
  const bindings = id => [{ id: `binding-${id}`, provider: "claude", externalThreadId: `session-${id}`, resolvedThreadFile: `/tmp/${id}.jsonl` }];
  const one = resolveCallingBinding(cfg, { readBindings: bindings, inspect: binding => binding.id === "binding-one" ? { timestamp: 2 } : null });
  assert.equal(one.memoryId, "one");
  assert.throws(() => resolveCallingBinding(cfg, { readBindings: bindings, inspect: () => ({ timestamp: 2 }) }), /多个已绑定窗口/);
});

test("thread resolution reports the exact calling Binding to mutating tools", () => {
  let target = null;
  const memoryId = resolveMcpThread({}, { memories: { one: {} } }, [], {}, {
    resolveCallingBinding: () => ({ memoryId: "one", bindingId: "binding-cc", externalThreadId: "session-cc", provider: "claude" }),
    onResolveBinding(binding) { target = binding; },
  });
  assert.equal(memoryId, "one");
  assert.equal(target.bindingId, "binding-cc");
});
