const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// TASK-0422：usage 遥测存储 + stmem usage 读写面。隔离 HOME，不读写任何真实记忆体。
const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-usage-tel-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { reportUsage, readUsageTelemetry, usageTelemetrySummary, telemetryFile, MAX_SESSIONS_PER_SOURCE } = require("../src/services/usage-telemetry");

const MEMORY_ID = "t-pando-tel";
const CLAUDE_MEMORY_ID = "t-claude-tel";
const SESSION = "9f1d2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";

saveConfigForTest({
  [MEMORY_ID]: { label: "Pando 遥测记忆", runtime: "pando", externalThreadId: "pando", ai: "AI", user: "用户", purpose: "accompany", minerMode: "subagent" },
  [CLAUDE_MEMORY_ID]: { label: "Claude 遥测记忆", runtime: "claude", threadId: CLAUDE_MEMORY_ID, ai: "AI", user: "用户", purpose: "accompany", minerMode: "subagent" },
});

function saveConfigForTest(config) {
  const file = path.join(home, ".stone_memory", "stmem.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config), "utf8");
}

const memoryRoot = path.join(home, ".stone_memory", "runtimes", "pando", "accompany", MEMORY_ID);

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function runCli(args, extra = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    ...extra,
  });
}

function spawnCliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = "", err = "";
    child.stdout.on("data", data => { out += data; });
    child.stderr.on("data", data => { err += data; });
    child.on("close", code => resolve({ code, out, err }));
    child.on("error", reject);
  });
}

test("T1: report 写入按 source 分桶，字段含 source/session/最近活动时间(UTC+时区口径)/分类计数", () => {
  const result = reportUsage({ memoryId: MEMORY_ID, source: "pando", session: SESSION, kind: "search", at: "2026-10-07T09:00:00Z" });
  assert.equal(result.applied, true);
  assert.equal(result.record.source, "pando");
  assert.equal(result.record.lastSessionId, SESSION);
  assert.equal(result.record.lastActivityAt, "2026-10-07T09:00:00.000Z");
  assert.deepEqual(result.record.counts, { search: 1, ingest: 0, other: 0 });
  assert.equal(result.record.total, 1);
  // 时区口径：UTC 事实 + 记忆体时区（缺省 Asia/Shanghai）的本地时间与偏移。
  assert.equal(result.record.timezone, "Asia/Shanghai");
  assert.equal(result.record.lastActivityLocal, "2026-10-07 17:00");
  assert.equal(result.record.utcOffset, "+08:00");
  // 单文件位于记忆体 logs/ 下。
  const file = path.join(memoryRoot, "logs", "usage-telemetry.json");
  assert.equal(telemetryFile(MEMORY_ID), file);
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(raw.sources.pando);
});

test("R1: 遥测只写 logs/，不进记忆内容面（不创建 memory/archive、不写线程文件）", () => {
  assert.ok(fs.existsSync(path.join(memoryRoot, "logs", "usage-telemetry.json")));
  assert.equal(fs.existsSync(path.join(memoryRoot, "memory")), false);
  assert.equal(fs.existsSync(path.join(memoryRoot, "thread.jsonl")), false);
  // 没有 sessionDir 配置写入。
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(config[MEMORY_ID].sessionDir, undefined);
});

test("T1: 同 (session, kind, at) 重复上报幂等，不重复计数", () => {
  const first = reportUsage({ memoryId: MEMORY_ID, source: "pando", session: SESSION, kind: "ingest", at: "2026-10-07T09:05:00Z" });
  assert.equal(first.applied, true);
  const repeat = reportUsage({ memoryId: MEMORY_ID, source: "pando", session: SESSION, kind: "ingest", at: "2026-10-07T09:05:00Z" });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.deduped, true);
  assert.equal(repeat.record.counts.ingest, 1);
  assert.equal(repeat.record.total, 2); // search 1 + ingest 1，重试未加成
  const again = reportUsage({ memoryId: MEMORY_ID, source: "pando", session: SESSION, kind: "ingest", at: "2026-10-07T09:05:00Z" });
  assert.equal(again.record.counts.ingest, 1);
  assert.equal(again.record.total, 2);
});

test("T2: show 输出 JSON 字段稳定可测；--source 过滤生效", () => {
  const shown = runCli(["usage", "show", "--memory", MEMORY_ID, "--source", "pando"]);
  assert.equal(shown.status, 0, shown.stderr);
  const payload = JSON.parse(shown.stdout);
  assert.equal(payload.memoryId, MEMORY_ID);
  assert.equal(payload.available, true);
  assert.equal(payload.reason, null);
  assert.match(payload.file, /usage-telemetry\.json$/);
  const record = payload.sources.pando;
  assert.deepEqual(Object.keys(record).sort(), ["counts", "lastActivityAt", "lastActivityLocal", "lastKind", "lastSessionId", "source", "timezone", "total", "utcOffset", "sessionCount", "sessions"].sort());
  assert.equal(record.total, 2);
  assert.equal(record.sessionCount, 1);
  assert.equal(record.sessions[0].sessionId, SESSION);
  // 全量 show（无 --source）同样可用。
  const all = JSON.parse(runCli(["usage", "show", "--memory", MEMORY_ID]).stdout);
  assert.ok(all.sources.pando);
});

test("T2: --help 文案如实（report 唯一写入口 + 有界策略）", () => {
  const help = runCli(["usage", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage report --memory <id> --source pando --session <id>/);
  assert.match(help.stdout, /usage show --memory <id> \[--source pando\]/);
  assert.match(help.stdout, /唯一写入口/);
  assert.match(help.stdout, /幂等/);
  assert.match(help.stdout, /不写入 archive\/feelings\/full/);
  // 顶层帮助也列出 usage。
  const topHelp = runCli(["--help"]);
  assert.match(topHelp.stdout, /stmem usage report/);
});

test("T4: report 对非法参数 fail-closed，错误可读，退出码非 0", () => {
  const badKind = runCli(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "s1", "--kind", "nope"]);
  assert.notEqual(badKind.status, 0);
  assert.match(badKind.stderr, /--kind 非法/);
  const emptySession = runCli(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", ""]);
  assert.notEqual(emptySession.status, 0);
  assert.match(emptySession.stderr, /--session 非法/);
  const badSource = runCli(["usage", "report", "--memory", MEMORY_ID, "--source", "PANDO!", "--session", "s1"]);
  assert.notEqual(badSource.status, 0);
  assert.match(badSource.stderr, /--source 非法/);
  const badAt = runCli(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "s1", "--at", "not-a-date"]);
  assert.notEqual(badAt.status, 0);
  assert.match(badAt.stderr, /--at 非法/);
  const unknownMemory = runCli(["usage", "report", "--memory", "no-such-mem", "--source", "pando", "--session", "s1"]);
  assert.notEqual(unknownMemory.status, 0);
  assert.match(unknownMemory.stderr, /记忆体不存在/);
  const unknownShow = runCli(["usage", "show", "--memory", "no-such-mem"]);
  assert.notEqual(unknownShow.status, 0);
  assert.match(unknownShow.stderr, /记忆体不存在/);
  const unknownAction = runCli(["usage", "frobnicate"]);
  assert.notEqual(unknownAction.status, 0);
});

test("T5: 双进程并发 report 不损坏文件，计数正确合并", async () => {
  const runs = await Promise.all([
    spawnCliAsync(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "conc-a", "--kind", "search", "--at", "2026-10-07T11:00:00Z"]),
    spawnCliAsync(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "conc-b", "--kind", "ingest", "--at", "2026-10-07T11:00:01Z"]),
    spawnCliAsync(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "conc-c", "--kind", "other", "--at", "2026-10-07T11:00:02Z"]),
    spawnCliAsync(["usage", "report", "--memory", MEMORY_ID, "--source", "pando", "--session", "conc-d", "--kind", "search", "--at", "2026-10-07T11:00:03Z"]),
  ]);
  for (const run of runs) assert.equal(run.code, 0, run.err);
  const file = path.join(memoryRoot, "logs", "usage-telemetry.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")); // 不损坏：合法 JSON
  const record = raw.sources.pando;
  // 前序用例已写入 search 1 + ingest 1（SESSION 桶）。
  assert.equal(record.counts.search, 3);
  assert.equal(record.counts.ingest, 2);
  assert.equal(record.counts.other, 1);
  // 前序用例累计 2（search+ingest 各 1）+ 并发 4 = 6。
  const summary = readUsageTelemetry(MEMORY_ID);
  assert.equal(summary.sources.pando.total, 6);
  assert.equal(Object.keys(summary.sources.pando.sessions).length, 5);
  // 锁目录已清理，不残留。
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("T1: 单文件有界——session 桶按最近活动截断，聚合计数不丢", () => {
  for (let i = 0; i < 60; i += 1) {
    reportUsage({ memoryId: CLAUDE_MEMORY_ID, source: "pando", session: `bulk-${String(i).padStart(2, "0")}`, kind: "other", at: `2026-10-06T10:00:${String(i % 60).padStart(2, "0")}Z` });
  }
  const summary = usageTelemetrySummary(CLAUDE_MEMORY_ID, { source: "pando" });
  assert.equal(summary.available, true);
  const record = summary.sources.pando;
  assert.ok(record.sessionCount <= MAX_SESSIONS_PER_SOURCE, `session 桶应截断到 ${MAX_SESSIONS_PER_SOURCE}`);
  assert.equal(record.sessionCount, MAX_SESSIONS_PER_SOURCE);
  assert.equal(record.total, 60); // 聚合计数不因截断丢失
  // 保留的是最近的 session，最旧的被淘汰。
  assert.equal(record.sessions.some(item => item.sessionId === "bulk-59"), true);
  assert.equal(record.sessions.some(item => item.sessionId === "bulk-00"), false);
  const file = path.join(home, ".stone_memory", "runtimes", "claude", "accompany", CLAUDE_MEMORY_ID, "logs", "usage-telemetry.json");
  assert.ok(fs.statSync(file).size < 64 * 1024);
});

test("T4: 遥测文件缺失/损坏 fail-soft（读不抛错，reason 如实）；report 遇损坏可恢复写入", () => {
  const file = telemetryFile(MEMORY_ID);
  fs.rmSync(file, { force: true });
  const missing = readUsageTelemetry(MEMORY_ID);
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "missing");
  const missingSummary = usageTelemetrySummary(MEMORY_ID, { source: "pando" });
  assert.equal(missingSummary.available, false);
  assert.equal(missingSummary.reason, "missing");
  const missingShow = runCli(["usage", "show", "--memory", MEMORY_ID, "--source", "pando"]);
  assert.equal(missingShow.status, 0);
  assert.equal(JSON.parse(missingShow.stdout).reason, "missing");

  fs.writeFileSync(file, "{oops 不是 JSON", "utf8");
  const corrupt = readUsageTelemetry(MEMORY_ID);
  assert.equal(corrupt.available, false);
  assert.equal(corrupt.reason, "corrupt");
  const corruptShow = runCli(["usage", "show", "--memory", MEMORY_ID, "--source", "pando"]);
  assert.equal(corruptShow.status, 0);
  assert.equal(JSON.parse(corruptShow.stdout).reason, "corrupt");

  const recovered = reportUsage({ memoryId: MEMORY_ID, source: "pando", session: "after-corrupt", kind: "search", at: "2026-10-07T12:00:00Z" });
  assert.equal(recovered.applied, true);
  assert.equal(recovered.record.total, 1);
});
