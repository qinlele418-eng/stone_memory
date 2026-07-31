const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 隔离 HOME：只在沙箱记忆体上验证前端 apply 的排队/静默窗口保护。
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-apply-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
const { startWebServer } = require("../src/web/server");

const threadId = "00000000-0000-4000-8000-000000000003";
const stoneDir = path.join(sandboxHome, ".stone_memory");
const sessionDir = path.join(sandboxHome, "sessions");
const threadFile = path.join(sessionDir, `${threadId}.jsonl`);

// bin/stmem 对非诊断命令会自动拉起常驻 watcher-supervisor（detached，pid 记在沙箱
// ~/.stone_memory/watcher.pid）。测试结束必须把它收掉，不能向沙箱外泄漏后台进程；
// watcher 子进程发现 supervisor 消失后会自行退出。
test.after(() => {
  try {
    const pid = parseInt(fs.readFileSync(path.join(stoneDir, "watcher.pid"), "utf8"), 10);
    if (Number.isFinite(pid)) process.kill(pid, "SIGTERM");
  } catch {}
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

function setupThread() {
  fs.mkdirSync(stoneDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
    [threadId]: {
      label: "Web apply guard test",
      runtime: "claude",
      purpose: "accompany",
      sessionDir,
    },
  }));
  const messages = [
    { type: "user", uuid: "u-1", timestamp: "2026-07-30T12:00:00.000Z", message: { role: "user", content: "傍晚一起去江边吹风吗" } },
    { type: "assistant", uuid: "a-1", parentUuid: "u-1", timestamp: "2026-07-30T12:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "好，我带上外套等你" }] } },
  ];
  fs.writeFileSync(threadFile, messages.map(JSON.stringify).join("\n") + "\n");
}

function postApply(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method: "POST",
      path: `/api/libraries/${threadId}/rebuild/apply`,
      headers: {
        host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`,
        "content-type": "application/json", "content-length": Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function serverFixture(t) {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test("apply refuses while the thread file was written within the quiet window", async t => {
  setupThread();
  const port = await serverFixture(t);
  fs.utimesSync(threadFile, new Date(), new Date()); // Agent 刚写过线程
  const response = await postApply(port, { windowDays: 3 });
  assert.equal(response.status, 409, `刚被写过的线程不该被当场重写，实际：${response.status} ${response.body}`);
  assert.match(response.body, /排队|Agent/);
});

test("apply with queue=true enqueues through the CLI instead of rewriting now", async t => {
  setupThread();
  const port = await serverFixture(t);
  const original = fs.readFileSync(threadFile, "utf8");
  const response = await postApply(port, { windowDays: 3, queue: true });
  assert.equal(response.status, 202, `排队请求应返回 202，实际：${response.status} ${response.body}`);
  assert.equal(JSON.parse(response.body).queued, true);
  const pending = JSON.parse(fs.readFileSync(path.join(stoneDir, "rebuild-pending.json"), "utf8"));
  assert.equal(pending[0].threadId, threadId);
  assert.equal(fs.readFileSync(threadFile, "utf8"), original, "排队不得当场改写线程文件");
});

test("apply still runs immediately once the thread file has been quiet", async t => {
  setupThread();
  const port = await serverFixture(t);
  const quiet = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(threadFile, quiet, quiet);
  const response = await postApply(port, { windowDays: 3 });
  assert.equal(response.status, 200, `静默线程应照常应用，实际：${response.status} ${response.body}`);
  assert.equal(JSON.parse(response.body).success, true);
});
