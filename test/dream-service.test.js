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

test("dream operation requests free Markdown with an optional H1 title", () => {
  const prompt = buildDreamPrompt({
    dreamType: "beautiful",
    userName: "test-user",
    aiName: "test-ai",
  });

  assert.match(prompt, /`# 梦境标题`.*可选增强/u);
  assert.doesNotMatch(prompt, /第一行只能|第二行留空/u);
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
      return "# Bridge：still open?\ntest-body";
    },
  });

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "completed");
  assert.equal(result.dream.dreamType, "erotic");
  assert.equal(result.dream.title, "Bridge：still open?");
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

test("dream service saves free Markdown without an H1 in one subagent call", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-markdown-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = "thread-test";
  const dreamStore = new DreamStore({ root: path.join(root, "dream") });
  const markdown = [
    "标题：桥的另一端",
    "Title: The lamp stays on",
    "",
    "“前夫。”她忽然开口，又问：\"Really?\"",
    "桌上的纸写着 { dream: true }。",
    "",
    "```js",
    "const payload = { dream: true };",
    "```",
  ].join("\n");
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
      return markdown;
    },
  });

  const result = service.generate({ threadId, date: "2026-07-29" });

  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(result.dream.title, "");
  assert.equal(dreamStore.get(threadId, "2026-07-29").body, markdown);
});

test("dream service rejects whitespace once and leaves no dream file", t => {
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
      return " \n\t\n ";
    },
  });

  assert.throws(
    () => service.generate({ threadId, date: "2026-07-29" }),
    error => error.code === "DREAM_OUTPUT_EMPTY",
  );
  assert.equal(calls, 1);
  assert.equal(dreamStore.get(threadId, "2026-07-29"), null);
});

function sequence(values) {
  return () => values.shift();
}

function feeling(id, sourceDate) {
  return { id, source_date: sourceDate, content: id, importance: 3 };
}
