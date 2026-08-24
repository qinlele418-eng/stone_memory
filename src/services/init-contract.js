const os = require("os");
const path = require("path");

const INIT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Stone Memory init batch",
  type: "object",
  additionalProperties: false,
  required: ["libraryName", "threadId", "ai", "user", "runtime", "purpose", "sessionDir", "minerMode"],
  properties: {
    libraryName: { type: "string", minLength: 1, description: "记忆体显示名称，例如 alisa；不是线程 ID。" },
    threadId: { type: "string", pattern: "^[A-Za-z0-9._:-]+$", description: "Claude/Codex 真实线程 ID，必须能在 sessionDir 下匹配到对应 JSONL 文件。" },
    ai: { type: "string", minLength: 1, description: "AI 的显示名字。" },
    user: { type: "string", minLength: 1, description: "用户的显示名字。" },
    userGender: { type: "string", enum: ["female", "male", "unspecified"], default: "unspecified" },
    relationshipTimeline: {
      type: "array", default: [], items: { type: "string", minLength: 1 },
      description: "关系阶段时间线，每行一条；Miner 用于判断当天所处阶段，空数组表示不提供。",
    },
    runtime: { type: "string", enum: ["claude", "codex"] },
    purpose: { type: "string", enum: ["accompany", "coding", "study"] },
    sessionDir: { type: "string", minLength: 1, description: "线程文件搜索根目录，不是 JSONL 文件名；Stone Memory 会递归查找。" },
    minerMode: { type: "string", enum: ["subagent", "api"] },
    apiProvider: { type: "string", description: "minerMode=api 时填写，例如 deepseek/openai/anthropic。" },
    apiKey: { type: "string", description: "仅通过权限受限的 batch 文件传递，禁止放入命令行参数或提交到 Git。" },
    baseUrl: { type: "string" },
    model: { type: "string", description: "API 实际可用的模型名。Stone Memory 不预设模型名，API 模式必须显式填写。" },
    windowDays: { type: "integer", minimum: 1, default: 3 },
    keepToolPairs: { type: "integer", minimum: 0, default: 30 },
    mcpRebuildDefaultsEnabled: { type: "boolean", default: false },
    mcpSummaryLimit: { type: "integer", minimum: 0, default: 0 },
    mcpMinImportance: { type: "integer", minimum: 0, maximum: 5, default: 0 },
    contextWindowTokens: { type: ["integer", "null"], minimum: 1 },
    automaticFullMining: { type: "boolean", default: true },
    automaticMemoryMaintenance: { type: "boolean", default: true },
    automaticCompression: { type: "boolean", default: false },
    automaticDream: { type: "boolean", default: false },
    watcherEnabled: { type: "boolean", default: true },
    watcherModules: {
      type: "object",
      additionalProperties: { type: "boolean" },
      properties: {
        archive: { type: "boolean" }, miner: { type: "boolean" },
        compression: { type: "boolean" }, dream: { type: "boolean" },
      },
    },
  },
};

function buildInitTemplate(runtime = "codex") {
  const selected = runtime === "claude" ? "claude" : "codex";
  return {
    libraryName: "记忆体显示名称",
    threadId: "真实线程ID，例如019f91...",
    ai: "AI名字",
    user: "用户名字",
    userGender: "unspecified",
    relationshipTimeline: [],
    runtime: selected,
    purpose: "accompany",
    sessionDir: selected === "codex"
      ? path.join(os.homedir(), ".codex", "sessions")
      : path.join(os.homedir(), ".claude", "projects", "对应项目目录"),
    minerMode: "subagent",
    windowDays: 3,
    keepToolPairs: 30,
    mcpRebuildDefaultsEnabled: false,
    mcpSummaryLimit: 0,
    mcpMinImportance: 0,
    automaticFullMining: true,
    automaticMemoryMaintenance: true,
    automaticCompression: false,
    automaticDream: false,
    watcherEnabled: true,
    watcherModules: { archive: true, miner: true, compression: false, dream: false },
  };
}

module.exports = { INIT_SCHEMA, buildInitTemplate };
