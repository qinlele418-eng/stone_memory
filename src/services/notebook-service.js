"use strict";

const path = require("node:path");
const { getThreadDir } = require("../config");
const { NotebookStore } = require("../storage/notebook-store");

class NotebookService {
  constructor({ storeFactory = defaultStoreFactory } = {}) { this.storeFactory = storeFactory; }
  status({ threadId }) { return this.withStore(threadId, store => store.status()); }
  createTopic({ threadId, ...input }) { return this.withStore(threadId, store => store.createTopic(input)); }
  updateTopic({ threadId, ...input }) { return this.withStore(threadId, store => store.updateTopic(input)); }
  write({ threadId, ...input }) { return this.withStore(threadId, store => store.writeEntry(input)); }
  query({ threadId, ...input }) { return this.withStore(threadId, store => store.query(input)); }
  read({ threadId, noteId }) { return this.withStore(threadId, store => store.readEntry(noteId)); }
  asset({ threadId, topicId, filename }) { return this.withStore(threadId, store => store.readAsset(topicId, filename)); }
  list({ threadId, topicId, includeBody = false }) {
    return this.withStore(threadId, store => store.listEntries({ topicId, includeBody }));
  }

  withStore(threadId, operation) {
    const store = this.storeFactory(requiredText(threadId, "threadId"));
    try { return operation(store); }
    finally { store.close(); }
  }
}

function defaultStoreFactory(threadId) {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  return new NotebookStore({ threadId, root: path.join(memoryDir, "notebook"), memoryDir });
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

module.exports = { NotebookService, defaultStoreFactory };
