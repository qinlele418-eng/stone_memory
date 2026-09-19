const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { PROJECT_ROOT, moduleDataDir, resolveInside } = require("../services/developer-module-contract");
const { jsonValue } = require("./provider-contract");
function createContext(manifest, { memoryId = null, signal, writable = false, logger = () => {}, projectRoot = PROJECT_ROOT, timeoutMs = 30000 } = {}) {
  const dataDir = manifest.scope === "global" || memoryId ? moduleDataDir(manifest, { threadId: memoryId }) : null;
  const context = {
    moduleId: manifest.id, memoryId, threadId: memoryId, moduleDataDir: dataDir, signal,
    logger: Object.freeze({ info: () => logger("MCP_PROVIDER_INFO"), warn: () => logger("MCP_PROVIDER_WARN"), error: () => logger("MCP_PROVIDER_ERROR") }),
    resolveDataPath(relative) { if (!dataDir) throw new Error("MCP_MEMORY_REQUIRED"); return resolveInside(dataDir, relative); },
    async runCommand(action, payload) {
      if (signal?.aborted) throw new Error("MCP_CANCELLED");
      if (!writable || !manifest.permissions.includes("mcp:write") || !Object.hasOwn(manifest.entry.commands || {}, action)) throw new Error("MCP_COMMAND_DENIED");
      jsonValue(payload);
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("MCP_BATCH_TOO_LARGE");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-mcp-"));
      fs.chmodSync(dir, 0o700);
      const batch = path.join(dir, "input.json");
      try {
        fs.writeFileSync(batch, body, { mode: 0o600, flag: "wx" });
        const args = [path.join(projectRoot, "bin/stmem"), "module", manifest.id, action, "--batch-file", batch];
        if (memoryId) args.push("--memory", memoryId);
        return await new Promise((resolve, reject) => {
          // A valid 1 MiB batch may produce a larger JSON receipt (body plus
          // metadata/escaping). Preserve the existing Notebook CLI output cap.
          execFile(process.execPath, args, { cwd: projectRoot, windowsHide: true, signal, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
            if (error) return reject(new Error("MCP_COMMAND_FAILED"));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error("MCP_COMMAND_RESULT")); }
          });
        });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
  if (manifest.permissions.includes("core:read") && memoryId) {
    // Bind every reader to the already-authorized memory; no cross-memory argument.
    context.core = require("./readers").createReaders(memoryId);
  }
  return Object.freeze(context);
}
module.exports = { createContext };
