const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { childEnvWithHome } = require("../test-support/child-env");

const THREAD_ID = "00000000-0000-4000-8000-000000000002";

function setupHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-catchup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneDir = path.join(home, ".stone_memory");
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [THREAD_ID]: { label: "catch-up", runtime: "claude", purpose: "accompany", sessionDir },
  }));
  const rows = [
    { type: "user", uuid: "u-1", timestamp: "2026-07-30T12:00:00.000Z", message: { role: "user", content: "今天想去河边散步" } },
    { type: "assistant", uuid: "a-1", parentUuid: "u-1", timestamp: "2026-07-30T12:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "好呀，带上相机一起去" }] } },
  ];
  const threadFile = path.join(sessionDir, `${THREAD_ID}.jsonl`);
  fs.writeFileSync(threadFile, `${rows.map(JSON.stringify).join("\n")}\n`);
  return { home, stoneDir, threadFile, env: childEnvWithHome(home) };
}

function filesWithHashes(dir) {
  const files = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push([full, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  };
  walk(dir);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}

function rebuild(env, apply = false) {
  return spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), "rebuild", "--thread", THREAD_ID, ...(apply ? ["--apply"] : [])], { env, encoding: "utf8", timeout: 30_000 });
}

function setupCodexHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-codex-dryrun-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stoneDir = path.join(home, ".stone_memory");
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [THREAD_ID]: { label: "codex catch-up", runtime: "codex", purpose: "coding", sessionDir },
  }));
  const rows = [
    { type: "session_meta", timestamp: "2026-07-30T12:00:00.000Z", payload: { session_id: THREAD_ID, cwd: "/tmp" } },
    { type: "response_item", timestamp: "2026-07-30T12:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我整理今天的计划" }] } },
    { type: "response_item", timestamp: "2026-07-30T12:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好，我们先列三件事。" }] } },
  ];
  const threadFile = path.join(sessionDir, `${THREAD_ID}.jsonl`);
  fs.writeFileSync(threadFile, `${rows.map(JSON.stringify).join("\n")}\n`);
  return { stoneDir, threadFile, env: childEnvWithHome(home) };
}

function archivedTexts(stoneDir) {
  const databasePath = path.join(stoneDir, "stone-memory.db");
  if (!fs.existsSync(databasePath)) return [];
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare("SELECT text FROM messages WHERE thread_id=? ORDER BY timestamp").all(THREAD_ID).map(row => row.text);
  } finally {
    db.close();
  }
}

test("rebuild dry-run previews catch-up without writing full or SQLite", t => {
  const { stoneDir, threadFile, env } = setupHome(t);
  const before = filesWithHashes(stoneDir);
  const sourceBefore = fs.readFileSync(threadFile, "utf8");
  const result = rebuild(env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(filesWithHashes(stoneDir), before);
  assert.equal(fs.readFileSync(threadFile, "utf8"), sourceBefore);
  assert.deepEqual(archivedTexts(stoneDir), []);
});

test("rebuild apply catches unarchived messages up before replacing the thread", t => {
  const { stoneDir, threadFile, env } = setupHome(t);
  const result = rebuild(env, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(archivedTexts(stoneDir).sort(), ["今天想去河边散步", "好呀，带上相机一起去"].sort());
  const rebuilt = fs.readFileSync(threadFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(rebuilt.length > 0);
  assert.ok(rebuilt[0].uuid);
  assert.equal(rebuilt.some(row => row.type === "system" && row.subtype === "init"), false);
});

test("Codex rebuild dry-run does not write full or SQLite", t => {
  const { stoneDir, threadFile, env } = setupCodexHome(t);
  const before = filesWithHashes(stoneDir);
  const sourceBefore = fs.readFileSync(threadFile, "utf8");
  const result = rebuild(env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(filesWithHashes(stoneDir), before);
  assert.equal(fs.readFileSync(threadFile, "utf8"), sourceBefore);
});

test("Codex rebuild apply catches unarchived messages up before replacing the thread", t => {
  const { stoneDir, env } = setupCodexHome(t);
  const result = rebuild(env, true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(archivedTexts(stoneDir).sort(), ["帮我整理今天的计划", "好，我们先列三件事。"].sort());
});
