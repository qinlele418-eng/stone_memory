const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function setup(t, runtime = "claude") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-migration-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone);
  const planner = path.join(home, "planner.js");
  const planFile = path.join(home, "plan.json");
  const receipt = path.join(home, "planner-input.json");
  fs.writeFileSync(planner, `const fs = require('node:fs'); let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>prompt+=c); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({prompt,args:process.argv.slice(2)})); process.stdout.write(fs.readFileSync(${JSON.stringify(planFile)},'utf8'));});`);
  const command = `"${process.execPath}" "${planner}"`;
  // Include Claude's print flag after the JS entry, so the adapter does not
  // prepend it as Node's unrelated `-p` evaluation option.
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ alpha: { runtime, purpose: "test" }, beta: { runtime, purpose: "test" }, runtimes: { claude: { command: `${command} -p`, flags: {} }, codex: { command, flags: {} } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(home, "fixture.db"), STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_THREAD_ID: "", STMEM_SEARCH_ONLY: "0", STMEM_NOTEBOOK_STEWARD: "0" };
  function run(file, args = [], input) {
    const result = spawnSync(process.execPath, [path.join(root, file), ...args], { env, input, encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  }
  const rpc = (method, params) => JSON.parse(run("mcp-server.js", [], JSON.stringify({ id: 1, method, params }) + "\n")).result;
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: { thread: "alpha", ...args } });
  const cli = args => JSON.parse(run("bin/stmem", ["module", "mcp", ...args]));
  const enable = module => {
    cli(["enable", "--module", module, "--memory", "alpha", "--apply"]);
    cli(["enable", "--module", module, "--memory", "alpha", "--global", "--apply"]);
  };
  const data = result => { assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  return { home, stone, env, rpc, call, cli, enable, data, planFile, receipt };
}

test("both migrated modules own all public names, preserve schemas, and deny old routes when disabled", t => {
  const f = setup(t);
  const baseline = require("./fixtures/mcp/core-tools.json").TOOLS;
  const migrated = baseline.filter(tool => /^stmem_(notebook|dream)_/.test(tool.name));
  const inputs = {
    stmem_notebook_status: {}, stmem_notebook_query: { query: "synthetic" }, stmem_notebook_read: { noteId: "absent" },
    stmem_notebook_topic_manage: { action: "create", name: "unauthorized" },
    stmem_notebook_write: { title: "unauthorized", body: "must-not-write" },
    stmem_notebook_delegate: { request: "must-not-plan" },
    stmem_dream_latest: {}, stmem_dream_status: {}, stmem_dream_get: { date: "2026-01-01" },
  };
  assert.equal(migrated.length, 9);
  for (const tool of migrated) assert.equal(f.call(tool.name).isError, true);
  assert.equal(fs.existsSync(f.env.STMEM_DB_PATH), false);
  f.enable("notebook-lab"); f.enable("dream-lab");
  const listed = f.rpc("tools/list").tools;
  assert.ok(!listed.some(tool => /^stmem_(notebook|dream)_lab_/.test(tool.name)));
  for (const old of migrated) {
    const actual = structuredClone(listed.find(tool => tool.name === old.name));
    assert.ok(actual, old.name);
    assert.equal(listed.filter(tool => tool.name === old.name).length, 1);
    delete actual.annotations;
    const expected = structuredClone(old);
    expected.inputSchema.properties.thread = { type: "string", description: "Explicit enabled memory ID" };
    expected.inputSchema.required = [...(expected.inputSchema.required || []), "thread"];
    assert.deepEqual(actual, expected);
    const denied = f.call(old.name, { ...inputs[old.name], thread: "beta" });
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text, "MCP_MEMORY_DISABLED");
  }
  assert.equal(fs.existsSync(f.env.STMEM_DB_PATH), false);
  assert.equal(fs.existsSync(f.receipt), false);
  for (const module of ["notebook-lab", "dream-lab"]) {
    f.cli(["disable", "--module", module, "--memory", "alpha", "--global", "--apply"]);
    f.cli(["enable", "--module", module, "--memory", "beta", "--apply"]);
  }
  const remaining = f.rpc("tools/list").tools;
  for (const tool of migrated) {
    assert.ok(!remaining.some(item => item.name === tool.name));
    const disabled = f.call(tool.name, inputs[tool.name]);
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /未知工具|MCP_UNKNOWN_TOOL/);
  }
  assert.ok(remaining.some(tool => tool.name === "stmem_memory_rebuild"));
});

for (const runtime of ["claude", "codex"]) {
  test(`Notebook writes and delegate execute through module CLI (${runtime}, synthetic planner)`, t => {
    const f = setup(t, runtime); f.enable("notebook-lab");
    const topic = f.data(f.call("stmem_notebook_topic_manage", { action: "create", name: "Synthetic topic" }));
    f.data(f.call("stmem_notebook_topic_manage", { action: "update", topicId: topic.id, description: "updated" }));
    const note = f.data(f.call("stmem_notebook_write", { topicId: topic.id, title: "Synthetic note", body: "original" }));
    assert.equal(f.call("stmem_notebook_write", { noteId: note.id, title: "bad", body: "bad", expectedRevision: 999 }).isError, true);
    assert.equal(f.data(f.call("stmem_notebook_read", { noteId: note.id })).body, "original");
    const writePlan = plan => fs.writeFileSync(f.planFile, JSON.stringify({ confidence: 1, reason: "synthetic", ...plan }));
    writePlan({ action: "create_note", topicId: topic.id, title: "Delegated" });
    const receipt = f.data(f.call("stmem_notebook_delegate", { request: "create synthetic note", content: "PRIVATE-SYNTHETIC-BODY" }));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.action, "create_note");
    const created = f.data(f.call("stmem_notebook_read", { noteId: receipt.note.id }));
    assert.equal(created.body, "PRIVATE-SYNTHETIC-BODY");
    const captured = JSON.parse(fs.readFileSync(f.receipt));
    assert.ok(!JSON.stringify(captured).includes("PRIVATE-SYNTHETIC-BODY"));
    writePlan({ action: "update_note", noteId: created.id, updateMode: "append" });
    f.data(f.call("stmem_notebook_delegate", { request: "append", content: "second", updateMode: "append" }));
    assert.equal(f.data(f.call("stmem_notebook_read", { noteId: created.id })).body, "PRIVATE-SYNTHETIC-BODY\n\nsecond");
    fs.writeFileSync(f.planFile, "invalid-plan");
    assert.equal(f.call("stmem_notebook_delegate", { request: "fail", content: "must-not-commit" }).isError, true);
    assert.equal(f.data(f.call("stmem_notebook_read", { noteId: created.id })).body, "PRIVATE-SYNTHETIC-BODY\n\nsecond");
    const tmp = path.join(f.stone, "runtimes", runtime, "test", "alpha", "tmp");
    assert.ok(!fs.readdirSync(tmp).some(file => /^mcp-notebook-.*\.json$/.test(file)));
    const config = JSON.parse(fs.readFileSync(path.join(tmp, "notebook-steward-mcp.json")));
    assert.equal(config.mcpServers.stone_notebook_steward.env.STMEM_THREAD_ID, "alpha");
  });
}

test("near-limit Notebook batch returns its complete CLI receipt after writing", t => {
  const f = setup(t); f.enable("notebook-lab");
  const topic = f.data(f.call("stmem_notebook_topic_manage", { action: "create", name: "Large synthetic note" }));
  const input = { topicId: topic.id, title: "Synthetic boundary", body: "" };
  input.body = "x".repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(input)) - 16);
  const written = f.data(f.call("stmem_notebook_write", input));
  assert.equal(written.body, input.body);
  const read = f.data(f.call("stmem_notebook_read", { noteId: written.id }));
  assert.equal(read.body, input.body);
});
