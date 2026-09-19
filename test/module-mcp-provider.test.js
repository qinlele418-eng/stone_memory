const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Registry } = require("../src/mcp/registry");
const { validateManifest } = require("../src/services/developer-module-contract");
const { resolveProvider, validateTools, validateInput } = require("../src/mcp/provider-contract");
const { readConfig, planChange, applyChange } = require("../src/services/developer-module-mcp-config");
const { loadModuleProviders } = require("../src/mcp/module-provider-loader");
const { createContext } = require("../src/mcp/context");
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const definition = () => ({ name: "read", description: "fixture read", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false }, annotations: { ...annotations } });
const manifest = (id = "fixture", scope = "memory") => ({ id, version: "1.0.0", sdkVersion: 2, scope, permissions: ["mcp:tools"], entry: { mcp: "backend/mcp.js" } });
const options = { state: { globalEnabled: true, memories: { alpha: true, beta: false } }, memoryIds: ["alpha", "beta"] };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-provider-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function install(root, m, source = 'module.exports = { tools: () => [], call: () => ({content: []}) };') {
  const dir = path.join(root, m.id);
  fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, "backend/mcp.js"), source);
  return dir;
}
test("manifest preserves v1 and requires v2 permission and confined provider entry", t => {
  assert.deepEqual(validateManifest({ ...manifest(), sdkVersion: 1, entry: {} }), []);
  assert.equal(validateManifest(manifest()).length, 0);
  for (const change of [{ permissions: [] }, { sdkVersion: 1 }, { entry: { mcp: "../bad.js" } }, { entry: { mcp: "C:\\bad.js" } }]) assert.ok(validateManifest({ ...manifest(), ...change }).length);
  const root = fixture(t);
  const dir = install(root, manifest());
  assert.equal(resolveProvider(dir, "backend/mcp.js"), path.join(dir, "backend/mcp.js"));
  for (const entry of ["../bad.js", "/tmp/bad.js", "C:\\bad.js", "backend/../backend/mcp.js", "missing.js"]) assert.throws(() => resolveProvider(dir, entry));
});
test("provider path rejects a linked directory", t => {
  const root = fixture(t);
  const dir = install(root, manifest());
  const external = path.join(root, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "mcp.js"), "");
  fs.symlinkSync(external, path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveProvider(dir, "linked/mcp.js"), /SYMLINK/);
});
test("registry validates names, closed schemas, annotations, JSON and collisions atomically", () => {
  for (const mutate of [d => d.name = "BAD", d => delete d.annotations.readOnlyHint, d => d.inputSchema.additionalProperties = true, d => d.inputSchema.pattern = "x", d => d.description = () => "x", d => d.annotations.readOnlyHint = false]) {
    const tool = definition(); mutate(tool);
    assert.throws(() => validateTools(manifest(), [tool]));
  }
  const registry = new Registry();
  assert.throws(() => registry.registerModule(manifest(), { async tools() { throw new Error("bad asynchronous definition"); }, call() {} }, options), /SYNCHRONOUS/);
  registry.registerCore({ tools: [{ name: "stmem_fixture_read" }], call: () => "core" });
  assert.throws(() => registry.registerModule(manifest(), { tools: () => [{ ...definition(), name: "other" }, definition()], call() {} }, options), /CONFLICT/);
  assert.equal(registry.list().length, 1);
});
test("module calls validate explicit authorized memory and isolate failures and timeout", async () => {
  const registry = new Registry();
  let calls = 0, signal;
  registry.registerModule(manifest(), {
    tools: () => [definition()],
    async call(context, name, args) {
      calls++;
      if (args.query === "fail") throw new Error("SECRET /private/home conversation");
      if (args.query === "null-error") throw null;
      if (args.query === "bad") return { text: "wrong shape" };
      if (args.query === "slow") { signal = context.signal; return new Promise(() => {}); }
      return { content: [{ type: "text", text: context.memoryId }], isError: false };
    },
  }, { ...options, timeoutMs: 20 });
  const call = args => registry.call("stmem_fixture_read", args);
  for (const args of [{ query: "ok" }, { memoryId: "beta", query: "ok" }, { memoryId: "../alpha", query: "ok" }, { memoryId: "alpha", query: "ok", extra: true }, { memoryId: "alpha", query: "" }]) assert.equal((await call(args)).isError, true);
  assert.equal(calls, 0);
  assert.equal((await call({ memoryId: "alpha", query: "fail" })).content[0].text, "MCP_PROVIDER_CALL_FAILED");
  assert.equal((await call({ memoryId: "alpha", query: "null-error" })).content[0].text, "MCP_PROVIDER_CALL_FAILED");
  assert.equal((await call({ memoryId: "alpha", query: "bad" })).isError, true);
  assert.equal((await call({ memoryId: "alpha", query: "slow" })).content[0].text, "MCP_CALL_TIMEOUT");
  assert.equal(signal.aborted, true);
  assert.equal((await call({ memoryId: "alpha", query: "ok" })).content[0].text, "alpha");
});
test("const and enum compare JSON structurally; host memory field cannot conflict with root constraints", () => {
  const object = { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false };
  for (const constraint of [{ const: { a: 1, b: 2 } }, { enum: [{ a: 1, b: 2 }] }]) {
    validateInput({ ...object, ...constraint }, { b: 2, a: 1 });
    assert.throws(() => validateInput({ ...object, ...constraint }, { a: 2, b: 1 }), /MCP_INPUT/);
    const tool = { ...definition(), inputSchema: { ...object, ...constraint } };
    assert.throws(() => validateTools(manifest(), [tool]), /HOST_FIELD_CONFLICT/);
    assert.doesNotThrow(() => validateTools(manifest("fixture", "global"), [tool]));
  }
  const nested = { type: "object", properties: { value: { type: "array", items: object, const: [{ a: 1, b: 2 }, { a: 3, b: 4 }] } }, required: ["value"], additionalProperties: false };
  validateInput(nested, { value: [{ b: 2, a: 1 }, { b: 4, a: 3 }] });
  assert.throws(() => validateInput(nested, { value: [{ a: 3, b: 4 }, { a: 1, b: 2 }] }), /CONST/);
  assert.doesNotThrow(() => validateTools(manifest(), [{ ...definition(), inputSchema: nested }]));
});
test("read-only contexts cannot invoke writes or cross-memory readers", async () => {
  const context = createContext(manifest(), { memoryId: "alpha" });
  assert.equal(context.core, undefined);
  await assert.rejects(context.runCommand("write", { body: "secret" }), /DENIED/);
});
test("write bridge spawns the CLI with a private batch and cleans success and failure", async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/stmem"), `
    const fs = require('fs');
    const args = process.argv.slice(2);
    const batch = args[args.indexOf('--batch-file') + 1];
    const payload = JSON.parse(fs.readFileSync(batch, 'utf8'));
    fs.writeFileSync('receipt.json', JSON.stringify({args, batch, mode: fs.statSync(batch).mode & 511, payload}));
    if (payload.fail) process.exit(1);
    process.stdout.write(JSON.stringify({ok: true}));
  `);
  const m = manifest(); m.permissions.push("mcp:write"); m.entry.commands = { save: "backend/commands/save.js" };
  const context = createContext(m, { memoryId: "alpha", writable: true, projectRoot: root });
  assert.deepEqual(await context.runCommand("save", { body: "PRIVATE-LONG-BODY" }), { ok: true });
  const receipt = JSON.parse(fs.readFileSync(path.join(root, "receipt.json")));
  assert.deepEqual(receipt.args.slice(0, 3), ["module", "fixture", "save"]);
  assert.deepEqual(receipt.args.slice(-2), ["--memory", "alpha"]);
  assert.ok(!receipt.args.join(" ").includes("PRIVATE-LONG-BODY"));
  assert.equal(fs.existsSync(receipt.batch), false);
  if (process.platform !== "win32") assert.equal(receipt.mode, 0o600);
  await assert.rejects(context.runCommand("save", { fail: true }), /COMMAND_FAILED/);
  const failure = JSON.parse(fs.readFileSync(path.join(root, "receipt.json")));
  assert.equal(fs.existsSync(failure.batch), false);
});
test("config dry-run, revision, global gate, explicit scope and optimistic locking", t => {
  const root = fixture(t), file = path.join(root, "state", "mcp.json");
  install(root, manifest()); install(root, manifest("global-fixture", "global"));
  const input = { moduleId: "fixture", memoryId: "alpha", enabled: true, root, file, memoryIds: ["alpha", "beta"] };
  assert.deepEqual(readConfig(file).modules, {});
  const plan = planChange(input);
  assert.equal(fs.existsSync(file), false);
  applyChange(plan, file);
  assert.equal(readConfig(file).revision, 1);
  assert.equal(readConfig(file).modules.fixture.memories.alpha, true);
  assert.equal(readConfig(file).modules.fixture.globalEnabled, false);
  assert.throws(() => applyChange(plan, file), /REVISION/);
  assert.throws(() => planChange({ ...input, memoryId: undefined }), /MEMORY_ID/);
  assert.throws(() => planChange({ ...input, memoryId: "../alpha" }), /MEMORY_ID/);
  assert.throws(() => planChange({ ...input, moduleId: "global-fixture" }), /GLOBAL_MEMORY/);
  applyChange(planChange({ ...input, global: true }), file);
  assert.equal(readConfig(file).modules.fixture.globalEnabled, true);
  applyChange(planChange({ ...input, enabled: false, global: true }), file);
  assert.equal(readConfig(file).modules.fixture.globalEnabled, false);
  assert.equal(readConfig(file).modules.fixture.memories.alpha, true);
  assert.equal(readConfig(file).revision, 3);
  applyChange(planChange({ ...input, memoryId: "beta" }), file);
  assert.deepEqual(readConfig(file).modules.fixture, { globalEnabled: false, memories: { alpha: true, beta: true } });
  const registry = new Registry();
  let loaded = false;
  registry.registerModule(manifest(), { tools() { loaded = true; return [definition()]; }, call() {} }, { ...options, state: readConfig(file).modules.fixture });
  assert.equal(loaded, false);
  assert.deepEqual(registry.list(), []);
  applyChange(planChange({ ...input, global: true }), file);
  assert.deepEqual(readConfig(file).modules.fixture, { globalEnabled: true, memories: { alpha: true, beta: true } });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test("loader never executes disabled code; failures and deleted modules preserve Core", t => {
  const root = fixture(t);
  install(root, manifest("disabled"), 'throw new Error("disabled code must not execute")');
  install(root, manifest("broken"), 'throw new Error("SECRET /home/path")');
  install(root, manifest("good", "global"), `module.exports = { tools: () => [${JSON.stringify(definition())}], call: () => ({content: []}) };`);
  const registry = new Registry();
  registry.registerCore({ tools: [{ name: "core" }], call: () => ({ content: [] }) });
  const logs = [];
  const reports = loadModuleProviders(registry, { root, projectRoot: root, memoryIds: ["alpha"], logger: row => logs.push(row), config: { modules: { broken: options.state, good: options.state, deleted: options.state } } });
  assert.equal(reports.find(r => r.id === "disabled").provider, "disabled");
  assert.equal(reports.find(r => r.id === "broken").provider, "failed");
  assert.equal(reports.find(r => r.id === "deleted").provider, "missing");
  assert.deepEqual(registry.list().map(tool => tool.name), ["core", "stmem_good_read"]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|\/home\/path/);
});

test("legacy names are host-owned, memory-bound, read-only, and collision checked", async () => {
  const m = manifest("notebook-lab");
  const provider = { tools: () => [definition()], call: context => ({ content: [{ type: "text", text: context.memoryId }] }) };
  const registry = new Registry();
  registry.registerModule(m, provider, options);
  assert.equal(registry.list()[0].name, "stmem_notebook_read");
  assert.equal((await registry.call("stmem_notebook_read", { thread: "alpha", query: "ok" })).content[0].text, "alpha");
  assert.equal((await registry.call("stmem_notebook_read", { thread: "beta", query: "ok" })).isError, true);
  const ordinary = new Registry();
  ordinary.registerModule(manifest("another-module"), provider, options);
  assert.equal(ordinary.list()[0].name, "stmem_another_module_read");
  assert.throws(() => validateTools({ ...m, scope: "global" }, [definition()]), /LEGACY_CONTRACT/);
  assert.throws(() => validateTools({ ...m, permissions: [...m.permissions, "mcp:write"] }, [{ ...definition(), annotations: { ...annotations, readOnlyHint: false } }]), /LEGACY_CONTRACT/);
  const reserved = definition(); reserved.inputSchema.properties.thread = { type: "string" };
  assert.throws(() => validateTools(m, [reserved]), /RESERVED/);
  const collision = new Registry();
  collision.registerCore({ tools: [{ name: "stmem_notebook_read" }], call() {} });
  assert.throws(() => collision.registerModule(m, provider, options), /CONFLICT/);
});

test("missing or failed module providers cannot fall back to migrated Core routes", async t => {
  const root = fixture(t);
  const core = require("../src/mcp/core");
  for (const broken of [false, true]) {
    if (broken) for (const id of ["notebook-lab", "dream-lab"]) install(root, manifest(id), 'throw new Error("synthetic load failure")');
    const registry = new Registry();
    registry.registerCore(core);
    const reports = loadModuleProviders(registry, { root, projectRoot: root, config: { modules: { "notebook-lab": options.state, "dream-lab": options.state } }, memoryIds: options.memoryIds, logger() {} });
    assert.equal(reports.find(item => item.id === "notebook-lab").provider, broken ? "failed" : "missing");
    assert.equal(reports.find(item => item.id === "dream-lab").provider, broken ? "failed" : "missing");
    for (const name of ["stmem_notebook_status", "stmem_notebook_query", "stmem_notebook_read", "stmem_notebook_topic_manage", "stmem_notebook_write", "stmem_notebook_delegate", "stmem_dream_latest", "stmem_dream_status", "stmem_dream_get"]) {
      assert.ok(!registry.list().some(tool => tool.name === name));
      const result = await registry.call(name, { thread: "alpha", query: "synthetic", noteId: "absent" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /未知工具|MCP_UNKNOWN_TOOL/);
    }
    assert.ok(registry.list().some(tool => tool.name === "stmem_memory_status"));
  }
});
