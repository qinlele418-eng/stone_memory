"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveAutomaticActions,
  shouldAutoMineDate,
} = require("../src/services/automatic-mining-policy");

test("conversation sync and memory mining are independent switches", () => {
  assert.deepEqual(resolveAutomaticActions({}), {
    sync: true, mine: true, compact: false,
  });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: false,
    automaticMemoryMaintenance: false,
  }), { sync: false, mine: false, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: true,
    automaticMemoryMaintenance: false,
  }), { sync: true, mine: false, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: false,
    automaticMemoryMaintenance: true,
  }), { sync: false, mine: true, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: true,
    automaticMemoryMaintenance: true,
  }), { sync: true, mine: true, compact: false });
});

test("automatic compression requires its own explicit switch", () => {
  assert.equal(resolveAutomaticActions({
    autoCompact: { enabled: true },
  }).compact, false);
  assert.equal(resolveAutomaticActions({
    automaticCompression: true,
  }).compact, true);
});

test("automatic mining only considers completed dates", () => {
  assert.equal(shouldAutoMineDate("2026-07-27", {
    today: "2026-07-30",
    automaticMemoryMaintenance: true,
  }), true);
  assert.equal(shouldAutoMineDate("2026-07-30", {
    today: "2026-07-30",
    automaticMemoryMaintenance: true,
  }), false);
  assert.equal(shouldAutoMineDate("2026-07-27", {
    today: "2026-07-30",
    automaticMemoryMaintenance: false,
  }), false);
});
