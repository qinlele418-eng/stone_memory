"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldAutoMineDate } = require("../src/services/automatic-mining-policy");

test("full mining only bootstraps dates that existed when the memory body was registered", () => {
  const config = {
    createdDate: "2026-07-15",
    automaticFullMining: true,
    automaticMemoryMaintenance: false,
  };
  assert.equal(shouldAutoMineDate("2026-07-14", config), true);
  assert.equal(shouldAutoMineDate("2026-07-15", config), true);
  assert.equal(shouldAutoMineDate("2026-07-27", config), false);
});

test("maintenance owns dates created after registration", () => {
  const config = {
    createdDate: "2026-07-15",
    automaticFullMining: false,
    automaticMemoryMaintenance: true,
  };
  assert.equal(shouldAutoMineDate("2026-07-14", config), false);
  assert.equal(shouldAutoMineDate("2026-07-15", config), true);
  assert.equal(shouldAutoMineDate("2026-07-27", config), true);
});

test("disabling both automatic lanes never mines", () => {
  assert.equal(shouldAutoMineDate("2026-07-27", {
    createdDate: "2026-07-15",
    automaticFullMining: false,
    automaticMemoryMaintenance: false,
  }), false);
});
