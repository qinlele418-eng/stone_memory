const fs = require("node:fs");
const path = require("node:path");
const { MODULE_ROOT, PROJECT_ROOT, listModuleDirectories, validateManifest } = require("../services/developer-module-contract");
const { auditModule } = require("../services/developer-module-audit");
const { readConfig } = require("../services/developer-module-mcp-config");
const { resolveProvider } = require("./provider-contract");
function loadModuleProviders(registry, { root = MODULE_ROOT, projectRoot = PROJECT_ROOT, config, memoryIds = require("../config").listThreadIds(), logger = record => process.stderr.write(JSON.stringify(record) + "\n") } = {}) {
  const reports = [];
  let configError = false;
  if (!config) {
    try { config = readConfig(); }
    catch { config = { modules: {} }; configError = true; }
  }
  for (const moduleDir of listModuleDirectories(root)) {
    const id = path.basename(moduleDir);
    const report = { id, installed: true, globalEnabled: false, memories: {}, provider: "not-declared" };
    reports.push(report);
    let version = "unknown";
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(moduleDir, "module.json"), "utf8"));
      if (validateManifest(manifest, { directoryName: id }).length) throw new Error("MCP_MANIFEST_INVALID");
      version = String(manifest.version).slice(0, 40).replace(/[^a-zA-Z0-9.+-]/g, "_");
      report.scope = manifest.scope;
      report.permissions = manifest.permissions;
      report.declared = Boolean(manifest.entry.mcp);
      if (!manifest.entry.mcp) continue;
      const state = Object.hasOwn(config.modules, id) ? config.modules[id] : { globalEnabled: false, memories: {} };
      report.globalEnabled = state.globalEnabled;
      report.memories = state.memories;
      report.provider = configError ? "config-error" : "disabled";
      if (!state.globalEnabled || (manifest.scope === "memory" && !memoryIds.some(memoryId => state.memories[memoryId] === true))) continue;
      if (auditModule(moduleDir, { projectRoot }).some(item => item.severity === "error")) throw new Error("MCP_AUDIT_FAILED");
      const file = resolveProvider(moduleDir, manifest.entry.mcp);
      const log = code => logger({ moduleId: id, version, code, at: new Date().toISOString() });
      registry.registerModule(manifest, require(file), { state, memoryIds, logger: log });
      report.provider = "loaded";
    } catch {
      report.provider = "failed";
      report.errorCode = "MCP_PROVIDER_LOAD_FAILED";
      logger({ moduleId: /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : "invalid", version, code: report.errorCode, at: new Date().toISOString() });
    }
  }
  for (const [id, state] of Object.entries(config.modules)) {
    if (!reports.some(report => report.id === id)) reports.push({ id, installed: false, ...state, provider: "missing" });
  }
  return reports;
}
module.exports = { loadModuleProviders };
