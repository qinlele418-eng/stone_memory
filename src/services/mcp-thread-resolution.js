const { legacyEntries, listMemoryIds, assertMemoryId } = require("./memory-identity");

function resolveMcpThread(args = {}, cfg = {}, configuredThreadIds = [], env = process.env, options = {}) {
  const requested = args.memoryId || args.thread || env.STMEM_MEMORY_ID || env.STMEM_THREAD_ID
    || env.STMEM_CURRENT_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  const legacy = legacyEntries(cfg);
  const memoryIds = listMemoryIds(cfg);
  if (requested) {
    const id = assertMemoryId(requested);
    if (memoryIds.includes(id)) return id;
    const direct = legacy.find(([key]) => key === id);
    if (direct) return direct[1].memoryId || id;

    // Host session IDs are Binding identities, not database partition IDs.
    const matches = new Set(legacy.filter(([, value]) => value.externalThreadId === id)
      .map(([key, value]) => value.memoryId || key));
    const readBindings = options.readBindings || (memoryId => require("./memory-binding-config").readBindingConfig(memoryId).bindings);
    for (const memoryId of Object.keys(cfg.memories || {})) {
      const bindings = readBindings(memoryId);
      // enabled controls automatic watching; stopping it does not unbind a window.
      if (bindings.some(binding => binding.externalThreadId === id)) matches.add(memoryId);
    }
    if (matches.size === 1) return [...matches][0];
    if (matches.size > 1) throw new Error("线程对应多个记忆体，请显式指定 memoryId");
    throw new Error(`未配置线程：${id}；未找到对应的记忆体或 Binding`);
  }
  const candidates = memoryIds.length ? memoryIds : [...new Set(configuredThreadIds)];
  if (options.allowSoleMemory !== false && candidates.length === 1) return candidates[0];
  if (candidates.length === 1) {
    throw new Error("该操作会修改正式状态，请通过当前宿主 session 或 memoryId/thread 显式指定记忆体");
  }
  if (candidates.length > 1) {
    throw new Error(`存在多个记忆体，请显式指定 thread 或 memoryId：${candidates.join(", ")}`);
  }
  throw new Error("没有已配置的记忆体");
}

module.exports = { resolveMcpThread };
