const test = require("node:test");
const assert = require("node:assert/strict");

const { serializeJsonl } = require("../src/lib/jsonl");

test("serialized JSONL ends with exactly one record terminator", () => {
  assert.equal(serializeJsonl(['{"id":1}', '{"id":2}']), '{"id":1}\n{"id":2}\n');
  assert.equal(serializeJsonl([]), "");
});
