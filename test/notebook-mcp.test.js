"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { NotebookStore } = require("../src/storage/notebook-store");

test("MCP exposes notebook tools and reads sealed notes", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneRoot = path.join(home, ".stone_memory");
  const databasePath = path.join(stoneRoot, "stone-memory.db");
  fs.mkdirSync(stoneRoot, { recursive: true });
  fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
    "thread-test": { runtime: "codex", purpose: "accompany", user: "user", ai: "ai" },
  }));
  const notebookRoot = path.join(stoneRoot, "runtimes", "codex", "accompany", "thread-test", "memory", "notebook");
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = databasePath;
  const store = new NotebookStore({ threadId: "thread-test", root: notebookRoot });
  const topic = store.createTopic({ name: "论坛笔记" });
  const note = store.writeEntry({ topicId: topic.id, title: "封存的一页", body: "和朋友聊过月亮。", visibility: "sealed" });
  store.close();
  if (previous === undefined) delete process.env.STMEM_DB_PATH;
  else process.env.STMEM_DB_PATH = previous;

  const responses = callServer([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stmem_notebook_status", arguments: { thread: "thread-test" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stmem_notebook_query", arguments: { thread: "thread-test", query: "月亮" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stmem_notebook_read", arguments: { thread: "thread-test", noteId: note.id } } },
  ], { HOME: home, USERPROFILE: home, STMEM_DB_PATH: databasePath });
  const names = new Set(responses[0].result.tools.map(tool => tool.name));
  for (const name of ["stmem_notebook_status", "stmem_notebook_topic_manage", "stmem_notebook_write", "stmem_notebook_query", "stmem_notebook_read"]) {
    assert.ok(names.has(name), name);
  }
  assert.equal(JSON.parse(responses[1].result.content[0].text).topicCount, 1);
  assert.equal(JSON.parse(responses[2].result.content[0].text).matches[0].visibility, "sealed");
  assert.equal(JSON.parse(responses[3].result.content[0].text).body, "和朋友聊过月亮。");

  const create = callServer([
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "stmem_notebook_topic_manage", arguments: { thread: "thread-test", action: "create", name: "游戏攻略", isDefault: true } } },
  ], { HOME: home, USERPROFILE: home, STMEM_DB_PATH: databasePath });
  assert.equal(create[0].result.isError, false, create[0].result.content[0].text);
  const createdTopic = JSON.parse(create[0].result.content[0].text);
  const write = callServer([
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "stmem_notebook_write", arguments: { thread: "thread-test", title: "第一局", body: "先观察，再发言。", tags: ["攻略"] } } },
  ], { HOME: home, USERPROFILE: home, STMEM_DB_PATH: databasePath });
  assert.equal(write[0].result.isError, false, write[0].result.content[0].text);
  const writtenNote = JSON.parse(write[0].result.content[0].text);
  const reread = callServer([
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "stmem_notebook_read", arguments: { thread: "thread-test", noteId: writtenNote.id } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "stmem_notebook_query", arguments: { thread: "thread-test", topicId: createdTopic.id, tags: ["攻略"] } } },
  ], { HOME: home, USERPROFILE: home, STMEM_DB_PATH: databasePath });
  assert.equal(JSON.parse(reread[0].result.content[0].text).body, "先观察，再发言。");
  assert.equal(JSON.parse(reread[1].result.content[0].text).matches[0].id, writtenNote.id);
  const listedWrite = responses[0].result.tools.find(tool => tool.name === "stmem_notebook_write");
  assert.deepEqual(listedWrite.inputSchema.required, ["title", "body"]);
});

function callServer(messages, env) {
  const server = path.join(__dirname, "..", "mcp-server.js");
  const input = `${messages.map(message => JSON.stringify(message)).join("\n")}\n`;
  const child = spawnSync(process.execPath, [server], {
    env: Object.fromEntries(Object.entries({
      ...process.env, STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_SEARCH_ONLY: "0", STMEM_THREAD_ID: "", ...env,
    }).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    input,
    encoding: "utf8",
    timeout: 3_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
