"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildDreamTask,
  buildDreamPrompt,
  DreamService,
  parseDreamOutput,
  rollDreamType,
  selectDreamFeelings,
} = require("../src/services/dream-service");
const { DreamStore } = require("../src/storage/dream-store");
const { MemoryStore } = require("../src/storage/memory-store");

test("dream type roll preserves DreamSea probability boundaries", () => {
  assert.equal(rollDreamType({ randomInt: () => 7_999 }).finalType, "beautiful");
  assert.equal(rollDreamType({ randomInt: sequence([8_000, 9_999]) }).finalType, "nightmare");
  assert.equal(rollDreamType({ randomInt: sequence([9_000]) }).finalType, "erotic");
  assert.equal(rollDreamType({ randomInt: sequence([0, 1_999]) }).finalType, "beautiful_erotic");
  assert.equal(rollDreamType({ randomInt: sequence([8_000, 999]) }).finalType, "nightmare_erotic");
});

test("dream materials use ten random current feelings and four random same-thread historical feelings", () => {
  const current = Array.from({ length: 12 }, (_, index) => feeling(`today-${index + 1}`, "2026-07-29"));
  const historical = Array.from({ length: 6 }, (_, index) => feeling(`history-${index + 1}`, "2026-07-20"));
  const future = feeling("future", "2026-07-30");

  const selected = selectDreamFeelings({
    feelings: [...historical, ...current, future],
    date: "2026-07-29",
    randomInt: maximum => maximum - 1,
  });

  assert.deepEqual(selected.current.map(row => row.id), [
    "today-12", "today-1", "today-2", "today-3", "today-4",
    "today-5", "today-6", "today-7", "today-8", "today-9",
  ]);
  assert.deepEqual(selected.historical.map(row => row.id), [
    "history-6", "history-1", "history-2", "history-3",
  ]);
});

test("dream operation combines one DreamSea type strategy with configured names", () => {
  const prompt = buildDreamPrompt({
    dreamType: "nightmare",
    userName: "test-user",
    aiName: "test-ai",
  });

  assert.match(prompt, /test-user/);
  assert.match(prompt, /test-ai/);
  assert.match(prompt, /`nightmare`/);
  assert.doesNotMatch(prompt, /\{\{[^}]+\}\}|\{(?:userName|aiName)\}/);
});

test("dream operation requests a title followed by plain narrative text", () => {
  const prompt = buildDreamPrompt({
    dreamType: "beautiful",
    userName: "test-user",
    aiName: "test-ai",
  });

  assert.match(prompt, /第一行.*标题：梦境标题/u);
  assert.match(prompt, /第二行留空/u);
  assert.doesNotMatch(prompt, /合法 JSON 对象|validation|endingValence|sourceAnchors/u);
});

test("dream task keeps current and historical feelings as structured stdin data", () => {
  const task = JSON.parse(buildDreamTask({
    dreamType: "nightmare",
    date: "2026-07-29",
    current: [feeling("today", "2026-07-29")],
    historical: [feeling("history", "2026-07-20")],
  }));

  assert.equal(task.sourceDate, "2026-07-29");
  assert.equal(task.requestedType, "nightmare");
  assert.equal(task.currentFeelings[0].content, "today");
  assert.equal(task.historicalFeelings[0].content, "history");
});

test("dream output keeps narrative quotes and code as plain text", () => {
  const output = [
    "标题：灯塔背面的城",
    "",
    "“前夫。”她忽然开口。",
    "她又说：\"满分。\"",
    "桌上的纸写着：const payload = { dream: true };",
  ].join("\n");

  assert.deepEqual(parseDreamOutput(output), {
    title: "灯塔背面的城",
    body: [
      "“前夫。”她忽然开口。",
      "她又说：\"满分。\"",
      "桌上的纸写着：const payload = { dream: true };",
    ].join("\n"),
  });
});

test("dream output requires a blank line between title and narrative", () => {
  assert.throws(
    () => parseDreamOutput("标题：灯塔背面的城\n说明：以下是梦境正文\n灯一直亮着。"),
    error => error.code === "DREAM_OUTPUT_INVALID",
  );
});

test("all five standard dream types resolve independent prompt assets", () => {
  const dreamTypes = [
    "beautiful",
    "nightmare",
    "erotic",
    "beautiful_erotic",
    "nightmare_erotic",
  ];

  for (const dreamType of dreamTypes) {
    const prompt = buildDreamPrompt({
      dreamType,
      userName: "test-user",
      aiName: "test-ai",
    });
    assert.ok(prompt.length > 0);
    assert.doesNotMatch(prompt, /\{\{[^}]+\}\}|\{(?:userName|aiName)\}/);
  }
});

test("dream service generates once from published same-thread feelings and saves text", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-service-"));
  const memoryDir = path.join(root, "memory");
  const threadId = "thread-test";
  const seed = new MemoryStore({ memoryDir, threadId });
  seed.replaceDay("2026-07-20", {
    feelings: Array.from({ length: 6 }, (_, index) => ({
      content: `history-${index + 1}`,
      importance: 3,
    })),
  });
  seed.replaceDay("2026-07-29", {
    feelings: Array.from({ length: 12 }, (_, index) => ({
      content: `today-${index + 1}`,
      importance: 3,
    })),
    features: [{ content: "derived feature", importance: 3 }],
    dayState: {
      status: "completed",
      feelingCount: 12,
      featureCount: 1,
      completedAt: "2026-07-30T00:00:00.000Z",
    },
  });
  seed.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const calls = [];
  const dreamStore = new DreamStore({ root: path.join(root, "dream") });
  const service = new DreamService({
    dreamStore,
    memoryStoreFactory: () => new MemoryStore({ memoryDir, threadId }),
    getThreadConfig: () => ({ userName: "test-user", aiName: "test-ai" }),
    operationDirectoryForThread: () => path.join(root, "tmp"),
    randomInt: maximum => maximum - 1,
    runSubagent: (task, options) => {
      calls.push({
        task: JSON.parse(task),
        operation: fs.readFileSync(options.opsFile, "utf8"),
        options,
      });
      return "标题：test-title\n\ntest-body";
    },
  });

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "completed");
  assert.equal(result.dream.dreamType, "erotic");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.threadId, threadId);
  assert.match(calls[0].options.opsFile, /\.md$/);
  assert.match(calls[0].operation, /test-user/);
  assert.match(calls[0].operation, /test-ai/);
  assert.equal(calls[0].task.currentFeelings[0].content, "today-12");
  assert.equal(calls[0].task.historicalFeelings[0].content, "history-6");
  assert.equal(fs.existsSync(calls[0].options.opsFile), false);
  assert.equal(dreamStore.get(threadId, "2026-07-29").body, "test-body");
  assert.equal(service.generate({ threadId, date: "2026-07-29" }).status, "already_exists");
  assert.equal(calls.length, 1);
});

test("dream service retries invalid text and saves the next complete dream", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = "thread-test";
  const dreamStore = new DreamStore({ root: path.join(root, "dream") });
  const responses = [
    JSON.stringify({
      title: "旧 JSON 输出",
      dream: { body: "这份旧协议不再接受。", endingValence: "sensual" },
      validation: {
        requestedType: "erotic",
        matchesRequestedType: true,
        usesFeelingMaterial: true,
      },
    }),
    "标题：第二次抵达\n\n她说：\"满分。\"\n\n灯一直亮着。",
  ];
  let calls = 0;
  const service = new DreamService({
    dreamStore,
    memoryStoreFactory: () => ({
      getDayState: () => ({ status: "completed" }),
      listFeelings: () => [feeling("today", "2026-07-29")],
      close() {},
    }),
    getThreadConfig: () => ({ userName: "test-user", aiName: "test-ai" }),
    operationDirectoryForThread: () => path.join(root, "tmp"),
    randomInt: maximum => maximum === 1 ? 0 : 9_000,
    runSubagent: () => {
      calls++;
      return responses.shift();
    },
  });

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.equal(dreamStore.get(threadId, "2026-07-29").body, "她说：\"满分。\"\n\n灯一直亮着。");
});

test("dream service leaves no file after all text attempts are invalid", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = "thread-test";
  const dreamStore = new DreamStore({ root: path.join(root, "dream") });
  let calls = 0;
  const service = new DreamService({
    dreamStore,
    memoryStoreFactory: () => ({
      getDayState: () => ({ status: "completed" }),
      listFeelings: () => [feeling("today", "2026-07-29")],
      close() {},
    }),
    getThreadConfig: () => ({ userName: "test-user", aiName: "test-ai" }),
    operationDirectoryForThread: () => path.join(root, "tmp"),
    randomInt: maximum => maximum === 1 ? 0 : 9_000,
    runSubagent: () => {
      calls++;
      return "标题：没有正文\n\n";
    },
  });

  assert.throws(
    () => service.generate({ threadId, date: "2026-07-29" }),
    error => error.code === "DREAM_OUTPUT_INVALID",
  );
  assert.equal(calls, 3);
  assert.equal(dreamStore.get(threadId, "2026-07-29"), null);
});

function sequence(values) {
  return () => values.shift();
}

function feeling(id, sourceDate) {
  return { id, source_date: sourceDate, content: id, importance: 3 };
}
