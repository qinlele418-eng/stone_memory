const { test, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const childProcess = require("node:child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-compat-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

// Capture the public command boundary without starting a CLI or reading real data.
let commandResult = () => ({ status: 0, stdout: " {} \n" });
const spawnSync = mock.method(childProcess, "spawnSync", (...args) => commandResult(...args));
const service = require("../src/web/server");
const contract = {
  startWebServer: 0, listLibraries: 0, overview: 1, previewRows: 1,
  paginate: 1, buildConversationCalendar: 1, listDeveloperModules: 0,
  miningDatesFromStore: 2, miningCommandArgs: 3, miningCheckCommandArgs: 3,
  targetedMiningCommandArgs: 3, timelineCommandArgs: 2, compactTimelineReport: 1,
  compressionCommandArgs: 1, safeStmemFailure: 3, runStmem: 1,
  reviewCandidateForWeb: 1, reviewProfileFromInput: 1, reviewBatchPayload: 1,
  reviewBatchCommandArgs: 3,
};

test("original CommonJS and ESM entry retains every export and function signature", async () => {
  assert.equal(spawnSync.mock.callCount(), 0, "import must not execute CLI commands");
  assert.deepEqual(Object.keys(contract).sort(), Object.keys(service).filter(name => Object.hasOwn(contract, name)).sort());
  assert.strictEqual(require("../src/web/server.js"), service);
  const esm = await import(pathToFileURL(require.resolve("../src/web/server")).href);
  assert.strictEqual(esm.default, service);
  for (const [name, arity] of Object.entries(contract)) {
    assert.equal(typeof service[name], "function", name);
    assert.equal(service[name].length, arity, name);
    assert.strictEqual(esm[name], service[name], name);
  }
});

test("runStmem retains synchronous return, CLI location, options and thrown errors", () => {
  const root = path.resolve(__dirname, "..");
  commandResult = (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [path.join(root, "bin", "stmem"), "status"]);
    assert.deepEqual(options, { cwd: root, encoding: "utf8", timeout: 123, maxBuffer: 456 });
    return { status: 0, stdout: " result \n" };
  };
  assert.equal(service.runStmem(["status"], { timeout: 123, maxBuffer: 456 }), "result");
  const cause = new Error("spawn failed");
  commandResult = () => ({ error: cause });
  assert.throws(() => service.runStmem(["status"]), error => error === cause);
  commandResult = () => ({ status: 9, stderr: "[memory-miner] error: fixture failure" });
  assert.throws(() => service.runStmem(["mine"]), { message: "error: fixture failure" });
  commandResult = () => ({ status: 0, stdout: "{}" });
});

async function start(t) {
  const pending = service.startWebServer({ host: "127.0.0.1", port: 0 });
  assert.ok(pending instanceof Promise);
  const server = await pending;
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP routing retains fallthrough, JSON errors, static cache and redirects", async t => {
  const base = await start(t);
  for (const [url, method] of [["/api/missing", "GET"], ["/api/libraries", "PATCH"], ["/review-lab/api/missing", "GET"]]) {
    const response = await fetch(base + url, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "接口不存在" });
  }
  const invalid = await fetch(base + "/api/session-file/check", { method: "POST", body: "{" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "请求 JSON 格式无效" });
  const libraries = await fetch(base + "/api/libraries");
  assert.equal(libraries.status, 200);
  assert.deepEqual((await libraries.json()).libraries, []);
  const page = await fetch(base + "/", { headers: { "accept-encoding": "identity" } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  const cached = await fetch(base + "/", { headers: { "accept-encoding": "identity", "if-none-match": page.headers.get("etag") } });
  assert.equal(cached.status, 304);
  const redirect = await fetch(base + "/dream-lab/?fixture=1", { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "/developer-modules/dream-lab/?fixture=1");
});

test("developer module GET and POST bridge retains global scope and private batch cleanup", async t => {
  const base = await start(t);
  let batchFile;
  commandResult = (executable, args) => {
    assert.deepEqual(args.slice(1, 4), ["module", "developer-community", "status"]);
    assert.equal(args.includes("--memory"), false);
    const batchIndex = args.indexOf("--batch-file");
    if (batchIndex !== -1) {
      batchFile = args[batchIndex + 1];
      assert.deepEqual(JSON.parse(fs.readFileSync(batchFile, "utf8")), { fixture: true });
      if (process.platform !== "win32") assert.equal(fs.statSync(batchFile).mode & 0o777, 0o600);
    }
    return { status: 0, stdout: '{"fixture":"ok"}' };
  };
  t.after(() => { commandResult = () => ({ status: 0, stdout: "{}" }); });
  const url = base + "/api/developer-modules/developer-community/commands/status";
  for (const options of [{}, { method: "POST", body: JSON.stringify({ fixture: true }) }]) {
    const response = await fetch(url, options);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { fixture: "ok" });
  }
  assert.ok(batchFile);
  assert.equal(fs.existsSync(path.dirname(batchFile)), false);
  const calls = spawnSync.mock.callCount();
  const missingThread = await fetch(base + "/api/developer-modules/dream-lab/commands/preferences");
  assert.equal(missingThread.status, 400);
  assert.deepEqual(await missingThread.json(), { error: "缺少当前记忆体" });
  assert.equal(spawnSync.mock.callCount(), calls);
});

test("servers created through the existing export continue sharing import previews", async t => {
  const first = await start(t);
  const second = await start(t);
  const response = await fetch(first + "/api/imports/preview", {
    method: "POST", headers: { "x-file-name": "fixture.jsonl" },
    body: JSON.stringify({ timestamp: "2026-05-12T10:00:00Z", type: "human", text: "fixture" }) + "\n",
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  // Internal state is used only for fixture cleanup; sharing is asserted via HTTP.
  const { previews } = require("../src/web/state");
  t.after(() => {
    const item = previews.get(preview.token);
    if (item) fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true });
    previews.delete(preview.token);
  });
  const shared = await fetch(second + `/api/imports/${preview.token}`);
  assert.equal(shared.status, 200);
  const result = await shared.json();
  assert.equal(result.token, preview.token);
  assert.deepEqual(result.rows, preview.rows);
  assert.equal(result.rows.length, 1);
});
