const fs = require("fs");
const path = require("path");
const os = require("os");
const { json, readJson, error } = require("../http-io");
const { listLibraries, overview, publicThreadSettings } = require("../library-queries");
const { listScenarios } = require("../../services/scenario-registry");
const { findThreadSessionFile } = require("../../lib/thread-session-file");
const { runStmem } = require("../cli-client");
const { NOT_HANDLED } = require("../route-result");

async function handleLibraries(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/libraries") return json(res, 200, { libraries: listLibraries(), scenarios: listScenarios().map(({ directory, ...row }) => row) });

  if (req.method === "POST" && url.pathname === "/api/session-file/check") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "").trim(), sessionDir = String(body.sessionDir || "").trim();
    if (!threadId || !sessionDir) throw new Error("请先填写真实 Claude/Codex 线程 ID 和线程文件搜索目录");
    const file = findThreadSessionFile(sessionDir, threadId);
    if (!file) throw new Error(`在这个目录中没有找到线程 ${threadId} 的 JSONL 文件，请重新填写路径或检查文件是否存在`);
    return json(res, 200, { found: true, file });
  }

  const overviewMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/overview$/);
  if (req.method === "GET" && overviewMatch) {
    const data = overview(decodeURIComponent(overviewMatch[1]));
    return data ? json(res, 200, data) : error(res, 404, "记忆体不存在");
  }

  const settingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/settings$/);
  if (settingsMatch) {
    const threadId = decodeURIComponent(settingsMatch[1]);
    if (req.method === "GET") return json(res, 200, publicThreadSettings(threadId));
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const current = publicThreadSettings(threadId);
      const automationKeys = ["automaticFullMining", "automaticMemoryMaintenance", "automaticCompression", "automaticDream", "watcherEnabled"];
      const regularBody = Object.fromEntries(Object.entries(body).filter(([key]) => !automationKeys.includes(key)));
      const input = { ...current, ...regularBody, threadId, runtime: current.runtime, purpose: current.purpose };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-web-config-"));
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
      try {
        runStmem(["init", "--thread", threadId, "--batch-file", file]);
        const moduleArgs = ["watcher", "set", "--thread", threadId];
        const moduleMap = {
          automaticFullMining: "--archive",
          automaticMemoryMaintenance: "--miner",
          automaticCompression: "--compression",
          automaticDream: "--dream",
        };
        for (const [key, flag] of Object.entries(moduleMap)) {
          if (Object.hasOwn(body, key)) moduleArgs.push(flag, body[key] === true ? "on" : "off");
        }
        if (moduleArgs.length > 4) runStmem(moduleArgs);
        if (Object.hasOwn(body, "watcherEnabled")) {
          runStmem(["watcher", body.watcherEnabled === true ? "on" : "off", "--thread", threadId]);
        } else if (moduleArgs.length > 4) {
          const resulting = publicThreadSettings(threadId);
          const anyModule = resulting.automaticFullMining || resulting.automaticMemoryMaintenance
            || resulting.automaticCompression || resulting.automaticDream;
          runStmem(["watcher", anyModule ? "on" : "off", "--thread", threadId]);
        }
        return json(res, 200, { success: true, config: publicThreadSettings(threadId) });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  return NOT_HANDLED;
}

async function handleLibraryDelete(req, res, url) {
  const libraryMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)$/);
  if (req.method === "DELETE" && libraryMatch) {
    const threadId = decodeURIComponent(libraryMatch[1]);
    runStmem(["delete", "--thread", threadId]);
    return json(res, 200, { success: true, threadId });
  }
  return NOT_HANDLED;
}

module.exports = { handleLibraries, handleLibraryDelete };
