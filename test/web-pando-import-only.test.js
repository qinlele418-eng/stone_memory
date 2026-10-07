const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// TASK-0421：Stone Web 对 provider=pando（import_only，宿主工作区持有会话、
// 无线程文件）的呈现面分支。隔离 HOME，不读写任何真实记忆体。
const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-pando-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { startWebServer } = require("../src/web/server");
const { saveConfig } = require("../src/services/thread-setup");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

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

async function withServer(run) {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("W1: /api/session-file/check 对 pando 返回 pando 语义的如实响应", async () => {
  await withServer(async port => {
    for (const key of ["provider", "runtime"]) {
      const response = await request(port, "POST", "/api/session-file/check", { [key]: "pando" });
      assert.equal(response.status, 200, response.body);
      const payload = JSON.parse(response.body);
      assert.equal(payload.notApplicable, true);
      assert.equal(payload.provider, "pando");
      assert.match(payload.message, /Pando 由宿主工作区持有会话/);
      assert.doesNotMatch(response.body, /Claude\/Codex 线程 ID/);
      assert.doesNotMatch(response.body, /线程文件搜索目录"/);
    }
  });
});

test("W1 回归: /api/session-file/check 对 claude/codex 行为零变化", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-pando-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "019f.jsonl"), "{}\n");
  await withServer(async port => {
    const missing = await request(port, "POST", "/api/session-file/check", {});
    assert.equal(missing.status, 400);
    assert.match(missing.body, /请先填写真实 Claude\/Codex 线程 ID 和线程文件搜索目录/);
    const found = await request(port, "POST", "/api/session-file/check", { threadId: "019f", sessionDir: dir });
    assert.equal(found.status, 200);
    assert.deepEqual(JSON.parse(found.body), { found: true, file: path.join(dir, "019f.jsonl") });
  });
});

test("W3: 服务端 rebuild 路由对 pando 线程继续拒绝（preview/check/repair/queue/apply）", async () => {
  // 旧版 layout：直接在 stmem.json 里登记 runtime=pando 的线程。
  saveConfig({
    "t-pando-web": {
      label: "Pando 测试记忆", runtime: "pando", externalThreadId: "pando",
      ai: "AI", user: "用户", purpose: "accompany", minerMode: "subagent",
    },
  });
  await withServer(async port => {
    const base = "/api/libraries/t-pando-web/rebuild";
    const preview = await request(port, "GET", `${base}/preview?windowDays=1&toolPairs=15`);
    assert.equal(preview.status, 409);
    assert.match(preview.body, /pando 记忆体由宿主工作区持有会话、无会话原件/);
    assert.match(preview.body, /DB 口径降级预览/);

    const check = await request(port, "GET", `${base}/check`);
    assert.equal(check.status, 409);
    assert.match(check.body, /无会话原件/);

    const repair = await request(port, "POST", `${base}/repair`, {});
    assert.equal(repair.status, 409);
    assert.match(repair.body, /无会话原件/);

    const queue = await request(port, "POST", `${base}/queue`, {});
    assert.equal(queue.status, 409);
    assert.match(queue.body, /无会话原件/);

    const apply = await request(port, "POST", `${base}/apply`, {});
    assert.equal(apply.status, 409);
    assert.match(apply.body, /rebuild --apply 对 pando 仍被拒绝/);
  });
});

test("W3: dry-run 对 pando 打 dbPreview 标记（DB 口径降级预览，只读）", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  assert.match(server, /runtime:"pando",dbPreview:true/g);
  assert.match(server, /PANDO_WRITE_REFUSAL/);
  assert.match(server, /PANDO_APPLY_REFUSAL/);
  // 拒绝分支先于任何写入执行：preview/check/repair/queue/apply 都判 pando。
  const rebuildRoutes = server.slice(server.indexOf("const rebuildMatch ="), server.indexOf("const importPreviewMatch", server.indexOf("const rebuildMatch =")));
  for (const action of ["preview", "check", "repair", "queue", "apply"]) {
    assert.ok(rebuildRoutes.includes(`action === "${action}"`), `route ${action} 仍存在`);
  }
  assert.match(rebuildRoutes, /rebuildProviderOf\(binding\) === "pando"/);
  assert.match(rebuildRoutes, /rebuildProviderOf\(bindingValue\?getConfiguredBinding\(threadId,bindingValue\):null\) === "pando"/);
});

test("W1: 创建表单 pando 分支不渲染也不校验 sessionDir/线程 ID，不调 session-file/check", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /const pandoMode = state\.form\.runtime === "pando"/);
  assert.match(app, /threadIdTarget\.innerHTML = pandoMode/);
  assert.match(app, /runtimeTarget\.innerHTML = pandoMode/);
  assert.match(app, /if \(pandoMode\) \{ state\.form\.threadId = ""; state\.form\.sessionDir = ""; \}/);
  assert.match(app, /for \(const name of \(pandoMode \? \["libraryName", "ai", "user"\] : \["libraryName", "threadId", "ai", "user"\]\)\)/);
  assert.match(app, /if \(!pandoMode && !String\(state\.form\.sessionDir \|\| ""\)\.trim\(\)\)/);
  // pando 跳过线程文件校验调用；claude/codex 仍调用。
  assert.match(app, /if \(!pandoMode\) await api\("\/api\/session-file\/check"/);
  assert.match(app, /await api\("\/api\/session-file\/check"/);
  // 任何路径不得引导为 pando 填写假 sessionDir。
  assert.doesNotMatch(app, /pando[^"]*sessionDir\s*[:=]\s*["']/);
});

test("W2: 总览卡对 pando 如实呈现 identity/占用/注入，claude/codex 模板零变化", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /const PANDO_IDENTITY = "Pando · import_only（宿主会话，无线程文件）"/);
  assert.match(app, /const threadIdentity=pandoMode\?PANDO_IDENTITY:/);
  assert.match(app, /threadUsageBody=pandoMode/);
  assert.match(app, /threadInjectionBody=pandoMode/);
  assert.match(app, /线程文件口径的窗口占用数据不可用/);
  assert.match(app, /注入计数数据来源不可用，不显示占位数字/);
  // claude/codex 回归：原按钮与原口径仍在非 pando 分支。
  assert.match(app, /`<footer><button class="secondary" id="overview-repair">线程修复<\/button><button class="primary" id="overview-rebuild">线程重建<\/button><\/footer>`/);
  assert.match(app, /document\.querySelector\("#overview-repair"\)\?\.addEventListener\("click",\(\)=>checkAndRepair\(data\)\)/);
});

test("W3: 上下文管理页对 pando 只保留 DB 口径预览，不渲染/不发起修复与裁剪", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  // 检查线程/永久裁剪入口仅存在于非 pando 分支。
  assert.match(app, /\$\{pandoMode\?"":`<button class="secondary rebuild-main-button" id="check-thread">/);
  assert.match(app, /\$\{pandoMode\?"":`<section class="section-card context-trim-card">/);
  assert.match(app, /if\(pandoMode\)injectionSettings\?\.remove\(\)/);
  assert.match(app, /pandoMode\?"不适用（无线程文件）"/);
  assert.match(app, /pandoMode\?"不适用（数据来源不可用）"/);
  // 前端对 pando 不发起 check/repair/裁剪调用；showIntegrity/checkAndRepair/trim 均有守卫。
  assert.match(app, /async function showIntegrity\(library, repair\) \{\s*const target = document\.querySelector\("#integrity"\); if \(!target\) return;\s*\/\/ pando 无线程文件：线程完整性检查\/修复不适用，不向服务端发起调用。\s*if \(isPandoLibrary\(library\)\) return null;/);
  assert.match(app, /async function checkAndRepair\(library\) \{\s*if \(isPandoLibrary\(library\)\) \{ showToast\("pando 记忆体没有线程文件，线程修复不适用"\); return; \}/);
  assert.match(app, /if \(isPandoLibrary\(library\)\) \{\s*main\.innerHTML = `<div class="dashboard-head"><div><p class="eyebrow">永久裁剪<\/p><h1>对 Pando 不适用<\/h1>/);
  // DB 口径降级预览：明示无会话原件、无任何 apply/写入按钮。
  assert.match(app, /async function previewPandoDbRebuild\(library,options=\{\}\)/);
  assert.match(app, /if\(pandoMode\)previewPandoDbRebuild\(library,\{target:"#rebuild-preview-modal-content"\}\)/);
  assert.match(app, /const PANDO_DB_PREVIEW_NOTE = "pando import_only 无会话原件：以下为 DB 口径降级预览（只读，不写入任何文件）；会话重建（full\/ 原件 \+ UUID 链）口径不可用，rebuild --apply 对 pando 仍被拒绝。"/);
  const pandoPreview = app.slice(app.indexOf("async function previewPandoDbRebuild"), app.indexOf("async function previewIntegratedRebuild"));
  assert.doesNotMatch(pandoPreview, /apply-previewed-rebuild|rebuild\/apply|rebuild\/queue|open-trim|preview-trim|renderTrimWorkbench/);
});

test("W1/W4: 接入管理与导入入口对 pando 如实标注 import_only", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /importOnly=binding\.provider==="pando"\|\|binding\.mode==="import_only"/);
  assert.match(app, /import_only（宿主会话，无线程文件）/);
  assert.match(app, /Pando 记忆体由宿主工作区持有会话，没有线程文件；这里只导入通用 JSON\/JSONL\/SQLite 对话文件（DB 口径写入记忆库）/);
  assert.match(app, /pandoWizard \? "Pando 记忆体由宿主工作区持有会话，没有线程文件；这一步可导入通用 JSON\/JSONL\/SQLite 对话文件（DB 口径写入记忆库），也可以直接跳过。"/);
});

test("W2: 上下文管理页 pando 状态卡与注入卡文案（不显示占位 0/进度条）", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /\$\{pandoMode\?`<p class="thread-not-applicable">\$\{PANDO_THREAD_NOTE\}；线程文件口径的窗口占用数据不可用。<\/p>`:`<div class="context-usage">/);
  assert.match(app, /\$\{pandoMode\?`<span class="badge">不适用<\/span>`:`<span class="badge" id="context-retention-mode">暂无记录<\/span>`\}/);
  assert.match(app, /当前窗口注入按线程重建口径取数，对 Pando 不适用；注入计数数据来源不可用，不显示占位数字。/);
});
