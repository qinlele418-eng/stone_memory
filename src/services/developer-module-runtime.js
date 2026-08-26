const path = require("path");
const fs = require("node:fs");
const { getThreadDir, listThreadIds } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { listBindings, getBinding } = require("./memory-bindings");
const { findModule, moduleDataDir, resolveInside } = require("./developer-module-contract");

function withStore(threadId, action) {
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try { return action(store); }
  finally { store.close(); }
}

function createModuleContext(manifest, { threadId = null, dataRoot } = {}) {
  const dataDir = manifest.scope === "global" || threadId ? moduleDataDir(manifest, { threadId, dataRoot }) : null;
  return Object.freeze({
    moduleId: manifest.id,
    threadId,
    moduleDataDir: dataDir,
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

function loadCommand(module, action) {
  const command = module.manifest.entry?.commands?.[action];
  if (!command) throw new Error(`developer module ${module.id} does not expose action ${action}`);
  const file = resolveInside(module.moduleDir, command, `command ${action}`);
  if (!fs.existsSync(file)) throw new Error(`developer module command is missing: ${module.id}/${action}`);
  const implementation = require(file);
  if (typeof implementation.run !== "function") throw new Error(`developer module command must export run(context, input): ${module.id}/${action}`);
  return implementation;
}

async function runModuleAction({ moduleId, action, threadId, input = {}, dataRoot } = {}) {
  const module = findModule(moduleId);
  const context = createModuleContext(module.manifest, { threadId, dataRoot });
  const implementation = loadCommand(module, action);
  return implementation.run(context, input);
}

module.exports = { createModuleContext, loadCommand, runModuleAction };
