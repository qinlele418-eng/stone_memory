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
  return {
    action,
    threadId: valueAfter(args, "--memory") || valueAfter(args, "--thread"),
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
    const { readConfig, planChange, applyChange, reconnect } = require("../src/services/developer-module-mcp-config");
    if (operation === "status") {
      const { Registry } = require("../src/mcp/registry");
      const registry = new Registry();
      registry.registerCore({ tools: require("../src/mcp/core/definitions").TOOLS, call() {} });
      const config = readConfig();
      const modules = require("../src/mcp/module-provider-loader").loadModuleProviders(registry, { config });
      const result = { revision: config.revision, modules, reconnect, note: "Provider 结果是本次 CLI 探测，不代表已连接 MCP 会话。" };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (!["enable", "disable"].includes(operation)) throw new Error("MCP_OPERATION_INVALID");
    const plan = planChange({ moduleId: valueAfter(args, "--module"), memoryId: valueAfter(args, "--memory"), enabled: operation === "enable", global: args.includes("--global") });
    const apply = args.includes("--apply");
    if (apply) applyChange(plan);
    const state = plan.after.modules[plan.moduleId];
    const result = { applied: apply, dryRun: !apply, moduleId: plan.moduleId, memoryId: plan.memoryId, revision: apply ? plan.after.revision : plan.before.revision, state, reconnect,
      effectiveEnabled: state.globalEnabled && (plan.scope === "global" || state.memories[plan.memoryId] === true),
      note: plan.scope === "memory" && !state.globalEnabled ? "全局 MCP 仍关闭；记忆体选择不会打开全局开关。需另行使用 --global 显式开启。" : "全局开关与各记忆体选择独立保存。",
    };
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
    const { Registry } = require("../src/mcp/registry");
    const registry = new Registry();
    // Only explicitly enabled providers are executed for dynamic contract audit.
    // Core metadata is enough to detect collisions; do not load database code.
    registry.registerCore({ tools: require("../src/mcp/core/definitions").TOOLS, call() {} });
    const providers = require("../src/mcp/module-provider-loader").loadModuleProviders(registry);
    report.providers = providers;
    for (const provider of providers.filter(item => item.provider === "failed" || item.provider === "config-error")) {
      report.findings.push({ severity: "error", code: "mcp-provider-contract", moduleId: provider.id, message: "MCP Provider 加载或契约验证失败" });
      report.errors++;
    }
    report.ok = report.errors === 0;
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
  // Metadata commands and contract checks do not need the database runtime.
  const { createModuleContext } = require("../src/services/developer-module-runtime");
  const context = createModuleContext(loaded.manifest, { threadId: input.threadId });
  const output = await implementation.run(context, input);
  console.log(JSON.stringify(output ?? {}, null, moduleAction === "hook" ? 0 : 2));
  return output;
}

if (require.main === module) {
  runModuleCommand().catch(error => { console.error(`[module] error: ${error.message}`); process.exitCode = 1; });
}

module.exports = { runModuleCommand, commandInput, readBatchFile };
