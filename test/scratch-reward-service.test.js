"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ScratchRewardService,
  ScratchSettingsStore,
} = require("../src/services/scratch-reward-service");

function fixture() {
  return {
    feelings: [
      feeling("mint-start", "2026-01-01", "开始在窗边种薄荷", 3),
      feeling("paper-plane", "2026-01-10", "以后想重新折一架纸飞机", 3),
      feeling("mint-return", "2026-03-01", "春天时薄荷重新长出了新叶", 4),
      feeling("project-one", "2026-04-25", "石头项目完成了第一轮整理", 3),
      feeling("project-two", "2026-04-30", "石头项目进入新的测试阶段", 5),
    ],
    features: [
      feature("mint-one", "2026-01-01", "薄荷", 3),
      feature("plane", "2026-01-10", "纸飞机", 3),
      feature("mint-two", "2026-03-01", "薄荷", 4),
      feature("project-one", "2026-04-25", "石头项目", 3),
      feature("project-two", "2026-04-30", "石头项目", 5),
    ],
    dayStates: ["2026-01-01", "2026-01-10", "2026-03-01", "2026-04-25", "2026-04-30"]
      .map(sourceDate => ({ source_date: sourceDate, status: "completed" })),
  };
}

test("scratch inspect returns probabilities without opening memory storage", () => {
  let storesOpened = 0;
  const service = new ScratchRewardService({
    memoryStoreFactory: () => { storesOpened += 1; throw new Error("inspect must not open memory storage"); },
    resolveGenerationModeImpl: () => "api",
  });

  const result = service.inspect("thread-test");

  assert.equal(result.generationMode, "api");
  assert.equal(result.probabilities.colors.gray, 52);
  assert.equal(result.eligibility.gold.available, true);
  assert.equal(storesOpened, 0);
});

test("scratch settings persist free replacement rewards per memory body", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-scratch-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ScratchSettingsStore({ getThreadDirImpl: threadId => path.join(root, threadId) });

  const saved = store.save("thread-test", { rewards: { gray: "买一杯奶茶", gold: "选一部电影" } });

  assert.equal(saved.rewards.gray, "买一杯奶茶");
  assert.equal(store.get("thread-test").rewards.gold, "选一部电影");
  assert.equal(store.get("thread-other").rewards.gray, "");
});

test("scratch rewards read selected dates and reuse configured generation services", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-scratch-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = fixture();
  const storeCalls = [];
  const generationCalls = [];
  const deepSearchCalls = [];
  const service = new ScratchRewardService({
    settingsStore: new ScratchSettingsStore({ getThreadDirImpl: threadId => path.join(root, threadId) }),
    memoryStoreFactory: () => memoryStore(data, storeCalls),
    getThreadProfile: () => ({ userName: "测试用户", aiName: "测试AI" }),
    randomInt: () => 0,
    searchByKeywordImpl: keywordSearch,
    runConfiguredGenerationImpl: async request => {
      generationCalls.push(request);
      return "这是一封从最近一天记忆里写出的信。";
    },
    runConfiguredDeepSearchImpl: async request => {
      deepSearchCalls.push(request);
      return `深度搜索结果：${request.query.split("\n")[0]}`;
    },
  });

  const result = await service.generate({
    threadId: "thread-test",
    colors: ["gray", "blue", "pink", "silver", "gold"],
  });

  assert.equal(result.rewards.length, 5);
  assert.equal(result.rewards.find(row => row.color === "gray").sources.length, 2);
  assert.match(result.rewards.find(row => row.color === "pink").body, /已经/u);
  assert.equal(generationCalls.length, 1);
  assert.match(generationCalls[0].systemPrompt, /测试AI/u);
  assert.equal(generationCalls[0].threadId, "thread-test");
  assert.equal(deepSearchCalls.length, 2);
  assert.match(deepSearchCalls.find(row => /有温度的‘未完待续’卡片/u.test(row.query)).query, /记忆线索/u);
  assert.match(deepSearchCalls.find(row => /完整的记忆专题时间线/u.test(row.query)).query, /石头项目/u);
  assert.ok(result.rewards.every(row => !row.error));
  assert.ok(storeCalls.some(call => call.method === "listFeelings"));
  assert.ok(storeCalls.every(call => call.method === "listDayStates" || Boolean(call.date)));
});

test("custom reward bypasses memory storage and configured generation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-scratch-custom-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsStore = new ScratchSettingsStore({ getThreadDirImpl: threadId => path.join(root, threadId) });
  settingsStore.save("thread-test", { rewards: { blue: "今天由你决定晚餐" } });
  let generationCalls = 0;
  const service = new ScratchRewardService({
    settingsStore,
    memoryStoreFactory: () => { throw new Error("custom reward must not open memory storage"); },
    runConfiguredGenerationImpl: () => { generationCalls += 1; return "不应调用"; },
  });

  const result = await service.generate({ threadId: "thread-test", colors: ["blue"] });

  assert.equal(result.rewards[0].kind, "custom");
  assert.equal(result.rewards[0].body, "今天由你决定晚餐");
  assert.equal(generationCalls, 0);
});

function memoryStore(data, calls) {
  return {
    listDayStates() {
      calls.push({ method: "listDayStates" });
      return data.dayStates;
    },
    listFeelings(options) {
      assert.equal(typeof options?.date, "string");
      calls.push({ method: "listFeelings", date: options.date });
      return data.feelings.filter(row => row.source_date === options.date);
    },
    listFeatures(options) {
      assert.equal(typeof options?.date, "string");
      calls.push({ method: "listFeatures", date: options.date });
      return data.features.filter(row => row.source_date === options.date);
    },
    listMessages() {
      throw new Error("scratch rewards must not load messages directly");
    },
    close() {
      calls.push({ method: "close", date: "closed" });
    },
  };
}

function keywordSearch(term) {
  if (term.includes("薄荷")) return {
    hits: [feeling("mint-start", "2026-01-01", "开始在窗边种薄荷", 3)],
    firstSeen: "2026-01-01",
    lastSeen: "2026-03-01",
  };
  if (term.includes("纸飞机")) return {
    hits: [feeling("paper-plane", "2026-01-10", "以后想重新折一架纸飞机", 3)],
    firstSeen: "2026-01-10",
    lastSeen: "2026-01-10",
  };
  return { hits: [], firstSeen: null, lastSeen: null };
}

function feeling(id, sourceDate, content, importance) {
  return { id, source_date: sourceDate, date: sourceDate, content, importance };
}

function feature(id, sourceDate, content, importance) {
  return { id, source_date: sourceDate, category: "misc", content, importance };
}
