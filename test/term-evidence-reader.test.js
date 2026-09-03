const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readMatchingUserMessages,
  readMatchingFeelings,
  countMessageCooccurrences,
  cooccurrenceKey,
} = require("../src/services/term-evidence-reader");

test("large message histories are scanned one date at a time and only matching rows survive", () => {
  const dates = Array.from({ length: 180 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1));
    return date.toISOString().slice(0, 10);
  });
  const calls = [];
  const store = {
    listMessageDates: () => dates,
    listMessages: options => {
      assert.ok(options?.date, "an unbounded message read must never occur");
      calls.push(options.date);
      return Array.from({ length: 200 }, (_, index) => ({
        type: "user", sourceDate: options.date, timestamp: `${options.date}T00:00:00Z`,
        text: index === 0 && options.date === dates.at(-1) ? "少爷和女仆" : "普通对话",
      }));
    },
  };
  const rows = readMatchingUserMessages({ store, terms: ["少爷"] });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, dates.length);
});

test("cooccurrence counting keeps counts instead of retaining matching message bodies", () => {
  const store = {
    listMessageDates: () => ["2026-08-01", "2026-08-02"],
    listMessages: ({ date }) => date === "2026-08-01"
      ? [
        { type: "user", text: "少爷和女仆" },
        { type: "user", text: "少爷" },
        { type: "assistant", text: "少爷和女仆" },
      ]
      : [{ type: "user", text: "少爷与女仆又出现了" }],
  };
  const counts = countMessageCooccurrences({ store, terms: ["少爷", "女仆"] });
  assert.equal(counts.get(cooccurrenceKey(["少爷", "女仆"])), 2);
});

test("feeling evidence uses a streaming iterator and retains only requested evidence", () => {
  let iterated = 0;
  const store = {
    *iterateFeelingEvidence() {
      for (let index = 0; index < 10_000; index++) {
        iterated++;
        yield { id: `f-${index}`, source_date: "2026-08-01", content: index % 2500 === 0 ? "少爷和女仆" : "别的摘要" };
      }
    },
  };
  const rows = readMatchingFeelings({ store, terms: ["少爷"] });
  assert.equal(iterated, 10_000);
  assert.equal(rows.length, 4);
});
