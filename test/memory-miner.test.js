const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  MemoryMiner,
  normalizeNewImportance,
  sortFeelingsChronologically,
  feelingEventTime,
  buildFeelingPrompt,
} = require("../src/services/memory-miner");

test("feeling prompts keep ordinary events instead of treating weak features as an empty day", () => {
  for (const purpose of ["accompany", "coding", "study"]) {
    const prompt = buildFeelingPrompt("石头", "小鱼", purpose);
    assert.match(prompt, /普通.*importance 2|importance 2.*普通/);
    assert.match(prompt, /不要因为.*重大.*省略/);
    assert.match(prompt, /重复、测试、指令噪声/);
    assert.doesNotMatch(prompt, /没有值得记的内容/);
  }
});

test("new mining normalizes importance to 2, 3, or 5", () => {
  assert.deepEqual([1, 2, 3, 4, 5, null].map(normalizeNewImportance), [2, 2, 3, 3, 5, 2]);
});

test("accompany operations expand the configured AI name before reaching the model", t => {
  const miner = minerFixture(t, [{ text: "今天的对话" }]);
  const prompt = miner._readOperationsPrompt();
  assert.match(prompt, /你是 Alessio/);
  assert.doesNotMatch(prompt, /\{aiName\}/);
});

test("new feelings are stored in event-time order with unknown times stable at the end", () => {
  const entries = [
    { content: "7月4日，上午十点二十八分。十点发生的事。" },
    { content: "7月4日，中午十二点二十三分。中午发生的事。" },
    { content: "7月4日，早上八点五十三分。早上发生的事。" },
    { content: "7月4日。没有明确时间的第一件事。" },
    { content: "7月4日，晚上九点三十八分。晚上发生的事。" },
    { content: "7月4日。没有明确时间的第二件事。" },
  ];

  assert.deepEqual(
    sortFeelingsChronologically(entries).map(entry => entry.content),
    [
      entries[2].content,
      entries[0].content,
      entries[1].content,
      entries[4].content,
      entries[3].content,
      entries[5].content,
    ],
  );
});

test("targeted mining uses existing feelings as tone examples and appends selected events", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "被选中的对话" }]);
  miner.store.appendTargeted("2026-06-12", { feelings: [{ content: "6月12日，早上八点。已有摘要。", importance: 3 }] });
  let received;
  miner._extractViaSubagent = async (messages, prompt) => {
    received = { messages, prompt };
    return [{ content: "6月12日，上午九点。补挖出的事件。", importance: 3 }];
  };

  const result = await miner.mineTargeted("2026-06-12", miner.store.listMessages({ date: "2026-06-12" }));
  assert.equal(received.messages.length, 1);
  assert.match(received.prompt, /已有摘要/);
  assert.match(received.prompt, /仅用于模仿叙述视角和语气/);
  assert.equal(result.feelings.length, 1);
  assert.equal(feelingEventTime(result.feelings[0], "2026-06-12"), "2026-06-12T01:00:00.000Z");
  assert.deepEqual(miner.store.listFeelings({ date: "2026-06-12" }).map(row => row.content), [
    "6月12日，早上八点。已有摘要。",
    "6月12日，上午九点。补挖出的事件。",
  ]);
});

test("review preview returns candidate material without publishing the day", async t => {
  const miner = minerFixture(t, [{ timestamp: "2026-06-12T01:00:00.000Z", text: "候选审阅对话" }]);
  miner.deepseekConfig = { apiKey: ["test", "only"].join("-"), baseUrl: "https://example.invalid", model: "test-model" };
  const prompts = [];
  miner._extractViaSubagent = async (_messages, prompt) => {
    prompts.push(prompt);
    if (/只输出 features/.test(prompt)) {
      return [{ content: "候选特征", category: "relation", importance: 3 }];
    }
    return [{ content: "6月12日，上午九点。候选摘要。", importance: 3 }];
  };
  const preview = await miner.preview("2026-06-12", {
    promptOverlay: "本次只用于候选审阅。",
  });
  assert.equal(preview.messageCount, 1);
  assert.equal(preview.chunkCount, 1);
  assert.equal(preview.feelings.length, 1);
  assert.equal(preview.features.length, 1);
  assert.match(preview.promptHash, /^[0-9a-f]{64}$/);
  assert.ok(prompts.every(prompt => /本次只用于候选审阅/.test(prompt)));
  assert.equal(miner.store.listFeelings({ date: "2026-06-12" }).length, 0);
  assert.equal(miner.store.listFeatures({ date: "2026-06-12" }).length, 0);
  assert.equal(miner.store.getDayState("2026-06-12"), null);
});
function minerFixture(t, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-miner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const miner = new MemoryMiner({
    memoryDir: dir, threadId: "test", archive: { readDay: () => messages }, deepseekConfig: {},
    personaConfig: { purpose: "accompany" },
  });
  miner.store.insertMessages(messages.map((row, i) => ({
    timestamp: row.timestamp || `2026-06-12T00:00:0${i}.000Z`, sourceDate: "2026-06-12",
    role: row.type || "user", text: row.text || `message ${i}`,
  })));
  return miner;
}

test("a short day is still mined and an empty model result completes successfully", async t => {
  const miner = minerFixture(t, [{}, {}]);
  let called = 0;
  miner._mineDayWithSubagent = async targetDate => {
    called++;
    miner._saveState({ [`feeling:${targetDate}`]: Date.now(), [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine("2026-06-12");
  assert.equal(called, 1);
  assert.equal(result.status, "completed_empty");
  assert.equal(result.feelingCount, 0);
  assert.equal(result.featureCount, 0);
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "completed_empty");
  assert.equal(state.message_count, 2);
});

test("mining errors propagate to callers", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  miner._mineDayWithSubagent = async () => { throw new Error("model unavailable"); };
  await assert.rejects(() => miner.mine("2026-06-12"), err => err.code === "MINING_FAILED" && /model unavailable/.test(err.message));
  const state = miner.store.getDayState("2026-06-12");
  assert.equal(state.status, "failed");
  assert.match(state.next_retry_at, /^\d{4}-/);
});

test("a partial channel failure clears temporary completion markers for a full retry", async t => {
  const miner = minerFixture(t, [{ text: "需要挖掘的对话" }]);
  miner._mineDayWithSubagent = async targetDate => {
    miner._saveState({ [`feeling:${targetDate}`]: Date.now() });
    throw new Error("features failed");
  };
  await assert.rejects(() => miner.mine("2026-06-12"), /features failed/);
  const state = miner._readState();
  assert.equal(state["feeling:2026-06-12"], undefined);
  assert.equal(state["feature:2026-06-12"], undefined);
});

test("API channel mines large dialogue in chunks and accepts an empty final tail", async t => {
  const messages = Array.from({ length: 105 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(1000),
  }));
  const miner = minerFixture(t, []);
  let calls = 0;
  const prompts = [];
  miner._extractViaSubagent = async (_messages, prompt) => {
    prompts.push(prompt);
    calls++;
    return calls < 3 ? [{ content: `6月12日，上午${calls === 1 ? "八" : "九"}点。第${calls}块事件。`, importance: 2 }] : [];
  };
  await miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  });
  assert.equal(calls, 3);
  assert.equal(miner.pendingFeelings.length, 2);
  assert.doesNotMatch(prompts[0], /上一块最后/);
  assert.match(prompts[1], /上一块最后 1 条/);
  assert.match(prompts[1], /第1块事件/);
  assert.match(prompts[1], /禁止再次输出/);
});

test("chunk continuity includes only the previous five generated entries", t => {
  const miner = minerFixture(t, []);
  const previous = Array.from({ length: 7 }, (_, index) => ({
    content: `摘要${index + 1}`,
    importance: 2,
  }));
  const prompt = miner._chunkPrompt("base", 1, 3, previous, "feelings");
  assert.doesNotMatch(prompt, /摘要1|摘要2/);
  for (let index = 3; index <= 7; index++) assert.match(prompt, new RegExp(`摘要${index}`));
});

test("an unchunked day keeps the original prompt unchanged", t => {
  const miner = minerFixture(t, []);
  assert.equal(
    miner._chunkPrompt("正式原始提示词", 0, 1, [{ content: "不应出现" }], "feelings"),
    "正式原始提示词",
  );
});

test("a failed chunk does not publish partial day results", async t => {
  const messages = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 5, 12, 0, index)).toISOString(),
    type: "user",
    text: "x".repeat(1000),
  }));
  const miner = minerFixture(t, []);
  let calls = 0;
  miner._extractViaSubagent = async () => {
    calls++;
    if (calls === 2) throw new Error("chunk failed");
    return [{ content: "6月12日，上午八点。第一块事件。", importance: 2 }];
  };
  await assert.rejects(() => miner._mineChannel({
    targetDate: "2026-06-12", messages, prompt: "prompt",
    stateKey: "feeling:2026-06-12", label: "feelings",
  }), /chunk failed/);
  assert.equal(miner.pendingFeelings.length, 0);
  assert.equal(miner._readState()["feeling:2026-06-12"], undefined);
});

test("three consecutive failures block automatic retries and enqueue a notification", async t => {
  const miner = minerFixture(t, [{ text: "x" }]);
  miner._mineDayWithSubagent = async () => { throw new Error("model unavailable"); };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(() => miner.mine("2026-06-12"));
  }
  const day = miner.store.getDayState("2026-06-12");
  assert.equal(day.status, "blocked");
  assert.equal(day.attempt, 3);
  assert.equal(day.next_retry_at, null);
  const notifications = miner.store.db.prepare("SELECT * FROM notifications WHERE thread_id=?").all("test");
  assert.deepEqual(notifications.map(item => [item.type, item.source_date, item.is_read]), [["mining_blocked", "2026-06-12", 0]]);
});

test("active date lock returns locked status", async t => {
  const miner = minerFixture(t, Array.from({ length: 5 }, () => ({ text: "x" })));
  fs.mkdirSync(path.join(miner.memoryDir, ".mining-lock-2026-06-12"));
  const result = await miner.mine("2026-06-12");
  assert.equal(result.status, "locked");
});

test("forced remine replaces a completed day directly", async t => {
  const miner = minerFixture(t, [{ text: "new conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed" });
  miner._mineDayWithSubagent = async targetDate => {
    await miner._saveEntries([{ content: "new", importance: 4 }], { targetDate, stateKey: `feeling:${targetDate}`, label: "feelings", isFeature: false });
    miner._saveState({ [`feature:${targetDate}`]: Date.now() });
  };
  const result = await miner.mine(date, { force: true });
  assert.equal(result.status, "completed");
  const rows = miner.store.listFeelings({ date });
  assert.deepEqual(rows.map(row => row.content), ["new"]);
});

test("failed forced remine restores the previous result and completion state", async t => {
  const miner = minerFixture(t, [{ text: "conversation" }]);
  const date = "2026-06-12";
  miner.store.replaceDay(date, { feelings: [{ content: "old", importance: 3 }] });
  miner.store.setDayState(date, { status: "completed", feelingCount: 1 });
  miner._mineDayWithSubagent = async () => { throw new Error("remine failed"); };
  await assert.rejects(() => miner.mine(date, { force: true }), /remine failed/);
  assert.deepEqual(miner.store.listFeelings({ date }).map(row => row.content), ["old"]);
  assert.equal(miner.store.getDayState(date).status, "completed");
});
