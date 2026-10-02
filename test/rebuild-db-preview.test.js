"use strict";

// R2：provider=pando 无 sessionDir 时，rebuild_preview 返回明示口径的 DB 降级预览（不抛错）；
// rebuild --apply 对 pando 的拒绝语义不放松；claude 无 sessionDir 维持原样报错。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

// src/config.js 在 require 时固化 CONFIG_PATH —— 必须先重定向 HOME 再加载源码。
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-db-preview-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { childEnvWithHome } = require("../test-support/child-env");
const { MemoryStore } = require("../src/storage/memory-store");
const { getThreadDir } = require("../src/config");

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeThreadConfig(threadId, runtime) {
  const stmemFile = path.join(home, ".stone_memory", "stmem.json");
  fs.mkdirSync(path.dirname(stmemFile), { recursive: true });
  const config = fs.existsSync(stmemFile) ? JSON.parse(fs.readFileSync(stmemFile, "utf8")) : {};
  config[threadId] = { ai: "小鱼", user: "旭乐", runtime, purpose: "accompany", windowDays: 2 };
  fs.writeFileSync(stmemFile, JSON.stringify(config), "utf8");
}

function seedMessages(threadId) {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const store = new MemoryStore({ memoryDir, threadId });
  store.insertMessages([
    { timestamp: "2026-06-17T11:58:00.000Z", sourceDate: "2026-06-17", role: "user", text: "归栖部署" },
    { timestamp: "2026-06-18T09:00:00.000Z", sourceDate: "2026-06-18", role: "assistant", text: "第二条" },
  ]);
  store.close();
}

function runRebuildCli(threadId, args = []) {
  const env = childEnvWithHome(home, { STMEM_SKIP_PENDING_REBUILDS: "1" });
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", "rebuild-thread.js"), "--thread", threadId, ...args], {
    cwd: PROJECT_ROOT, env, encoding: "utf8",
  });
}

function callMcpServer(name, args) {
  const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stmem-db-preview-test", version: "1" } } });
  const callMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const env = childEnvWithHome(home, { STMEM_SKIP_PENDING_REBUILDS: "1" });
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "mcp-server.js")], {
    cwd: PROJECT_ROOT, env, input: `${initMsg}\n${callMsg}\n`, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const toolResponse = responses.find(message => message.id === 2);
  assert.ok(toolResponse, "missing tools/call response");
  return {
    isError: toolResponse.result?.isError === true,
    text: (toolResponse.result?.content || []).map(part => part.text || "").join("\n"),
  };
}

test("renderDbRebuildPreview reports DB counts, watermark, and the caliber statement deterministically", () => {
  writeThreadConfig("t-preview-pando", "pando");
  seedMessages("t-preview-pando");

  const { renderDbRebuildPreview, DB_PREVIEW_MARKER } = require("../src/services/rebuild-db-preview");
  const first = renderDbRebuildPreview("t-preview-pando", { windowDays: 3 });
  const second = renderDbRebuildPreview("t-preview-pando", { windowDays: 3 });

  assert.equal(first, second, "同输入同输出");
  assert.match(first, /DB 口径降级预览（dry-run，未写入任何文件）/);
  assert.match(first, new RegExp(DB_PREVIEW_MARKER));
  assert.match(first, /Messages \(DB\):\s+2 条 \/ 2 天/);
  assert.match(first, /Date range:\s+2026-06-17 → 2026-06-18/);
  assert.match(first, /Feelings \(DB\):\s+0 条可注入/);
  assert.match(first, /Retain watermark:\s+无（feelings 为空）/);
  assert.match(first, /Window:\s+3 天/);
  assert.match(first, /rebuild --apply 对 pando 仍被拒绝/);
});

test("pando dry-run exits 0 with the DB preview; apply is still refused; claude dry-run unchanged error", () => {
  writeThreadConfig("t-cli-pando", "pando");
  writeThreadConfig("t-cli-claude", "claude");
  seedMessages("t-cli-pando");
  seedMessages("t-cli-claude");

  const preview = runRebuildCli("t-cli-pando", ["--window", "2"]);
  assert.equal(preview.status, 0, `pando dry-run 应退出 0：${preview.stderr}`);
  assert.match(preview.stdout, /DB 口径降级预览/);
  assert.match(preview.stdout, /仍被拒绝/);
  assert.match(preview.stdout, /未写入任何文件/);

  const apply = runRebuildCli("t-cli-pando", ["--apply"]);
  assert.equal(apply.status, 1, "pando --apply 必须仍被拒绝");
  assert.match(apply.stderr, /请在 stmem\.json 中配置 sessionDir/);

  const claudeDry = runRebuildCli("t-cli-claude");
  assert.equal(claudeDry.status, 1, "claude 无 sessionDir 的 dry-run 维持原样报错");
  assert.match(claudeDry.stderr, /请在 stmem\.json 中配置 sessionDir/);
});

test("MCP rebuild preview entry returns the DB preview for pando instead of an error", () => {
  writeThreadConfig("t-mcp-pando", "pando");
  seedMessages("t-mcp-pando");

  const outcome = callMcpServer("stmem_memory_rebuild_preview", {
    memoryId: "t-mcp-pando",
    context: { mode: "active_days", windowDays: 2, toolPairs: 15 },
  });
  assert.equal(outcome.isError, false, `MCP 入口不得报错：${outcome.text}`);
  assert.match(outcome.text, /DB 口径降级预览/);
  assert.match(outcome.text, /仍被拒绝/);
});
