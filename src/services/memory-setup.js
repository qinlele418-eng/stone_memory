const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadConfig, getMemoryContext, CONFIG_PATH } = require("../config");
const { saveConfig } = require("./thread-setup");
const { canonicalMemoryDir, legacyEntries } = require("./memory-identity");
const { getScenario, scenarioId } = require("./scenario-registry");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function ruleTemplates(ai = "") {
  const name = String(ai || "AI").trim() || "AI";
  return {
    "instructions.md": `# ${name} 的系统指令\n\n在此定义 ${name} 的基础人格、行为规则、回复风格。\n每次 rebuild 时这些指令会自动注入到新线程头部。\n`,
    "operations.md": `# ${name} 的操作指令\n\n在此定义 ${name} 可以使用的工具、API、外部系统。\n每次 rebuild 时这些操作指令会自动注入到新线程头部。\n`,
  };
}

function memoryScaffoldPlan(root) {
  const directories = ["memory/archive/full", "memory/import/done", "memory/mined/feelings", "rules", "logs"];
  const files = ["memory/retain-config.json", "memory/audit-marks.json", "rules/instructions.md", "rules/operations.md"];
  return {
    root,
    missingDirectories: directories.filter(relative => !fs.existsSync(path.join(root, relative))),
    missingFiles: files.filter(relative => !fs.existsSync(path.join(root, relative))),
  };
}

function ensureMemoryScaffold(root, { ai = "", now = new Date(), apply = true } = {}) {
  const plan = memoryScaffoldPlan(root);
  if (!apply) return { ...plan, changed: !!(plan.missingDirectories.length || plan.missingFiles.length) };
  for (const relative of plan.missingDirectories) fs.mkdirSync(path.join(root, relative), { recursive: true });
  const defaults = {
    "memory/retain-config.json": JSON.stringify({ retain: {}, eventAnchors: {} }, null, 2),
    "memory/audit-marks.json": JSON.stringify({ lastCutoffDate: `${now.getFullYear()}-01-01`, retainMarks: {} }, null, 2),
    ...Object.fromEntries(Object.entries(ruleTemplates(ai)).map(([name, content]) => [`rules/${name}`, content])),
  };
  for (const relative of plan.missingFiles) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, defaults[relative], { encoding: "utf8", mode: 0o600 });
  }
  const updatedFiles = [];
  if (String(ai || "").trim()) {
    const generic = ruleTemplates("");
    const named = ruleTemplates(ai);
    for (const name of Object.keys(named)) {
      const relative = `rules/${name}`;
      const file = path.join(root, relative);
      if (!plan.missingFiles.includes(relative) && fs.readFileSync(file, "utf8") === generic[name]) {
        fs.writeFileSync(file, named[name], { encoding: "utf8", mode: 0o600 });
        updatedFiles.push(relative);
      }
    }
  }
  return { ...plan, updatedFiles, changed: !!(plan.missingDirectories.length || plan.missingFiles.length || updatedFiles.length) };
}

function memoryRecord(memoryId, value = {}) {
  return {
    memoryId,
    label: String(value.label || "新建记忆体").trim() || "新建记忆体",
    status: value.status === "active" ? "active" : "draft",
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || value.createdAt || new Date().toISOString(),
    bindings: Array.isArray(value.bindings) ? value.bindings : [],
  };
}

function createMemory({ label = "新建记忆体" } = {}) {
  const config = loadConfig();
  const memoryId = crypto.randomUUID();
  const record = memoryRecord(memoryId, { label, createdAt: new Date().toISOString() });
  const root = canonicalMemoryDir(path.dirname(CONFIG_PATH), memoryId);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: false });
  try {
    writeJson(path.join(root, "memory.json"), {
      schemaVersion: 1, memoryId, label: record.label, status: "draft",
      purpose: null, ai: "", user: "", userGender: "unspecified",
      relationshipTimeline: [],
      mcpModules: ["notebook-lab", "dream-lab"], mcpModuleConfigVersion: 1,
      miner: { mode: null, apiProfile: null },
      rebuild: { windowDays: 3, keepToolPairs: 30, contextWindowTokens: null, mcpRebuildDefaultsEnabled: false, mcpSummaryLimit: 0, mcpMinImportance: 0 },
      createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
    writeJson(path.join(root, "bindings.json"), {
      schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [],
    });
    writeJson(path.join(root, "watcher.json"), {
      schemaVersion: 1, enabled: false,
      modules: { archive: false, miner: false, compression: false, dream: false },
    });
    writeJson(path.join(root, ".layout-v1.json"), {
      schemaVersion: 1, status: "complete", memoryId, origin: "created", completedAt: record.createdAt,
    });
    ensureMemoryScaffold(root);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  config.memories = config.memories || {};
  config.memories[memoryId] = record;
  try { saveConfig(config); }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
  return { ...record, directory: root };
}

function getMemory(memoryId, config = loadConfig()) {
  const value = config.memories?.[memoryId];
  return value ? memoryRecord(memoryId, value) : null;
}

function listMemories(config = loadConfig()) {
  const records = new Map(Object.entries(config.memories || {}).map(([id, value]) => [id, memoryRecord(id, value)]));
  for (const [legacyKey, value] of legacyEntries(config)) {
    const memoryId = String(value.memoryId || legacyKey);
    if (records.has(memoryId)) continue;
    records.set(memoryId, memoryRecord(memoryId, {
      label: value.label || legacyKey,
      status: "active",
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      bindings: value.bindings,
    }));
  }
  return [...records.values()];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function publicMemorySettings(memoryId) {
  const context = getMemoryContext(memoryId);
  if (context.layout === "memory-v1") return readJson(path.join(context.root, "memory.json"));
  const entry = context.config;
  return {
    schemaVersion: 1, memoryId: context.memoryId, label: entry.label || context.memoryId, status: "active",
    purpose: entry.purpose || null, scenario: scenarioId(entry), ai: entry.ai || "", user: entry.user || "",
    userGender: entry.userGender || "unspecified",
    relationshipTimeline: Array.isArray(entry.relationshipTimeline) ? entry.relationshipTimeline : [],
    miner: { mode: entry.minerMode || null, apiProfile: entry.apiProvider || null },
    rebuild: {
      windowDays: entry.windowDays ?? 3, keepToolPairs: entry.keepToolPairs ?? 30,
      contextWindowTokens: entry.contextWindowTokens ?? null,
    },
    createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null,
    compatibilityLayout: true,
  };
}

function optionalText(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  const normalized = String(value ?? "").trim();
  if (!normalized && !nullable) throw new Error(`${label}不能为空`);
  if (normalized.length > 200) throw new Error(`${label}不能超过 200 个字符`);
  return normalized || null;
}

function boundedInteger(value, label, minimum, maximum, { nullable = false } = {}) {
  if ((value === null || value === "") && nullable) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function validateMemorySettings(current, patch, config = loadConfig()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置必须是 JSON 对象");
  const allowed = new Set(["label", "purpose", "scenario", "ai", "user", "userGender", "relationshipTimeline", "miner", "rebuild"]);
  const unknown = Object.keys(patch).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`不支持的记忆体设置：${unknown.join("、")}`);
  const next = JSON.parse(JSON.stringify(current));
  if (Object.hasOwn(patch, "label")) next.label = optionalText(patch.label, "记忆体名字");
  if (Object.hasOwn(patch, "purpose")) {
    const purpose = optionalText(patch.purpose, "用途", { nullable: true });
    if (purpose && !["accompany", "coding", "study"].includes(purpose)) throw new Error("用途必须是 accompany、coding 或 study");
    next.purpose = purpose;
  }
  if (Object.hasOwn(patch, "scenario")) {
    const scenario = getScenario(patch.scenario);
    next.scenario = scenario.id;
    if (!next.purpose) next.purpose = scenario.storagePurpose;
  }
  if (Object.hasOwn(patch, "ai")) next.ai = optionalText(patch.ai, "AI 名字", { nullable: true }) || "";
  if (Object.hasOwn(patch, "user")) next.user = optionalText(patch.user, "用户名字", { nullable: true }) || "";
  if (Object.hasOwn(patch, "userGender")) {
    const gender = optionalText(patch.userGender, "用户性别");
    if (!["unspecified", "female", "male"].includes(gender)) throw new Error("用户性别必须是 unspecified、female 或 male");
    next.userGender = gender;
  }
  if (Object.hasOwn(patch, "relationshipTimeline")) {
    if (!Array.isArray(patch.relationshipTimeline)) throw new Error("关系时间轴必须是数组");
    next.relationshipTimeline = patch.relationshipTimeline.map(value => String(value || "").trim()).filter(Boolean);
  }
  if (Object.hasOwn(patch, "miner")) {
    if (!patch.miner || typeof patch.miner !== "object" || Array.isArray(patch.miner)) throw new Error("miner 设置必须是对象");
    const minerUnknown = Object.keys(patch.miner).filter(key => !["mode", "apiProfile"].includes(key));
    if (minerUnknown.length) throw new Error(`不支持的 miner 设置：${minerUnknown.join("、")}`);
    next.miner = { ...(next.miner || { mode: null, apiProfile: null }) };
    if (Object.hasOwn(patch.miner, "mode")) {
      const mode = optionalText(patch.miner.mode, "挖掘模式", { nullable: true });
      if (mode && !["api", "subagent"].includes(mode)) throw new Error("挖掘模式必须是 api 或 subagent");
      next.miner.mode = mode;
    }
    if (Object.hasOwn(patch.miner, "apiProfile")) next.miner.apiProfile = optionalText(patch.miner.apiProfile, "API profile", { nullable: true });
    if (next.miner.mode === "api") {
      if (!next.miner.apiProfile) throw new Error("API 挖掘模式需要选择 API profile");
      if (!config.apiKeys?.[next.miner.apiProfile]) throw new Error(`API profile 不存在：${next.miner.apiProfile}`);
    }
  }
  if (Object.hasOwn(patch, "rebuild")) {
    if (!patch.rebuild || typeof patch.rebuild !== "object" || Array.isArray(patch.rebuild)) throw new Error("rebuild 设置必须是对象");
    const rebuildUnknown = Object.keys(patch.rebuild).filter(key => !["windowDays", "keepToolPairs", "contextWindowTokens", "mcpRebuildDefaultsEnabled", "mcpSummaryLimit", "mcpMinImportance"].includes(key));
    if (rebuildUnknown.length) throw new Error(`不支持的 rebuild 设置：${rebuildUnknown.join("、")}`);
    next.rebuild = { ...(next.rebuild || {}) };
    if (Object.hasOwn(patch.rebuild, "windowDays")) next.rebuild.windowDays = boundedInteger(patch.rebuild.windowDays, "窗口天数", 1, 365);
    if (Object.hasOwn(patch.rebuild, "keepToolPairs")) next.rebuild.keepToolPairs = boundedInteger(patch.rebuild.keepToolPairs, "工具链组数", 0, 500);
    if (Object.hasOwn(patch.rebuild, "contextWindowTokens")) next.rebuild.contextWindowTokens = boundedInteger(patch.rebuild.contextWindowTokens, "上下文窗口", 1, 100000000, { nullable: true });
    if (Object.hasOwn(patch.rebuild, "mcpRebuildDefaultsEnabled")) next.rebuild.mcpRebuildDefaultsEnabled = patch.rebuild.mcpRebuildDefaultsEnabled === true;
    if (Object.hasOwn(patch.rebuild, "mcpSummaryLimit")) next.rebuild.mcpSummaryLimit = boundedInteger(patch.rebuild.mcpSummaryLimit, "MCP 摘要上限", 0, 1000000);
    if (Object.hasOwn(patch.rebuild, "mcpMinImportance")) next.rebuild.mcpMinImportance = boundedInteger(patch.rebuild.mcpMinImportance, "MCP 最低重要度", 0, 5);
  }
  next.schemaVersion = 1;
  next.memoryId = current.memoryId;
  next.status = current.status;
  next.createdAt = current.createdAt;
  next.updatedAt = current.updatedAt;
  delete next.compatibilityLayout;
  return next;
}

function updateMemorySettings(memoryId, patch, { apply = false } = {}) {
  const context = getMemoryContext(memoryId);
  if (context.layout !== "memory-v1") throw new Error("旧布局记忆体需先完成 memory-layout 迁移后再写分项设置");
  const file = path.join(context.root, "memory.json");
  const current = readJson(file);
  const settings = validateMemorySettings(current, patch);
  const changed = JSON.stringify(current) !== JSON.stringify(settings);
  if (!apply) return { valid: true, changed, settings };
  if (!changed) return { applied: true, changed: false, settings: current };
  ensureMemoryScaffold(context.root, { ai: settings.ai });
  settings.updatedAt = new Date().toISOString();
  const config = loadConfig();
  const original = fs.readFileSync(file, "utf8");
  writeJson(file, settings);
  try {
    config.memories = config.memories || {};
    config.memories[memoryId] = {
      ...(config.memories[memoryId] || {}), memoryId, label: settings.label,
      status: settings.status, createdAt: settings.createdAt, updatedAt: settings.updatedAt,
    };
    saveConfig(config);
  } catch (error) {
    fs.writeFileSync(file, original, { encoding: "utf8", mode: 0o600 });
    throw error;
  }
  return { applied: true, changed: true, settings };
}

function deleteDraftMemory(memoryId, { apply = false, now = new Date() } = {}) {
  const config = loadConfig();
  const registered = getMemory(memoryId, config);
  if (!registered) throw new Error(`记忆体不存在：${memoryId}`);
  const context = getMemoryContext(memoryId);
  const memoryFile = path.join(context.root, "memory.json");
  const settings = fs.existsSync(memoryFile) ? readJson(memoryFile) : registered;
  const bindingsFile = path.join(context.root, "bindings.json");
  const bindings = fs.existsSync(bindingsFile) ? readJson(bindingsFile).bindings || [] : [];
  if (context.configured || settings.status !== "draft" || bindings.length) {
    throw new Error("只能用 memory delete 删除尚未绑定、没有数据的草稿记忆体");
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = path.join(path.dirname(CONFIG_PATH), "backups", "deleted-memories", `${memoryId}-${stamp}`);
  const sourceExists = fs.existsSync(context.root);
  const plan = { memoryId, label: settings.label, source: context.root, backup: sourceExists ? backup : null, recoverable: sourceExists };
  if (!apply) return { dryRun: true, ...plan };
  if (sourceExists) {
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.renameSync(context.root, backup);
  }
  try {
    if (config.memories) delete config.memories[memoryId];
    saveConfig(config);
  } catch (error) {
    if (sourceExists) fs.renameSync(backup, context.root);
    throw error;
  }
  return { applied: true, ...plan };
}

function repairMemoryScaffold(memoryId, { apply = false } = {}) {
  const context = getMemoryContext(memoryId);
  if (context.layout !== "memory-v1") throw new Error("旧布局记忆体不需要 canonical 骨架修复");
  const settings = publicMemorySettings(memoryId);
  const result = ensureMemoryScaffold(context.root, { ai: settings.ai, apply });
  return { memoryId, applied: apply, ...result };
}

module.exports = {
  createMemory, getMemory, listMemories, publicMemorySettings,
  validateMemorySettings, updateMemorySettings, deleteDraftMemory, repairMemoryScaffold,
  memoryScaffoldPlan, ensureMemoryScaffold, writeJson,
};
