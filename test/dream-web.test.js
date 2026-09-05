"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-web-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const stoneRoot = path.join(home, ".stone_memory");
const threadId = "thread-web";
fs.mkdirSync(stoneRoot, { recursive: true });
fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
  [threadId]: {
    runtime: "codex",
    purpose: "accompany",
    user: "test-user",
    ai: "test-ai",
    automaticDream: true,
  },
}));

const { startWebServer } = require("../src/web/server");
const { DreamStore } = require("../src/storage/dream-store");

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

test("Dream Lab API hides NSFW archives and prompts until the thread opts in", async t => {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new DreamStore({ root: path.join(stoneRoot, "dream") });
  store.save({
    threadId,
    date: "2026-09-01",
    dreamType: "erotic",
    title: "hidden",
    body: "hidden body",
  });

  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const base = `/api/libraries/${threadId}/dreams`;

  const hiddenDream = await request(port, "GET", `${base}?date=2026-09-01`);
  assert.equal(hiddenDream.status, 404);
  assert.match(hiddenDream.body.error, /当前不可见/u);

  for (const type of ["common-core", "beautiful", "nightmare"]) {
    const prompt = await request(port, "GET", `${base}/prompt?type=${type}`);
    assert.equal(prompt.status, 200);
    assert.doesNotMatch(prompt.body.content, /绮梦|绮染|亲密内容|欲望/u);
  }

  const hiddenPrompt = await request(port, "GET", `${base}/prompt?type=erotic`);
  assert.equal(hiddenPrompt.status, 400);

  const enabled = await request(port, "PUT", `${base}/nsfw`, { enabled: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.nsfwEnabled, true);

  const visiblePrompt = await request(port, "GET", `${base}/prompt?type=erotic`);
  assert.equal(visiblePrompt.status, 200);
  assert.match(visiblePrompt.body.content, /绮梦/u);
});
