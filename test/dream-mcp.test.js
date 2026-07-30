const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DreamStore } = require("../src/storage/dream-store");
const { MemoryStore } = require("../src/storage/memory-store");

test("MCP exposes latest, coverage, and exact-date dream reads", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneRoot = path.join(home, ".stone_memory");
  const databasePath = path.join(stoneRoot, "stone-memory.db");
  fs.mkdirSync(stoneRoot, { recursive: true });
  fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
    "thread-test": {
      runtime: "codex",
      purpose: "accompany",
      user: "test-user",
      ai: "test-ai",
    },
  }));

  const previousDatabasePath = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = databasePath;
  try {
    const memoryStore = new MemoryStore({
      memoryDir: path.join(stoneRoot, "fixture-memory"),
      threadId: "thread-test",
    });
    for (const date of ["2026-07-27", "2026-07-28", "2026-07-29"]) {
      memoryStore.replaceDay(date, {
        feelings: [{ content: `feeling-${date}`, importance: 3 }],
        dayState: { status: "completed", feelingCount: 1 },
      });
    }
    memoryStore.close();
  } finally {
    if (previousDatabasePath === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previousDatabasePath;
  }

  const dreamStore = new DreamStore({ root: path.join(stoneRoot, "dream") });
  dreamStore.save({
    threadId: "thread-test",
    date: "2026-07-27",
    dreamType: "beautiful",
    title: "first",
    body: "first body",
  });
  dreamStore.save({
    threadId: "thread-test",
    date: "2026-07-29",
    dreamType: "nightmare",
    title: "latest",
    body: "latest body",
  });

  const responses = callServer([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "stmem_dream_latest", arguments: { thread: "thread-test" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "stmem_dream_status", arguments: { thread: "thread-test" } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "stmem_dream_get",
        arguments: { thread: "thread-test", date: "2026-07-27" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "stmem_dream_get",
        arguments: { thread: "thread-test", date: "2026-07-28" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "stmem_dream_get",
        arguments: { thread: "thread-test" },
      },
    },
  ], {
    HOME: home,
    STMEM_DB_PATH: databasePath,
  });

  const tools = new Map(responses[0].result.tools.map(tool => [tool.name, tool]));
  assert.ok(tools.has("stmem_dream_latest"));
  assert.ok(tools.has("stmem_dream_status"));
  assert.deepEqual(tools.get("stmem_dream_get").inputSchema.required, ["date"]);

  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), {
    threadId: "thread-test",
    date: "2026-07-29",
    dreamType: "nightmare",
    title: "latest",
    body: "latest body",
  });
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), {
    threadId: "thread-test",
    from: "2026-07-27",
    to: "2026-07-29",
    availableDates: ["2026-07-27", "2026-07-29"],
    missingDates: ["2026-07-28"],
  });
  assert.equal(JSON.parse(responses[3].result.content[0].text).body, "first body");
  assert.equal(responses[4].result.isError, false);
  assert.deepEqual(JSON.parse(responses[4].result.content[0].text), {
    threadId: "thread-test",
    date: "2026-07-28",
    dreamType: null,
    title: "",
    body: "",
    found: false,
    message: "指定日期没有梦境",
  });
  assert.equal(responses[5].result.isError, true);
  assert.match(responses[5].result.content[0].text, /YYYY-MM-DD/);
});

function callServer(messages, env) {
  const server = path.join(__dirname, "..", "mcp-server.js");
  const input = messages.map(message => JSON.stringify(message)).join("\n") + "\n";
  const child = spawnSync(process.execPath, [server], {
    env: Object.fromEntries(Object.entries({
      ...process.env,
      STMEM_SKIP_PENDING_REBUILDS: "1",
      STMEM_SEARCH_ONLY: "0",
      STMEM_THREAD_ID: "",
      ...env,
    }).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    input,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
