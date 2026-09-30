const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { childEnvWithHome } = require("../test-support/child-env");

const root = path.resolve(__dirname, "..");
const stmem = path.join(root, "bin", "stmem");
const server = path.join(root, "mcp-server.js");

function run(home, args) {
  const env = childEnvWithHome(home);
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [stmem, ...args], {
    cwd: root, env, encoding: "utf8",
  });
}

function createMemory(home, label) {
  const created = run(home, ["memory", "create", "--name", label]);
  assert.equal(created.status, 0, created.stderr);
  return JSON.parse(created.stdout).memory;
}

function callMcp(home, messages, env = {}) {
  const input = `${messages.map(message => JSON.stringify(message)).join("\n")}\n`;
  const childEnv = childEnvWithHome(home, { STMEM_SKIP_PENDING_REBUILDS: "1", ...env });
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [server], {
    cwd: root,
    env: childEnv,
    input, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test("MCP exposes one current-window bind tool and refuses cross-memory rebinding", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = createMemory(home, "第一记忆体");
  const second = createMemory(home, "第二记忆体");
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "rollout-current-window.jsonl"), "{}\n");
  const environment = {
    CODEX_THREAD_ID: "current-window",
    STMEM_CURRENT_SESSION_ROOT: sessions,
  };

  const responses = callMcp(home, [
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "第一记忆体" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: second.memoryId } } },
  ], environment);

  const bindTool = responses[0].result.tools.find(tool => tool.name === "stmem_memory_bind");
  assert.deepEqual(bindTool.inputSchema.required, ["memory", "thread", "provider"]);
  assert.deepEqual(Object.keys(bindTool.inputSchema.properties), ["memory", "thread", "provider"]);
  assert.match(responses[1].result.content[0].text, /已绑定到记忆体“第一记忆体”.*已自动开启对话录入和自动生成摘要/);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].result.isError, true);
  assert.match(responses[2].result.content[0].text, /已绑定到其他记忆体.*不支持改绑/);

  const firstBindings = JSON.parse(run(home, ["binding", "list", "--memory", first.memoryId]).stdout);
  const secondBindings = JSON.parse(run(home, ["binding", "list", "--memory", second.memoryId]).stdout);
  assert.equal(firstBindings.bindings[0].externalThreadId, "current-window");
  assert.equal(secondBindings.bindings.length, 0);
  const watcher = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "memories", first.memoryId, "watcher.json"), "utf8"));
  assert.equal(watcher.enabled, true);
  assert.equal(watcher.modules.archive, true);
  assert.equal(watcher.modules.miner, true);
  assert.equal(watcher.modules.compression, false);
});

test("MCP bind accepts per-call thread identity when the server process has no session env", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-request-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const memory = createMemory(home, "请求身份记忆体");
  const sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive:true });
  fs.writeFileSync(path.join(sessions, "rollout-request-window.jsonl"), "{}\n");

  const responses = callMcp(home, [{
    jsonrpc:"2.0", id:1, method:"tools/call",
    params:{ name:"stmem_memory_bind", arguments:{ memory:"请求身份记忆体", thread:"request-window", provider:"codex" } },
  }], { CODEX_THREAD_ID:"", CLAUDE_CODE_SESSION_ID:"", STMEM_CURRENT_THREAD_ID:"", CODEX_HOME:path.join(home, ".codex") });

  assert.equal(responses[0].result.isError, false);
  assert.match(responses[0].result.content[0].text, /已绑定到记忆体“请求身份记忆体”/u);
  const bindings = JSON.parse(run(home, ["binding", "list", "--memory", memory.memoryId]).stdout);
  assert.equal(bindings.bindings[0].externalThreadId, "request-window");
});

test("MCP bind reports the host-specific setup when the current window id is unavailable", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  createMemory(home, "待绑定记忆体");

  const responses = callMcp(home, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "待绑定记忆体" } } },
  ], { CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", STMEM_CURRENT_THREAD_ID: "" });

  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.content[0].text, /本次 Bind 请求中传入 thread 与 provider/u);
});

// TASK-0376: provider=pando。fixture 直接以 fs 组装 memoryId=finn 的 memory-v1
// 骨架（与 memory-setup.createMemory 同构），HOME 内没有任何会话文件。
function createFinnMemoryHome(home) {
  const root = path.join(home, ".stone_memory", "memories", "finn");
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
  write("memory.json", {
    schemaVersion: 1, memoryId: "finn", label: "Finn", status: "draft",
    purpose: null, ai: "", user: "", userGender: "unspecified", relationshipTimeline: [],
    mcpModules: ["notebook-lab", "dream-lab"], mcpModuleConfigVersion: 1,
    miner: { mode: null, apiProfile: null },
    rebuild: { windowDays: 1, keepToolPairs: 15, contextWindowTokens: null, mcpRebuildDefaultsEnabled: false, mcpSummaryLimit: 0, mcpMinImportance: 0 },
    createdAt: now, updatedAt: now,
  });
  write("bindings.json", { schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] });
  write("watcher.json", { schemaVersion: 1, enabled: false, modules: { archive: false, miner: false, compression: false, dream: false } });
  write(".layout-v1.json", { schemaVersion: 1, status: "complete", memoryId: "finn", origin: "created", completedAt: now });
  const configFile = path.join(home, ".stone_memory", "stmem.json");
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  config.memories = config.memories || {};
  config.memories.finn = { memoryId: "finn", label: "Finn", status: "draft", createdAt: now, updatedAt: now, bindings: [] };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

const neutralWindowEnv = {
  CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", STMEM_CURRENT_THREAD_ID: "",
  STMEM_CURRENT_PROVIDER: "", PANDO_THREAD_ID: "",
};

test("MCP bind accepts provider=pando with no session files and binds memoryId=finn idempotently", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-pando-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  createFinnMemoryHome(home);

  const bind = { name: "stmem_memory_bind", arguments: { memory: "finn", thread: "pando-conv-001", provider: "pando" } };
  const responses = callMcp(home, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: bind },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: bind },
  ], neutralWindowEnv);

  assert.equal(responses[0].result.isError, false);
  assert.match(responses[0].result.content[0].text, /已绑定到记忆体“Finn”（finn）/u);
  assert.equal(responses[1].result.isError, false);
  assert.match(responses[1].result.content[0].text, /此前已经绑定到记忆体“Finn”/u);

  const bindings = JSON.parse(run(home, ["binding", "list", "--memory", "finn"]).stdout);
  assert.equal(bindings.bindings.length, 1);
  assert.equal(bindings.bindings[0].provider, "pando");
  assert.equal(bindings.bindings[0].externalThreadId, "pando-conv-001");
  assert.equal(bindings.bindings[0].mode, "import_only");
  assert.equal(bindings.bindings[0].sessionRoot, null);
  assert.equal(bindings.bindings[0].resolvedThreadFile, null);
  assert.equal(bindings.primaryBindingId, bindings.bindings[0].id);
});

test("MCP pando bind falls back to PANDO_THREAD_ID env when the request carries only the memory", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-pando-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  createFinnMemoryHome(home);

  const responses = callMcp(home, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "finn" } } },
  ], { ...neutralWindowEnv, PANDO_THREAD_ID: "pando-conv-env" });

  assert.equal(responses[0].result.isError, false);
  assert.match(responses[0].result.content[0].text, /已绑定到记忆体“Finn”/u);
  const bindings = JSON.parse(run(home, ["binding", "list", "--memory", "finn"]).stdout);
  assert.equal(bindings.bindings[0].externalThreadId, "pando-conv-env");
});

test("MCP pando bind fails explicitly on wrong provider, illegal thread and cross-memory rebinding", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-pando-err-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  createFinnMemoryHome(home);
  const second = createMemory(home, "第二记忆体");

  const responses = callMcp(home, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "finn", thread: "pando-conv-001", provider: "pando" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: second.label, thread: "pando-conv-001", provider: "pando" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "finn", thread: "pando-conv-err", provider: "pandoc" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stmem_memory_bind", arguments: { memory: "finn", thread: "bad thread", provider: "pando" } } },
  ], neutralWindowEnv);

  assert.equal(responses[0].result.isError, false);
  assert.equal(responses[1].result.isError, true);
  assert.match(responses[1].result.content[0].text, /已绑定到其他记忆体.*不支持改绑/u);
  assert.equal(responses[2].result.isError, true);
  assert.match(responses[2].result.content[0].text, /无法识别当前窗口属于 Codex 还是 Claude Code/u);
  assert.equal(responses[3].result.isError, true);
  assert.match(responses[3].result.content[0].text, /不是合法线程 ID/u);
  const secondBindings = JSON.parse(run(home, ["binding", "list", "--memory", second.memoryId]).stdout);
  assert.equal(secondBindings.bindings.length, 0);
});
