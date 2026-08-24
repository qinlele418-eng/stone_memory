"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DreamService, buildDreamPrompt } = require("../src/services/dream-service");
const { DreamStore } = require("../src/storage/dream-store");
const { MemoryStore } = require("../src/storage/memory-store");
const { DreamPreferences } = require("../src/services/dream-preferences");

function seedMemory(root, threadId) {
  const memoryDir = path.join(root, "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  store.replaceDay("2026-07-29", {
    feelings: Array.from({ length: 3 }, (_, index) => ({ content: `today-${index + 1}`, importance: 3 })),
    features: [],
    dayState: { status: "completed", feelingCount: 3, featureCount: 0, completedAt: "2026-07-30T00:00:00.000Z" },
  });
  store.close();
}

function makeService(t, { preferences, runSubagent, dreamStore, randomInt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = "thread-test";
  seedMemory(root, threadId);
  const store = preferences || new DreamPreferences({ baseDirForThread: id => path.join(root, id) });
  return {
    root,
    threadId,
    store,
    service: new DreamService({
      dreamStore: dreamStore || new DreamStore({ root: path.join(root, "dream") }),
      memoryStoreFactory: () => new MemoryStore({ memoryDir: path.join(root, "memory"), threadId }),
      getThreadConfig: () => ({ userName: "test-user", aiName: "test-ai" }),
      operationDirectoryForThread: () => path.join(root, "tmp"),
      randomInt: randomInt || (maximum => maximum - 1),
      runSubagent: runSubagent || (() => "# title\nbody"),
      preferences: store,
    }),
  };
}

test("buildDreamPrompt prefers a thread override and falls back to bundled", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-prompt-override-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const overrideDir = path.join(root, "prompts");
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.writeFileSync(path.join(overrideDir, "beautiful.md"), "OVERRIDDEN-TYPE-PROMPT");

  const withOverride = buildDreamPrompt({
    dreamType: "beautiful",
    userName: "u",
    aiName: "a",
    overrideDirectory: overrideDir,
  });
  assert.match(withOverride, /OVERRIDDEN-TYPE-PROMPT/);

  const withoutOverride = buildDreamPrompt({
    dreamType: "beautiful",
    userName: "u",
    aiName: "a",
    overrideDirectory: path.join(root, "missing"),
  });
  assert.doesNotMatch(withoutOverride, /OVERRIDDEN-TYPE-PROMPT/);
  assert.match(withoutOverride, /本次类型是 `beautiful`/);
});

test("one-shot forces the dream type and is consumed after a successful save", t => {
  const { threadId, store, service } = makeService(t);
  store.setOneShot(threadId, "nightmare");

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "completed");
  assert.equal(result.dream.dreamType, "nightmare");
  assert.equal(store.read(threadId).oneShot, null);
});

test("one-shot is not consumed when the subagent fails", t => {
  const { threadId, store, service } = makeService(t, {
    runSubagent: () => { throw new Error("subagent boom"); },
  });
  store.setOneShot(threadId, "nightmare");

  assert.throws(() => service.generate({ threadId, date: "2026-07-29" }), /subagent boom/);
  assert.equal(store.read(threadId).oneShot.dreamType, "nightmare");
});

test("one-shot is not consumed when the dream already exists", t => {
  const { threadId, store, service } = makeService(t);
  service.dreamStore.save({ threadId, date: "2026-07-29", dreamType: "beautiful", title: "x", body: "existing" });
  store.setOneShot(threadId, "nightmare");

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "already_exists");
  assert.equal(store.read(threadId).oneShot.dreamType, "nightmare");
});
