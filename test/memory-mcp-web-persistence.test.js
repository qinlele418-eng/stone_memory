const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

test("memory MCP switch persists a disabled module across fresh status requests", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-mcp-web-"));
  const memoryId = "11111111-1111-4111-8111-111111111111";
  const stone = path.join(home, ".stone_memory");
  const memoryRoot = path.join(stone, "memories", memoryId);
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    memories: { [memoryId]: { memoryId, label: "MCP 回归", status: "active" } },
  }));
  fs.writeFileSync(path.join(memoryRoot, ".layout-v1.json"), JSON.stringify({
    schemaVersion: 1, status: "complete", memoryId,
  }));
  const settingsFile = path.join(memoryRoot, "memory.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    schemaVersion: 1, memoryId, label: "MCP 回归", status: "active",
    mcpModules: ["notebook-lab"], mcpModuleConfigVersion: 1,
  }));
  const serverFile = path.join(__dirname, "../src/web/server.js");
  const child = spawn(process.execPath, ["-e",
    `require(${JSON.stringify(serverFile)}).startWebServer({port:0}).then(server => process.send(server.address().port));`], {
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
  const port = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`web startup exited: ${code}; ${stderr}`)));
  });
  const url = `http://127.0.0.1:${port}/api/libraries/${memoryId}/mcp`;
  const request = async (method = "GET", body) => {
    const response = await fetch(url, body === undefined ? undefined : {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const enabled = async id => (await request()).modules.find(item => item.id === id)?.enabled;
  assert.equal(await enabled("notebook-lab"), true);
  assert.equal(await enabled("dream-lab"), false);

  const preview = await request("POST", { moduleId: "dream-lab", enabled: true });
  assert.equal(preview.dryRun, true);
  assert.equal(await enabled("dream-lab"), false);

  const applied = await request("POST", { moduleId: "dream-lab", enabled: true, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(await enabled("dream-lab"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcpModules,
    ["notebook-lab", "dream-lab"]);

  await request("POST", { moduleId: "dream-lab", enabled: false, apply: true });
  assert.equal(await enabled("dream-lab"), false);
  assert.equal(await enabled("notebook-lab"), true);
});

test("access-page MCP switch sends an applied memory-level change", () => {
  const app = fs.readFileSync(path.join(__dirname, "../src/web/public/app.js"), "utf8");
  assert.match(app, /data-mcp-module[^\\n]*input\\.onchange[\\s\\S]*?body:JSON\\.stringify\\(\\{moduleId:input\\.dataset\\.mcpModule,enabled:input\\.checked,apply:true\\}\\)/u);
});
