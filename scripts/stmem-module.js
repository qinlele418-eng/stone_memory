const path = require("path");
const { loadModules, findModule, moduleDataDir, resolveInside } = require("../src/services/developer-module-contract");
const { createModuleContext } = require("../src/services/developer-module-runtime");
const { auditDeveloperModules } = require("../src/services/developer-module-audit");

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

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      try { resolve(text.trim() ? JSON.parse(text) : {}); }
      catch (error) { reject(error); }
    });
    process.stdin.on("error", reject);
  });
}

function commandInput(args, action) {
  return {
    action,
    threadId: valueAfter(args, "--thread"),
    bindingId: valueAfter(args, "--binding") || valueAfter(args, "--id"),
    summaryLimit: valueAfter(args, "--summary-limit"),
    minImportance: valueAfter(args, "--min-importance"),
    maxChars: valueAfter(args, "--max-chars"),
  };
}

async function runModuleCommand(args = process.argv.slice(3)) {
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
  const loaded = findModule(action);
  const moduleAction = args[1];
  if (!moduleAction) throw new Error(`缺少模块命令：stmem module ${loaded.id} <action>`);
  const relative = loaded.manifest.entry?.commands?.[moduleAction];
  if (!relative) throw new Error(`模块 ${loaded.id} 未登记命令：${moduleAction}`);
  const commandFile = resolveInside(loaded.moduleDir, relative, `module command ${moduleAction}`);
  const implementation = require(commandFile);
  if (typeof implementation.run !== "function") throw new Error(`模块命令 ${moduleAction} 未导出 run(context,input)`);
  const input = commandInput(args.slice(1), moduleAction);
  if (moduleAction === "hook") {
    try { input.stdin = await readStdin(); }
    catch { return console.log("{}"); }
  }
  const context = createModuleContext(loaded.manifest, { threadId: input.threadId });
  const output = await implementation.run(context, input);
  console.log(JSON.stringify(output ?? {}, null, moduleAction === "hook" ? 0 : 2));
  return output;
}

if (require.main === module) {
  runModuleCommand().catch(error => { console.error(`[module] error: ${error.message}`); process.exitCode = 1; });
}

module.exports = { runModuleCommand };
