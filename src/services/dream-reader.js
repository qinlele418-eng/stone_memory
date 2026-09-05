"use strict";

const path = require("node:path");
const { getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { DreamStore } = require("../storage/dream-store");
const { DreamPreferences } = require("./dream-preferences");
const { isNsfwDreamType } = require("./dream-policy");

class DreamReader {
  constructor({
    dreamStore = new DreamStore(),
    preferences = new DreamPreferences(),
    memoryStoreFactory = threadId => new MemoryStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    }),
  } = {}) {
    this.dreamStore = dreamStore;
    this.preferences = preferences;
    this.memoryStoreFactory = memoryStoreFactory;
  }

  get(threadId, date) {
    const dream = this.dreamStore.get(threadId, date);
    return this.isVisible(threadId, dream) ? dream : null;
  }

  latest(threadId) {
    const dates = this.listDates(threadId);
    return dates.length ? this.get(threadId, dates.at(-1)) : null;
  }

  listDates(threadId) {
    return this.list(threadId).map(dream => dream.date);
  }

  list(threadId) {
    return this.dreamStore.list(threadId).filter(dream => this.isVisible(threadId, dream));
  }

  isVisible(threadId, dream) {
    if (!dream) return false;
    return this.preferences.read(threadId).nsfwEnabled || !isNsfwDreamType(dream.dreamType);
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
    const firstDreamDate = this.listDates(threadId)[0] || null;
    const eligibleDates = this.eligibleDates(threadId);
    const expectedDates = firstDreamDate ? eligibleDates.filter(date => date >= firstDreamDate) : [];
    const available = new Set(this.listDates(threadId));
    const stored = new Set(this.dreamStore.listDates(threadId));
    return {
      threadId,
      from: expectedDates[0] || null,
      to: expectedDates.at(-1) || null,
      availableDates: expectedDates.filter(date => available.has(date)),
      missingDates: expectedDates.filter(date => !stored.has(date)),
    };
  }
}

module.exports = { DreamReader };
