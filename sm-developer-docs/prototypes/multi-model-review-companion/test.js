"use strict";

const assert = require("node:assert/strict");
const companion = require("./server");

assert.equal(companion.RULE_KEYS.length, 6);
assert.match(companion.friendlyPreviewError(new Error("<!DOCTYPE html><title>524: A timeout occurred</title>")), /524/);
assert.equal(
  companion.parseModelJson('```json\n{"feelings":[],"features":[]}\n```').feelings.length,
  0,
);

const rawFeelings = Array.from({ length: 25 }, (_, index) => ({
  content: `7月1日，上午${(index % 12) + 1}点。事件${index}`,
  importance: 3,
}));
const normalized = companion.normalizeResults(
  rawFeelings,
  [{ content: "她喜欢拥抱", category: "relation", importance: 3 }],
  "2026-07-01",
  true,
);
assert.equal(normalized.feelings.length, 20);
assert.equal(normalized.trimmedFeelings, 5);
assert.equal(normalized.features.length, 1);

const granular = companion.normalizeRuleSelection({
  rules: {
    sourceAware: true,
    relationshipPlatform: false,
    emotional: true,
    conflict: false,
    countLimit: true,
    strictBoundaries: true,
  },
});
assert.equal(Object.keys(granular).length, 6);
assert.equal(granular.sourceAware, true);
assert.equal(granular.relationshipPlatform, false);

const legacy = companion.normalizeRuleSelection({ historical: true, countLimit: true });
assert.ok(Object.values(legacy).every(Boolean));

const parts = companion.loadHistoricalRuleParts();
assert.equal(Object.keys(parts.parts).length, 5);
const texts = companion.selectedRuleTexts(granular, parts.parts);
assert.equal(texts.length, 4);
const prompt = companion.buildPrompt({
  operations: "作者原版",
  ruleTexts: [...texts, "8 至 20 条"],
  date: "2026-07-01",
  chunkIndex: 0,
  chunkCount: 1,
  previousFeelings: [],
});
assert.match(prompt, /8 至 20 条/);
assert.match(prompt, /作者原版/);

const parentA = {
  id: "candidate-1-aaaaaaaaaa",
  model: "model-a",
  modelLabel: "模型 A",
  status: "review_pending",
  date: "2026-07-01",
  feelings: [
    { content: "7月1日，上午9点。一起吃早餐。", importance: 3, eventTime: "2026-07-01T01:00:00.000Z" },
    { content: "7月1日，晚上9点。认真拥抱。", importance: 5, eventTime: "2026-07-01T13:00:00.000Z" },
  ],
  features: [{ content: "她喜欢热牛奶。", category: "eat", importance: 3 }],
};
const parentB = {
  id: "candidate-2-bbbbbbbbbb",
  model: "model-b",
  modelLabel: "模型 B",
  status: "review_pending",
  date: "2026-07-01",
  feelings: [
    { content: "7月1日，上午9点。一起吃早餐。", importance: 3, eventTime: "2026-07-01T01:00:00.000Z" },
    { content: "7月1日，下午3点。一起散步。", importance: 3, eventTime: "2026-07-01T07:00:00.000Z" },
  ],
  features: [{ content: "她更喜欢温牛奶。", category: "eat", importance: 3 }],
};
const mixed = companion.buildHybridSelection([parentA, parentB], {
  feelings: [
    { candidateId: parentA.id, index: 1 },
    { candidateId: parentB.id, index: 1 },
    { candidateId: parentA.id, index: 0 },
    { candidateId: parentB.id, index: 0 },
  ],
  features: [
    { candidateId: parentA.id, index: 0 },
    { candidateId: parentB.id, index: 0 },
  ],
}, true);
assert.equal(mixed.feelings.length, 3);
assert.equal(mixed.features.length, 2);
assert.equal(mixed.exactDuplicatesDropped.feelings, 1);
assert.equal(mixed.feelings[0].content, "7月1日，上午9点。一起吃早餐。");
assert.equal(mixed.provenance.feelings.length, mixed.feelings.length);
assert.equal(mixed.provenance.features[1].modelLabel, "模型 B");

const edited = companion.buildHybridSelection([parentA, parentB], {
  feelings: [
    {
      candidateId: parentB.id,
      index: 1,
      content: "7月1日，下午两点。把散步提前了一小时。",
    },
    { candidateId: parentA.id, index: 0 },
  ],
}, false);
assert.equal(edited.feelings[0].content, "7月1日，上午9点。一起吃早餐。");
assert.equal(edited.feelings[1].content, "7月1日，下午两点。把散步提前了一小时。");
assert.equal(edited.provenance.feelings[1].edited, true);
assert.match(edited.provenance.feelings[1].originalContentSha256, /^[0-9a-f]{64}$/);
assert.throws(() => companion.buildHybridSelection([parentB], {
  feelings: [{ candidateId: parentB.id, index: 1, content: "改完却没有日期时间。" }],
}), /必须保留完整日期/);

const manyParent = {
  ...parentA,
  id: "candidate-3-cccccccccc",
  feelings: Array.from({ length: 21 }, (_, index) => ({
    content: `7月1日，第${index + 1}件不同事件。`,
    importance: 3,
    eventTime: `2026-07-01T${String(index % 20).padStart(2, "0")}:00:00.000Z`,
  })),
};
assert.throws(() => companion.buildHybridSelection([manyParent], {
  feelings: manyParent.feelings.map((row, index) => ({ candidateId: manyParent.id, index })),
}, true), /不能超过 20 条/);

let sourceAudit = null;
if (process.env.STONE_COMPANION_TEST_THREAD_ID && process.env.STONE_REPO && process.env.STONE_MEMORY_DIR) {
  const { MemoryStore } = require(`${process.env.STONE_REPO}/src/storage/memory-store.js`);
  const store = new MemoryStore({
    memoryDir: process.env.STONE_MEMORY_DIR,
    threadId: process.env.STONE_COMPANION_TEST_THREAD_ID,
  });
  try {
    const messages = store.listMessages({ date: "2026-07-04" });
    sourceAudit = companion.attachHistoricalSources(messages);
    assert.ok(sourceAudit.matched > 0);
    assert.ok(sourceAudit.sourceCount > 0);
    assert.equal(sourceAudit.messages.length, messages.length);
  } finally {
    store.close();
  }
}

process.stdout.write(JSON.stringify({
  ok: true,
  ruleCount: companion.RULE_KEYS.length,
  promptParts: texts.length,
  cap: normalized.feelings.length,
  trimmed: normalized.trimmedFeelings,
  hybrid: {
    feelings: mixed.feelings.length,
    features: mixed.features.length,
    exactDuplicatesDropped: mixed.exactDuplicatesDropped.feelings,
  },
  sourceAudit: sourceAudit ? {
    matched: sourceAudit.matched,
    unmatched: sourceAudit.unmatched,
    sourceCount: sourceAudit.sourceCount,
  } : null,
}) + "\n");
