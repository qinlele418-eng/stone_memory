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

  listDates(threadId) {
    return this.dreamStore.listDates(threadId);
  }

  eligibleDates(threadId) {
    const memoryStore = this.memoryStoreFactory(threadId);
    let states;
    try {
      states = memoryStore.listDayStates();
    } finally {
      memoryStore.close();
    }
    return states
      .filter(row => row.status === "completed")
      .map(row => row.source_date)
      .sort();
  }

  coverage(threadId) {
    const firstDreamDate = this.dreamStore.listDates(threadId)[0] || null;
    const eligibleDates = this.eligibleDates(threadId);
    return this.dreamStore.coverage(
      threadId,
      firstDreamDate
        ? eligibleDates.filter(date => date >= firstDreamDate)
        : [],
    );
  }
}

module.exports = { DreamReader };
