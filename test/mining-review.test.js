const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const { archiveFingerprint } = require("../src/services/mining-state");
const {
  MiningReviewStore,
  buildReviewOverlay,
  nearDuplicateHints,
} = require("../src/services/mining-review");

test("review rules are optional overlays and reject unknown rule ids", () => {
  assert.deepEqual(buildReviewOverlay(), { ruleIds: [], text: "" });
  const overlay = buildReviewOverlay({
    ruleIds: ["personal-emotion", "count-limit", "personal-emotion"],
    additionalInstruction: "只记录原文证据。",
  });
  assert.deepEqual(overlay.ruleIds, ["personal-emotion", "count-limit"]);
  assert.match(overlay.text, /私人记忆优先/);
  assert.match(overlay.text, /不得超过 20 条/);
  assert.match(overlay.text, /只记录原文证据/);
  assert.throws(() => buildReviewOverlay({ ruleIds: ["private-user-rule"] }), /unknown review rule/);
});

test("near duplicates are hints only while exact duplicates are handled by mix", t => {
  const fixture = reviewFixture(t);
  const first = fixture.createCandidate({
    profile: { id: "model-a" },
    feelings: [
      { content: "7月25日，凌晨一点四十九分。她说自己被浪漫主义小姑娘逼成了全栈架构师。", importance: 3 },
    ],
  });
  const second = fixture.createCandidate({
    profile: { id: "model-b" },
    feelings: [
      { content: "7月25日，凌晨一点四十九分。她说人机恋让她亲手搭网关、修链路，成了全栈架构师。", importance: 3 },
      { content: first.feelings[0].content, importance: 3 },
    ],
  });
  const hints = nearDuplicateHints([first, second], 0.18);
  assert.ok(hints.some(item => item.left.candidateId !== item.right.candidateId));

  const hybrid = fixture.reviews.mix({
    date: fixture.date,
    selection: {
      feelings: [
        { candidateId: first.id, index: 0 },
        { candidateId: second.id, index: 0 },
        { candidateId: second.id, index: 1 },
      ],
      features: [],
    },
  });
  assert.equal(hybrid.feelings.length, 2);
  assert.equal(hybrid.hybrid.exactDuplicatesDropped.feelings, 1);
  assert.ok(hybrid.hybrid.nearDuplicateHints.length >= 1);
});

test("edited hybrid keeps original provenance and sorts feelings by event time", t => {
  const fixture = reviewFixture(t);
  const first = fixture.createCandidate({
    profile: { id: "model-a" },
    feelings: [
      { content: "7月25日，下午三点十九分。下午的事件。", importance: 3 },
      { content: "7月25日，凌晨一点四十九分。凌晨的事件。", importance: 3 },
    ],
  });
  const edited = "7月25日，下午三点十九分。人工核对后的下午事件。";
  const hybrid = fixture.reviews.mix({
    date: fixture.date,
    enforceCountLimit: true,
    selection: {
      feelings: [
        { candidateId: first.id, index: 1, content: edited },
        { candidateId: first.id, index: 0 },
      ],
      features: [],
    },
  });
  assert.deepEqual(hybrid.feelings.map(row => row.content), [
    first.feelings[0].content,
    edited,
  ]);
  const provenance = hybrid.hybrid.selectionProvenance.feelings[1];
  assert.equal(provenance.edited, true);
  assert.match(provenance.originalContentSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.feelings[1].content, "7月25日，下午三点十九分。下午的事件。");
});

test("apply rechecks fingerprint, backs up SQLite and atomically replaces one day", async t => {
  const fixture = reviewFixture(t);
  fixture.store.replaceDay(fixture.date, {
    feelings: [{ content: "旧摘要", importance: 3 }],
    features: [{ content: "旧特征", category: "misc", importance: 3 }],
  });
  const candidate = fixture.createCandidate({
    profile: { id: "model-a" },
    feelings: [{ content: "7月25日，早上八点。新摘要。", importance: 3 }],
    features: [{ content: "新特征", category: "relation", importance: 3 }],
  });
  const result = await fixture.reviews.apply(candidate.id);
  assert.equal(result.ok, true);
  assert.match(result.backup.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.store.listFeelings({ date: fixture.date })[0].content, "7月25日，早上八点。新摘要。");
  assert.equal(fixture.store.listFeatures({ date: fixture.date })[0].content, "新特征");
  assert.equal(fixture.reviews.load(candidate.id).status, "applied");
  assert.ok(fs.existsSync(path.join(fixture.memoryDir, "backups", result.backup.filename)));
});

test("mix and apply reject stale candidates after messages change", async t => {
  const fixture = reviewFixture(t);
  const first = fixture.createCandidate({
    profile: { id: "model-a" },
    feelings: [{ content: "7月25日，早上八点。候选。", importance: 3 }],
  });
  fixture.store.insertMessages([{
    timestamp: "2026-07-25T02:00:00.000Z",
    sourceDate: fixture.date,
    role: "user",
    text: "new message",
  }]);
  assert.throws(() => fixture.reviews.mix({
    date: fixture.date,
    selection: { feelings: [{ candidateId: first.id, index: 0 }], features: [] },
  }), /messages changed/);
  await assert.rejects(() => fixture.reviews.apply(first.id), /messages changed/);
});

function reviewFixture(t) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-review-"));
  const threadId = "review-test-thread";
  const date = "2026-07-25";
  const store = new MemoryStore({ memoryDir, threadId });
  store.insertMessages([
    {
      timestamp: "2026-07-25T00:00:00.000Z",
      sourceDate: date,
      role: "user",
      text: "hello",
    },
    {
      timestamp: "2026-07-25T00:01:00.000Z",
      sourceDate: date,
      role: "assistant",
      text: "hi",
    },
  ]);
  const reviews = new MiningReviewStore({ memoryDir, threadId });
  const fingerprint = archiveFingerprint(store.listMessages({ date }));
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });
  return {
    memoryDir,
    threadId,
    date,
    store,
    reviews,
    createCandidate(input) {
      return reviews.createCandidate({
        date,
        archiveFingerprint: fingerprint,
        messageCount: 2,
        chunkCount: 1,
        priorCounts: { feelings: 0, features: 0 },
        features: [],
        ...input,
      });
    },
  };
}
