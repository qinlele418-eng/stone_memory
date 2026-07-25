const test = require("node:test");
const assert = require("node:assert/strict");
const { archiveFingerprint, isCompleted, shouldAttempt, requiresRemine, retryDelayMs, listBlockedDays } = require("../src/services/mining-state");

test("legacy skipped+mined date is not treated as completed", () => {
  const state = { "mined:2026-06-12": 1, "skipped:2026-06-12": 1 };
  assert.equal(isCompleted(state, "2026-06-12"), false);
  assert.equal(shouldAttempt(state, "2026-06-12", Array.from({ length: 5 }, (_, i) => ({ text: String(i) }))), true);
});

test("completed_empty is a terminal successful state", () => {
  const state = { "day:2026-06-12": { status: "completed_empty", messageCount: 2 } };
  assert.equal(isCompleted(state, "2026-06-12"), true);
  assert.equal(shouldAttempt(state, "2026-06-12", [{ text: "a" }, { text: "b" }]), false);
});

test("completed date is queued for safe remine when its archive grows", () => {
  const original = [{ timestamp: "2026-06-12T01:00:00Z", type: "user", text: "first" }];
  const state = { "day:2026-06-12": {
    status: "completed",
    messageCount: 1,
    archiveFingerprint: archiveFingerprint(original),
    completedAt: "2026-06-12T02:00:00Z",
  } };
  assert.equal(requiresRemine(state, "2026-06-12", original), false);
  assert.equal(requiresRemine(state, "2026-06-12", [...original, {
    timestamp: "2026-06-12T03:00:00Z", type: "assistant", text: "second",
  }]), true);
});

test("historical imports do not remine when their event time predates completion", () => {
  const state = { "day:2026-06-12": { status: "completed", completedAt: "2026-07-01T00:00:00Z" } };
  assert.equal(requiresRemine(state, "2026-06-12", [
    { timestamp: "2026-06-12T01:00:00Z", text: "original" },
    { timestamp: "2026-06-12T02:00:00Z", text: "late historical import" },
  ]), false);
});

test("legacy completed date without a completion time is not remine automatically", () => {
  const state = { "day:2026-06-12": { status: "completed", messageCount: 1 } };
  assert.equal(requiresRemine(state, "2026-06-12", [{ timestamp: "2026-06-12T03:00:00Z" }]), false);
});

test("failed date observes retry backoff", () => {
  const now = Date.parse("2026-06-12T00:00:00Z");
  const state = { "day:2026-06-12": { status: "failed", nextRetryAt: "2026-06-12T00:05:00Z" } };
  assert.equal(shouldAttempt(state, "2026-06-12", [], now), false);
  assert.equal(shouldAttempt(state, "2026-06-12", [], now + retryDelayMs(2)), true);
});

test("blocked date is excluded from automatic scheduling and exposed for inspection", () => {
  const state = { "day:2026-06-12": { status: "blocked", attempt: 3, errorCode: "OUTPUT_INVALID", errorMessage: "bad json" } };
  assert.equal(shouldAttempt(state, "2026-06-12", [], Date.now() + 86400000), false);
  assert.deepEqual(listBlockedDays(state).map(item => [item.date, item.errorCode]), [["2026-06-12", "OUTPUT_INVALID"]]);
});
