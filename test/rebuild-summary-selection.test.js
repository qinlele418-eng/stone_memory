const test = require("node:test");
const assert = require("node:assert/strict");
const { selectRebuildFeelings } = require("../src/services/thread-rebuilder");

function feeling(id, importance) {
  return { id, importance };
}

test("keeps the latest matching summaries after hidden rows were excluded upstream", () => {
  const rows = [
    feeling("one", 1),
    feeling("two", 3),
    feeling("three", 2),
    feeling("four", 4),
    feeling("five", 5),
  ];
  const result = selectRebuildFeelings(rows, { summaryLimit: 2, minImportance: 3 });
  assert.deepEqual(result.selected.map(row => row.id), ["four", "five"]);
  assert.equal(result.overflow, 0);
});

test("protected anchors bypass importance and consume the summary limit", () => {
  const rows = [
    feeling("old-anchor", 1),
    feeling("older-normal", 5),
    feeling("newer-normal", 4),
    feeling("latest-normal", 5),
  ];
  const result = selectRebuildFeelings(rows, {
    summaryLimit: 3,
    minImportance: 4,
    protectedIds: new Set(["old-anchor"]),
  });
  assert.deepEqual(result.selected.map(row => row.id), ["old-anchor", "newer-normal", "latest-normal"]);
  assert.equal(result.protectedCount, 1);
});

test("protected anchors may exceed the requested limit but are never removed", () => {
  const rows = [feeling("a", 1), feeling("b", 1), feeling("c", 5)];
  const result = selectRebuildFeelings(rows, {
    summaryLimit: 1,
    minImportance: 5,
    protectedIds: new Set(["a", "b"]),
  });
  assert.deepEqual(result.selected.map(row => row.id), ["a", "b"]);
  assert.equal(result.overflow, 1);
});

test("zero limit and zero importance preserve backward-compatible full injection", () => {
  const rows = [feeling("a", 1), feeling("b", 5)];
  const result = selectRebuildFeelings(rows, { summaryLimit: 0, minImportance: 0 });
  assert.deepEqual(result.selected.map(row => row.id), ["a", "b"]);
});
