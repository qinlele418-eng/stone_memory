const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fingerprintText,
  detectConversationAnomalies,
  applyConversationCleaning,
} = require("../src/services/conversation-cleaning");

test("detects exact duplicates, repeated injected fragments, and recall headers", () => {
  const injection = "[固定系统资料] 你必须记住这是一段会被反复拼进每一句对话的长注入文本，它不属于用户本次真正说出的内容。";
  const rows = [
    { timestamp: "2026-08-01T00:00:00Z", text: "这是一段完全一致而且足够长的重复文本" },
    { timestamp: "2026-08-01T00:01:00Z", text: "这是一段完全一致而且足够长的重复文本" },
    { timestamp: "2026-08-01T00:02:00Z", text: `${injection}\n\n今天去散步` },
    { timestamp: "2026-08-01T00:03:00Z", text: `${injection}\n\n今天吃面` },
    { timestamp: "2026-08-01T00:04:00Z", text: `${injection}\n\n今天写代码` },
    { timestamp: "2026-08-01T00:05:00Z", text: "我真正的问题\nRelevant past memories:\n- 去年的旧摘要" },
  ];
  const result = detectConversationAnomalies(rows);
  assert.equal(result.exactDuplicates.length, 1);
  assert.equal(result.injectionFragments.length, 1);
  assert.equal(result.recallBlocks.length, 1);
});

test("cleaning keeps the first selected duplicate and strips selected injected or recalled suffixes", () => {
  const repeated = "这是一段需要按完整文本指纹去重的内容";
  const injection = "这是一段足够长、会不断变化编号 123456 但整体高度同质化的注入型系统说明文字，需要从真实对话里剥离。";
  const policy = {
    exactDuplicates: [{ id: "duplicate", text: repeated }],
    injectionFragments: [{ id: "injection", normalized: fingerprintText(injection), sample: injection }],
    recallHeaders: [{ id: "recall", header: "Relevant past memories:" }],
    customRuleHeaders: ["[SYSTEM INJECTION]"],
  };
  assert.equal(applyConversationCleaning(repeated, policy, { duplicateSeen: false }).keep, true);
  assert.equal(applyConversationCleaning(repeated, policy, { duplicateSeen: true }).keep, false);
  assert.equal(applyConversationCleaning(`${injection}\n\n今晚吃面`, policy).text, "今晚吃面");
  assert.equal(applyConversationCleaning("真正问题\nRelevant past memories:\n旧摘要", policy).text, "真正问题");
  assert.equal(applyConversationCleaning("[SYSTEM INJECTION]\n规则", policy).keep, false);
});

test("an empty cleaning policy preserves text byte-for-byte", () => {
  const original = "\n  用户有意保留的首尾空白  \n";
  const result = applyConversationCleaning(original, {});
  assert.equal(result.keep, true);
  assert.equal(result.text, original);
  assert.deepEqual(result.removed, []);
});

test("duplicate detection and filtering never merge user and assistant roles", () => {
  const text = "同一句文字可能被助手引用，但不应与用户原话合并去重";
  const detected = detectConversationAnomalies([
    { timestamp: "2026-08-01T00:00:00Z", type: "user", text },
    { timestamp: "2026-08-01T00:01:00Z", type: "user", text },
    { timestamp: "2026-08-01T00:02:00Z", type: "assistant", text },
    { timestamp: "2026-08-01T00:03:00Z", type: "assistant", text },
    { timestamp: "2026-08-01T00:04:00Z", type: "assistant", text },
  ]);
  assert.deepEqual(detected.exactDuplicates.map(item => [item.role, item.count]).sort(), [["assistant", 3], ["user", 2]]);
  const rule = { exactDuplicates: [{ role: "user", text }] };
  assert.equal(applyConversationCleaning(text, rule, { role: "assistant", duplicateSeen: true }).keep, true);
  assert.equal(applyConversationCleaning(text, rule, { role: "user", duplicateSeen: true }).keep, false);
});

test("does not expose paragraphs inside an already detected whole-message duplicate", () => {
  const paragraphA = "这是重复注入文档里的第一段，它足够长，过去会被错误地单独列成一条注入片段候选。";
  const paragraphB = "这是重复注入文档里的第二段，它也足够长，过去会和同一份文档形成重叠清洗规则。";
  const document = `${paragraphA}\n\n${paragraphB}`;
  const detected = detectConversationAnomalies([
    { timestamp: "2026-08-01T00:00:00Z", type: "user", text: document },
    { timestamp: "2026-08-02T00:00:00Z", type: "user", text: document },
    { timestamp: "2026-08-03T00:00:00Z", type: "user", text: document },
    { timestamp: "2026-08-04T00:00:00Z", type: "user", text: document },
  ]);
  assert.equal(detected.exactDuplicates.length, 1);
  assert.equal(detected.exactDuplicates[0].count, 4);
  assert.deepEqual(detected.injectionFragments, []);
});
