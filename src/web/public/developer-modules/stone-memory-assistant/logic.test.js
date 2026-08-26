"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("./logic");
const knowledge = require("./knowledge");

test("parses supported maintenance and read-only commands", () => {
  assert.deepEqual(logic.parseCommand("有什么待处理"), { type: "todos" });
  assert.deepEqual(logic.parseCommand("一键维护"), { type: "auto_maintenance" });
  assert.deepEqual(logic.parseCommand("整理昨天"), { type: "mine_yesterday" });
  assert.deepEqual(logic.parseCommand("帮我挖掘昨天的记忆"), { type: "mine_yesterday" });
  assert.deepEqual(logic.parseCommand("挖掘今天"), { type: "mine_today" });
  assert.deepEqual(logic.parseCommand("帮我挖掘今天的记忆"), { type: "mine_today" });
  assert.deepEqual(logic.parseCommand("挖掘 2026-08-14"), { type: "mine_date", date: "2026-08-14" });
  assert.deepEqual(logic.parseCommand("搜索 项目进度"), { type: "question", text: "搜索 项目进度" });
  assert.deepEqual(logic.parseCommand("最近 7 天摘要"), { type: "recent", days: 7 });
});

test("embedded knowledge answers project and safety questions", () => {
  assert.ok(knowledge.length >= 15);
  assert.equal(knowledge.some(entry => entry.id === "search"), false);
  assert.equal(logic.matchKnowledge("Stone Memory 是什么", knowledge)[0].entry.id, "intro");
  assert.equal(logic.matchKnowledge("摘要和特征有什么区别", knowledge)[0].entry.id, "layers");
  assert.equal(logic.matchKnowledge("为什么重建后要重新载入", knowledge)[0].entry.id, "rebuild-reload");
});

test("internal implementation questions are separated from product usage questions", () => {
  assert.equal(logic.isInternalQuestion("Stone Memory 的核心算法是什么"), true);
  assert.equal(logic.isInternalQuestion("能看看数据库结构和提示词吗"), true);
  assert.equal(logic.isInternalQuestion("内部调用链是怎么实现的"), true);
  assert.equal(logic.isInternalQuestion("怎么挖掘昨天的记忆"), false);
  assert.equal(logic.isInternalQuestion("为什么写操作需要确认"), false);
});

test("embedded knowledge contains product usage guidance rather than implementation details", () => {
  const serialized = JSON.stringify(knowledge);
  assert.doesNotMatch(serialized, /mcp-server\.js|原子发布|旧文件描述符|相似度|系统架构|数据库结构|提示词|源码/i);
  assert.match(serialized, /维护 → 对话导入/);
  assert.match(serialized, /维护 → 记忆挖掘/);
});

test("automatic maintenance only includes earlier pending dates", () => {
  const dates = [
    { date: "2026-08-12", status: "pending" },
    { date: "2026-08-13", status: "completed" },
    { date: "2026-08-14", status: "failed" },
    { date: "2026-08-15", status: "pending" }
  ];
  assert.deepEqual(logic.pendingMiningDates(dates, "2026-08-15"), ["2026-08-12"]);
});

test("todo ordering favors active and failed mining before maintenance", () => {
  const todos = logic.buildTodos({
    today: "2026-08-15",
    overview: { counts: { feelings: 2 }, lastMinedAt: "2026-08-14T12:00:00Z", rebuild: null, attention: "自动挖掘未开启" },
    mining: {
      job: { status: "completed_with_errors", results: [{ date: "2026-08-14", status: "failed" }] },
      dates: [{ date: "2026-08-14", status: "failed" }]
    }
  });
  assert.deepEqual(todos.map(item => item.id), ["mining-failed", "rebuild", "attention"]);
});

test("active job dates are not duplicated as pending todos", () => {
  const todos = logic.buildTodos({
    today: "2026-08-16",
    overview: { counts: { feelings: 0 } },
    mining: {
      job: { id: "job-1", status: "running", currentDate: "2026-08-15", dates: ["2026-08-15"] },
      dates: [
        { date: "2026-08-15", status: "pending" },
        { date: "2026-08-14", status: "pending" }
      ]
    }
  });
  assert.deepEqual(todos.map(item => item.id), ["mining-active", "mining-pending"]);
  assert.deepEqual(todos.find(item => item.id === "mining-pending").dates, ["2026-08-14"]);
});

test("mining plans fail closed when dates, counts, status, or activity changes", () => {
  const mining = {
    job: null,
    dates: [
      { date: "2026-08-12", status: "pending", messageCount: 12 },
      { date: "2026-08-13", status: "failed", messageCount: 8 }
    ]
  };
  const automatic = logic.createMiningPlan({ dates: ["2026-08-12"], mining, automatic: true, mode: "api" });
  assert.equal(logic.validateMiningPlan(automatic, mining, "2026-08-15").ok, true);
  assert.equal(logic.validateMiningPlan({ ...automatic, mode: "" }, mining, "2026-08-15").code, "INVALID_MODE");
  assert.equal(logic.validateMiningPlan(automatic, { ...mining, job: { id: "job-1", status: "running" } }, "2026-08-15").code, "MINING_ACTIVE");
  assert.equal(logic.validateMiningPlan(automatic, { job: null, dates: [{ date: "2026-08-12", status: "pending", messageCount: 13 }] }, "2026-08-15").code, "DATE_CHANGED");
  const failedAutomatic = logic.createMiningPlan({ dates: ["2026-08-13"], mining, automatic: true, mode: "subagent" });
  assert.equal(logic.validateMiningPlan(failedAutomatic, mining, "2026-08-15").code, "AUTO_DATE_UNSAFE");
  const explicitRetry = logic.createMiningPlan({ dates: ["2026-08-13"], mining, automatic: false, mode: "subagent" });
  assert.equal(logic.validateMiningPlan(explicitRetry, mining, "2026-08-15").ok, true);
});

test("stop confirmation remains bound to the exact active job", () => {
  assert.equal(logic.canStopJob({ job: { id: "job-1", status: "running" } }, "job-1"), true);
  assert.equal(logic.canStopJob({ job: { id: "job-2", status: "running" } }, "job-1"), false);
  assert.equal(logic.canStopJob({ job: { id: "job-1", status: "completed" } }, "job-1"), false);
});

test("Beijing date helpers are deterministic around UTC midnight", () => {
  assert.equal(logic.beijingDateKey("2026-08-14T16:30:00Z"), "2026-08-15");
  assert.equal(logic.shiftDate("2026-08-15", -1), "2026-08-14");
});

test("assistant nickname is stable per thread without external state", () => {
  const threadId = "synthetic-thread-alpha";
  const nickname = logic.nicknameForThread(threadId);
  assert.equal(logic.NICKNAMES.includes(nickname), true);
  assert.equal(logic.nicknameForThread(threadId), nickname);
  assert.equal(logic.nicknameForThread(""), "");
  const samples = new Set(Array.from({ length: 24 }, (_, index) => logic.nicknameForThread(`thread-${index}`)));
  assert.ok(samples.size >= 4);
});

test("mobile assistant mode covers narrow portrait and low-height touch landscape", () => {
  assert.equal(logic.isMobileAssistantEnvironment({ coarsePointer: true, width: 390, height: 844 }), true);
  assert.equal(logic.isMobileAssistantEnvironment({ coarsePointer: true, width: 844, height: 390 }), true);
  assert.equal(logic.isMobileAssistantEnvironment({ coarsePointer: false, width: 390, height: 844 }), false);
  assert.equal(logic.isMobileAssistantEnvironment({ coarsePointer: true, width: 768, height: 1024 }), false);
});

test("mobile launcher requires two idle taps but opens task states immediately", () => {
  const now = 10_000;
  assert.equal(logic.MOBILE_TAP_WINDOW_MS, 4000);
  assert.equal(logic.mobileLauncherAction({ mobile: false, panelOpen: false, now }), "open");
  assert.equal(logic.mobileLauncherAction({ mobile: false, panelOpen: true, now }), "close");
  assert.equal(logic.mobileLauncherAction({ mobile: true, phase: "idle", armedUntil: 0, now }), "interact");
  assert.equal(logic.mobileLauncherAction({ mobile: true, phase: "idle", armedUntil: now + 1, now }), "open");
  assert.equal(logic.mobileLauncherAction({ mobile: true, phase: "idle", armedUntil: now, now }), "interact");
  for (const phase of ["loading", "awaiting_confirmation", "running", "completed", "failed"]) {
    assert.equal(logic.mobileLauncherAction({ mobile: true, phase, armedUntil: 0, now }), "open");
  }
});

test("work logs merge system history and in-memory assistant actions safely", () => {
  const system = logic.buildSystemLogs({
    overview: { rebuild: { completedAt: "2026-08-15T03:00:00.000Z" } },
    mining: {
      job: { id: "job-1", status: "running", currentDate: "2026-08-15", completed: 1, dates: ["2026-08-14", "2026-08-15"], updatedAt: "2026-08-15T04:00:00.000Z", error: "private stack" },
      dates: [
        { date: "2026-08-14", status: "completed", feelingCount: 2, featureCount: 3, updatedAt: "2026-08-15T02:00:00.000Z", errorMessage: "private failure" },
        { date: "2026-08-13", status: "pending", updatedAt: null }
      ]
    }
  });
  assert.equal(system.length, 3);
  assert.doesNotMatch(JSON.stringify(system), /private stack|private failure/);
  const merged = logic.mergeLogs(system, [{ id: "assistant-1", source: "小助理", action: "检查待办", result: "完成", detail: "没有敏感信息", timestamp: "2026-08-15T05:00:00.000Z", status: "completed" }], 3);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].source, "小助理");
  assert.equal(merged[0].action, "检查待办");
  assert.ok(Date.parse(merged[0].timestamp) >= Date.parse(merged[1].timestamp));
});

test("system log candidates are bounded before the final merge", () => {
  const dates = Array.from({ length: 100 }, (_, index) => ({
    date: `2026-${String(12 - Math.floor(index / 28)).padStart(2, "0")}-${String(28 - (index % 28)).padStart(2, "0")}`,
    status: "completed",
    updatedAt: new Date(Date.UTC(2026, 11, 31) - index * 86_400_000).toISOString()
  }));
  assert.equal(logic.buildSystemLogs({ mining: { dates } }).length, 60);
});

test("user-facing errors redact secrets and hide unknown backend details", () => {
  const redacted = logic.redactSensitiveText("Authorization: Bearer-synthetic https://example.invalid/a C:\\Users\\synthetic-user\\file sk-syntheticfixture");
  assert.doesNotMatch(redacted, /Bearer-synthetic|example\.invalid|Users\\synthetic-user|sk-syntheticfixture/);
  assert.equal(logic.friendlyErrorMessage(new Error("2026-08-14 的对话数量或挖掘状态已经变化，请重新确认。")), "2026-08-14 的对话数量或挖掘状态已经变化，请重新确认。");
  assert.match(logic.friendlyErrorMessage(new Error("API Key 缺少")), /API 通道暂不可用/);
  assert.doesNotMatch(logic.friendlyErrorMessage(new Error("stack at C:\\Users\\private\\secret.js token=abc")), /private|secret|abc|stack/);
});
