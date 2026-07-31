"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runPostMiningHooks } = require("../src/services/post-mining-hooks");

test("post-mining hooks are independently enabled and isolated", () => {
  const results = runPostMiningHooks({ threadConfig: { automaticDream: true } }, {
    hooks: [
      { id: "disabled", enabled: () => false, run: () => { throw new Error("must not run"); } },
      { id: "dream", enabled: context => context.threadConfig.automaticDream, run: () => ({ attempted: true, ok: true }) },
      { id: "broken", run: () => { throw new Error("plugin failed"); } },
    ],
  });
  assert.deepEqual(results.map(row => [row.id, row.attempted, row.ok]), [
    ["disabled", false, false],
    ["dream", true, true],
    ["broken", true, false],
  ]);
  assert.match(results[2].error.message, /plugin failed/);
});
