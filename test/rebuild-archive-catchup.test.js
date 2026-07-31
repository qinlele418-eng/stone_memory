const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 场景：线程里有 watcher 还没归档的对话（messages 表为空），此时触发重建。
// 重建会覆盖线程文件——如果不先规范化落库，这段对话就只存在于 full/ 原始备份，
// 全量对话和挖掘永远看不见。断言：重建后 messages 表已补齐。
test("rebuild ingests thread messages the archive has not seen before rewriting", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-catchup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const threadId = "00000000-0000-4000-8000-000000000002";
  const stoneDir = path.join(home, ".stone_memory");
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [threadId]: {
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
  fs.writeFileSync(path.join(sessionDir, `${threadId}.jsonl`), messages.map(JSON.stringify).join("\n") + "\n");

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const rebuild = spawnSync(process.execPath, [
    path.join(__dirname, "..", "scripts", "rebuild-thread.js"),
    "--thread", threadId,
  ], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(rebuild.status, 0, rebuild.stderr || rebuild.stdout);

  // 在子进程里读库：memory-reader 的路径在 require 时按 HOME 计算
  const dbCheck = spawnSync(process.execPath, ["-e", `
    const path = require("node:path");
    const { readMessages } = require(${JSON.stringify(path.join(__dirname, "..", "src", "storage", "memory-reader"))});
    const memoryDir = path.join(process.env.HOME, ".stone_memory", "runtimes", "claude", "accompany", ${JSON.stringify(threadId)}, "memory");
    console.log(JSON.stringify(readMessages(memoryDir, { threadId: ${JSON.stringify(threadId)} }).map(row => row.text)));
  `], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(dbCheck.status, 0, dbCheck.stderr);
  const texts = JSON.parse(dbCheck.stdout.trim());
  assert.ok(texts.includes("今天想去河边散步"), `messages 表应补齐用户消息，实际：${dbCheck.stdout}`);
  assert.ok(texts.includes("好呀，带上相机一起去"), `messages 表应补齐助手消息，实际：${dbCheck.stdout}`);
});
