const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { childEnvWithHome } = require("../test-support/child-env");

test("watcher runtime can scan archive dates with automation disabled", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const threadId = "00000000-0000-4000-8000-000000000001";
  const stoneDir = path.join(home, ".stone_memory");
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [threadId]: {
      label: "Watcher smoke test",
      runtime: "codex",
      purpose: "accompany",
      sessionDir: path.join(home, "sessions"),
      automaticFullMining: false,
      automaticMemoryMaintenance: false,
      automaticCompression: false,
    },
  }));

  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "scripts", "watcher.js"),
    "--thread", threadId,
    "--once",
  ], {
    env: childEnvWithHome(home),
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.doesNotMatch(result.stdout, /MemoryStore is not defined|轮询出错/);
});
