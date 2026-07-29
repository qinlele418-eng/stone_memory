const test = require("node:test");
const assert = require("node:assert/strict");
const { applyAnchorItems, buildAnchorEntry } = require("../src/services/memory-editor");

test("retain anchors store a confirmed original-message window", () => {
  assert.deepEqual(buildAnchorEntry({}, { source_date: "2026-07-04" }, "retain", {
    startUtc: "2026-07-04T01:00:00Z",
    endUtc: "2026-07-04T02:00:00Z",
  }), {
    anchor: true,
    _date: "2026-07-04",
    startUtc: "2026-07-04T01:00:00.000Z",
    endUtc: "2026-07-04T02:00:00.000Z",
  });
});

test("retain anchor updates preserve an existing precise window unless a new one is confirmed", () => {
  const previous={anchor:true,_date:"2026-07-04",startUtc:"2026-07-04T01:00:00.000Z",endUtc:"2026-07-04T02:00:00.000Z"};
  assert.deepEqual(buildAnchorEntry(previous, { source_date: "2026-07-04" }, "retain"), previous);
  assert.throws(()=>buildAnchorEntry({}, { source_date: "2026-07-04" }, "retain", {
    startUtc: "2026-07-04T03:00:00Z",
    endUtc: "2026-07-04T02:00:00Z",
  }), /时间范围无效/);
});

test("batch anchor updates prepare retain and event changes in one config", () => {
  const feelings = new Map([
    ["f1", { source_date: "2026-07-04" }],
    ["f2", { source_date: "2026-07-05" }],
  ]);
  const result = applyAnchorItems({
    retain: { old: { anchor: true } },
    eventAnchors: { f2: { anchor: true } },
  }, feelings, [
    { id: "f1", type: "retain", enabled: true },
    { id: "f2", type: "event", enabled: false },
  ]);
  assert.deepEqual(result, {
    retain: {
      old: { anchor: true },
      f1: { anchor: true, _date: "2026-07-04" },
    },
    eventAnchors: {},
  });
});
