const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMiningApiBody, miningApiProfile, normalizeMiningApiProfile } = require("../src/services/mining-api-profile");

test("raw API profile preserves the legacy request shape", () => {
  const body = buildMiningApiBody({
    profile: "raw",
    model: "model",
    messages: [{ role: "user", content: "对话" }],
  });
  assert.equal(body.max_tokens, 4000);
  assert.equal(Object.hasOwn(body, "thinking"), false);
});

test("optimized API profile raises the output budget and disables thinking", () => {
  const body = buildMiningApiBody({
    profile: "optimized",
    model: "model",
    messages: [],
  });
  assert.equal(body.max_tokens, 8000);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("missing or unknown API profiles fall back to the optimized profile", () => {
  assert.equal(normalizeMiningApiProfile(), "optimized");
  assert.equal(normalizeMiningApiProfile("nope"), "optimized");
  assert.equal(miningApiProfile("nope").maxTokens, 8000);
});
