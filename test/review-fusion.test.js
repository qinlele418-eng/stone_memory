const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const { archiveFingerprint } = require("../src/services/mining-state");
const { MiningReviewStore } = require("../src/services/mining-review");
const {
  buildFusionPlan,
  editFusionCandidate,
  fuseReviewCandidate,
  materializeFusion,
  preciseFeelingEventTime,
} = require("../src/services/review-fusion");

test("same-event fusion merges duplicate groups while preserving unique rows and source audit", async t => {
  const fixture = fusionFixture(t);
  const first = fixture.createCandidate({
    profile: {
      id: "subagent:codex:gpt-5.6-sol:xhigh",
      label: "gpt-5.6-sol极高",
      channel: "subagent",
      runtime: "codex",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
    },
    feelings: [
      { content: "7月25日，下午三点十九分。她完成了 Stone 同事件融合实验，保留了时间和关键词。", importance: 3 },
      { content: "7月25日，晚上六点。她去吃晚饭，这是另一个事件。", importance: 2 },
    ],
    features: [
      { content: "她希望记忆融合保留准确时间和检索关键词", category: "preference", importance: 3 },
    ],
  });
  const second = fixture.createCandidate({
    profile: {
      id: "api:deepseek:test",
      label: "ds pro",
      channel: "api",
      provider: "deepseek",
      model: "test",
    },
    feelings: [
      { content: "7月25日，下午三点十九分。她完成 Stone 同事件融合实验，并保留准确时间与检索关键词。", importance: 3 },
    ],
    features: [
      { content: "她要求融合后的记忆保留时间及关键词，避免影响检索", category: "preference", importance: 3 },
    ],
  });
  const hybrid = fixture.reviews.mix({
    date: fixture.date,
    selection: {
      feelings: [
        { candidateId: first.id, index: 0 },
        { candidateId: second.id, index: 0 },
        { candidateId: first.id, index: 1 },
      ],
      features: [
        { candidateId: first.id, index: 0 },
        { candidateId: second.id, index: 0 },
      ],
    },
  });
  const plan = buildFusionPlan(hybrid, [first, second]);
  assert.equal(plan.groups.feelings.length, 1);
  assert.equal(plan.groups.features.length, 1);

  const response = {
    feelings: plan.groups.feelings.map(group => ({
      groupId: group.id,
      memberIds: group.members.map(row => row.id),
      merge: true,
      content: "7月25日，下午三点十九分。她完成了 Stone 同事件融合实验，保留了准确时间与检索关键词。",
    })),
    features: plan.groups.features.map(group => ({
      groupId: group.id,
      memberIds: group.members.map(row => row.id),
      merge: true,
      content: "她希望融合后的记忆保留准确时间和检索关键词，避免影响检索",
    })),
  };
  const fused = await fuseReviewCandidate({
    reviews: fixture.reviews,
    sourceCandidateId: hybrid.id,
    writerProfile: first.profile,
    generate: async () => response,
  });

  assert.equal(fused.profile.id, "fusion");
  assert.equal(fused.feelings.length, 2);
  assert.equal(fused.features.length, 1);
  assert.equal(fused.fusion.stats.mergedGroups, 2);
  assert.equal(fused.fusion.provenance.feelings[0].sources.length, 2);
  assert.match(fused.fusion.provenance.feelings[0].sources[0].content, /同事件融合实验/);
  assert.equal(fused.fusion.provenance.feelings[0].sources[0].eventTime, "2026-07-25T07:19:00.000Z");
  const edited = editFusionCandidate({
    reviews: fixture.reviews,
    candidateId: fused.id,
    edits: {
      feelings: [{
        index: 0,
        content: "7月25日，下午三点十九分。她完成 Stone 同事件融合实验，并亲手校正了融合预览。",
      }],
    },
  });
  assert.match(edited.feelings[0].content, /亲手校正/);
  assert.equal(edited.fusion.manualEdits.length, 1);
  assert.match(fixture.reviews.load(hybrid.id).feelings[0].content, /保留了时间和关键词/);
  assert.equal(fixture.store.listFeelings({ date: fixture.date }).length, 0);
  assert.throws(() => editFusionCandidate({
    reviews: fixture.reviews,
    candidateId: fused.id,
    edits: { feelings: [{ index: 0, content: "7月25日，下午四点十九分。时间被错误移动。" }] },
  }), /changed the event time beyond the safe window/);
  assert.equal(fixture.reviews.load(hybrid.id).status, "review_pending");
  assert.equal(fixture.store.listMessages({ date: fixture.date }).length, 2);
});

test("fusion rejects a rewritten feeling that moves beyond the source event time", t => {
  const plan = {
    date: "2026-07-25",
    rows: { feelings: [], features: [] },
    groups: {
      feelings: [{
        id: "feelings-group-1",
        members: [
          sourceRow("feelings:0", "2026-07-25T07:19:00.000Z"),
          sourceRow("feelings:1", "2026-07-25T07:19:00.000Z"),
        ],
      }],
      features: [],
    },
  };
  assert.throws(() => materializeFusion(plan, {
    feelings: [{
      groupId: "feelings-group-1",
      memberIds: ["feelings:0", "feelings:1"],
      merge: true,
      content: "7月25日，下午四点十九分。错误地移动了一小时。",
    }],
    features: [],
  }), /changed the event time beyond the safe window/);
});

test("fusion parses Chinese zero-padded minutes without rounding them to the hour", () => {
  assert.equal(
    preciseFeelingEventTime("7月25日，上午十一点零五分。她发来镜像自拍。", "2026-07-25"),
    "2026-07-25T03:05:00.000Z",
  );
});

function sourceRow(id, eventTime) {
  return {
    id,
    index: Number(id.split(":")[1]),
    kind: "feelings",
    content: "7月25日，下午三点十九分。同一事件。",
    eventTime,
    importance: 3,
    candidateId: `candidate-${id}`,
    profileId: "source",
    modelLabel: "source",
  };
}

function fusionFixture(t) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-fusion-"));
  const threadId = "fusion-test-thread";
  const date = "2026-07-25";
  const store = new MemoryStore({ memoryDir, threadId });
  store.insertMessages([
    { timestamp: "2026-07-25T07:19:00.000Z", sourceDate: date, role: "user", text: "开始测试" },
    { timestamp: "2026-07-25T07:20:00.000Z", sourceDate: date, role: "assistant", text: "测试完成" },
  ]);
  const reviews = new MiningReviewStore({ memoryDir, threadId });
  const fingerprint = archiveFingerprint(store.listMessages({ date }));
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });
  return {
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
        feelings: [],
        features: [],
        ...input,
      });
    },
  };
}
