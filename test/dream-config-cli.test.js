"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runDreamCommand } = require("../scripts/stmem-dream");
const { DreamPreferences } = require("../src/services/dream-preferences");

function run(args, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preferences = new DreamPreferences({ baseDirForThread: id => path.join(root, id) });
  const lines = [];
  const result = runDreamCommand(args, {
    preferencesFactory: () => preferences,
    writeLine: line => lines.push(line),
  });
  return { result, preferences, lines };
}

test("dream preferences reports safe defaults", t => {
  const { result, lines } = run(["preferences", "--thread", "thread-a"], t);
  assert.equal(result.threadId, "thread-a");
  assert.equal(result.nsfwEnabled, false);
  assert.deepEqual(result.excludedTypes, []);
  assert.equal(result.oneShot, null);
  assert.equal(result.multipliers.beautiful, 1);
  assert.equal(result.distribution.mode, "safe");
  assert.ok(result.distribution.final.beautiful > 0.88 && result.distribution.final.beautiful < 0.90);
  assert.deepEqual(JSON.parse(lines[0]), result);
});

test("dream nsfw explicitly enables and disables the full policy", t => {
  const enabled = run(["nsfw", "--thread", "thread-a", "on"], t);
  assert.equal(enabled.result.nsfwEnabled, true);
  assert.equal(enabled.result.distribution.mode, "nsfw");

  const disabled = run(["nsfw", "--thread", "thread-a", "off"], t);
  assert.equal(disabled.result.nsfwEnabled, false);
  assert.equal(disabled.result.distribution.mode, "safe");
});

test("dream pin rejects NSFW types while the capability is disabled", t => {
  assert.throws(
    () => run(["pin", "--thread", "thread-a", "--type", "erotic"], t),
    error => error.code === "DREAM_NSFW_DISABLED",
  );
});

test("dream pin sets a one-shot override and unpin clears it", t => {
  const first = run(["pin", "--thread", "thread-a", "--type", "nightmare"], t);
  assert.equal(first.result.oneShot.dreamType, "nightmare");

  const second = run(["unpin", "--thread", "thread-a"], t);
  assert.equal(second.result.oneShot, null);
});

test("dream guard sets a custom exclusion set and clears it", t => {
  const on = run(["guard", "--thread", "thread-a", "--exclude", "nightmare", "--exclude", "nightmare_erotic"], t);
  assert.deepEqual(on.result.excludedTypes, ["nightmare", "nightmare_erotic"]);
  assert.equal(on.result.distribution.final.nightmare, 0);
  assert.equal(on.result.distribution.final.nightmare_erotic, 0);

  const off = run(["guard", "--thread", "thread-a"], t);
  assert.deepEqual(off.result.excludedTypes, []);
});

test("dream multiplier updates weights and rejects unknown steps", t => {
  const result = run(["multiplier", "--thread", "thread-a", "--erotic", "2"], t);
  assert.equal(result.result.multipliers.erotic, 2);

  assert.throws(
    () => run(["multiplier", "--thread", "thread-a", "--erotic", "1.37"], t),
    /multiplier must be one of/,
  );
});

test("dream prompt reads bundled, writes override, and resets", t => {
  const before = run(["prompt", "--thread", "thread-a", "--type", "beautiful"], t);
  assert.equal(before.result.custom, false);
  assert.match(before.result.content, /`beautiful`/);

  const file = path.join(os.tmpdir(), `stmem-dream-prompt-${process.pid}.md`);
  fs.writeFileSync(file, "自定义美梦秘典");
  t.after(() => fs.rmSync(file, { force: true }));
  const after = run(["prompt", "--thread", "thread-a", "--type", "beautiful", "--set", file], t);
  assert.equal(after.result.custom, true);
  assert.equal(after.result.content, "自定义美梦秘典");

  const reset = run(["prompt", "--thread", "thread-a", "--type", "beautiful", "--reset"], t);
  assert.equal(reset.result.custom, false);
});

test("prompt write rejects a common rule that drops the type slot", t => {
  const file = path.join(os.tmpdir(), `stmem-dream-common-${process.pid}.md`);
  fs.writeFileSync(file, "没有占位符的公共规则");
  t.after(() => fs.rmSync(file, { force: true }));
  assert.throws(
    () => run(["prompt", "--thread", "thread-a", "--type", "common-core", "--set", file], t),
    /\{\{typePrompt\}\}/,
  );
});
