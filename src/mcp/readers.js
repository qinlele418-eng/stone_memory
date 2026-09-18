const path = require("node:path");
const { getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { NotebookStore } = require("../storage/notebook-store");
const { listBindings, getBinding } = require("../services/memory-bindings");
const { DreamReader } = require("../services/dream-reader");

function createReaders(memoryId) {
  const memoryDir = path.join(getThreadDir(memoryId), "memory");
  function read(Store, operation) {
    let store;
    try {
      store = new Store({ memoryDir, root: path.join(memoryDir, "notebook"), threadId: memoryId, readonly: true });
      return operation(store);
    } catch (error) {
      if (error.message === "STORAGE_UPGRADE_REQUIRED") throw new Error("MCP_STORAGE_UPGRADE_REQUIRED");
      throw error;
    } finally { store?.close(); }
  }
  return Object.freeze({
    dream: Object.freeze({
      latest: () => new DreamReader().latest(memoryId),
      get: date => new DreamReader().get(memoryId, date),
      status: () => read(MemoryStore, store => new DreamReader({
        memoryStoreFactory: () => ({ listDayStates: () => store.db ? store.listDayStates() : [], close() {} }),
      }).coverage(memoryId)),
    }),
    listBindings: () => read(MemoryStore, store => store.db ? listBindings(store) : []),
    getBinding: id => read(MemoryStore, store => {
      if (!store.db) throw new Error("MCP_BINDING_NOT_FOUND");
      return getBinding(store, id);
    }),
    listFeelings: () => read(MemoryStore, store => store.listFeelings()),
    notebook: Object.freeze({
      catalog: () => read(NotebookStore, store => store.status()),
      search: args => read(NotebookStore, store => store.query(args)),
      read: noteId => read(NotebookStore, store => store.readEntry(noteId)),
    }),
  });
}
module.exports = { createReaders };
