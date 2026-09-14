const path = require("path");
const { getThreadDir, listMemoryIds, getMemoryContext } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { listBindings, getBinding } = require("./memory-bindings");
const { readBindingConfig, getConfiguredBinding } = require("./memory-binding-config");
const { moduleDataDir, resolveInside } = require("./developer-module-contract");

function withStore(threadId, action) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try { return action(store); }
  finally { store.close(); }
}

function moduleBindings(memoryId) {
  const context = getMemoryContext(memoryId);
  return context.layout === "memory-v1"
    ? readBindingConfig(memoryId).bindings
    : withStore(memoryId, store => listBindings(store));
}

function moduleBinding(memoryId, bindingId) {
  const context = getMemoryContext(memoryId);
  return context.layout === "memory-v1"
    ? getConfiguredBinding(memoryId, bindingId)
    : withStore(memoryId, store => getBinding(store, bindingId));
}

function createModuleContext(manifest, { memoryId = null, threadId = null } = {}) {
  if (memoryId && threadId && memoryId !== threadId) throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
  const selectedMemoryId = memoryId || threadId;
  if (manifest.scope === "memory" && selectedMemoryId) getMemoryContext(selectedMemoryId);
  const dataDir = manifest.scope === "global" || selectedMemoryId ? moduleDataDir(manifest, { memoryId: selectedMemoryId }) : null;
  return Object.freeze({
    moduleId: manifest.id,
    memoryId: selectedMemoryId,
    threadId: selectedMemoryId,
    moduleDataDir: dataDir,
    resolveDataPath(relativePath) {
      if (!dataDir) throw new Error("该命令需要 --memory <记忆体ID>");
      return resolveInside(dataDir, relativePath, "module data path");
    },
    core: Object.freeze({
      listMemoryIds: () => listMemoryIds(),
      listBindings: memoryId => moduleBindings(memoryId),
      getBinding: (memoryId, bindingId) => moduleBinding(memoryId, bindingId),
      listFeelings: memoryId => withStore(memoryId, store => store.listFeelings()),
    }),
  });
}

module.exports = { createModuleContext };
