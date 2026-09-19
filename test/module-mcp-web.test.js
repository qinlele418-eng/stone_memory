const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
test("HTTP MCP management delegates preview/apply to CLI with explicit memory", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-web-"));
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone);
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ alpha: { runtime: "codex", purpose: "test" } }));
  const serverFile = path.join(__dirname, "../src/web/server.js");
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(serverFile)}).startWebServer({port:0}).then(server => process.send(server.address().port));`], {
    env: { ...process.env, HOME: home, USERPROFILE: home, STMEM_DB_PATH: path.join(stone, "test.db") },
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await closed;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`web startup exited: ${code}`))); });
  const base = `http://127.0.0.1:${port}/api/developer-modules`;
  const request = async (url, options) => {
    try { return await fetch(url, options); }
    catch (error) { throw new Error(`HTTP fixture failed (port ${port}, exit ${child.exitCode}): ${error.cause?.message || error.message}; ${stderr}`, { cause: error }); }
  };
  const change = body => request(`${base}/notebook-lab/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await change({ enabled: true, apply: true })).status, 400);
  const preview = await change({ enabled: true, memoryId: "alpha" });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).dryRun, true);
  const config = path.join(stone, "developer-module-mcp.json");
  assert.equal(fs.existsSync(config), false);
  const applied = await change({ enabled: true, memoryId: "alpha", apply: true });
  assert.equal(applied.status, 200);
  assert.match((await applied.json()).reconnect, /重新连接/);
  assert.equal(JSON.parse(fs.readFileSync(config)).revision, 1);
  const disabled = await (await request(`${base}/mcp`)).json();
  assert.equal(disabled.modules.find(item => item.id === "notebook-lab").provider, "disabled");
  assert.equal((await change({ enabled: true, global: true, memoryId: "alpha", apply: true })).status, 200);
  const status = await (await request(`${base}/mcp`)).json();
  assert.equal(status.modules.find(item => item.id === "notebook-lab").provider, "loaded");
  assert.equal((await change({ enabled: false, memoryId: "alpha", apply: true })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(config)).revision, 3);
});
