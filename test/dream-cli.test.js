const test = require("node:test");
const assert = require("node:assert/strict");
const { runDreamCommand } = require("../scripts/stmem-dream");

test("internal dream command requires an explicit thread and date", () => {
  assert.throws(() => runDreamCommand([], {
    serviceFactory() {
      throw new Error("must not construct service");
    },
  }), /--thread/);
  assert.throws(() => runDreamCommand(["--thread", "thread-test"], {
    serviceFactory() {
      throw new Error("must not construct service");
    },
  }), /--date/);
});

test("internal dream command delegates one formal write to the dream service", () => {
  const calls = [];
  const lines = [];
  const result = runDreamCommand([
    "--thread",
    "thread-test",
    "--date",
    "2026-07-29",
  ], {
    serviceFactory() {
      return {
        generate(input) {
          calls.push(input);
          return {
            status: "completed",
            dream: {
              threadId: input.threadId,
              date: input.date,
              dreamType: "beautiful",
              title: "fixture",
              body: "fixture body",
            },
          };
        },
      };
    },
    writeLine(line) {
      lines.push(line);
    },
  });

  assert.deepEqual(calls, [{ threadId: "thread-test", date: "2026-07-29" }]);
  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(lines[0]), {
    status: "completed",
    threadId: "thread-test",
    date: "2026-07-29",
    dreamType: "beautiful",
  });
});
