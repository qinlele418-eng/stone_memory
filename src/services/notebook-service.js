"use strict";

const path = require("node:path");
const { getThreadDir } = require("../config");
const { NotebookStore } = require("../storage/notebook-store");
const { dataDirFor } = require("./developer-module-data");

class NotebookService {
  constructor(options = {}) {
    this.storeFactory = options.storeFactory || defaultStoreFactory;
    this.fallbackStoreFactory = options.fallbackStoreFactory === undefined
      ? (options.storeFactory ? null : defaultLegacyStoreFactory)
      : options.fallbackStoreFactory;
  }
  status({ threadId }) {
    return this.withReadableStore(threadId, store => store.status(), result => result.topicCount > 0 || result.entryCount > 0);
  }
  createTopic({ threadId, ...input }) { return this.withStore(threadId, store => store.createTopic(input)); }
  updateTopic({ threadId, ...input }) { return this.withStore(threadId, store => store.updateTopic(input)); }
  write({ threadId, ...input }) { return this.withStore(threadId, store => store.writeEntry(input)); }
  query({ threadId, ...input }) { return this.withReadableStore(threadId, store => store.query(input), result => result.matchCount > 0); }
  read({ threadId, noteId }) {
    return this.withReadableStore(threadId, store => {
      try { return store.readEntry(noteId); }
      catch (error) { if (/not found/u.test(error.message)) return null; throw error; }
    }, Boolean, { missingMessage: `notebook entry not found: ${noteId}` });
  }
  list({ threadId, topicId, includeBody = false }) {
    return this.withReadableStore(threadId, store => store.listEntries({ topicId, includeBody }), result => result.length > 0);
  }

  withStore(threadId, operation) {
    const store = this.storeFactory(requiredText(threadId, "threadId"));
    try { return operation(store); }
    finally { store.close(); }
  }

  withReadableStore(threadId, operation, hasResult, { missingMessage = null } = {}) {
    const normalizedThreadId = requiredText(threadId, "threadId");
    const primary = this.withStore(normalizedThreadId, operation);
    if (hasResult(primary) || !this.fallbackStoreFactory) return primary;
    const fallback = this.fallbackStoreFactory(normalizedThreadId);
    try {
      const legacy = operation(fallback);
      if (missingMessage && !hasResult(legacy)) throw new Error(missingMessage);
      return legacy;
    } finally { fallback.close(); }
  }
}

function defaultStoreFactory(threadId, options = {}) {
  const dataDir = dataDirFor("notebook-lab", threadId, options);
  return new NotebookStore({
    threadId,
    root: path.join(dataDir, "documents"),
    databaseFile: path.join(dataDir, "module.sqlite"),
  });
}

function defaultLegacyStoreFactory(threadId) {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  return new NotebookStore({ threadId, root: path.join(memoryDir, "notebook"), memoryDir });
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

module.exports = { NotebookService, defaultStoreFactory, defaultLegacyStoreFactory };
