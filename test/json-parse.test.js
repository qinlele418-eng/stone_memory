const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJsonArray, parseJsonObject } = require("../src/lib/json-parse");

test("parseJsonArray keeps returning plain arrays", () => {
  assert.deepEqual(parseJsonArray('[{"content":"a"}]'), [{ content: "a" }]);
  assert.deepEqual(parseJsonArray('```json\n[{"content":"b"}]\n```'), [{ content: "b" }]);
  assert.deepEqual(parseJsonArray("not json at all"), []);
});

test("parseJsonArray unwraps {feelings,features} envelopes instead of dropping them", () => {
  // operations/memory-miner-operations.md documents an object with two arrays,
  // so the subagent legitimately answers with an envelope. Returning [] here
  // silently discards a whole mined day.
  const envelope = '{"feelings":[{"content":"x"}],"features":[]}';
  assert.deepEqual(parseJsonArray(envelope), [{ content: "x" }]);
  assert.deepEqual(parseJsonArray(envelope, { preferKeys: ["feelings"] }), [{ content: "x" }]);
  assert.deepEqual(
    parseJsonArray('{"feelings":[],"features":[{"content":"y"}]}', { preferKeys: ["features"] }),
    [{ content: "y" }],
  );
  assert.deepEqual(parseJsonArray('```json\n{"feelings":[{"content":"z"}]}\n```'), [{ content: "z" }]);
  assert.deepEqual(parseJsonArray('{"feelings":[],"features":[]}'), []);
  assert.deepEqual(parseJsonArray('{"note":"no arrays here"}'), []);
});

test("parseJsonObject is unchanged", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseJsonObject("nope"), null);
});
