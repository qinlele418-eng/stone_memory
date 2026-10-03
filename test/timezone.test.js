"use strict";

// TASK-0400：timezone 成为 memory 级配置。
// ① 缺省 Asia/Shanghai 与旧 +08:00 硬编码逐字节兼容；② 统一解析入口 + 非法值 fail-closed 留痕；
// ③ archive 日切分 / feelings 时间戳 / web 显示在跨时区配置下三处一致。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// src/config.js 在 require 时固化 CONFIG_PATH —— 必须先重定向 HOME 再加载源码。
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-timezone-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const {
  DEFAULT_TIMEZONE, isValidTimeZone, resolveMemoryTimezone,
  zonedDateKey, zonedWallTime, wallTimeToUtc, shiftDateKey,
} = require("../src/services/timezone");
const { dateKeyFromTs, MemoryArchive } = require("../src/services/memory-archive");
const { beijingDateKey, ingestMessages } = require("../src/services/thread-ingest");
const { feelingToUtc } = require("../src/services/thread-rebuilder");
const { feelingEventTime } = require("../src/services/memory-miner");
const { localDateKey, memoryGrowthDays } = require("../src/web/server");
const frontendLogic = require("../src/web/public/developer-modules/stone-memory-assistant/logic");

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

const STONE_ROOT = path.join(home, ".stone_memory");

function registerMemory(memoryId, { timezone = null, legacy = false } = {}) {
  fs.mkdirSync(STONE_ROOT, { recursive: true });
  const stmemFile = path.join(STONE_ROOT, "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  if (legacy) {
    config[memoryId] = { runtime: "codex", purpose: "accompany", ai: "小鱼", user: "旭乐", timezone: timezone || undefined };
  } else {
    config.memories = config.memories || {};
    config.memories[memoryId] = { memoryId, label: memoryId, status: "active", createdAt: "2026-01-01T00:00:00.000Z" };
  }
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");

  if (!legacy) {
    const root = path.join(STONE_ROOT, "memories", memoryId);
    fs.mkdirSync(path.join(root, "memory"), { recursive: true });
    fs.writeFileSync(path.join(root, ".layout-v1.json"), JSON.stringify({
      schemaVersion: 1, status: "complete", memoryId, origin: "created", completedAt: "2026-01-01T00:00:00.000Z",
    }), "utf8");
    fs.writeFileSync(path.join(root, "memory.json"), JSON.stringify({
      schemaVersion: 1, memoryId, label: memoryId, status: "active",
      ...(timezone ? { timezone } : {}),
    }), "utf8");
    fs.writeFileSync(path.join(root, "bindings.json"), JSON.stringify({ schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] }), "utf8");
    fs.writeFileSync(path.join(root, "watcher.json"), JSON.stringify({ schemaVersion: 1, enabled: false, modules: {} }), "utf8");
    return path.join(root, "memory");
  }
  return path.join(STONE_ROOT, "runtimes", "codex", "accompany", memoryId, "memory");
}

function captureWarnings(callback) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  try { return { result: callback(), lines }; }
  finally { console.warn = original; }
}

// ---- ① 缺省行为与旧 +08:00 硬编码逐字节一致 ----

test("缺省时区为 Asia/Shanghai，且日键在旧 +08:00 边界逐字节一致", () => {
  assert.equal(DEFAULT_TIMEZONE, "Asia/Shanghai");
  assert.equal(resolveMemoryTimezone("unconfigured-thread"), "Asia/Shanghai");
  // 16:00Z 是 +08:00 的日切点：之前算当天，之后算次日
  assert.equal(zonedDateKey("2026-06-17T15:59:59.000Z"), "2026-06-17");
  assert.equal(zonedDateKey("2026-06-17T16:00:00.000Z"), "2026-06-18");
  assert.equal(dateKeyFromTs("2026-06-17T15:59:59.000Z"), "2026-06-17");
  assert.equal(dateKeyFromTs("2026-06-17T16:00:00.000Z"), "2026-06-18");
  assert.equal(beijingDateKey("2026-06-17T16:00:00.000Z"), "2026-06-18");
  assert.equal(dateKeyFromTs("not-a-timestamp"), null);
});

test("缺省时区下 feelings 墙上时间 → UTC 与旧 +08:00 公式逐字节一致", () => {
  // 旧：new Date(`${date}T${hh}:${mm}:00.000+08:00`).toISOString()
  assert.equal(feelingToUtc({ date: "2026-05-01", hour: 20, minute: 30 }), "2026-05-01T12:30:00.000Z");
  assert.equal(feelingToUtc({ date: "2026-05-01", hour: 0, minute: 0 }), "2026-04-30T16:00:00.000Z");
  assert.equal(feelingToUtc({ date: "2026-05-01", hour: null, minute: 0 }), null);
  // miner 正午兜底时间戳：旧 `${date}T12:00:${ss}+08:00`
  assert.equal(wallTimeToUtc("2026-05-01", 12, 0, DEFAULT_TIMEZONE, 7), new Date("2026-05-01T12:00:07+08:00").toISOString());
  assert.equal(feelingEventTime({ content: "5月1日，晚上8点半散步" }, "2026-05-01"), "2026-05-01T12:30:00.000Z");
  assert.equal(feelingEventTime({ content: "没有时间信息" }, "2026-05-01"), null);
});

test("墙上时间往返一致：任一时区下 UTC → 墙上 → UTC 恢复原值", () => {
  for (const zone of [DEFAULT_TIMEZONE, "UTC", "America/New_York", "Asia/Kolkata", "Europe/Berlin"]) {
    for (const instant of ["2026-01-15T04:30:00.000Z", "2026-07-15T23:10:00.000Z", "2026-03-08T07:30:00.000Z"]) {
      const wall = zonedWallTime(instant, zone);
      assert.equal(wallTimeToUtc(wall.date, wall.hour, wall.minute, zone), instant, `${zone} ${instant}`);
    }
  }
});

test("isValidTimeZone 接受 IANA/UTC，拒绝垃圾值", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
});

// ---- ② fail-closed：非法配置回默认并留痕 ----

test("非法时区 fail-closed 回默认，并只告警一次", () => {
  const memoryDir = registerMemory("bad-zone-memory", { timezone: "Mars/Olympus" });
  assert.equal(path.basename(path.dirname(memoryDir)), "bad-zone-memory", "fixture sanity");
  const { result, lines } = captureWarnings(() => resolveMemoryTimezone("bad-zone-memory"));
  assert.equal(result, "Asia/Shanghai");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Mars\/Olympus/);
  assert.match(lines[0], /bad-zone-memory/);
  // 同一记忆体同一非法值不重复告警
  const { lines: second } = captureWarnings(() => resolveMemoryTimezone("bad-zone-memory"));
  assert.equal(second.length, 0);
});

test("非字符串与时区配置为空时回默认", () => {
  registerMemory("numeric-zone", { timezone: 8 });
  assert.equal(resolveMemoryTimezone("numeric-zone"), "Asia/Shanghai");
  registerMemory("blank-zone", { timezone: "   " });
  assert.equal(resolveMemoryTimezone("blank-zone"), "Asia/Shanghai");
});

// ---- ③ 跨时区配置：archive 日切分 / feelings 时间戳 / web 显示三处一致 ----

test("archive 日切分跟随记忆体时区（memory-v1 + 旧布局）", () => {
  const nyDir = registerMemory("ny-memory", { timezone: "America/New_York" });
  const shDir = registerMemory("sh-memory", { timezone: "Asia/Shanghai" });
  const legacyDir = registerMemory("legacy-kolkata", { timezone: "Asia/Kolkata", legacy: true });

  // 2026-01-01T04:30Z = 纽约 2025-12-31 23:30（EST）= 上海 2026-01-01 12:30 = 加尔各答 10:00
  const ts = "2026-01-01T04:30:00.000Z";
  assert.equal(dateKeyFromTs(ts, "America/New_York"), "2025-12-31");
  assert.equal(dateKeyFromTs(ts, "Asia/Shanghai"), "2026-01-01");
  assert.equal(dateKeyFromTs(ts, "Asia/Kolkata"), "2026-01-01");
  assert.equal(resolveMemoryTimezone("ny-memory"), "America/New_York");
  assert.equal(resolveMemoryTimezone("legacy-kolkata"), "Asia/Kolkata");

  const nyArchive = new MemoryArchive(nyDir, { threadId: "ny-memory" });
  const shArchive = new MemoryArchive(shDir, { threadId: "sh-memory" });
  try {
    nyArchive.archiveMessage({ timestamp: ts, type: "user", text: "跨年夜前的最后一句" });
    shArchive.archiveMessage({ timestamp: ts, type: "user", text: "跨年夜前的最后一句" });
    const nyDay = nyArchive.readDay("2025-12-31");
    const shDay = shArchive.readDay("2026-01-01");
    assert.equal(nyDay.length, 1, "NY 配置下消息落入 12-31");
    assert.equal(shDay.length, 1, "上海配置下同一条消息落入 01-01");
    assert.equal(nyDay[0].sourceDate, "2025-12-31");
    assert.equal(shDay[0].sourceDate, "2026-01-01");
  } finally {
    nyArchive.close();
    shArchive.close();
  }
  void legacyDir; // 旧布局解析已由 resolveMemoryTimezone 断言覆盖
});

test("ingest 日切分跟随 memoryStore 的记忆体时区", () => {
  const memoryDir = registerMemory("ingest-tz-memory", { timezone: "America/New_York" });
  const { MemoryStore } = require("../src/storage/memory-store");
  const store = new MemoryStore({ memoryDir, threadId: "ingest-tz-memory" });
  try {
    const result = ingestMessages([
      { type: "user", timestamp: "2026-01-01T03:50:00.000Z", message: { role: "user", content: "纽约还没跨年" } },
      { type: "assistant", timestamp: "2026-01-01T05:10:00.000Z", message: { role: "assistant", content: "纽约已经跨年" } },
    ].map(row => ({ type: row.type, timestamp: row.timestamp, message: row.message, text: row.message.content })), { memoryStore: store });
    void result;
    const days = store.db.prepare("SELECT source_date, COUNT(*) n FROM messages WHERE thread_id=? GROUP BY source_date ORDER BY source_date").all("ingest-tz-memory");
    assert.deepEqual(days, [
      { source_date: "2025-12-31", n: 1 },
      { source_date: "2026-01-01", n: 1 },
    ]);
  } finally { store.close(); }
});

test("feelings 时间戳在跨时区配置下与 archive 日键一致", () => {
  // 同一墙上时间在不同配置下得到不同 UTC，但换算回当地墙上时间/日键必然吻合
  for (const zone of ["America/New_York", "Asia/Shanghai", "Asia/Kolkata"]) {
    const utc = feelingToUtc({ date: "2026-08-14", hour: 23, minute: 30 }, zone);
    const wall = zonedWallTime(utc, zone);
    assert.deepEqual([wall.date, wall.hour, wall.minute], ["2026-08-14", 23, 30], zone);
    assert.equal(dateKeyFromTs(utc, zone), "2026-08-14", `${zone} 日键与 feelings 墙上日期一致`);
  }
  // 纽约 8 月为夏令时（EDT = -4）：23:30 墙上时间 → 次日 03:30Z
  assert.equal(feelingToUtc({ date: "2026-08-14", hour: 23, minute: 30 }, "America/New_York"), "2026-08-15T03:30:00.000Z");
  // 冬令时 EST = -5
  assert.equal(feelingToUtc({ date: "2026-01-01", hour: 20, minute: 30 }, "America/New_York"), "2026-01-02T01:30:00.000Z");
});

test("web 显示：服务端日键、增长天数与前端格式化在同一时区下一致", () => {
  const instant = new Date("2026-08-14T16:30:00.000Z");
  for (const zone of ["America/New_York", "Asia/Shanghai", "UTC"]) {
    assert.equal(localDateKey(instant, zone), zonedDateKey(instant, zone), `server localDateKey == zonedDateKey (${zone})`);
    // 前端小助理模块的日键（通过 window 注入的展示时区）
    globalThis.window = { stmemDisplayTimezone: () => zone };
    try {
      assert.equal(frontendLogic.beijingDateKey(instant.toISOString()), zonedDateKey(instant, zone), `frontend day key (${zone})`);
      assert.equal(frontendLogic.displayTimeZone(), zone);
    } finally { delete globalThis.window; }
    // 前端无法取得注入时（Node 直连）回退 UTC，不再内嵌任何硬编码时区
    assert.equal(frontendLogic.beijingDateKey(instant.toISOString()), zonedDateKey(instant, "UTC"));
  }
  // 首页"今天"的起点随配置移动：上海今天 00:00 与纽约今天 00:00 是不同 UTC 时刻
  const shanghaiToday = zonedDateKey(Date.now(), "Asia/Shanghai");
  const nyToday = zonedDateKey(Date.now(), "America/New_York");
  const shanghaiStart = wallTimeToUtc(shanghaiToday, 0, 0, "Asia/Shanghai");
  const nyStart = wallTimeToUtc(nyToday, 0, 0, "America/New_York");
  assert.equal(zonedWallTime(shanghaiStart, "Asia/Shanghai").minute, 0);
  assert.notEqual(shanghaiStart, nyStart);
  // 增长天数是纯日差，与时区锚点无关（与既有 web-server 测试同参数）
  assert.equal(memoryGrowthDays("2026-04-15T01:30:11.034Z", "2026-04-15", "2026-09-19"), 158);
  assert.equal(memoryGrowthDays(null, null, "2026-09-19"), 0);
});

test("日期键平移工具与旧 _yesterday 公式一致", () => {
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDateKey("2027-03-01", -1), "2027-02-28");
  assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDateKey("bad", -1), null);
});

test("memory settings 写入路径接受合法时区、清空回默认、拒绝非法值", () => {
  const { validateMemorySettings } = require("../src/services/memory-setup");
  const current = {
    schemaVersion: 1, memoryId: "m1", label: "m", status: "active",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const next = validateMemorySettings(current, { timezone: "America/New_York" });
  assert.equal(next.timezone, "America/New_York");
  const cleared = validateMemorySettings({ ...next }, { timezone: "" });
  assert.equal(cleared.timezone, null);
  assert.throws(() => validateMemorySettings(current, { timezone: "Mars/Olympus" }), /IANA/);
});
