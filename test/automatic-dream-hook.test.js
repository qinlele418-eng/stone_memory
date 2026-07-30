const test = require("node:test");
const assert = require("node:assert/strict");
const {
  runAutomaticDream,
  shouldRunAutomaticDream,
} = require("../src/services/automatic-dream-hook");

test("automatic dream runs once only for yesterday's normal completed mining", () => {
  const calls = [];
  const result = runAutomaticDream({
    threadId: "thread-test",
    date: "2026-07-29",
    today: "2026-07-30",
    force: false,
    cliPath: "/project/bin/stmem",
    execFileSync(file, args, options) {
      calls.push({ file, args, options });
      return '{"status":"completed"}\n';
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    "/project/bin/stmem",
    "dream",
    "--thread",
    "thread-test",
    "--date",
    "2026-07-29",
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("automatic dream skips backlog mining and forced remine", () => {
  assert.equal(shouldRunAutomaticDream({
    date: "2026-07-28",
    today: "2026-07-30",
    force: false,
  }), false);
  assert.equal(shouldRunAutomaticDream({
    date: "2026-07-29",
    today: "2026-07-30",
    force: true,
  }), false);
});

test("automatic dream reports one failed attempt without retrying", () => {
  let calls = 0;
  const result = runAutomaticDream({
    threadId: "thread-test",
    date: "2026-07-29",
    today: "2026-07-30",
    force: false,
    cliPath: "/project/bin/stmem",
    execFileSync() {
      calls++;
      throw new Error("subagent unavailable");
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.attempted, true);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /subagent unavailable/);
});
