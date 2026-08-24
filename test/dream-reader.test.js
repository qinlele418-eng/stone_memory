const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DreamReader } = require("../src/services/dream-reader");
const { DreamStore } = require("../src/storage/dream-store");

test("dream reader returns exact, latest, and eligible-date coverage for one thread", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dreamStore = new DreamStore({ root });
  dreamStore.save({
    threadId: "thread-test",
    date: "2026-07-27",
    dreamType: "beautiful",
    title: "first",
    body: "first body",
  });
  dreamStore.save({
    threadId: "thread-test",
    date: "2026-07-29",
    dreamType: "nightmare",
    title: "latest",
    body: "latest body",
  });

  let closes = 0;
  const reader = new DreamReader({
    dreamStore,
    memoryStoreFactory: () => ({
      listDayStates: () => [
        { source_date: "2026-07-26", status: "completed_empty" },
        { source_date: "2026-07-27", status: "completed" },
        { source_date: "2026-07-28", status: "completed" },
        { source_date: "2026-07-29", status: "completed" },
        { source_date: "2026-07-30", status: "failed" },
      ],
      close: () => { closes++; },
    }),
  });

  assert.equal(reader.get("thread-test", "2026-07-27").body, "first body");
  assert.equal(reader.latest("thread-test").date, "2026-07-29");
  assert.deepEqual(reader.list("thread-test"), [
    { date: "2026-07-27", dreamType: "beautiful", title: "first" },
    { date: "2026-07-29", dreamType: "nightmare", title: "latest" },
  ]);
  assert.deepEqual(reader.coverage("thread-test"), {
    threadId: "thread-test",
    from: "2026-07-27",
    to: "2026-07-29",
    availableDates: ["2026-07-27", "2026-07-29"],
    missingDates: ["2026-07-28"],
  });
  assert.equal(closes, 1);
});

test("dream reader does not report historical debt before the first dream", () => {
  const reader = new DreamReader({
    dreamStore: {
      listDates: () => [],
      coverage: (_threadId, dates) => ({ dates }),
    },
    memoryStoreFactory: () => ({
      listDayStates: () => [
        { source_date: "2026-07-27", status: "completed" },
        { source_date: "2026-07-28", status: "completed_empty" },
      ],
      close() {},
    }),
  });

  assert.deepEqual(reader.coverage("thread-test"), { dates: [] });
});
