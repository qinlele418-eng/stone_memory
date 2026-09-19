const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const { resolveDatabasePath } = require("../src/storage/database-location");

test("runtime threads share one global database while isolated fixtures stay local", () => {
  const runtimeMemory = path.join(os.homedir(), ".stone_memory", "runtimes", "claude", "coding", "thread-a", "memory");
  assert.equal(resolveDatabasePath(runtimeMemory), path.join(os.homedir(), ".stone_memory", "stone-memory.db"));
  const isolatedMemory = path.resolve(path.sep, "tmp", "stmem-fixture", "memory");
  assert.equal(resolveDatabasePath(isolatedMemory), path.join(isolatedMemory, "stone-memory.db"));
});

test("canonical memory directories use the same global database as legacy runtimes", () => {
  const home = os.homedir();
  assert.equal(
    resolveDatabasePath(path.join(home, ".stone_memory", "memories", "memory-1", "memory")),
    path.join(home, ".stone_memory", "stone-memory.db"),
  );
});
