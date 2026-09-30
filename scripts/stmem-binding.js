#!/usr/bin/env node
const path = require("path");
const { spawnSync } = require("child_process");
const { getThreadDir, listMemoryIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const {
  planBinding,
  addBinding,
  listBindings,
  setBindingEnabled,
  previewBindingImport,
  applyBindingImport,
  previewRevertImport,
  revertBindingImport,
  listImportBatches,
} = require("../src/services/memory-bindings");
const {
  readBindingConfig, planBindingAdd, applyBindingAdd, planBindingSwitch, applyBindingSwitch,
  planBindingPrimary, applyBindingPrimary, planBindingState, applyBindingState, migrateLegacyBinding,
  planBindingSuccessorDiscovery, applyBindingSuccessorDiscovery,
} = require("../src/services/memory-binding-config");

function parseArgs(argv) {
  const args = [...argv];
  const action = args.shift() || "list";
  const options = { action, apply: false };
  const values = {
    "--thread": "threadId",
    "--memory": "memoryId",
    "--id": "bindingId",
    "--binding": "bindingId",
    "--provider": "provider",
    "--external-thread": "externalThreadId",
    "--thread-file": "threadFile",
    "--mode": "mode",
    "--source": "source",
    "--batch": "batchId",
    "--table": "table",
    "--map-time": "timeField",
    "--map-role": "roleField",
    "--map-content": "contentField",
    "--batch-file": "batchFile",
    "--confirmed-plan": "confirmedPlan",
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") { options.apply = true; continue; }
    if (arg === "--dry-run") { options.apply = false; continue; }
    if (arg === "--json") { options.json = true; continue; }
    const key = values[arg];
    if (!key || !args[index + 1]) throw new Error(`未知或缺少参数：${arg}`);
    options[key] = args[++index];
  }
  return options;
}

function usage() {
  return `用法：
  stmem binding list --memory <记忆体ID>
  stmem binding add --memory <记忆体ID> --batch-file <json> [--apply]
  stmem binding switch --memory <记忆体ID> --binding <id> [--confirmed-plan <token> --apply]
  stmem binding primary --memory <记忆体ID> --binding <id> [--apply]
  stmem binding enable|disable|remove --memory <记忆体ID> --binding <id> [--apply]
  stmem binding migrate-legacy --memory <记忆体ID> [--apply]
  stmem binding discover-successors --memory <记忆体ID> [--apply]
  stmem binding list --thread <记忆体ID>
  stmem binding add --thread <记忆体ID> --provider codex --external-thread <id> --thread-file <jsonl>
  stmem binding add --memory <记忆体ID> --batch-file <json>   # batch: {"provider":"pando","externalThreadId":"<会话ID>"}（pando 无需会话文件）
  stmem binding add ... --apply
  stmem binding enable|disable --thread <记忆体ID> --id <binding-id> --apply
  stmem binding import --thread <记忆体ID> --binding <id> [--source <文件>]
  stmem binding import ... --apply
  stmem binding batches --thread <记忆体ID> [--binding <id>]
  stmem binding revert --thread <记忆体ID> --batch <batch-id>
  stmem binding revert ... --apply

所有新增、导入、停用和撤销操作默认只预览；必须显式 --apply 才写入。`;
}

function requireValue(value, label) {
  if (!value) throw new Error(`缺少 ${label}`);
  return value;
}

function runBindingCommand(argv = process.argv.slice(3)) {
  const options = parseArgs(argv);
  if (["help", "--help", "-h"].includes(options.action)) {
    console.log(usage());
    return;
  }
  if (!options.memoryId && !options.threadId) {
    const configured = listMemoryIds();
    if (options.action !== "list") throw new Error("Binding 写操作必须显式指定 --memory <id>");
    if (configured.length > 1) throw new Error("存在多个记忆体，请显式指定 --memory <id>");
    options.memoryId = configured.length === 1 ? configured[0] : null;
  }
  if (options.memoryId) {
    let output;
    if (options.action === "list") output = { memoryId: options.memoryId, ...readBindingConfig(options.memoryId) };
    else if (options.action === "migrate-legacy") output = migrateLegacyBinding(options.memoryId, { apply: options.apply });
    else if (options.action === "discover-successors") output = options.apply
      ? applyBindingSuccessorDiscovery(options.memoryId)
      : planBindingSuccessorDiscovery(options.memoryId);
    else if (options.action === "add") {
      if (!options.batchFile) throw new Error("新 Binding 写入需要 --batch-file <json>");
      const input = JSON.parse(require("fs").readFileSync(options.batchFile, "utf8"));
      output = options.apply ? applyBindingAdd(options.memoryId, input) : planBindingAdd(options.memoryId, input);
    } else if (options.action === "switch") {
      const bindingId = requireValue(options.bindingId, "--binding <id>");
      if (!options.apply) output = planBindingSwitch(options.memoryId, bindingId);
      else output = applyBindingSwitch(options.memoryId, bindingId, {
        confirmedPlan: options.confirmedPlan,
        rebuild(binding) {
          const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "stmem"), "rebuild", "--thread", options.memoryId, "--binding", binding.id, "--apply"], {
            cwd: path.join(__dirname, ".."), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
          });
          return { status: result.status, output: result.stdout, error: result.error?.message || result.stderr };
        },
      });
    } else if (options.action === "primary") {
      const bindingId = requireValue(options.bindingId, "--binding <id>");
      output = options.apply ? applyBindingPrimary(options.memoryId, bindingId) : planBindingPrimary(options.memoryId, bindingId);
    } else if (["enable", "disable", "remove"].includes(options.action)) {
      const bindingId = requireValue(options.bindingId, "--binding <id>");
      output = options.apply
        ? applyBindingState(options.memoryId, bindingId, options.action)
        : planBindingState(options.memoryId, bindingId, options.action);
    } else throw new Error("新记忆体 Binding 支持 list|add|primary|switch|enable|disable|remove|migrate-legacy|discover-successors");
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  const threadId = options.threadId;
  if (!threadId) throw new Error("未指定记忆体，请使用 --thread <id>");
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  try {
    let output;
    if (options.action === "list") {
      output = { memoryId: threadId, bindings: listBindings(store) };
    } else if (options.action === "add") {
      const input = {
        provider: options.provider,
        externalThreadId: options.externalThreadId,
        threadFile: options.threadFile,
        mode: options.mode,
      };
      output = options.apply ? addBinding(store, input) : { dryRun: true, ...planBinding(store, input) };
    } else if (options.action === "enable" || options.action === "disable") {
      const bindingId = requireValue(options.bindingId, "--id <binding-id>");
      output = options.apply
        ? { changed: true, binding: setBindingEnabled(store, bindingId, options.action === "enable") }
        : { dryRun: true, action: options.action, bindingId };
    } else if (options.action === "import") {
      const bindingId = requireValue(options.bindingId, "--binding <binding-id>");
      output = options.apply
        ? applyBindingImport(store, bindingId, options)
        : previewBindingImport(store, bindingId, options);
    } else if (options.action === "batches") {
      output = { memoryId: threadId, batches: listImportBatches(store, options.bindingId) };
    } else if (options.action === "revert") {
      const id = requireValue(options.batchId, "--batch <batch-id>");
      output = options.apply ? revertBindingImport(store, id) : previewRevertImport(store, id);
    } else {
      throw new Error(`未知 binding 操作：${options.action}\n${usage()}`);
    }
    console.log(JSON.stringify(output, null, 2));
    return output;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try { runBindingCommand(); }
  catch (error) { console.error(`[binding] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, runBindingCommand };
