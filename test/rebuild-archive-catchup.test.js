const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 场景：线程里有 watcher 还没归档的对话（messages 表为空），此时触发重建。
// 评审边界：dry-run 严格只读，只报告预计补录多少；apply 才允许写 full/ 和 SQLite，
// 且必须在覆盖活动线程之前补齐规范化归档。

const THREAD_ID = "00000000-0000-4000-8000-000000000002";

function setupHome(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const stoneDir = path.join(home, ".stone_memory");
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [THREAD_ID]: {
      label: "Rebuild catch-up test",
      runtime: "claude",
      purpose: "accompany",
      sessionDir,
    },
  }));

  const messages = [
    { type: "user", uuid: "u-1", timestamp: "2026-07-30T12:00:00.000Z", message: { role: "user", content: "今天想去河边散步" } },
    { type: "assistant", uuid: "a-1", parentUuid: "u-1", timestamp: "2026-07-30T12:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "好呀，带上相机一起去" }] } },
  ];
  const threadFile = path.join(sessionDir, `${THREAD_ID}.jsonl`);
  fs.writeFileSync(threadFile, messages.map(JSON.stringify).join("\n") + "\n");

  return { home, stoneDir, sessionDir, threadFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function runRebuild(env, extraArgs = []) {
  return spawnSync(process.execPath, [
    path.join(__dirname, "..", "scripts", "rebuild-thread.js"),
    "--thread", THREAD_ID,
    ...extraArgs,
  ], { env, encoding: "utf8", timeout: 30_000 });
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readArchivedTexts(env) {
  // 在子进程里读库：memory-reader 的路径在 require 时按 HOME 计算
  const dbCheck = spawnSync(process.execPath, ["-e", `
    const path = require("node:path");
    const { readMessages } = require(${JSON.stringify(path.join(__dirname, "..", "src", "storage", "memory-reader"))});
    const memoryDir = path.join(process.env.HOME, ".stone_memory", "runtimes", "claude", "accompany", ${JSON.stringify(THREAD_ID)}, "memory");
    console.log(JSON.stringify(readMessages(memoryDir, { threadId: ${JSON.stringify(THREAD_ID)} }).map(row => row.text)));
  `], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(dbCheck.status, 0, dbCheck.stderr);
  return JSON.parse(dbCheck.stdout.trim());
}

test("dry-run reports the pending catch-up but writes nothing", t => {
  const { stoneDir, threadFile, env } = setupHome(t, "stmem-rebuild-dryrun-");

  const before = listFiles(stoneDir).map(f => [f, hashFile(f)]);
  const threadHashBefore = hashFile(threadFile);

  const rebuild = runRebuild(env); // 不带 --apply → dry-run
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);
  assert.match(rebuild.stdout, /would back up 2 new messages to full\//);
  assert.match(rebuild.stdout, /would ingest up to 2 normalized messages/);

  // 严格只读：stone_memory 下没有新增或改动任何文件（允许出现空目录），线程文件原样
  const after = listFiles(stoneDir).map(f => [f, hashFile(f)]);
  assert.deepEqual(after, before, "dry-run 不得写 full、SQLite 或 archive");
  assert.equal(hashFile(threadFile), threadHashBefore, "dry-run 不得改写线程文件");
  assert.deepEqual(readArchivedTexts(env), [], "dry-run 后 messages 表必须仍为空");
});

test("apply ingests thread messages the archive has not seen before rewriting", t => {
  const { sessionDir, threadFile, env } = setupHome(t, "stmem-rebuild-catchup-");

  const rebuild = runRebuild(env, ["--apply"]);
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);

  const texts = readArchivedTexts(env);
  assert.ok(texts.includes("今天想去河边散步"), `messages 表应补齐用户消息，实际：${JSON.stringify(texts)}`);
  assert.ok(texts.includes("好呀，带上相机一起去"), `messages 表应补齐助手消息，实际：${JSON.stringify(texts)}`);

  // 线程确实被重建覆盖：留有 .bak 备份，且原文件仍存在
  const baks = fs.readdirSync(sessionDir).filter(name => name.includes(".bak."));
  assert.equal(baks.length, 1, `apply 应留下原线程备份，实际：${JSON.stringify(fs.readdirSync(sessionDir))}`);
  assert.ok(fs.existsSync(threadFile));
});
