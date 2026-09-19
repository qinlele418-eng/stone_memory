const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMemoryArg } = require("../src/lib/memory-cli");

test("memory CLI never guesses the first of multiple memories", () => {
  assert.throws(() => resolveMemoryArg([], { configuredMemoryIds: ["memory-a", "memory-b"] }), /存在多个记忆体/);
  assert.equal(resolveMemoryArg(["--memory", "memory-b"], { configuredMemoryIds: ["memory-a", "memory-b"] }), "memory-b");
});

test("read-only commands may omit memory only when exactly one exists", () => {
  assert.equal(resolveMemoryArg([], { configuredMemoryIds: ["memory-a"] }), "memory-a");
  assert.throws(() => resolveMemoryArg([], { configuredMemoryIds: [] }), /未指定记忆体/);
});

test("write commands can require an explicit memory even in a single-memory install", () => {
  assert.throws(() => resolveMemoryArg([], { allowDefault: false, configuredMemoryIds: ["memory-a"] }), /--memory/);
  assert.equal(resolveMemoryArg(["--thread", "memory-a"], { allowDefault: false }), "memory-a");
  assert.throws(() => resolveMemoryArg(["--memory", "memory-a", "--thread", "memory-b"], { allowDefault: false }), /不能指向不同/);
});
