"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeModelName } = require("../src/lib/model-name");

test("model names preserve provider suffixes without allowing shell syntax", () => {
  assert.equal(normalizeModelName("deepseek-v4-flash[1m]"), "deepseek-v4-flash[1m]");
  assert.equal(normalizeModelName("openai/gpt-5.6:latest"), "openai/gpt-5.6:latest");
  assert.throws(() => normalizeModelName("model; rm"), /unsupported characters/);
  assert.throws(() => normalizeModelName("model\nnext"), /unsupported characters/);
});
