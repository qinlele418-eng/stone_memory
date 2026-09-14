function resolveMcpThread(args = {}, cfg = {}, configuredThreadIds = [], env = process.env, options = {}) {
  const requested = args.memoryId || args.thread || env.STMEM_MEMORY_ID || env.STMEM_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  if (requested) {
    if (!cfg[requested]) throw new Error(`未配置线程：${requested}`);
    return cfg[requested].memoryId || requested;
  }
  if (options.allowSoleMemory !== false && configuredThreadIds.length === 1) return configuredThreadIds[0];
  if (configuredThreadIds.length === 1) {
    throw new Error("该操作会修改正式状态，请通过当前宿主 session 或 memoryId/thread 显式指定记忆体");
  }
  if (configuredThreadIds.length > 1) {
    throw new Error(`存在多个记忆体，请显式指定 thread：${configuredThreadIds.join(", ")}`);
  }
  throw new Error("没有已配置的记忆体");
}

module.exports = { resolveMcpThread };
