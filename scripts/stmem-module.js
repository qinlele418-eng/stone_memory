const path = require("path");
const { loadModules, findModule, moduleDataDir } = require("../src/services/developer-module-contract");
const { auditDeveloperModules } = require("../src/services/developer-module-audit");
const { runModuleAction } = require("../src/services/developer-module-runtime");
const fs = require("node:fs");

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function printAudit(report, json) {
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(`开发者模块审计：${report.modules} 个模块，${report.errors} 个错误，${report.warnings} 个迁移提醒`);
  for (const item of report.findings) {
    const location = item.file ? ` · ${path.relative(process.cwd(), item.file)}` : "";
    console.log(`${item.severity === "error" ? "错误" : "提醒"} [${item.moduleId}/${item.code}] ${item.message}${location}`);
  }
}

function runModuleCommand(args = process.argv.slice(3)) {
  const action = args[0] || "list";
  const json = args.includes("--json");
  if (action === "list") {
    const modules = loadModules().map(item => ({ id: item.id, title: item.manifest.title, scope: item.manifest.scope, version: item.manifest.version, valid: !item.errors.length }));
    return console.log(json ? JSON.stringify(modules, null, 2) : modules.map(item => `${item.id}\t${item.scope}\tv${item.version}\t${item.title || ""}`).join("\n"));
  }
  if (action === "inspect" || action === "paths") {
    const id = valueAfter(args, "--id") || args[1];
    const loaded = findModule(id);
    const threadId = valueAfter(args, "--thread");
    const output = {
      id: loaded.id,
      codeDir: loaded.moduleDir,
      dataDir: loaded.manifest.scope === "global" || threadId ? moduleDataDir(loaded.manifest, { threadId }) : null,
      manifest: loaded.manifest,
    };
    return console.log(JSON.stringify(output, null, 2));
  }
  if (action === "audit") {
    const report = auditDeveloperModules();
    printAudit(report, json);
    if (args.includes("--strict") && !report.ok) process.exitCode = 1;
    return;
  }
  const moduleId = action;
  const command = args[1];
  const threadId = valueAfter(args, "--thread");
  if (!command) throw new Error("module command requires: stmem module <module-id> <action>");
  if (!threadId && findModule(moduleId).manifest.scope === "memory") throw new Error("module command requires --thread <id>");
  const batchFile = valueAfter(args, "--batch-file");
  const input = batchFile ? JSON.parse(fs.readFileSync(batchFile, "utf8")) : {};
  if (args.includes("--apply")) input.apply = true;
  if (args.includes("--dry-run")) input.apply = false;
  return Promise.resolve(runModuleAction({ moduleId, action: command, threadId, input }))
    .then(result => console.log(JSON.stringify(result, null, 2)));
}

if (require.main === module) {
  try { runModuleCommand(); }
  catch (error) { console.error(`[module] error: ${error.message}`); process.exitCode = 1; }
}

module.exports = { runModuleCommand };
