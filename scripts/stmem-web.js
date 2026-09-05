#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("node:child_process");
const { startWebServer } = require("../src/web/server");
const { loadConfig } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");
const { readManagedPid, startManagedProcess, stopManagedProcess } = require("../src/services/managed-local-process");

const STONE = path.join(os.homedir(), ".stone_memory");
const PID_FILE = path.join(STONE, "web.pid");
const LOG_FILE = path.join(STONE, "web.log");
const WATCH_SCRIPT = path.join(__dirname, "stmem-web-watch.js");
const MARKER = ["stmem-web-watch.js", "stmem-web.js", "stmem web"];
const invokedThroughCli = path.basename(process.argv[1] || "") === "stmem";
const args = process.argv.slice(invokedThroughCli ? 3 : 2);
const actions = new Set(["start", "stop", "restart", "status", "config", "dev", "serve"]);
const action = actions.has(args[0]) ? args.shift() : "serve";
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function webConfig({ persistFlags = false } = {}) {
  const config = loadConfig();
  const current = config.web || {};
  const rawPort = value("--port");
  const port = rawPort == null ? Number(current.port) || 4173 : Number(rawPort);
  const host = value("--host") || current.host || "127.0.0.1";
  const publicUrl = value("--url") || current.publicUrl || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Web 端口必须是 1～65535 的整数");
  if (!String(host).trim()) throw new Error("Web 监听地址不能为空");
  if (publicUrl) {
    const parsed = new URL(publicUrl);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("前端访问地址必须使用 http 或 https");
  }
  const next = { host: String(host).trim(), port, publicUrl: String(publicUrl).trim() };
  if (persistFlags && (value("--host") != null || rawPort != null || value("--url") != null)) {
    config.web = next;
    saveConfig(config);
  }
  return next;
}

function startBackground() {
  const config = webConfig({ persistFlags: true });
  return startManagedProcess({
    script: WATCH_SCRIPT,
    pidFile: PID_FILE,
    marker: MARKER,
    args: ["--host", config.host, "--port", String(config.port)],
    logFile: LOG_FILE,
  });
}

async function serve() {
  const config = webConfig();
  const watchChild = args.includes("--watch-child");
  if (!watchChild) {
    const existing = readManagedPid(PID_FILE, MARKER);
    if (existing && existing !== process.pid) throw new Error(`Stone Memory 前端已运行 (pid ${existing})`);
    fs.mkdirSync(STONE, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    const cleanup = () => {
      try {
        if (Number(fs.readFileSync(PID_FILE, "utf8")) === process.pid) fs.rmSync(PID_FILE, { force: true });
      } catch {}
    };
    process.once("exit", cleanup);
  }
  const server = await startWebServer({ host: config.host, port: config.port });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const address = server.address();
  console.log(`Stone Memory 前端已启动：http://${address.address}:${address.port}`);
  if (config.publicUrl) console.log(`前端访问地址：${config.publicUrl}`);
  console.log("按 Ctrl+C 停止。");
}

function startDevelopmentServer() {
  const config = webConfig({ persistFlags: true });
  const existing = readManagedPid(PID_FILE, MARKER);
  if (existing) throw new Error(`后台 Web 正在运行 (pid ${existing})；请先执行 stmem web stop，再启动 dev`);
  console.log(`Stone Memory dev：http://${config.host}:${config.port}`);
  console.log("后端 JS 变化会自动重启；HTML/CSS/前端 JS 无需重启，刷新浏览器即可读取最新文件。");
  const child = spawn(process.execPath, [WATCH_SCRIPT, "--foreground", "--host", config.host, "--port", String(config.port)], {
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    let stopping = false;
    const forward = signal => {
      stopping = true;
      if (!child.killed) child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (code && !stopping) reject(new Error(`Stone Memory dev 退出（${signal || `code ${code}`}）`));
      else resolve();
    });
  });
}

async function main() {
  if (action === "serve") return serve();
  if (action === "dev") return startDevelopmentServer();
  if (action === "config") {
    const config = webConfig({ persistFlags: true });
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (action === "status") {
    const pid = readManagedPid(PID_FILE, MARKER);
    const config = webConfig();
    console.log(`Stone Memory 前端：${pid ? `运行中 (pid ${pid})` : "未运行"}`);
    console.log(`监听 ${config.host}:${config.port}${config.publicUrl ? ` · 访问 ${config.publicUrl}` : ""}`);
    return;
  }
  if (action === "stop" || action === "restart") {
    const result = stopManagedProcess({ pidFile: PID_FILE, marker: MARKER });
    console.log(result.stopped ? `Stone Memory 前端已停止 (pid ${result.pid})` : "Stone Memory 前端原本未运行");
  }
  if (action === "start" || action === "restart") {
    const result = startBackground();
    console.log(result.started ? `Stone Memory 前端已启动 (pid ${result.pid})` : `Stone Memory 前端已在运行 (pid ${result.pid})`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
