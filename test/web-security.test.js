const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  WebAuthError, SESSION_TTL_MS, isLoopbackHost, hashToken, generateToken, configuredAuth, isPublicWebApiRoute, createWebAuth,
} = require("../src/security/web-auth");
const { assertSafeThreadId, assertRuntimeAndPurpose } = require("../src/config");
const { safeStmemFailure, redactWebSecrets, error: respondWithError } = require("../src/web/server");
const { appendPrivateFile, ensurePrivateDirectory, writePrivateFile, hardenDatabaseArtifacts } = require("../src/security/local-data-permissions");
const { inspectProcessLock } = require("../src/lib/process-lock");

function request(headers = {}, method = "GET") {
  return { headers, method, socket: { encrypted: false } };
}

test("web auth recognises loopback listeners without treating all interfaces as local", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

test("thread path segments reject traversal while retaining opaque identifiers", () => {
  assert.equal(assertSafeThreadId("019f91a4:worker_a.b"), "019f91a4:worker_a.b");
  for (const value of ["", ".", "..", "a/b", "a\\b", "a\0b", "a".repeat(256)]) assert.throws(() => assertSafeThreadId(value));
  assert.doesNotThrow(() => assertRuntimeAndPurpose("codex", "coding"));
  assert.throws(() => assertRuntimeAndPurpose("../codex", "coding"));
  assert.throws(() => assertRuntimeAndPurpose("codex", "../coding"));
});

test("browser sessions expire, are same-origin protected, and are invalidated by rotation", () => {
  const token = generateToken();
  const config = { web: { auth: { tokenVerifier: hashToken(token), tokenVersion: 1 } } };
  let clock = 1_000;
  const auth = createWebAuth({ host: "0.0.0.0", configProvider: () => config, now: () => clock });
  assert.equal(auth.authenticate(request({ authorization: `Bearer ${token}` })).kind, "bearer");
  const cookie = auth.unlock(token, request({ host: "stone.test" }, "POST"));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=28800/);
  const sessionId = /stmem_web_session=([^;]+)/.exec(cookie)[1];
  const sessionRequest = request({ cookie: `stmem_web_session=${sessionId}`, host: "stone.test", origin: "http://stone.test" }, "POST");
  assert.equal(auth.authenticate(sessionRequest).kind, "session");
  assert.doesNotThrow(() => auth.assertSameOrigin(sessionRequest, { kind: "session" }));
  assert.throws(() => auth.assertSameOrigin(request({ cookie: `stmem_web_session=${sessionId}`, host: "stone.test", origin: "https://attacker.test" }, "POST"), { kind: "session" }), WebAuthError);
  clock += SESSION_TTL_MS + 1;
  assert.throws(() => auth.authenticate(sessionRequest), error => error instanceof WebAuthError && error.status === 401);
  clock = 1_000;
  const cookie2 = auth.unlock(token, request({ host: "stone.test" }, "POST"));
  const sessionId2 = /stmem_web_session=([^;]+)/.exec(cookie2)[1];
  const sessionRequest2 = request({ cookie: `stmem_web_session=${sessionId2}`, host: "stone.test", origin: "http://stone.test" }, "POST");
  config.web.auth = { tokenVerifier: hashToken(generateToken()), tokenVersion: 2 };
  assert.throws(() => auth.authenticate(sessionRequest2), error => error instanceof WebAuthError && error.status === 401);
});

test("browser session cookies become Secure only when the configured browser origin is HTTPS", () => {
  const token = generateToken();
  const config = { web: { publicUrl: "https://stone.example.test", auth: { tokenVerifier: hashToken(token), tokenVersion: 1 } } };
  const auth = createWebAuth({ host: "0.0.0.0", configProvider: () => config });
  assert.match(auth.unlock(token, request({ host: "stone.example.test" }, "POST")), /; Secure$/);
});

test("public auth allowlist is explicit and minimal", () => {
  assert.equal(isPublicWebApiRoute("GET", "/api/auth/status"), true);
  assert.equal(isPublicWebApiRoute("POST", "/api/auth/unlock"), true);
  for (const [method, pathname] of [["POST", "/api/auth/status"], ["GET", "/api/auth/unlock"], ["GET", "/api/libraries"], ["GET", "/review-lab/api/anything"]]) {
    assert.equal(isPublicWebApiRoute(method, pathname), false, `${method} ${pathname}`);
  }
});

test("web-facing failure text redacts credential-shaped values", () => {
  const raw = "Error: apiKey=super-secret-value authorization: Bearer stmem_abcDEF0123456789 payload={\"apiKey\":\"new-json-api-secret\",\"api_key\":\"new-json-snake-secret\",\"authorization\":\"Bearer new-json-auth-secret\"}";
  const redacted = redactWebSecrets(raw);
  const secretPattern = /super-secret-value|stmem_abcDEF0123456789|new-json-api-secret|new-json-snake-secret|new-json-auth-secret/;
  assert.doesNotMatch(redacted, secretPattern);
  assert.doesNotMatch(safeStmemFailure(raw, "mine", 1), secretPattern);
});

test("all JSON error responses redact credential-shaped values", () => {
  let status, headers, payload;
  const response = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(body) { payload = JSON.parse(body); },
  };
  respondWithError(response, 400, "request failed: {\"apiKey\":\"new-json-api-secret\",\"api_key\":\"new-json-snake-secret\",\"authorization\":\"Bearer new-json-auth-secret\"}");
  assert.equal(status, 400);
  assert.equal(headers["cache-control"], "no-store");
  assert.doesNotMatch(payload.error, /new-json-api-secret|new-json-snake-secret|new-json-auth-secret/);
});

test("POSIX hardening affects Stone-owned files only", t => {
  if (process.platform === "win32") return t.skip("Windows does not provide POSIX mode-bit semantics; run this assertion on Linux CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-private-paths-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-external-source-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const stone = path.join(root, ".stone_memory");
  const database = path.join(stone, "runtimes", "codex", "coding", "memory", "memory.sqlite");
  const source = path.join(external, "conversation.json");
  const security = { trustedRoot: root };
  ensurePrivateDirectory(path.dirname(database), security);
  writePrivateFile(database, "sqlite-placeholder", {}, security);
  writePrivateFile(`${database}-wal`, "wal", {}, security);
  writePrivateFile(`${database}-shm`, "shm", {}, security);
  fs.writeFileSync(source, "outside", { mode: 0o644 });
  hardenDatabaseArtifacts(database, security);
  assert.equal(fs.statSync(stone).mode & 0o777, 0o700);
  for (const file of [database, `${database}-wal`, `${database}-shm`]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(source).mode & 0o777, 0o644, "external Binding/import sources must not be chmodded");
});

test("POSIX private writes and appends never follow a symlink", t => {
  if (process.platform === "win32") return t.skip("Windows does not provide the POSIX no-follow guarantee exercised here");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-private-symlink-"));
  const external = path.join(root, "outside.txt");
  const privateFile = path.join(root, ".stone_memory", "state.json");
  const security = { trustedRoot: root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(external, "outside data", { mode: 0o640 });
  fs.chmodSync(external, 0o640);
  const before = fs.statSync(external);
  const unchanged = () => {
    const after = fs.statSync(external);
    assert.equal(fs.readFileSync(external, "utf8"), "outside data");
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.mtimeMs, before.mtimeMs);
  };
  ensurePrivateDirectory(path.dirname(privateFile), security);
  fs.symlinkSync(external, privateFile);
  assert.throws(() => writePrivateFile(privateFile, "must not replace external", {}, security), /符号链接/);
  unchanged();
  assert.throws(() => appendPrivateFile(privateFile, "must not append external", { encoding: "utf8" }, security), /符号链接/);
  unchanged();
});

test("POSIX private paths trust an external home boundary but reject symlinks below it", t => {
  if (process.platform === "win32") return t.skip("Windows does not provide the POSIX symlink semantics exercised here");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-private-boundary-"));
  const realHome = path.join(root, "real-home");
  const linkedHome = path.join(root, "linked-home");
  const privateFile = path.join(linkedHome, ".stone_memory", "state.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(realHome);
  fs.symlinkSync(realHome, linkedHome);
  const security = { trustedRoot: linkedHome };
  assert.doesNotThrow(() => writePrivateFile(privateFile, "safe", {}, security));
  assert.equal(fs.readFileSync(path.join(realHome, ".stone_memory", "state.json"), "utf8"), "safe");
  fs.unlinkSync(privateFile);
  fs.symlinkSync(path.join(root, "outside"), privateFile);
  assert.throws(() => writePrivateFile(privateFile, "unsafe", {}, security), /符号链接/);
});

test("POSIX watcher state and lock artifacts tighten existing permissions", t => {
  if (process.platform === "win32") return t.skip("Windows does not provide POSIX mode-bit semantics; run this assertion on Linux CI");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-private-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runtimePath = path.join(__dirname, "..", "src", "services", "watcher-runtime.js");
  const lockPath = path.join(__dirname, "..", "src", "lib", "process-lock.js");
  const script = `
    const fs = require("fs"), path = require("path");
    const id = "thread-private-state", home = process.env.HOME;
    const stone = path.join(home, ".stone_memory");
    fs.mkdirSync(stone, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({ [id]: { runtime: "codex", purpose: "coding" } }), { mode: 0o600 });
    const runtime = require(${JSON.stringify(runtimePath)}), { inspectProcessLock } = require(${JSON.stringify(lockPath)});
    const { root, stateFile, lockDir } = runtime.watcherPaths(id);
    fs.mkdirSync(root, { recursive: true, mode: 0o755 }); fs.chmodSync(root, 0o755);
    fs.writeFileSync(stateFile, JSON.stringify({ status: "old" }), { mode: 0o644 }); fs.chmodSync(stateFile, 0o644);
    fs.mkdirSync(lockDir, { mode: 0o755 }); fs.chmodSync(lockDir, 0o755);
    const owner = path.join(lockDir, "owner.json"); fs.writeFileSync(owner, JSON.stringify({ pid: 0 }), { mode: 0o644 }); fs.chmodSync(owner, 0o644);
    runtime.readWatcherState(id, { verifyProcess: false });
    inspectProcessLock(lockDir, "watcher.js", { privatePaths: true });
    console.log(JSON.stringify({ root: fs.statSync(root).mode & 0o777, state: fs.statSync(stateFile).mode & 0o777, lock: fs.statSync(lockDir).mode & 0o777, owner: fs.statSync(owner).mode & 0o777 }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { root: 0o700, state: 0o600, lock: 0o700, owner: 0o600 });
});

test("web auth CLI stores only a verifier and rejects unprotected non-loopback startup", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-security-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const bin = path.join(__dirname, "..", "bin", "stmem");
  const rejected = spawnSync(process.execPath, [bin, "web", "--host", "0.0.0.0"], { env, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /必须先执行 stmem web auth rotate/);
  const rotated = spawnSync(process.execPath, [bin, "web", "auth", "rotate", "--json"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(rotated.status, 0, rotated.stderr);
  const result = JSON.parse(rotated.stdout);
  assert.match(result.token, /^stmem_/);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(configuredAuth(config).tokenVerifier, hashToken(result.token));
  assert.equal(JSON.stringify(config).includes(result.token), false, "配置不得保存明文 Token");
  assert.equal(Object.hasOwn(config.web.auth, "token"), false);
  assert.equal(Number.isInteger(config.web.auth.tokenVersion), true);
  const allPrivateFiles = [];
  const collect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(item); else allPrivateFiles.push(item);
    }
  };
  collect(home);
  for (const file of allPrivateFiles) assert.equal(fs.readFileSync(file, "utf8").includes(result.token), false, `Token leaked to ${file}`);
  const configured = spawnSync(process.execPath, [bin, "web", "config", "--host", "0.0.0.0", "--port", "43171", "--url", "http://stone.lan:43171"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(configured.status, 0, configured.stderr);
  const afterConfig = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(afterConfig.web.auth.tokenVerifier, hashToken(result.token), "web config must preserve authentication state");
  assert.equal(afterConfig.web.host, "0.0.0.0");
  assert.equal(afterConfig.web.publicUrl, "http://stone.lan:43171", "HTTP with a token is warned at start, not prohibited");
});

test("public thread settings never serialise the configured model API key", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-secret-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".stone_memory", "stmem.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    "thread-safe": { label: "Safe", runtime: "codex", purpose: "coding", apiProvider: "provider", sessionDir: "/srv/private/codex/sessions" },
    apiKeys: { provider: { key: "model-secret-must-not-leak", model: "model-a", baseUrl: "https://example.test" } },
  }));
  const script = `const { publicThreadSettings } = require(${JSON.stringify(path.join(__dirname, "..", "src", "web", "server.js"))}); console.log(JSON.stringify({ local: publicThreadSettings("thread-safe"), remote: publicThreadSettings("thread-safe", { redactLocalPaths: true }) }));`;
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const { local, remote } = JSON.parse(child.stdout);
  assert.equal(local.hasApiKey, true);
  assert.equal(Object.hasOwn(local, "apiKey"), false);
  assert.equal(local.sessionDir, "/srv/private/codex/sessions");
  assert.equal(remote.sessionDir, "");
  assert.equal(child.stdout.includes("model-secret-must-not-leak"), false);
});

test("the HTTP API rejects unauthenticated requests before routing and blocks cross-origin cookie writes", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-http-auth-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const serverPath = path.join(__dirname, "..", "src", "web", "server.js");
  const authPath = path.join(__dirname, "..", "src", "security", "web-auth.js");
  const script = `
    const fs = require("fs"), http = require("http"), path = require("path");
    const { hashToken } = require(${JSON.stringify(authPath)});
    const home = process.env.USERPROFILE;
    fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
    const token = "stmem_test_token";
    fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({ web: { auth: { tokenVerifier: hashToken(token), tokenVersion: 1 } } }));
    const { startWebServer } = require(${JSON.stringify(serverPath)});
    const call = (port, method, pathname, headers = {}, body = "") => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, res => {
        const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }); req.on("error", reject); if (body) req.write(body); req.end();
    });
    (async () => {
      const server = await startWebServer({ host: "127.0.0.1", port: 0 });
      const port = server.address().port;
      const denied = await call(port, "GET", "/api/libraries");
      const allowed = await call(port, "GET", "/api/libraries", { authorization: "Bearer " + token });
      const unlocked = await call(port, "POST", "/api/auth/unlock", { "content-type": "application/json" }, JSON.stringify({ token }));
      const csrf = await call(port, "POST", "/api/missing", { cookie: unlocked.headers["set-cookie"][0], origin: "https://attacker.test" });
      const reviewDenied = await call(port, "GET", "/review-lab/api/missing");
      const rotated = await call(port, "POST", "/api/web-security/token", { authorization: "Bearer " + token });
      const nextToken = JSON.parse(rotated.body).token;
      const oldAfterRotate = await call(port, "GET", "/api/libraries", { authorization: "Bearer " + token });
      const newAfterRotate = await call(port, "GET", "/api/libraries", { authorization: "Bearer " + nextToken });
      const sessionAfterRotate = await call(port, "GET", "/api/libraries", { cookie: unlocked.headers["set-cookie"][0] });
      await new Promise(resolve => server.close(resolve));
      fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({}));
      const local = await startWebServer({ host: "127.0.0.1", port: 0 });
      const localPort = local.address().port;
      const unsafeMethods = await Promise.all(["POST", "PUT", "PATCH", "DELETE"].map(method => call(localPort, method, "/api/missing", { origin: "https://attacker.test", "sec-fetch-site": "cross-site" })));
      await new Promise(resolve => local.close(resolve));
      console.log(JSON.stringify({ denied, allowed, unlocked, csrf, reviewDenied, rotated, oldAfterRotate, newAfterRotate, sessionAfterRotate, unsafeMethods }));
    })().catch(error => { console.error(error.stack); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.denied.status, 401);
  assert.equal(result.denied.headers["www-authenticate"], "Bearer");
  assert.equal(result.denied.headers["cache-control"], "no-store");
  assert.equal(result.denied.headers["access-control-allow-origin"], undefined);
  assert.equal(result.denied.headers["access-control-allow-credentials"], undefined);
  assert.equal(result.allowed.status, 200);
  assert.equal(result.unlocked.status, 200);
  assert.match(result.unlocked.headers["set-cookie"][0], /HttpOnly/);
  assert.equal(result.csrf.status, 403);
  assert.equal(result.reviewDenied.status, 401);
  assert.equal(result.rotated.status, 200);
  assert.match(JSON.parse(result.rotated.body).token, /^stmem_/);
  assert.equal(result.oldAfterRotate.status, 401);
  assert.equal(result.newAfterRotate.status, 200);
  assert.equal(result.sessionAfterRotate.status, 401);
  for (const response of result.unsafeMethods) {
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  }
});

test("a non-loopback Web listener cannot name server files, but CLI-registered Bindings still preview", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-binding-home-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-binding-external-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  });
  const source = path.join(external, "source.json");
  const sourceContents = JSON.stringify([
    { timestamp: "2026-09-01T00:00:00.000Z", role: "user", content: "隔离 Binding 测试" },
    { timestamp: "2026-09-01T00:01:00.000Z", role: "assistant", content: "保持 preview-first" },
  ]);
  fs.writeFileSync(source, sourceContents);
  const token = "stmem_binding_test_token";
  const authPath = path.join(__dirname, "..", "src", "security", "web-auth.js");
  const { hashToken: hash } = require(authPath);
  const configPath = path.join(home, ".stone_memory", "stmem.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    web: { auth: { tokenVerifier: hash(token), tokenVersion: 1 } },
    "thread-security": { label: "Security", runtime: "codex", purpose: "coding", ai: "A", user: "U", sessionDir: source },
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const bin = path.join(__dirname, "..", "bin", "stmem");
  const registered = spawnSync(process.execPath, [bin, "binding", "add", "--thread", "thread-security", "--provider", "codex", "--external-thread", "external-security", "--thread-file", source, "--apply"], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(registered.status, 0, registered.stderr);
  const bindingId = JSON.parse(registered.stdout).binding.id;
  const serverPath = path.join(__dirname, "..", "src", "web", "server.js");
  const script = `
    const http = require("http");
    const { startWebServer } = require(${JSON.stringify(serverPath)});
    const call = (port, pathname, body, method = "POST") => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: {
        authorization: "Bearer ${token}", "content-type": "application/json", "x-forwarded-for": "127.0.0.1", host: "localhost"
      } }, res => { const chunks=[]; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })); });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
    (async () => {
      const server = await startWebServer({ host: "0.0.0.0", port: 0 });
      const port = server.address().port;
      const settings = await call(port, "/api/libraries/thread-security/settings", {}, "GET");
      const add = await call(port, "/api/libraries/thread-security/bindings", { provider: "codex", threadFile: ${JSON.stringify(source)} });
      const temporary = await call(port, "/api/libraries/thread-security/bindings/not-real/import", { source: ${JSON.stringify(source)} });
      const sessionCheck = await call(port, "/api/session-file/check", { threadId: "thread-security", sessionDir: ${JSON.stringify(source)} });
      const sessionUpdate = await call(port, "/api/libraries/thread-security/settings", { sessionDir: ${JSON.stringify(source)} }, "PATCH");
      const sessionCreate = await call(port, "/api/libraries", { threadId: "remote-new", sessionDir: ${JSON.stringify(source)} });
      const registered = await call(port, "/api/libraries/thread-security/bindings/${bindingId}/import", {});
      await new Promise(resolve => server.close(resolve));
      console.log(JSON.stringify({ settings, add, temporary, sessionCheck, sessionUpdate, sessionCreate, registered }));
    })().catch(error => { console.error(error.stack); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.settings.status, 200);
  assert.equal(JSON.parse(result.settings.body).sessionDir, "");
  assert.equal(result.settings.body.includes(${JSON.stringify("/srv/private/codex/sessions")}), false);
  assert.equal(result.add.status, 400);
  assert.match(result.add.body, /不能注册服务器本地 Binding 路径/);
  assert.equal(result.temporary.status, 400);
  assert.match(result.temporary.body, /不能临时指定服务器本地路径/);
  assert.equal(result.sessionCheck.status, 400);
  assert.match(result.sessionCheck.body, /不能指定服务器本地线程文件目录/);
  assert.equal(result.sessionUpdate.status, 400);
  assert.match(result.sessionUpdate.body, /不能修改服务器本地线程文件目录/);
  assert.equal(result.sessionCreate.status, 400);
  assert.match(result.sessionCreate.body, /不能新增服务器本地线程文件目录/);
  assert.equal(result.registered.status, 200, result.registered.body);
  assert.equal(fs.readFileSync(source, "utf8"), sourceContents, "Stone must never modify an external Binding source");
});
