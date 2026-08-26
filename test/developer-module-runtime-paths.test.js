"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ScratchSettingsStore } = require("../src/services/scratch-reward-service");
const { DreamStore } = require("../src/storage/dream-store");
const { DreamPreferences } = require("../src/services/dream-preferences");
const { MiningReviewStore } = require("../src/services/mining-review");
const { NotebookService } = require("../src/services/notebook-service");

function rootFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-runtime-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("scratch reads legacy settings only as fallback and writes settings.json only", t => {
  const root = rootFixture(t);
  const threadDir = path.join(root, "thread");
  const dataDir = path.join(root, "module-data");
  const legacy = path.join(threadDir, "memory", "developer-modules", "my-module.json");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ rewards: { gray: "legacy" } }));
  const store = new ScratchSettingsStore({ getThreadDirImpl: () => threadDir, dataDirForThread: () => dataDir });
  assert.equal(store.get("thread-a").rewards.gray, "legacy");
  store.save("thread-a", { rewards: { gray: "new" } });
  assert.equal(store.get("thread-a").rewards.gray, "new");
  assert.equal(JSON.parse(fs.readFileSync(legacy, "utf8")).rewards.gray, "legacy");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).rewards.gray, "new");
});

test("dream data and preferences prefer module data while legacy remains unchanged", t => {
  const root = rootFixture(t);
  const primary = path.join(root, "module");
  const legacy = path.join(root, "legacy");
  const legacyDream = path.join(legacy, "thread-a", "2026", "08", "2026-08-20.txt");
  fs.mkdirSync(path.dirname(legacyDream), { recursive: true });
  fs.writeFileSync(legacyDream, "dreamType: beautiful\ndreamDate: 2026-08-20\ntitle: old\n\nlegacy\n");
  const dreams = new DreamStore({ root: primary, legacyRootForThread: id => path.join(legacy, id) });
  assert.equal(dreams.get("thread-a", "2026-08-20").body, "legacy");
  dreams.save({ threadId: "thread-a", date: "2026-08-21", dreamType: "beautiful", title: "new", body: "module" });
  assert.equal(fs.existsSync(path.join(primary, "thread-a", "2026", "08", "2026-08-21.txt")), true);
  assert.equal(fs.readFileSync(legacyDream, "utf8").includes("legacy"), true);

  const legacyPrefs = path.join(legacy, "prefs", "thread-a", "preferences.json");
  fs.mkdirSync(path.dirname(legacyPrefs), { recursive: true });
  fs.writeFileSync(legacyPrefs, JSON.stringify({ guard: true }));
  const preferences = new DreamPreferences({
    baseDirForThread: id => path.join(primary, "prefs", id),
    legacyBaseDirForThread: id => path.join(legacy, "prefs", id),
  });
  assert.equal(preferences.read("thread-a").guard, true);
  preferences.setGuard("thread-a", false);
  assert.equal(preferences.read("thread-a").guard, false);
  assert.equal(JSON.parse(fs.readFileSync(legacyPrefs, "utf8")).guard, true);
});

test("review candidates prefer module copies and new candidates never write legacy", t => {
  const root = rootFixture(t);
  const memoryDir = path.join(root, "memory");
  const dataDir = path.join(root, "module");
  const legacyDir = path.join(memoryDir, "review-candidates");
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyCandidate = {
    version: 1, id: "candidate-11111111-1111-4111-8111-111111111111", threadId: "thread-a",
    date: "2026-08-20", status: "review_pending", archiveFingerprint: "legacy-hash",
    feelings: [], features: [], ruleIds: [],
  };
  fs.writeFileSync(path.join(legacyDir, `${legacyCandidate.id}.json`), JSON.stringify(legacyCandidate));
  const store = new MiningReviewStore({ memoryDir, threadId: "thread-a", dataDir });
  assert.equal(store.load(legacyCandidate.id).date, "2026-08-20");
  const created = store.createCandidate({ date: "2026-08-21", archiveFingerprint: "hash", feelings: [], features: [] });
  assert.equal(fs.existsSync(path.join(dataDir, "candidates", `${created.id}.json`)), true);
  assert.equal(fs.existsSync(path.join(legacyDir, `${created.id}.json`)), false);
});

test("notebook read operations fall back but writes stay on the primary store", () => {
  const calls = [];
  const primary = {
    status: () => ({ topicCount: 0, entryCount: 0 }),
    createTopic: input => (calls.push(["primary-write", input]), { id: "new" }),
    close() {},
  };
  const legacy = { status: () => ({ topicCount: 1, entryCount: 2 }), close() { calls.push(["legacy-close"]); } };
  const service = new NotebookService({ storeFactory: () => primary, fallbackStoreFactory: () => legacy });
  assert.equal(service.status({ threadId: "thread-a" }).topicCount, 1);
  assert.equal(service.createTopic({ threadId: "thread-a", name: "new" }).id, "new");
  assert.deepEqual(calls, [["legacy-close"], ["primary-write", { name: "new" }]]);
});
