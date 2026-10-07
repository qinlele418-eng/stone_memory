"use strict";

// TASK-0425：Stone Web timezone 设置闭环（保存 → 持久化 → 刷新回显 → 页面统一口径）。
// 0400 契约的消费面锁定：时区校验/回退语义全部由既有 stmem memory settings --validate→--apply
// 与 services/timezone.js 承担，本链路只负责把值如实带给页面；全程零硬编码偏移。
// 隔离 HOME，不读写任何真实记忆体。

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-tz-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { startWebServer } = require("../src/web/server");
const { getMemoryContext } = require("../src/config");
const { DEFAULT_TIMEZONE, resolveMemoryTimezone } = require("../src/services/timezone");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const STONE_ROOT = path.join(home, ".stone_memory");

// memory-v1 记忆体夹具（同 test/timezone.test.js 的手工布局）
function registerMemory(memoryId, { timezone = undefined } = {}) {
  fs.mkdirSync(STONE_ROOT, { recursive: true });
  const stmemFile = path.join(STONE_ROOT, "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config.memories = config.memories || {};
  config.memories[memoryId] = { memoryId, label: memoryId, status: "active", createdAt: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
  const root = path.join(STONE_ROOT, "memories", memoryId);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, ".layout-v1.json"), JSON.stringify({
    schemaVersion: 1, status: "complete", memoryId, origin: "created", completedAt: "2026-01-01T00:00:00.000Z",
  }), "utf8");
  fs.writeFileSync(path.join(root, "memory.json"), JSON.stringify({
    schemaVersion: 1, memoryId, label: memoryId, status: "active", ai: "小鱼", user: "旭乐", purpose: "accompany",
    ...(timezone !== undefined ? { timezone } : {}),
  }), "utf8");
  fs.writeFileSync(path.join(root, "bindings.json"), JSON.stringify({ schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] }), "utf8");
  fs.writeFileSync(path.join(root, "watcher.json"), JSON.stringify({ schemaVersion: 1, enabled: false, modules: {} }), "utf8");
  return path.join(root, "memory.json");
}

// 旧布局夹具：只有 stmem.json 根级条目，无 memories/ 目录
function registerLegacyMemory(memoryId) {
  fs.mkdirSync(STONE_ROOT, { recursive: true });
  const stmemFile = path.join(STONE_ROOT, "stmem.json");
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config[memoryId] = { runtime: "codex", purpose: "accompany", ai: "小鱼", user: "旭乐" };
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
}

function storedTimezone(memoryFile) {
  return JSON.parse(fs.readFileSync(memoryFile, "utf8")).timezone;
}

function request(port, method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method, path: pathname,
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

const FORM = (timezone, overrides = {}) => ({
  libraryName: "测试记忆体", ai: "小鱼", user: "旭乐", userGender: "unspecified",
  scenario: "accompany", minerMode: "subagent", windowDays: 1, keepToolPairs: 15, contextWindowTokens: 0,
  timezone,
  ...overrides,
});

async function withServer(run) {
  const server = await startWebServer({ host: "127.0.0.1", port: 0 });
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("Z2 保存链 E2E：填写→持久化→GET 刷新回显→PATCH 响应带回显", async () => {
  const memoryFile = registerMemory("tz-save-memory");
  await withServer(async port => {
    const base = `/api/libraries/tz-save-memory/settings`;
    const saved = await request(port, "PATCH", base, FORM("Asia/Shanghai"));
    assert.equal(saved.status, 200, saved.body);
    const savedConfig = JSON.parse(saved.body).config;
    assert.equal(savedConfig.timezone, "Asia/Shanghai", "PATCH 响应必须带回已存时区");
    assert.equal(storedTimezone(memoryFile), "Asia/Shanghai", "必须经 stmem settings --apply 落盘");
    // 刷新页面 = 重新 GET：字段仍显示已存值
    const echoed = JSON.parse((await request(port, "GET", base)).body);
    assert.equal(echoed.timezone, "Asia/Shanghai");
  });
});

test("Z3 非法 IANA 值明确报错且不落脏值", async () => {
  const memoryFile = registerMemory("tz-invalid-memory", { timezone: "Asia/Shanghai" });
  await withServer(async port => {
    const base = `/api/libraries/tz-invalid-memory/settings`;
    for (const bad of ["Asia/Beijing", "GMT+8", "乱写的时区"]) {
      const response = await request(port, "PATCH", base, FORM(bad));
      assert.equal(response.status, 400, `${bad} 应被拒绝`);
      const message = JSON.parse(response.body).error;
      assert.match(message, /IANA/, `${bad} 的报错必须说明 IANA 时区名称：${message}`);
      assert.match(message, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "报错必须带出收到的原值");
      assert.equal(storedTimezone(memoryFile), "Asia/Shanghai", `${bad} 不得落库`);
    }
    // 报错后原值仍可正常回显
    const echoed = JSON.parse((await request(port, "GET", base)).body);
    assert.equal(echoed.timezone, "Asia/Shanghai");
  });
});

test("Z3 留空保存恢复默认时区（DEFAULT_TIMEZONE 语义，不硬编码偏移）", async () => {
  const memoryFile = registerMemory("tz-blank-memory", { timezone: "America/New_York" });
  await withServer(async port => {
    const base = `/api/libraries/tz-blank-memory/settings`;
    const response = await request(port, "PATCH", base, FORM(""));
    assert.equal(response.status, 200, response.body);
    const config = JSON.parse(response.body).config;
    assert.equal(config.timezone, null, "清空后回显为 null（未配置态）");
    assert.equal(storedTimezone(memoryFile), null, "清空落盘为 null，而非任何具体偏移");
    assert.equal(resolveMemoryTimezone("tz-blank-memory"), DEFAULT_TIMEZONE, "未配置态生效时区 = DEFAULT_TIMEZONE");
    // 响应与落盘都不得出现硬编码 +08:00 之类偏移串
    assert.doesNotMatch(response.body, /\+\d{2}:\d{2}/);
  });
});

test("Z4 统一时区口径：defaultTimezone / 列表 / 总览全部走 memory timezone", async () => {
  const memoryFile = registerMemory("tz-display-memory");
  registerMemory("tz-display-ny", { timezone: "America/New_York" });
  // 无目录的登记项 → 草稿
  const stmemFile = path.join(STONE_ROOT, "stmem.json");
  const config = JSON.parse(fs.readFileSync(stmemFile, "utf8"));
  config.memories["tz-display-draft"] = { memoryId: "tz-display-draft", label: "草稿", status: "draft", createdAt: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");

  await withServer(async port => {
    // /api/libraries 携带服务端默认时区（前端不再退化为 UTC 字面量）
    const listPayload = JSON.parse((await request(port, "GET", "/api/libraries")).body);
    assert.equal(listPayload.defaultTimezone, DEFAULT_TIMEZONE);
    assert.equal(DEFAULT_TIMEZONE, "Asia/Shanghai", "默认时区常量与 0400 语义一致");
    const nyItem = listPayload.libraries.find(item => item.memoryId === "tz-display-ny");
    assert.equal(nyItem.timezone, "America/New_York", "列表项暴露记忆体生效时区");
    const plainItem = listPayload.libraries.find(item => item.memoryId === "tz-display-memory");
    assert.equal(plainItem.timezone, DEFAULT_TIMEZONE, "未配置记忆体的生效时区 = 默认时区");
    const draft = listPayload.libraries.find(item => item.memoryId === "tz-display-draft");
    assert.equal(draft?.timezone, null, "草稿无 memory timezone，如实为 null");
    // overview 携带生效时区（openLibrary 页面显示口径）
    const overviewNy = JSON.parse((await request(port, "GET", `/api/libraries/tz-display-ny/overview`)).body);
    assert.equal(overviewNy.timezone, "America/New_York");
    const overviewPlain = JSON.parse((await request(port, "GET", `/api/libraries/tz-display-memory/overview`)).body);
    assert.equal(overviewPlain.timezone, DEFAULT_TIMEZONE);
    void memoryFile;
  });
});

test("旧布局记忆体配置时区被明确拒绝（引导先迁移，不静默）", async () => {
  registerLegacyMemory("tz-legacy-memory");
  await withServer(async port => {
    const response = await request(port, "PATCH", `/api/libraries/tz-legacy-memory/settings`, FORM("Asia/Shanghai"));
    assert.equal(response.status, 400);
    assert.match(JSON.parse(response.body).error, /memory-layout 迁移/);
  });
});

test("前端消费面锁口：设置框/保存回显/打开记忆体均读取时区字段", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  // 设置页输入框绑定 config.timezone 并保留 datalist 建议与自由输入
  assert.match(app, /name="timezone" value="\$\{escapeHtml\(config\.timezone\|\|""\)\}"/);
  assert.match(app, /list="timezone-options"/);
  assert.match(app, /<datalist id="timezone-options">[\s\S]*?<option value="Asia\/Shanghai">/);
  // 打开记忆体与保存成功后的展示时区统一出口
  assert.match(app, /state\.displayTimezone = data\.timezone \|\| state\.defaultTimezone/);
  assert.match(app, /state\.displayTimezone = result\.config\.timezone \|\| state\.defaultTimezone/);
  assert.match(app, /function activeDisplayTimezone\(\)/);
  // 提示文案如实显示当前默认时区（不写死具体城市或偏移）
  assert.match(app, /当前默认：\$\{escapeHtml\(state\.defaultTimezone\)\}/);
  assert.doesNotMatch(app, /\+08:00/);
});
