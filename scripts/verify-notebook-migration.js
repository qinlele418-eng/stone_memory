// Compare the actual pre-migration server with the migrated provider.
// Usage: node scripts/verify-notebook-migration.js <pre-migration-checkout>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
if (!process.argv[2]) throw new Error("A pre-migration checkout is required");
const baseline = path.resolve(process.argv[2]);
assert.ok(fs.existsSync(path.join(baseline, "mcp-server.js")));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-parity-"));
const env = { ...process.env, HOME: home, USERPROFILE: home,
  STMEM_DB_PATH: path.join(home, "fixture.db"), STMEM_SKIP_PENDING_REBUILDS: "1",
  STMEM_SEARCH_ONLY: "0", STMEM_NOTEBOOK_STEWARD: "0", STMEM_THREAD_ID: "",
  NODE_PATH: path.join(root, "node_modules"),
};
function run(args, options = {}) {
  const child = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 15000, windowsHide: true, ...options });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout;
}
try {
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone);
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ alpha: { runtime: "codex", purpose: "test" }, beta: { runtime: "claude", purpose: "test" } }));
  const { topic, note } = JSON.parse(run(["-e", `
    const path = require('node:path');
    const { getThreadDir } = require('./src/config');
    const { NotebookStore } = require('./src/storage/notebook-store');
    const memoryDir = path.join(getThreadDir('alpha'), 'memory');
    const store = new NotebookStore({threadId:'alpha',memoryDir,root:path.join(memoryDir,'notebook')});
    const topic = store.createTopic({name:'Synthetic migration'});
    const note = store.writeEntry({topicId:topic.id,title:'Synthetic sealed',body:'synthetic migration body',tags:['regression'],visibility:'sealed'});
    store.close();
    process.stdout.write(JSON.stringify({topic,note}));
  `]));
  const calls = [
    ["status", {}], ["query", { query: "synthetic" }],
    ["query", { tags: ["regression"], topicId: topic.id, limit: 50 }],
    ["query", { query: "absent" }], ["read", { noteId: note.id }],
    ["read", { noteId: "absent" }], ["status", { thread: "beta" }],
  ];
  const input = calls.map(([name, args], i) => JSON.stringify({ id: i + 1, method: "tools/call", params: { name: `stmem_notebook_${name}`, arguments: { thread: "alpha", ...args } } })).join("\n") + "\n";
  const invoke = repo => run([path.join(repo, "mcp-server.js")], { cwd: repo, input }).trim().split("\n").map(JSON.parse).sort((a, b) => a.id - b.id);
  const before = invoke(baseline);
  assert.equal(before.length, calls.length);
  for (const response of before) assert.equal(response.result.isError, false, "Baseline must successfully read the seeded notes");
  for (const memory of ["alpha", "beta"]) {
    run([path.join(root, "bin/stmem"), "module", "mcp", "enable", "--module", "notebook-lab", "--memory", memory, "--apply"]);
  }
  run([path.join(root, "bin/stmem"), "module", "mcp", "enable", "--module", "notebook-lab", "--memory", "alpha", "--global", "--apply"]);
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(env.STMEM_DB_PATH)).digest("hex");
  const initial = hash();
  assert.deepEqual(invoke(root), before);
  assert.equal(hash(), initial);
  console.log("Notebook migration: 7/7 complete responses identical to old Core; main database hash unchanged.");
} finally { fs.rmSync(home, { recursive: true, force: true }); }
