const test = require("node:test");
const assert = require("node:assert/strict");
const { splitMiningMessages, byteLength } = require("../src/services/mining-chunks");

function message(index, size = 1024, gapMinutes = 1) {
  return {
    timestamp: new Date(Date.UTC(2026, 6, 25, 0, index * gapMinutes)).toISOString(),
    text: "x".repeat(size),
  };
}

const render = rows => rows.map(row => `[${row.timestamp}] ${row.text}`).join("\n");

test("continuous 102KB dialogue becomes two full-sized chunks and a small tail", () => {
  const messages = Array.from({ length: 102 }, (_, index) => message(index));
  const chunks = splitMiningMessages(messages, { render });
  assert.equal(chunks.length, 3);
  assert.ok(chunks.slice(0, 2).every(chunk => byteLength(render(chunk)) <= 50 * 1024));
  assert.ok(byteLength(render(chunks[2])) < 10 * 1024);
  assert.deepEqual(chunks.flat(), messages);
});

test("a five-minute dialogue gap is preferred over cutting through a session", () => {
  const first = Array.from({ length: 30 }, (_, index) => message(index));
  const second = Array.from({ length: 30 }, (_, index) => ({
    ...message(index + 40),
    timestamp: new Date(Date.UTC(2026, 6, 25, 2, index)).toISOString(),
  }));
  const chunks = splitMiningMessages([...first, ...second], { render });
  assert.deepEqual(chunks.map(chunk => chunk.length), [30, 30]);
});

test("one oversized message is never truncated", () => {
  const huge = message(0, 60 * 1024);
  const chunks = splitMiningMessages([huge], { render });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0][0], huge);
  assert.ok(byteLength(render(chunks[0])) > 50 * 1024);
});
