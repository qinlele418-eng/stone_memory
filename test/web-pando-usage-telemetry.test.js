const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// TASK-0422：Stone Web pando 记忆体『当前窗口』区的 usage 遥测呈现。
// 隔离 HOME，不读写任何真实记忆体；0421 的『不适用』基线保持，claude/codex 显示零变化。
const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-usage-tel-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { startWebServer } = require("../src/web/server");

const PANDO_ID = "t-pando-web-tel";
const CLAUDE_ID = "t-claude-web-tel";
const SESSION = "9f1d2a3b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";

fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({
  [PANDO_ID]: { label: "Pando 遥测记忆", runtime: "pando", externalThreadId: "pando", ai: "AI", user: "用户", purpose: "accompany", minerMode: "subagent" },
  [CLAUDE_ID]: { label: "Claude 对照记忆", runtime: "claude", threadId: CLAUDE_ID, ai: "AI", user: "用户", purpose: "accompany", minerMode: "subagent" },
}), "utf8");

const pandoRoot = path.join(home, ".stone_memory", "runtimes", "pando", "accompany", PANDO_ID);
const telemetryFileOf = () => path.join(pandoRoot, "logs", "usage-telemetry.json");

function reportViaCli(args) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), "usage", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function request(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("T3/T4: pando 总览 overview 无遥测时如实 available:false（reason missing），页面数据不 500", async () => {
  await withServer(async port => {
    const response = await request(port, "GET", `/api/libraries/${PANDO_ID}/overview`);
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.usageTelemetry.available, false);
    assert.equal(payload.usageTelemetry.reason, "missing");
    assert.deepEqual(payload.usageTelemetry.sources, {});
  });
});

test("T3: stmem usage report 后，pando overview 携带真实遥测事实", async () => {
  const report = reportViaCli(["report", "--memory", PANDO_ID, "--source", "pando", "--session", SESSION, "--kind", "search", "--at", "2026-10-07T09:00:00Z"]);
  assert.equal(report.status, 0, report.stderr);
  reportViaCli(["report", "--memory", PANDO_ID, "--source", "pando", "--session", SESSION, "--kind", "ingest", "--at", "2026-10-07T09:30:00Z"]);
  await withServer(async port => {
    const response = await request(port, "GET", `/api/libraries/${PANDO_ID}/overview`);
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    const record = payload.usageTelemetry.sources.pando;
    assert.equal(payload.usageTelemetry.available, true);
    assert.equal(record.source, "pando");
    assert.equal(record.lastSessionId, SESSION);
    assert.equal(record.lastActivityAt, "2026-10-07T09:30:00.000Z");
    assert.equal(record.lastActivityLocal, "2026-10-07 17:30");
    assert.equal(record.utcOffset, "+08:00");
    assert.equal(record.timezone, "Asia/Shanghai");
    assert.deepEqual(record.counts, { search: 1, ingest: 1, other: 0 });
    assert.equal(record.total, 2);
    // 不伪造线程文件口径的占用百分比：遥测面没有 percent/maxTokens 字段。
    assert.equal("percent" in record, false);
  });
});

test("T4: 遥测文件损坏时 overview 仍 200，fail-soft 降级 reason=corrupt", async () => {
  fs.mkdirSync(path.dirname(telemetryFileOf()), { recursive: true });
  fs.writeFileSync(telemetryFileOf(), "{oops 损坏", "utf8");
  await withServer(async port => {
    const response = await request(port, "GET", `/api/libraries/${PANDO_ID}/overview`);
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.usageTelemetry.available, false);
    assert.equal(payload.usageTelemetry.reason, "corrupt");
  });
});

test("T3: claude/codex 记忆体 overview 不携带 usageTelemetry 键（显示零变化）", async () => {
  await withServer(async port => {
    const response = await request(port, "GET", `/api/libraries/${CLAUDE_ID}/overview`);
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal("usageTelemetry" in payload, false);
    assert.equal(payload.runtime, "claude");
  });
});

test("T3: 前端 pando 分支渲染遥测事实行，无遥测渲染『暂无 Pando 活动记录』，不伪造占用百分比", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /function pandoUsageTelemetryLine\(telemetry\)/);
  assert.match(app, /function shortSessionId\(value\)/);
  assert.match(app, /暂无 Pando 活动记录/);
  // pando 分支：遥测行 + 0421『不适用』基线并存。
  const branchStart = app.indexOf("const threadUsageBody=pandoMode");
  const branchEnd = app.indexOf(":`<div class=\"context-usage\">", branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  const pandoBranch = app.slice(branchStart, branchEnd);
  assert.match(pandoBranch, /pandoUsageTelemetryLine\(data\.usageTelemetry\)/);
  assert.match(pandoBranch, /线程文件口径的窗口占用数据不可用/);
  // pando 分支不得出现线程文件口径的占用进度条/百分比计算。
  assert.doesNotMatch(pandoBranch, /usagePercent|aria-valuenow|contextUsageHint/);
  // claude/codex 分支维持原口径：进度条与 hint 原样保留。
  const claudeBranch = app.slice(branchEnd, app.indexOf("const threadInjectionBody=pandoMode"));
  assert.match(claudeBranch, /role="progressbar"/);
  assert.match(claudeBranch, /contextUsageHint\(usage,data\.automaticFullMining\)/);
  // session 短标识：超过 12 位截短加省略号（脱敏/短形）。
  assert.match(app, /id\.length > 12 \? `\$\{id\.slice\(0, 8\)\}…` : id/);
});

test("T3: styles 提供 pando-usage-telemetry 样式（遥测事实行）", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "styles.css"), "utf8");
  assert.match(styles, /\.pando-usage-telemetry \{/);
  assert.match(styles, /\.pando-usage-telemetry\.empty \{/);
});

test("T3: 真实 app.js 渲染函数对 overview 载荷求值——有遥测显示事实，无遥测显示『暂无』", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  const escapeHtml = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const shortFn = app.slice(app.indexOf("function shortSessionId"), app.indexOf("function pandoUsageTelemetryLine"));
  const lineFn = app.slice(app.indexOf("function pandoUsageTelemetryLine"), app.indexOf("function showToast"));
  assert.ok(shortFn && lineFn);
  const formatBeijingTime = () => "2026-10-07 17:50";
  eval(shortFn + lineFn);
  // overview 载荷口径：available:true + sources.pando 记录。
  const withTelemetry = pandoUsageTelemetryLine({
    file: "/x/logs/usage-telemetry.json", available: true, reason: null,
    sources: { pando: { source: "pando", lastSessionId: "0199f1d2-a3b4-7c5d-8e6f-9a0b1c2d3e4f", lastActivityAt: "2026-10-07T09:50:00.000Z", timezone: "Asia/Shanghai", utcOffset: "+08:00", counts: { search: 2, ingest: 1, other: 0 }, total: 3 } },
  });
  assert.match(withTelemetry, /最近活跃会话 <code title="0199f1d2-a3b4-7c5d-8e6f-9a0b1c2d3e4f">0199f1d2…<\/code>/);
  assert.match(withTelemetry, /最近活动 2026-10-07 17:50（Asia\/Shanghai \+08:00）/);
  assert.match(withTelemetry, /search 2 次 · ingest 1 次 · other 0 次/);
  assert.doesNotMatch(withTelemetry, /percent|aria-valuenow/);
  // 缺失/损坏/未上报（available:false 或 sources.pando 缺席）→『暂无 Pando 活动记录』。
  for (const payload of [null, { available: false, reason: "missing", sources: {} }, { available: false, reason: "corrupt", sources: {} }, { available: true, sources: {} }]) {
    const line = pandoUsageTelemetryLine(payload);
    assert.match(line, /暂无 Pando 活动记录/);
    assert.doesNotMatch(line, /search \d+ 次/);
  }
});
