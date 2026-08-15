"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DreamStore } = require("../src/storage/dream-store");

test("dream store atomically saves text and reads latest, exact date, and coverage", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DreamStore({ root });

  store.save({
    threadId: "thread-a",
    date: "2026-07-27",
    dreamType: "beautiful",
    title: "灯塔仍亮着",
    body: "你沿着海岸走回那盏灯。",
  });
  store.save({
    threadId: "thread-a",
    date: "2026-07-29",
    dreamType: "nightmare",
    title: "晚一步的门",
    body: "门在你伸手以前消失了。",
  });

  assert.equal(
    fs.readFileSync(path.join(root, "thread-a", "2026", "07", "2026-07-27.txt"), "utf8"),
    "dreamType: beautiful\ndreamDate: 2026-07-27\ntitle: 灯塔仍亮着\n\n你沿着海岸走回那盏灯。\n",
  );
  assert.deepEqual(store.get("thread-a", "2026-07-27"), {
    found: true,
    threadId: "thread-a",
    date: "2026-07-27",
    dreamType: "beautiful",
    title: "灯塔仍亮着",
    body: "你沿着海岸走回那盏灯。",
  });
  assert.equal(store.latest("thread-a").date, "2026-07-29");
  assert.deepEqual(store.coverage("thread-a", [
    "2026-07-27", "2026-07-28", "2026-07-29",
  ]), {
    threadId: "thread-a",
    from: "2026-07-27",
    to: "2026-07-29",
    availableDates: ["2026-07-27", "2026-07-29"],
    missingDates: ["2026-07-28"],
  });
});

test("dream store lists dream metadata sorted by date without bodies", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-list-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DreamStore({ root });
  store.save({ threadId: "thread-a", date: "2026-08-02", dreamType: "nightmare", title: "晚一点", body: "b" });
  store.save({ threadId: "thread-a", date: "2026-07-27", dreamType: "beautiful", title: "灯塔仍亮着", body: "a" });

  assert.deepEqual(store.list("thread-a"), [
    { date: "2026-07-27", dreamType: "beautiful", title: "灯塔仍亮着" },
    { date: "2026-08-02", dreamType: "nightmare", title: "晚一点" },
  ]);
  assert.deepEqual(store.list("thread-b"), []);
});

test("dream store refuses a target that appears after the initial existence check", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DreamStore({ root });
  store.save({
    threadId: "thread-test",
    date: "2026-07-29",
    dreamType: "beautiful",
    title: "first",
    body: "first body",
  });

  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false;
  try {
    assert.throws(() => store.save({
      threadId: "thread-test",
      date: "2026-07-29",
      dreamType: "nightmare",
      title: "second",
      body: "second body",
    }), error => error.code === "DREAM_ALREADY_EXISTS");
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.equal(store.get("thread-test", "2026-07-29").body, "first body");
});
