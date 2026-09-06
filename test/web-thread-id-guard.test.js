const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 隔离 HOME：只验证路由守卫，不读写任何真实记忆体。
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-guard-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
const { startWebServer } = require("../src/web/server");

// 目标目录逃出 ~/.stone_memory/runtimes/：命中漏洞时会在这里建库。
const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-escape-"));
const traversal = `${"..%2F".repeat(6)}${encodeURIComponent(escapeTarget).replace(/%2F/gi, "%2F")}%2FPWNED`;

function request(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: body ? { "content-type": "application/json" } : undefined,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function get(port, pathname) {
  return request(port, "GET", pathname);
}

test("every library route rejects an unknown thread id instead of touching the filesystem", async t => {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const readRoutes = [
    `/api/libraries/${traversal}/feelings`,
    `/api/libraries/${traversal}/features`,
    `/api/libraries/${traversal}/rules`,
    `/api/libraries/${traversal}/conversations`,
    `/api/libraries/${traversal}/timeline?terms=x`,
    `/api/libraries/${traversal}/compression/preview`,
    `/api/libraries/${traversal}/feelings/retain-preview?id=x`,
  ];
  for (const pathname of readRoutes) {
    const response = await get(port, pathname);
    assert.equal(response.status, 400, `${pathname} 应当拒绝未知线程`);
    assert.match(response.body, /记忆体不存在/);
  }

  const writeRoutes = [
    `/api/libraries/${traversal}/feelings/update`,
    `/api/libraries/${traversal}/feelings/anchor`,
    `/api/libraries/${traversal}/compression/apply`,
  ];
  for (const pathname of writeRoutes) {
    const response = await request(port, "POST", pathname, {});
    assert.equal(response.status, 400, `${pathname} 应当拒绝未知线程`);
    assert.match(response.body, /记忆体不存在/);
  }

  const reviewReadRoutes = [
    `/review-lab/api/dates?threadId=${traversal}`,
    `/review-lab/api/candidates?threadId=${traversal}`,
    `/review-lab/api/batches?threadId=${traversal}`,
  ];
  for (const pathname of reviewReadRoutes) {
    const response = await get(port, pathname);
    assert.equal(response.status, 400, `${pathname} 应当拒绝未知审阅线程`);
    assert.match(response.body, /记忆体不存在/);
  }

  const reviewWriteRoutes = [
    ["/review-lab/api/preview", { threadId: traversal, date: "2026-09-06" }],
    ["/review-lab/api/batches", { threadId: traversal }],
    ["/review-lab/api/hybrid", { threadId: traversal }],
    ["/review-lab/api/fusion", { threadId: traversal }],
  ];
  for (const [pathname, body] of reviewWriteRoutes) {
    const response = await request(port, "POST", pathname, body);
    assert.equal(response.status, 400, `${pathname} 应当拒绝未知审阅线程`);
    assert.match(response.body, /记忆体不存在/);
  }

  assert.equal(fs.existsSync(path.join(escapeTarget, "PWNED")), false, "不得在记忆体目录之外创建任何文件");
  assert.deepEqual(fs.readdirSync(escapeTarget), []);
});
