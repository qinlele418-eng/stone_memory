#!/usr/bin/env node

const capabilities = {
  protocolVersion: 1,
  product: "Stone Memory",
  localSingleUser: true,
  configuration: {
    machineTemplate: true,
    jsonSchema: true,
    validateBeforeApply: true,
    directConfigEditingSupported: false,
  },
  import: {
    builtInCleaning: true,
    multipleFiles: true,
    recursiveDirectory: true,
    preview: true,
    applyRequiresExplicitFlag: true,
    supportedSources: ["claude-jsonl", "codex-jsonl", "json", "jsonl", "sqlite"],
  },
  mining: {
    fullDay: true,
    selectedDates: true,
    targetedMessages: true,
    channels: ["api", "subagent"],
    retryAndFailureState: true,
  },
  rebuild: {
    dryRun: true,
    explicitApply: true,
    automaticFullBackup: true,
    integrityCheck: true,
    repair: true,
    runtimes: ["claude", "codex"],
  },
  safety: {
    sourceModificationRequiredForConfiguration: false,
    customImportScriptRequired: false,
    customRebuildScriptRequired: false,
    disableSafetyButtonsSupported: false,
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(capabilities, null, 2));
} else {
  console.log(`Stone Memory 内置能力

- 初始化：机器模板、JSON Schema、validate 后 apply
- 导入：Claude/Codex/JSON/JSONL/SQLite、批量文件、内置清洗、预览后应用
- 挖掘：整日、多个日期、精准补挖；API/Subagent 双通道
- 重建：dry-run、明确 apply、full 自动备份、完整性检查与修复
- 支持运行时：Claude、Codex

机器读取请运行：stmem capabilities --json
不要直接编辑 stmem.json，也不需要另造导入、清洗或 rebuild 脚本。`);
}
