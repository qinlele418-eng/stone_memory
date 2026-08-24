"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DreamPreferences } = require("../src/services/dream-preferences");

function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-prefs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new DreamPreferences({ baseDirForThread: threadId => path.join(root, threadId) });
}

test("missing preferences fall back to defaults", t => {
  const store = makeStore(t);
  const prefs = store.read("thread-a");
  assert.equal(prefs.guard, false);
  assert.deepEqual(prefs.multipliers, { beautiful: 1, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 });
  assert.equal(prefs.oneShot, null);
});

test("preferences round-trip per thread without cross-contamination", t => {
  const store = makeStore(t);
  store.setGuard("thread-a", true);
  store.setMultipliers("thread-a", { beautiful: 0.5, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 });
  assert.equal(store.read("thread-a").guard, true);
  assert.equal(store.read("thread-a").multipliers.beautiful, 0.5);
  assert.equal(store.read("thread-b").guard, false);
  assert.equal(store.read("thread-b").multipliers.beautiful, 1);
});

test("partial multiplier updates preserve previously set types", t => {
  const store = makeStore(t);
  store.setMultipliers("thread-a", { erotic: 2 });
  store.setMultipliers("thread-a", { beautiful: 0.5 });
  const prefs = store.read("thread-a");
  assert.equal(prefs.multipliers.erotic, 2);
  assert.equal(prefs.multipliers.beautiful, 0.5);
  assert.equal(prefs.multipliers.nightmare, 1);
});

test("one-shot is consumed only when the token still matches", t => {
  const store = makeStore(t);
  const set = store.setOneShot("thread-a", "nightmare");
  assert.equal(store.read("thread-a").oneShot.dreamType, "nightmare");
  assert.equal(store.consumeOneShot("thread-a", "wrong-token"), false);
  assert.equal(store.read("thread-a").oneShot.dreamType, "nightmare");
  assert.equal(store.consumeOneShot("thread-a", set.oneShot.token), true);
  assert.equal(store.read("thread-a").oneShot, null);
});

test("clearing one-shot resets the next-dream override", t => {
  const store = makeStore(t);
  store.setOneShot("thread-a", "erotic");
  store.clearOneShot("thread-a");
  assert.equal(store.read("thread-a").oneShot, null);
});

test("multiplier values must be an allowed step", t => {
  const store = makeStore(t);
  assert.throws(
    () => store.setMultipliers("thread-a", { beautiful: 1.37, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 }),
    /multiplier must be one of/,
  );
});

test("multipliers that zero out every candidate are rejected", t => {
  const store = makeStore(t);
  assert.throws(
    () => store.setMultipliers("thread-a", { beautiful: 0, nightmare: 0, erotic: 0, beautiful_erotic: 0, nightmare_erotic: 0 }),
    error => error.code === "DREAM_NO_CANDIDATE",
  );
});

test("guard rejects a combination that leaves no eligible random type", t => {
  const store = makeStore(t);
  store.setMultipliers("thread-a", { beautiful: 0, nightmare: 1, erotic: 0, beautiful_erotic: 0, nightmare_erotic: 0 });
  assert.throws(() => store.setGuard("thread-a", true), error => error.code === "DREAM_NO_CANDIDATE");
});

test("prompt override write, read, and reset with thread isolation", t => {
  const store = makeStore(t);
  assert.equal(store.readPromptOverride("thread-a", "beautiful.md"), null);
  store.writePromptOverride("thread-a", "beautiful.md", "custom beautiful prompt");
  assert.equal(store.readPromptOverride("thread-a", "beautiful.md"), "custom beautiful prompt");
  assert.equal(store.hasPromptOverride("thread-a", "beautiful.md"), true);
  assert.equal(store.readPromptOverride("thread-b", "beautiful.md"), null);
  store.resetPromptOverride("thread-a", "beautiful.md");
  assert.equal(store.readPromptOverride("thread-a", "beautiful.md"), null);
});

test("prompt override rejects empty content", t => {
  const store = makeStore(t);
  assert.throws(() => store.writePromptOverride("thread-a", "beautiful.md", "   "), /must not be empty/);
});

test("prompt override rejects path traversal outside known files", t => {
  const store = makeStore(t);
  assert.throws(() => store.writePromptOverride("thread-a", "../stmem.json", "x"), /invalid dream prompt file/);
});
