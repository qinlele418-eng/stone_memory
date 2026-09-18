const { validateTools, validateInput, validateResult } = require("./provider-contract");
const { createContext } = require("./context");
const { safeMemoryId } = require("../services/developer-module-mcp-config");
const { toolIdentity } = require("./legacy-tool-names");
function errorResult(code) { return { content: [{ type: "text", text: code }], isError: true }; }
class Registry {
  constructor() { this.entries = new Map(); }
  registerCore(provider) {
    this.core = provider;
    for (const tool of provider.tools) {
      if (this.entries.has(tool.name)) throw new Error("MCP_NAME_CONFLICT");
      this.entries.set(tool.name, { tool, call: args => provider.call(tool.name, args) });
    }
  }
  list() { return [...this.entries.values()].map(entry => entry.tool); }
  registerModule(manifest, provider, { state, memoryIds, timeoutMs, logger = () => {} } = {}) {
    if (!state?.globalEnabled || (manifest.scope === "memory" && !memoryIds.some(id => state.memories?.[id] === true))) return;
    if (typeof provider?.tools !== "function" || typeof provider?.call !== "function") throw new Error("MCP_PROVIDER_EXPORTS");
    const declared = provider.tools(createContext(manifest, { logger }));
    if (declared && typeof declared.then === "function") {
      Promise.resolve(declared).catch(() => {});
      throw new Error("MCP_TOOLS_MUST_BE_SYNCHRONOUS");
    }
    const definitions = validateTools(manifest, declared);
    const pending = [];
    for (const definition of definitions) {
      const identity = toolIdentity(manifest.id, definition.name);
      const { name, memoryArgument } = identity;
      const callTimeout = timeoutMs ?? identity.timeoutMs ?? 30000;
      if (this.entries.has(name)) throw new Error("MCP_NAME_CONFLICT");
      const tool = structuredClone(definition);
      tool.name = name;
      if (manifest.scope === "memory") {
        tool.inputSchema.properties[memoryArgument] = { type: "string", description: "Explicit enabled memory ID" };
        tool.inputSchema.required = [...(tool.inputSchema.required || []), memoryArgument];
      }
      pending.push([name, { tool, call: async (args, signal) => {
        const controller = new AbortController();
        let timer;
        let cancel;
        try {
          validateInput(tool.inputSchema, args);
          const memoryId = manifest.scope === "memory" ? safeMemoryId(args[memoryArgument], memoryIds) : null;
          if (memoryId && state.memories?.[memoryId] !== true) throw new Error("MCP_MEMORY_DISABLED");
          const context = createContext(manifest, { memoryId, signal: controller.signal, writable: !definition.annotations.readOnlyHint, logger, timeoutMs: callTimeout });
          const input = { ...args };
          if (memoryId) delete input[memoryArgument];
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("MCP_CALL_TIMEOUT")); }, callTimeout);
          });
          const cancelled = new Promise((_, reject) => {
            cancel = () => { controller.abort(); reject(new Error("MCP_CANCELLED")); };
            if (signal?.aborted) cancel();
            else signal?.addEventListener("abort", cancel, { once: true });
          });
          return validateResult(await Promise.race([Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("MCP_CANCELLED");
            return provider.call(context, definition.name, input);
          }), timeout, cancelled]));
        } catch (error) {
          // Provider messages, paths and stacks never cross the MCP boundary.
          const code = ["MCP_INPUT_SCHEMA", "MCP_INPUT_REQUIRED", "MCP_INPUT_PROPERTY", "MCP_INPUT_ENUM", "MCP_INPUT_CONST", "MCP_INPUT_BOUND", "MCP_MEMORY_ID", "MCP_MEMORY_DISABLED", "MCP_CALL_TIMEOUT", "MCP_CANCELLED", "MCP_STORAGE_UPGRADE_REQUIRED", "MCP_BINDING_NOT_FOUND"].includes(error?.message) ? error.message : "MCP_PROVIDER_CALL_FAILED";
          logger(code);
          if (code === "MCP_STORAGE_UPGRADE_REQUIRED") return errorResult(`${code}: 请通过正式 stmem CLI 初始化或升级数据库后重试。`);
          return errorResult(code);
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort(); }
      } }]);
    }
    for (const [name, entry] of pending) this.entries.set(name, entry);
  }
  async call(name, args, { signal } = {}) {
    const entry = this.entries.get(name);
    if (!entry) return this.core ? this.core.call(name, args) : { content: [{ type: "text", text: "MCP_UNKNOWN_TOOL" }], isError: true };
    return entry.call(args, signal);
  }
}
module.exports = { Registry, errorResult };
