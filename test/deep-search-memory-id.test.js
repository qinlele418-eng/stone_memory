const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-deep-memory-id-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const { resolveMcpThread } = require("../src/services/mcp-thread-resolution");
const { createMemory, updateMemorySettings } = require("../src/services/memory-setup");
const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const root = path.resolve(__dirname, "..");

test("resolver maps host sessions to memory IDs and rejects ambiguous or unknown targets", () => {
  const cfg = { memories: { one: { memoryId: "one" }, two: { memoryId: "two" } } };
  const options = { readBindings: id => [{ externalThreadId: `${id}-session`, enabled: false }] };
  for (const id of ["one", "two"]) {
    assert.equal(resolveMcpThread({ memoryId: id }, cfg, [], {}, options), id);
    assert.equal(resolveMcpThread({ thread: id }, cfg, [], {}, options), id);
    assert.equal(resolveMcpThread({ thread: `${id}-session` }, cfg, [], {}, options), id);
    for (const key of ["STMEM_CURRENT_THREAD_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "STMEM_THREAD_ID"]) {
      assert.equal(resolveMcpThread({}, cfg, [], { [key]: `${id}-session` }, options), id);
    }
  }
  assert.equal(resolveMcpThread({ memoryId: "two", thread: "one-session" }, cfg, [], {}, options), "two");
  assert.equal(resolveMcpThread({ thread: "two-session" }, cfg, [], { STMEM_THREAD_ID: "one" }, options), "two");
  assert.throws(() => resolveMcpThread({}, cfg, [], {}, { ...options, resolveCallingBinding: () => null }), /多个记忆体/);
  assert.equal(resolveMcpThread({}, cfg, [], {}, { ...options, resolveCallingBinding: () => ({ memoryId: "two" }) }), "two");
  assert.throws(() => resolveMcpThread({ thread: "missing" }, cfg, [], {}, options), /未找到/);
  assert.throws(() => resolveMcpThread({ thread: "duplicate" }, cfg, [], {}, {
    readBindings: () => [{ externalThreadId: "duplicate" }],
  }), /多个记忆体/);
  assert.throws(() => resolveMcpThread({ thread: "apiKeys" }, { apiKeys: {} }, [], {}), /未配置线程/);
  assert.equal(resolveMcpThread({}, { memories: { one: {} } }, [], {}, { ...options, resolveCallingBinding: () => null }), "one");
  assert.throws(() => resolveMcpThread({}, { memories: { one: {} } }, [], {}, { ...options, allowSoleMemory: false, resolveCallingBinding: () => null }), /显式指定记忆体/);
});

function fixture(label, session, enabled) {
  const memory = createMemory({ label });
  updateMemorySettings(memory.memoryId, { ai: "Fixture", user: "Reader", purpose: "accompany" }, { apply: true });
  const directory = getThreadDir(memory.memoryId);
  fs.writeFileSync(path.join(directory, "bindings.json"), JSON.stringify({ schemaVersion: 1, revision: 1,
    primaryBindingId: "primary", bindings: [{ id: "primary", provider: "codex", externalThreadId: session, enabled }] }));
  const store = new MemoryStore({ memoryDir: path.join(directory, "memory"), threadId: memory.memoryId });
  try {
    store.registerThread({ runtime: "codex", purpose: "accompany", label });
    store.insertMessages([{ timestamp: "2026-09-20T06:35:00Z", sourceDate: "2026-09-20", role: "user", text: `${label}的测试灯塔原文。` }]);
    store.replaceDay("2026-09-20", { feelings: [{ id: `${memory.memoryId}-feeling`, eventTime: "2026-09-20T06:35:00Z",
      content: `9月20日，下午两点三十五分。${label}的测试灯塔摘要。`, importance: 4 }], features: [], source: "manual" });
  } finally { store.close(); }
  return memory.memoryId;
}

test("real MCP dispatch and child retrieval use the requesting Binding's canonical memory", () => {
  const first = fixture("第一份", "session-one", true);
  const second = fixture("第二份", "session-two", false);
  const preload = path.join(home, "fake-generation.cjs");
  // Replace only the external model call. Actual MCP transport, identity resolution,
  // child MCP configuration, SQL keyword retrieval and archive lookup still run.
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    require(${JSON.stringify(path.join(root, "src/services/subagent-runner.js"))}).runSubagent = (_, options) => {
      const server = JSON.parse(fs.readFileSync(options.mcpConfig, 'utf8')).mcpServers.stone_memory_search;
      if (server.env.STMEM_THREAD_ID !== options.threadId) throw Error('Wrong child identity');
      const calls = [
        { jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'memory_keyword_search',arguments:{query:'测试灯塔'}} },
        { jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'memory_archive_context',arguments:{keywords:'测试灯塔',feelingDate:'2026-09-20'}} }
      ];
      const child = spawnSync(server.command, server.args, { cwd:server.cwd,
        env:{...process.env,...server.env}, input:calls.map(JSON.stringify).join('\\n')+'\\n', encoding:'utf8', timeout:10000 });
      if (child.status !== 0) throw Error(child.stderr);
      const responses = child.stdout.trim().split(/\\r?\\n/).map(JSON.parse);
      if (responses.some(row => row.result.isError)) throw Error('Child retrieval failed');
      return JSON.stringify({ memoryId: options.threadId,
        keyword: responses[0].result.content[0].text.includes('第二份'),
        archive: responses[1].result.content[0].text.includes('第二份'),
        leaked: responses.some(row => row.result.content[0].text.includes('第一份')) });
    };
  `);
  function call(args, host = "", name = "stmem_memory_deep_search") {
    const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_SKIP_PENDING_REBUILDS: "1" };
    for (const key of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "STMEM_MEMORY_ID", "STMEM_THREAD_ID", "STMEM_BINDING_ID",
      "STMEM_CURRENT_THREAD_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "STMEM_SEARCH_ONLY", "STMEM_NOTEBOOK_STEWARD"]) delete env[key];
    if (host) env.CODEX_THREAD_ID = host;
    const child = spawnSync(process.execPath, ["--require", preload, path.join(root, "mcp-server.js")], {
      env, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { query: "测试灯塔", ...args } } }) + "\n",
      encoding: "utf8", timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.trim(), child.stderr || child.error?.message || "MCP server returned no response");
    return JSON.parse(child.stdout.trim()).result;
  }
  for (const [args, host] of [[{ thread: "session-two" }, ""], [{ thread: second }, ""], [{ memoryId: second }, ""], [{}, "session-two"], [{ memoryId: second }, "session-one"]]) {
    const result = call(args, host);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), { memoryId: second, keyword: true, archive: true, leaked: false });
  }
  const sessionFile = path.join(home, "session-two.jsonl");
  const bindingsFile = path.join(getThreadDir(second), "bindings.json");
  const bindingConfig = JSON.parse(fs.readFileSync(bindingsFile, "utf8"));
  bindingConfig.bindings[0].resolvedThreadFile = sessionFile;
  fs.writeFileSync(bindingsFile, JSON.stringify(bindingConfig));
  const pendingCall = { type: "response_item", timestamp: new Date().toISOString(), payload: {
    type: "function_call", call_id: "pending-stmem-call", name: "mcp__stmem__stmem_memory_deep_search", arguments: "{\"query\":\"测试灯塔\"}",
  } };
  fs.writeFileSync(sessionFile, `${JSON.stringify(pendingCall)}\n`);
  const inferred = call({});
  assert.equal(inferred.isError, false, JSON.stringify(inferred));
  assert.equal(JSON.parse(inferred.content[0].text).memoryId, second);
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call_output", call_id: "pending-stmem-call", output: "ok" } })}\n`);
  const keyword = call({ thread: "session-two" }, "", "stmem_memory_search");
  assert.equal(keyword.isError, false);
  assert.match(keyword.content[0].text, /第二份/);
  assert.doesNotMatch(keyword.content[0].text, /第一份/);
  assert.equal(call({ thread: "missing" }, "session-one").isError, true);
  assert.equal(call({}).isError, true);
  assert.notEqual(first, second);
});
