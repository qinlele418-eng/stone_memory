const fs = require("node:fs");
const path = require("node:path");
const { MODULE_ROOT, PROJECT_ROOT, listModuleDirectories, validateManifest } = require("../services/developer-module-contract");
const { auditModule } = require("../services/developer-module-audit");
const { moduleIdsForMemory, resolveCurrentBinding } = require("../services/developer-module-mcp-config");
const { resolveProvider } = require("./provider-contract");
function loadModuleProviders(registry, { root = MODULE_ROOT, projectRoot = PROJECT_ROOT, session = resolveCurrentBinding(), memoryIds = require("../config").listMemoryIds(), logger = record => process.stderr.write(JSON.stringify(record) + "\n") } = {}) {
  const reports = [];
  const enabledModules = session ? moduleIdsForMemory(session.memoryId) : [];
  for (const moduleDir of listModuleDirectories(root)) {
    const id = path.basename(moduleDir);
    const report = { id, installed: true, enabled: enabledModules.includes(id), memoryId: session?.memoryId || null, bindingId: session?.bindingId || null, provider: "not-declared" };
    reports.push(report);
    let version = "unknown";
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, "module.json"), "utf8"));
      if (validateManifest(manifest, { directoryName: id }).length) throw new Error("MCP_MANIFEST_INVALID");
      version = String(manifest.version).slice(0, 40).replace(/[^a-zA-Z0-9.+-]/g, "_");
      report.title = manifest.title || id;
      report.summary = manifest.summary || "";
      report.scope = manifest.scope;
      report.permissions = manifest.permissions;
      report.declared = Boolean(manifest.entry.mcp);
      if (!manifest.entry.mcp) continue;
      report.provider = "disabled";
      if (!session || !enabledModules.includes(id)) continue;
      if (auditModule(moduleDir, { projectRoot }).some(item => item.severity === "error")) throw new Error("MCP_AUDIT_FAILED");
      const file = resolveProvider(moduleDir, manifest.entry.mcp);
      const log = code => logger({ moduleId: id, version, code, at: new Date().toISOString() });
      registry.registerModule(manifest, require(file), { session, memoryIds, logger: log });
      report.provider = "loaded";
    } catch {
      report.provider = "failed";
      report.errorCode = "MCP_PROVIDER_LOAD_FAILED";
      logger({ moduleId: /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : "invalid", version, code: report.errorCode, at: new Date().toISOString() });
    }
  }
  for (const id of enabledModules) {
    if (!reports.some(report => report.id === id)) reports.push({ id, installed: false, enabled: true, memoryId: session?.memoryId || null, bindingId: session?.bindingId || null, provider: "missing" });
  }
  return reports;
}
module.exports = { loadModuleProviders };
