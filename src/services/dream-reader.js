"use strict";

const path = require("node:path");
const { getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { DreamStore } = require("../storage/dream-store");

class DreamReader {
  constructor({
    dreamStore = new DreamStore(),
    memoryStoreFactory = threadId => new MemoryStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    }),
  } = {}) {
    this.dreamStore = dreamStore;
    this.memoryStoreFactory = memoryStoreFactory;
  }

  get(threadId, date) {
    return this.dreamStore.get(threadId, date);
  }

  latest(threadId) {
    return this.dreamStore.latest(threadId);
  }

  coverage(threadId) {
    const memoryStore = this.memoryStoreFactory(threadId);
    let states;
    try {
      states = memoryStore.listDayStates();
    } finally {
      memoryStore.close();
    }
    const eligibleDates = states
      .filter(row => ["completed", "completed_empty"].includes(row.status))
      .map(row => row.source_date);
    return this.dreamStore.coverage(threadId, eligibleDates);
  }
}

module.exports = { DreamReader };
