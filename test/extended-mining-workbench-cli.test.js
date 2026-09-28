"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-extended-cli-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone, { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    "memory-a": { runtime: "codex", purpose: "coding", label: "Synthetic" },
  }));
  const batch = path.join(home, "rule.json");
  fs.writeFileSync(batch, JSON.stringify({ operation: "create", name: "时间线", prompt: "保留事件的先后顺序。" }), { mode: 0o600 });
  return { home, batch, rules: path.join(stone, "developer-module-data", "memory-a", "extended-mining-workbench", "rules.json") };
}

async function cli(args) {
  const output = [];
  const originalLog = console.log;
  console.log = value => output.push(String(value));
  try {
    const { runModuleCommand } = require("../scripts/stmem-module");
    await runModuleCommand(["extended-mining-workbench", "rules", "--memory", "memory-a", ...args]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(output.length, 1);
  return JSON.parse(output[0]);
}

test("extended mining workbench exposes a dry-run/apply CLI for custom rules", async t => {
  const { batch, rules } = fixture(t);
  assert.equal((await cli(["--batch-file", batch])).dryRun, true);
  assert.equal(fs.existsSync(rules), false);
  assert.equal((await cli(["--batch-file", batch, "--apply"])).applied, true);
  assert.equal(fs.existsSync(rules), true);
  const listed = await cli([]);
  assert.equal(listed.rules.length, 1);
  assert.equal(listed.rules[0].name, "时间线");
});
