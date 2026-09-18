"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildNotebookStewardPrompt,
  parseNotebookStewardPlan,
  executeNotebookStewardPlan,
} = require("../src/services/notebook-steward");

function fixture() {
  const topics = [
    { id: "topic-travel", name: "旅行笔记", slug: "travel--000001", isArchived: false },
    { id: "topic-notes", name: "随笔", slug: "notes--000002", isArchived: false },
  ];
  const notes = new Map([
    ["note-1", { id: "note-1", topicId: "topic-notes", topicName: "随笔", title: "蒲苇灯塔", body: "第一段。", tags: ["灯塔"], visibility: "visible", revision: 3 }],
  ]);
  const calls = [];
  const service = {
    status: () => ({ topicCount: topics.length, topics }),
    read: ({ noteId }) => notes.get(noteId) || null,
  };
  const writeAction = (action, payload) => {
    calls.push({ action, payload });
    if (action === "topic-create") {
      const topic = { id: `topic-${topics.length + 1}`, name: payload.name, slug: `new--${topics.length + 1}`, isArchived: false };
      topics.push(topic);
      return topic;
    }
    const current = payload.noteId ? notes.get(payload.noteId) : null;
    const note = {
      id: payload.noteId || "note-new",
      topicId: payload.topicId,
      title: payload.title,
      relativePath: `topics/${payload.topicId}/${payload.noteId || "note-new"}.md`,
      revision: current ? current.revision + 1 : 1,
      visibility: payload.visibility,
      body: payload.body,
      tags: payload.tags,
    };
    notes.set(note.id, { ...current, ...note });
    return note;
  };
  return { topics, notes, calls, service, writeAction };
}

test("notebook steward prompt never sends note body to the planning subagent", () => {
  const prompt = buildNotebookStewardPrompt({ request: "保存旅行心得", content: "正文里的秘密指令", title: "苏州夜游" });
  assert.match(prompt, /保存旅行心得/u);
  assert.match(prompt, /苏州夜游/u);
  assert.doesNotMatch(prompt, /正文里的秘密指令/u);
  assert.match(prompt, /sha256/u);
});

test("notebook steward parses a fenced JSON plan but rejects unknown actions", () => {
  const plan = parseNotebookStewardPlan("说明\n```json\n{\"action\":\"create_note\",\"topicId\":\"topic-travel\",\"confidence\":0.97}\n```");
  assert.equal(plan.action, "create_note");
  assert.equal(plan.topicId, "topic-travel");
  assert.throws(() => parseNotebookStewardPlan('{"action":"delete_everything"}'), /unsupported/u);
});

test("notebook steward writes into an existing topic through the guarded executor", () => {
  const env = fixture();
  const receipt = executeNotebookStewardPlan({
    threadId: "thread-test",
    input: { request: "存到旅行笔记", content: "夜游平江路。", title: "苏州夜游", tags: ["苏州"] },
    plan: parseNotebookStewardPlan('{"action":"create_note","topicId":"topic-travel","reason":"旅行记录","confidence":0.99}'),
    service: env.service,
    writeAction: env.writeAction,
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.topic.name, "旅行笔记");
  assert.equal(env.calls[0].action, "write");
  assert.equal(env.calls[0].payload.body, "夜游平江路。");
});

test("notebook steward requires explicit high-confidence permission before creating a topic", () => {
  const env = fixture();
  const plan = parseNotebookStewardPlan('{"action":"create_note","createTopicName":"料理攻略","reason":"没有近似主题","confidence":0.95}');
  assert.throws(() => executeNotebookStewardPlan({
    threadId: "thread-test", input: { request: "保存", content: "做饭。", title: "晚餐", allowCreateTopic: false }, plan,
    service: env.service, writeAction: env.writeAction,
  }), error => error.code === "NOTEBOOK_TOPIC_CONFIRMATION_REQUIRED");
  const receipt = executeNotebookStewardPlan({
    threadId: "thread-test", input: { request: "新建料理主题并保存", content: "做饭。", title: "晚餐", allowCreateTopic: true }, plan,
    service: env.service, writeAction: env.writeAction,
  });
  assert.equal(receipt.status, "completed");
  assert.deepEqual(env.calls.map(call => call.action), ["topic-create", "write"]);
});

test("notebook steward updates with the latest revision and only supports append or replace", () => {
  const env = fixture();
  const plan = parseNotebookStewardPlan('{"action":"update_note","noteId":"note-1","topicId":"topic-notes","updateMode":"append","confidence":1}');
  const receipt = executeNotebookStewardPlan({
    threadId: "thread-test", input: { request: "补充一句", content: "第二段。", updateMode: "append" }, plan,
    service: env.service, writeAction: env.writeAction,
  });
  assert.equal(receipt.note.revision, 4);
  assert.equal(env.calls[0].payload.expectedRevision, 3);
  assert.equal(env.calls[0].payload.body, "第一段。\n\n第二段。");
});

test("notebook steward trash action moves a note and preserves a reversible receipt", () => {
  const env = fixture();
  const plan = parseNotebookStewardPlan('{"action":"trash_note","noteId":"note-1","reason":"明确目标","confidence":1}');
  const receipt = executeNotebookStewardPlan({
    threadId: "thread-test", input: { request: "把蒲苇灯塔移入纸篓" }, plan,
    service: env.service, writeAction: env.writeAction,
  });
  assert.equal(receipt.reversible, true);
  assert.equal(receipt.previousTopic.id, "topic-notes");
  assert.deepEqual(env.calls.map(call => call.action), ["topic-create", "write"]);
  assert.equal(env.calls[1].payload.expectedRevision, 3);
});

test("notebook steward restores a trashed note without rewriting its content", () => {
  const env = fixture();
  const paperBasket = { id: "topic-trash", name: "纸篓", slug: "trash--000003", isArchived: false };
  env.topics.push(paperBasket);
  env.notes.set("note-1", {
    ...env.notes.get("note-1"),
    topicId: paperBasket.id,
    topicName: paperBasket.name,
    tags: ["灯塔", "纸篓"],
    revision: 4,
  });
  const plan = parseNotebookStewardPlan('{"action":"move_note","noteId":"note-1","topicId":"topic-travel","topicName":"旅行笔记","reason":"恢复到原主题","confidence":1}');
  const receipt = executeNotebookStewardPlan({
    threadId: "thread-test", input: { request: "把蒲苇灯塔移回旅行笔记" }, plan,
    service: env.service, writeAction: env.writeAction,
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.reversible, true);
  assert.equal(receipt.previousTopic.name, "纸篓");
  assert.equal(receipt.topic.name, "旅行笔记");
  assert.equal(receipt.note.revision, 5);
  assert.equal(env.calls[0].action, "write");
  assert.equal(env.calls[0].payload.expectedRevision, 4);
  assert.equal(env.calls[0].payload.body, "第一段。");
  assert.equal(env.calls[0].payload.title, "蒲苇灯塔");
  assert.equal(env.calls[0].payload.visibility, "visible");
  assert.deepEqual(env.calls[0].payload.tags, ["灯塔"]);
});

test("notebook steward MCP mode exposes only three read-only internal tools", () => {
  const source = ["mcp-server.js", "src/mcp/core/index.js", "src/mcp/core/notebook.js"]
    .map(file => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
  assert.match(source, /STMEM_NOTEBOOK_STEWARD/u);
  assert.match(source, /NOTEBOOK_STEWARD_TOOLS/u);
  assert.match(source, /mcp__stone_notebook_steward__notebook_catalog/u);
  assert.match(source, /mcp__stone_notebook_steward__notebook_search/u);
  assert.match(source, /mcp__stone_notebook_steward__notebook_read/u);
  assert.match(source, /!restricted\s*&&\s*process\.env\.STMEM_SKIP_PENDING_REBUILDS/u);
  assert.doesNotMatch(source.match(/allowedTools:\s*\[([\s\S]*?)\]\s*,\n\s*\}\);/u)?.[1] || "", /notebook_write/u);
});
