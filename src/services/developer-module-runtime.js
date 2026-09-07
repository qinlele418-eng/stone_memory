const path = require("path");
const { getThreadDir, listThreadIds } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { listBindings, getBinding } = require("./memory-bindings");
const { moduleDataDir, resolveInside } = require("./developer-module-contract");
const { MIGRATION_STATE_ROOT } = require("./developer-module-migration-state");

function withStore(threadId, action) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try { return action(store); }
  finally { store.close(); }
}

function createModuleContext(manifest, { threadId = null } = {}) {
  const dataDir = manifest.scope === "global" || threadId ? moduleDataDir(manifest, { threadId }) : null;
  return Object.freeze({
    moduleId: manifest.id,
    threadId,
    moduleDataDir: dataDir,
    migrationStateRoot: MIGRATION_STATE_ROOT,
    legacyThreadDir: threadId ? getThreadDir(threadId) : null,
    resolveDataPath(relativePath) {
      if (!dataDir) throw new Error("该命令需要 --thread <记忆体ID>");
      return resolveInside(dataDir, relativePath, "module data path");
    },
    core: Object.freeze({
      listMemoryIds: () => listThreadIds(),
      listBindings: memoryId => withStore(memoryId, store => listBindings(store)),
      getBinding: (memoryId, bindingId) => withStore(memoryId, store => getBinding(store, bindingId)),
      listFeelings: memoryId => withStore(memoryId, store => store.listFeelings()),
    }),
  });
}

module.exports = { createModuleContext };
