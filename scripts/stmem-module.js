const fs = require("fs");
const path = require("path");
const { loadModules, findModule, moduleDataDir, resolveInside } = require("../src/services/developer-module-contract");
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

function readBatchFile(args) {
  const file = valueAfter(args, "--batch-file");
  if (!file) return {};
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("模块 batch-file 必须是普通文件");
  if (stat.size > 1024 * 1024) throw new Error("模块 batch-file 不能超过 1MB");
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("模块 batch-file 顶层必须是 JSON 对象");
  }
  return payload;
}

function commandInput(args, action) {
  const memoryId = valueAfter(args, "--memory");
  const legacyThreadId = valueAfter(args, "--thread");
  if (memoryId && legacyThreadId && memoryId !== legacyThreadId) throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
  return {
    action,
    memoryId: memoryId || legacyThreadId,
    threadId: memoryId || legacyThreadId,
    bindingId: valueAfter(args, "--binding") || valueAfter(args, "--id"),
    summaryLimit: valueAfter(args, "--summary-limit"),
    minImportance: valueAfter(args, "--min-importance"),
    maxChars: valueAfter(args, "--max-chars"),
    payload: readBatchFile(args),
  };
}

async function runModuleCommand(args = process.argv.slice(3)) {
  const action = args[0] || "list";
  const json = args.includes("--json");
  if (action === "mcp") {
    const operation = args[1] || "status";
    const memoryId = valueAfter(args, "--memory") || valueAfter(args, "--thread");
    if (!memoryId) throw new Error("MCP 设置必须指定 --memory");
    const { planChange, applyChange, reconnect } = require("../src/services/developer-module-mcp-config");
    if (operation === "status") {
      const { Registry } = require("../src/mcp/registry");
      const registry = new Registry();
      registry.registerCore({ tools: require("../src/mcp/core/definitions").TOOLS, call() {} });
      const modules = require("../src/mcp/module-provider-loader").loadModuleProviders(registry, { session: { memoryId } });
      const result = { memoryId, revision: require("../src/services/developer-module-mcp-config").readConfig({ memoryId }).revision, modules, reconnect };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (!["enable", "disable"].includes(operation)) throw new Error("MCP_OPERATION_INVALID");
    const plan = planChange({ moduleId: valueAfter(args, "--module"), memoryId, enabled: operation === "enable" });
    const apply = args.includes("--apply");
    const applied = apply ? applyChange(plan) : null;
    const result = { applied: apply, dryRun: !apply, moduleId: plan.moduleId, memoryId, enabled: plan.enabled, revision: applied?.config?.updatedAt ?? plan.revision, reconnect };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (action === "list") {
    const modules = loadModules().map(item => ({ id: item.id, title: item.manifest.title, scope: item.manifest.scope, version: item.manifest.version, valid: !item.errors.length }));
    return console.log(json ? JSON.stringify(modules, null, 2) : modules.map(item => `${item.id}\t${item.scope}\tv${item.version}\t${item.title || ""}`).join("\n"));
  }
  if (action === "inspect" || action === "paths") {
    const id = valueAfter(args, "--id") || args[1];
    const loaded = findModule(id);
    const threadId = valueAfter(args, "--memory") || valueAfter(args, "--thread");
    const output = {
      id: loaded.id,
      codeDir: loaded.moduleDir,
      dataDir: loaded.manifest.scope === "global" || threadId ? moduleDataDir(loaded.manifest, { memoryId: threadId }) : null,
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
  if (args.includes("--apply")) input.apply = true;
  if (args.includes("--dry-run")) input.apply = false;
  if (moduleAction === "hook") {
    try { input.stdin = await readStdin(); }
    catch { return console.log("{}"); }
  }
  // Metadata commands and contract checks do not need the database runtime.
  const { createModuleContext } = require("../src/services/developer-module-runtime");
  const context = createModuleContext(loaded.manifest, { memoryId: input.memoryId });
  const output = await implementation.run(context, input);
  console.log(JSON.stringify(output ?? {}, null, moduleAction === "hook" ? 0 : 2));
  return output;
}

if (require.main === module) {
  runModuleCommand().catch(error => { console.error(`[module] error: ${error.message}`); process.exitCode = 1; });
}

module.exports = { runModuleCommand, commandInput, readBatchFile };
