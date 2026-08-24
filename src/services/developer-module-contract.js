const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_ROOT = path.join(PROJECT_ROOT, "developer-modules");
const MODULE_DATA_ROOT = path.join(os.homedir(), ".stone_memory", "developer-module-data");
const MODULE_ID = /^[a-z0-9][a-z0-9-]*$/u;
const SCOPES = new Set(["memory", "global"]);

function assertModuleId(value) {
  const id = String(value || "").trim();
  if (!MODULE_ID.test(id)) throw new Error(`invalid developer module id: ${value}`);
  return id;
}

function safeSegment(value, label) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === ".." || /[\\/\0]/u.test(segment)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return segment;
}

function resolveInside(root, relativePath, label = "path") {
  const resolved = path.resolve(root, String(relativePath || "."));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes its module root`);
  return resolved;
}

function readManifest(moduleDir) {
  const file = path.join(moduleDir, "module.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, manifest };
}

function listModuleDirectories(root = MODULE_ROOT) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name))
    .sort();
}

function validateManifest(manifest, { directoryName } = {}) {
  const errors = [];
  const id = String(manifest?.id || "").trim();
  if (!MODULE_ID.test(id)) errors.push("id must use lowercase letters, numbers and hyphens");
  if (directoryName && id !== directoryName) errors.push(`id must match directory name ${directoryName}`);
  if (!String(manifest?.version || "").trim()) errors.push("version is required");
  if (!Number.isInteger(Number(manifest?.sdkVersion))) errors.push("sdkVersion must be an integer");
  if (!SCOPES.has(manifest?.scope)) errors.push("scope must be memory or global");
  if (!Array.isArray(manifest?.permissions)) errors.push("permissions must be an array");
  if (!manifest?.entry || typeof manifest.entry !== "object") errors.push("entry must describe frontend and/or commands");
  return errors;
}

function loadModules(root = MODULE_ROOT) {
  return listModuleDirectories(root).map(moduleDir => {
    const { file, manifest } = readManifest(moduleDir);
    const errors = validateManifest(manifest, { directoryName: path.basename(moduleDir) });
    return { id: manifest.id, moduleDir, file, manifest, errors };
  });
}

function findModule(id, root = MODULE_ROOT) {
  const moduleId = assertModuleId(id);
  const moduleDir = path.join(root, moduleId);
  if (!fs.existsSync(moduleDir)) throw new Error(`developer module not found: ${moduleId}`);
  const loaded = readManifest(moduleDir);
  const errors = validateManifest(loaded.manifest, { directoryName: moduleId });
  if (errors.length) throw new Error(`invalid developer module ${moduleId}: ${errors.join("; ")}`);
  return { id: moduleId, moduleDir, file: loaded.file, manifest: loaded.manifest };
}

function moduleDataDir(manifest, { threadId, dataRoot = MODULE_DATA_ROOT } = {}) {
  const id = assertModuleId(manifest.id);
  if (manifest.scope === "global") return path.join(dataRoot, "_global", id);
  return path.join(dataRoot, safeSegment(threadId, "thread id"), id);
}

module.exports = {
  PROJECT_ROOT,
  MODULE_ROOT,
  MODULE_DATA_ROOT,
  assertModuleId,
  resolveInside,
  listModuleDirectories,
  validateManifest,
  loadModules,
  findModule,
  moduleDataDir,
};
