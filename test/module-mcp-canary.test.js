const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-canary-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("formal CLI migrates existing Notebook tools and disables their old names without Core fallback", t => {
  const home = fixture(t), stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone);
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ alpha: { runtime: "codex", purpose: "test" }, beta: { runtime: "claude", purpose: "test" } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(stone, "test.db"), STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_SEARCH_ONLY: "0", STMEM_NOTEBOOK_STEWARD: "0" };
  const run = (file, args, input) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", file), ...args], { env, input, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").filter(Boolean);
  };
  const cli = args => JSON.parse(run("bin/stmem", ["module", "mcp", ...args]).join("\n"));
  const state = path.join(stone, "developer-module-mcp.json");
  const list = () => JSON.parse(run("mcp-server.js", [], JSON.stringify({ id: 1, method: "tools/list" }) + "\n")[0]).result.tools;
  const names = ["stmem_notebook_status", "stmem_notebook_query", "stmem_notebook_read"];
  assert.ok(!list().some(tool => names.includes(tool.name)));
  assert.equal(cli(["enable", "--module", "notebook-lab", "--memory", "alpha"]).dryRun, true);
  assert.equal(fs.existsSync(state), false);
  cli(["enable", "--module", "notebook-lab", "--memory", "alpha", "--apply"]);
  assert.equal(cli(["status", "--json"]).modules.find(item => item.id === "notebook-lab").provider, "disabled");
  cli(["enable", "--module", "notebook-lab", "--memory", "alpha", "--global", "--apply"]);
  const status = cli(["status", "--json"]);
  assert.equal(status.modules.find(item => item.id === "notebook-lab").provider, "loaded");
  const listed = list();
  assert.ok(!listed.some(tool => tool.name.startsWith("stmem_notebook_lab_")));
  for (const name of names) {
    assert.equal(listed.filter(tool => tool.name === name).length, 1);
    const actual = structuredClone(listed.find(tool => tool.name === name));
    const old = structuredClone(require("./fixtures/mcp/core-tools.json").TOOLS.find(tool => tool.name === name));
    assert.equal(actual.annotations.readOnlyHint, true);
    delete actual.annotations;
    // The sole schema change is mandatory explicit thread selection.
    old.inputSchema.properties.thread = { type: "string", description: "Explicit enabled memory ID" };
    old.inputSchema.required = [...(old.inputSchema.required || []), "thread"];
    assert.deepEqual(actual, old);
  }
  const denied = args => JSON.parse(run("mcp-server.js", [], JSON.stringify({ id: 1, method: "tools/call", params: { name: "stmem_notebook_status", arguments: args } }) + "\n")[0]).result;
  for (const args of [{}, { thread: "beta" }, { memoryId: "alpha" }, { thread: "alpha", memoryId: "beta" }]) assert.equal(denied(args).isError, true);
  for (const [flag, snapshot] of [["STMEM_SEARCH_ONLY", "SEARCH_TOOLS"], ["STMEM_NOTEBOOK_STEWARD", "NOTEBOOK_STEWARD_TOOLS"]]) {
    const child = spawnSync(process.execPath, [path.join(__dirname, "../mcp-server.js")], {
      env: { ...env, [flag]: "1" }, input: JSON.stringify({ id: 1, method: "tools/list" }) + "\n", encoding: "utf8", timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).result.tools, require("./fixtures/mcp/core-tools.json")[snapshot]);
  }
  const called = JSON.parse(run("mcp-server.js", [], JSON.stringify({ id: 1, method: "tools/call", params: { name: "stmem_notebook_status", arguments: { thread: "alpha" } } }) + "\n")[0]).result;
  assert.equal(called.isError, false, JSON.stringify(called));
  cli(["disable", "--module", "notebook-lab", "--memory", "alpha", "--global", "--apply"]);
  const beta = cli(["enable", "--module", "notebook-lab", "--memory", "beta", "--apply"]);
  assert.equal(beta.effectiveEnabled, false);
  assert.deepEqual(beta.state, { globalEnabled: false, memories: { alpha: true, beta: true } });
  assert.ok(!list().some(tool => ["stmem_notebook_status", "stmem_notebook_query", "stmem_notebook_read"].includes(tool.name)));
  for (const memoryId of ["alpha", "beta"]) {
    const result = JSON.parse(run("mcp-server.js", [], JSON.stringify({ id: 2, method: "tools/call", params: { name: "stmem_notebook_status", arguments: { thread: memoryId } } }) + "\n")[0]).result;
    assert.equal(result.isError, true);
  }
  cli(["disable", "--module", "notebook-lab", "--memory", "alpha", "--apply"]);
  const remaining = list().map(tool => tool.name);
  assert.ok(!remaining.includes("stmem_notebook_status"));
  assert.ok(remaining.includes("stmem_memory_status"));
});
