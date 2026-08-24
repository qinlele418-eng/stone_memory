const fs = require("fs");
const path = require("path");
const {
  PROJECT_ROOT,
  MODULE_ROOT,
  listModuleDirectories,
  resolveInside,
  validateManifest,
} = require("./developer-module-contract");

function finding(severity, code, moduleId, message, file = null) {
  return { severity, code, moduleId, message, file };
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else result.push(file);
  }
  return result;
}

function auditModule(moduleDir) {
  const directoryName = path.basename(moduleDir);
  const manifestFile = path.join(moduleDir, "module.json");
  if (!fs.existsSync(manifestFile)) return [finding("error", "manifest-missing", directoryName, "缺少 module.json", manifestFile)];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); }
  catch (error) { return [finding("error", "manifest-json", directoryName, `module.json 无法解析：${error.message}`, manifestFile)]; }
  const id = manifest.id || directoryName;
  const findings = validateManifest(manifest, { directoryName })
    .map(message => finding("error", "manifest-contract", id, message, manifestFile));
  const legacy = manifest.legacy || {};
  for (const storage of legacy.storage || []) {
    findings.push(finding(
      "warning",
      "legacy-storage",
      id,
      `运行数据仍写入历史位置：${storage.path}${storage.mode ? `（${storage.mode}）` : ""}`,
      manifestFile,
    ));
  }
  const frontend = manifest.entry?.frontend;
  if (frontend) {
    try {
      const target = legacy.frontend
        ? path.resolve(PROJECT_ROOT, legacy.frontend)
        : resolveInside(moduleDir, frontend, "frontend entry");
      if (!fs.existsSync(target)) findings.push(finding("error", "entry-missing", id, `前端入口不存在：${path.relative(PROJECT_ROOT, target)}`, manifestFile));
      if (legacy.frontend) findings.push(finding("warning", "legacy-frontend", id, "前端仍位于历史目录，后续应迁入模块代码根目录", target));
    } catch (error) { findings.push(finding("error", "entry-unsafe", id, error.message, manifestFile)); }
  }
  const commands = manifest.entry?.commands || {};
  for (const [action, relative] of Object.entries(commands)) {
    try {
      const target = legacy.commands?.[action]
        ? path.resolve(PROJECT_ROOT, legacy.commands[action])
        : resolveInside(moduleDir, relative, `command ${action}`);
      if (!fs.existsSync(target)) findings.push(finding("error", "command-missing", id, `命令 ${action} 不存在`, target));
      if (legacy.commands?.[action]) findings.push(finding("warning", "legacy-command", id, `命令 ${action} 仍借用 Core scripts/src，后续应迁入模块目录`, target));
    } catch (error) { findings.push(finding("error", "command-unsafe", id, error.message, manifestFile)); }
  }
  const sourceRoots = [moduleDir, ...Object.values(legacy).filter(value => typeof value === "string").map(value => path.resolve(PROJECT_ROOT, value))];
  const source = [...new Set(sourceRoots.flatMap(root => fs.existsSync(root) && fs.statSync(root).isDirectory() ? walk(root) : [root]))]
    .filter(file => /\.(?:js|mjs|cjs|ts)$/u.test(file) && fs.existsSync(file))
    .map(file => fs.readFileSync(file, "utf8")).join("\n");
  const canonicalSource = walk(moduleDir)
    .filter(file => /\.(?:js|mjs|cjs|ts)$/u.test(file))
    .map(file => fs.readFileSync(file, "utf8")).join("\n");
  if (/getThreadDir\s*\(|\.stone_memory|openDatabase\s*\([^)]*(?:memoryDir|getThreadDir)/u.test(canonicalSource)) {
    findings.push(finding("error", "storage-core-path", id, "模块代码直接定位 Core/线程数据目录；应使用 SDK 提供的 moduleDataDir", manifestFile));
  }
  if (/localStorage\.(?:getItem|setItem|removeItem)\s*\(/u.test(canonicalSource) && !manifest.storage?.browser) {
    findings.push(finding("error", "storage-browser-undeclared", id, "模块使用浏览器持久化但未声明 storage.browser", manifestFile));
  }
  if (/CREATE\s+TABLE|better-sqlite3|\.sqlite\b/iu.test(source) && !manifest.storage?.database) {
    findings.push(finding("warning", "storage-database-undeclared", id, "检测到数据库逻辑，但 manifest 未声明 storage.database", manifestFile));
  }
  if (/(?:fs\.)?(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync)\s*\(/u.test(source) && !manifest.storage?.documents && !manifest.storage?.files) {
    findings.push(finding("warning", "storage-files-undeclared", id, "检测到文件落盘逻辑，但 manifest 未声明 storage.files/documents", manifestFile));
  }
  if (/(?:spawn|execFile|fork)\s*\(|require\(["'](?:node:)?child_process["']\)/u.test(source) && !manifest.permissions?.includes("process:spawn") && !manifest.watcher) {
    findings.push(finding("warning", "process-undeclared", id, "检测到子进程或 watcher 逻辑，但未声明权限/插件", manifestFile));
  }
  return findings;
}

function auditDeveloperModules({ root = MODULE_ROOT } = {}) {
  const findings = listModuleDirectories(root).flatMap(auditModule);
  const errors = findings.filter(item => item.severity === "error").length;
  const warnings = findings.filter(item => item.severity === "warning").length;
  return { ok: errors === 0, root, modules: listModuleDirectories(root).length, errors, warnings, findings };
}

module.exports = { auditDeveloperModules };
