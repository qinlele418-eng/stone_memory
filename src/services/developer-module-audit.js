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

function escapedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function declaredCoreExtensions(manifest, moduleDir, findings, projectRoot) {
  const declared = new Set();
  const extensions = Array.isArray(manifest.coreExtensions) ? manifest.coreExtensions : [];
  for (const extension of extensions) {
    if (!extension || typeof extension !== "object" || !String(extension.path || "").trim() || !String(extension.reason || "").trim()) {
      findings.push(finding("error", "core-extension-contract", manifest.id, "coreExtensions 每项必须声明 path 与 reason", path.join(moduleDir, "module.json")));
      continue;
    }
    const target = path.resolve(projectRoot, extension.path);
    const relative = path.relative(projectRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || target.startsWith(`${moduleDir}${path.sep}`)) {
      findings.push(finding("error", "core-extension-unsafe", manifest.id, `非法 Core 扩展路径：${extension.path}`, path.join(moduleDir, "module.json")));
      continue;
    }
    declared.add(target);
  }
  return declared;
}

function auditCoreOwnership(moduleDir, manifest, findings, projectRoot) {
  if (manifest.legacy) return;
  const declared = declaredCoreExtensions(manifest, moduleDir, findings, projectRoot);
  const roots = [path.join(projectRoot, "bin"), path.join(projectRoot, "scripts"), path.join(projectRoot, "src")];
  const pattern = new RegExp(`(?:^|[^a-z0-9-])${escapedPattern(manifest.id)}(?:$|[^a-z0-9-])`, "iu");
  for (const file of roots.flatMap(walk).filter(item => /\.(?:js|mjs|cjs|ts)$/u.test(item) || path.basename(item) === "stmem")) {
    if (!pattern.test(fs.readFileSync(file, "utf8"))) continue;
    if (!declared.has(file)) {
      findings.push(finding("error", "core-extension-undeclared", manifest.id,
        `Core 文件引用了模块 ID，但 manifest 未声明 coreExtensions：${path.relative(projectRoot, file)}`, file));
    }
  }
  for (const file of declared) {
    if (!fs.existsSync(file)) findings.push(finding("error", "core-extension-missing", manifest.id,
      `声明的 Core 扩展文件不存在：${path.relative(projectRoot, file)}`, path.join(moduleDir, "module.json")));
  }
}

function auditModule(moduleDir, { projectRoot = PROJECT_ROOT } = {}) {
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
  if (manifest.entry?.mcp !== undefined) {
    try {
      const file = require("../mcp/provider-contract").resolveProvider(moduleDir, manifest.entry.mcp);
      const source = fs.readFileSync(file, "utf8");
      if (/console\.(?:log|info|debug)\s*\(|process\.stdout\s*\./u.test(source)) findings.push(finding("error", "mcp-stdout", id, "Provider 必须使用 context.logger", manifestFile));
      if (/(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|mkdir(?:Sync)?|rm(?:Sync)?)\s*\(|require\(["'](?:node:)?child_process["']\)/u.test(source)) findings.push(finding("error", "mcp-write-boundary", id, "Provider 写操作必须经过 context.runCommand 与正式模块 CLI", manifestFile));
    }
    catch { findings.push(finding("error", "mcp-entry", id, "MCP Provider 入口不存在或越界", manifestFile)); }
    // Never require a disabled provider during static audit. Export/schema checks
    // run only after explicit activation, inside the loader.
  }
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
        ? path.resolve(projectRoot, legacy.frontend)
        : resolveInside(moduleDir, frontend, "frontend entry");
      if (!fs.existsSync(target)) findings.push(finding("error", "entry-missing", id, `前端入口不存在：${path.relative(projectRoot, target)}`, manifestFile));
      if (legacy.frontend) findings.push(finding("warning", "legacy-frontend", id, "前端仍位于历史目录，后续应迁入模块代码根目录", target));
    } catch (error) { findings.push(finding("error", "entry-unsafe", id, error.message, manifestFile)); }
  }
  const commands = manifest.entry?.commands || {};
  for (const [action, relative] of Object.entries(commands)) {
    try {
      const target = legacy.commands?.[action]
        ? path.resolve(projectRoot, legacy.commands[action])
        : resolveInside(moduleDir, relative, `command ${action}`);
      if (!legacy.commands?.[action]) {
        const commandRelative = path.relative(path.join(moduleDir, "backend", "commands"), target);
        if (commandRelative.startsWith("..") || path.isAbsolute(commandRelative)) {
          findings.push(finding("error", "command-location", id, `命令 ${action} 必须位于 backend/commands/`, target));
        }
      }
      if (!fs.existsSync(target)) findings.push(finding("error", "command-missing", id, `命令 ${action} 不存在`, target));
      if (legacy.commands?.[action]) findings.push(finding("warning", "legacy-command", id, `命令 ${action} 仍借用 Core scripts/src，后续应迁入模块目录`, target));
    } catch (error) { findings.push(finding("error", "command-unsafe", id, error.message, manifestFile)); }
  }
  const sourceRoots = [moduleDir, ...Object.values(legacy).filter(value => typeof value === "string").map(value => path.resolve(projectRoot, value))];
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
  auditCoreOwnership(moduleDir, manifest, findings, projectRoot);
  return findings;
}

function auditDeveloperModules({ root = MODULE_ROOT, projectRoot = PROJECT_ROOT } = {}) {
  const findings = listModuleDirectories(root).flatMap(moduleDir => auditModule(moduleDir, { projectRoot }));
  const errors = findings.filter(item => item.severity === "error").length;
  const warnings = findings.filter(item => item.severity === "warning").length;
  return { ok: errors === 0, root, modules: listModuleDirectories(root).length, errors, warnings, findings };
}

module.exports = { auditDeveloperModules, auditModule };
