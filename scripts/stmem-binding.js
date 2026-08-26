#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listThreadIds } = require("../src/config");
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

function parseArgs(argv) {
  const args = [...argv];
  const action = args.shift() || "list";
  const options = { action, apply: false };
  const values = {
    "--thread": "threadId",
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
  stmem binding list --thread <记忆体ID>
  stmem binding add --thread <记忆体ID> --provider codex --external-thread <id> --thread-file <jsonl>
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
  const threadId = options.threadId || listThreadIds()[0];
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
