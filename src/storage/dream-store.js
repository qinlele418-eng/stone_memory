"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DREAM_TYPES = new Set([
  "beautiful",
  "nightmare",
  "erotic",
  "beautiful_erotic",
  "nightmare_erotic",
]);

class DreamStore {
  constructor({ root = path.join(os.homedir(), ".stone_memory", "dream") } = {}) {
    this.root = root;
  }

  save({ threadId, date, dreamType, title = "", body }) {
    const file = this.fileFor(threadId, date);
    if (!DREAM_TYPES.has(dreamType)) throw new Error(`invalid dream type: ${dreamType}`);
    const normalizedTitle = singleLine(title);
    const normalizedBody = String(body || "").trim();
    if (!normalizedBody) throw new Error("dream body is required");
    if (fs.existsSync(file)) {
      const error = new Error(`dream already exists: ${threadId}/${date}`);
      error.code = "DREAM_ALREADY_EXISTS";
      throw error;
    }
    const content = [
      `dreamType: ${dreamType}`,
      `dreamDate: ${date}`,
      `title: ${normalizedTitle}`,
      "",
      normalizedBody,
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const conflict = new Error(`dream already exists: ${threadId}/${date}`);
        conflict.code = "DREAM_ALREADY_EXISTS";
        throw conflict;
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
    return this.get(threadId, date);
  }

  get(threadId, date) {
    const file = this.fileFor(threadId, date);
    if (!fs.existsSync(file)) return null;
    return parseDreamFile(fs.readFileSync(file, "utf8"), { threadId, date });
  }

  latest(threadId) {
    const dates = this.listDates(threadId);
    return dates.length ? this.get(threadId, dates.at(-1)) : null;
  }

  // 目录只读视图：按日期升序返回每场梦的元信息，不含正文。
  list(threadId) {
    return this.listDates(threadId).map(date => {
      const dream = this.get(threadId, date);
      return { date, dreamType: dream.dreamType, title: dream.title };
    });
  }

  coverage(threadId, eligibleDates) {
    assertThreadId(threadId);
    const expected = [...new Set((eligibleDates || []).map(assertDate))].sort();
    const available = new Set(this.listDates(threadId));
    return {
      threadId,
      from: expected[0] || null,
      to: expected.at(-1) || null,
      availableDates: expected.filter(date => available.has(date)),
      missingDates: expected.filter(date => !available.has(date)),
    };
  }

  listDates(threadId) {
    const threadRoot = path.join(this.root, assertThreadId(threadId));
    const dates = [];
    for (const year of directoryNames(threadRoot, /^\d{4}$/)) {
      for (const month of directoryNames(path.join(threadRoot, year), /^\d{2}$/)) {
        const directory = path.join(threadRoot, year, month);
        for (const entry of safeReadDir(directory)) {
          const match = entry.isFile() && entry.name.match(/^(\d{4}-\d{2}-\d{2})\.txt$/);
          if (match) dates.push(match[1]);
        }
      }
    }
    return [...new Set(dates)].sort();
  }

  fileFor(threadId, date) {
    const normalizedThreadId = assertThreadId(threadId);
    const normalizedDate = assertDate(date);
    const [year, month] = normalizedDate.split("-");
    return path.join(this.root, normalizedThreadId, year, month, `${normalizedDate}.txt`);
  }
}

function parseDreamFile(content, { threadId, date }) {
  const match = String(content).match(
    /^dreamType: ([a-z_]+)\ndreamDate: (\d{4}-\d{2}-\d{2})\ntitle: ([^\n]*)\n\n([\s\S]*?)\n?$/,
  );
  if (!match || !DREAM_TYPES.has(match[1]) || match[2] !== date || !match[4].trim()) {
    const error = new Error(`invalid dream file: ${threadId}/${date}`);
    error.code = "DREAM_FILE_INVALID";
    throw error;
  }
  return {
    found: true,
    threadId,
    date,
    dreamType: match[1],
    title: match[3],
    body: match[4].trim(),
  };
}

function directoryNames(directory, pattern) {
  return safeReadDir(directory)
    .filter(entry => entry.isDirectory() && pattern.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

function safeReadDir(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function assertThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId || threadId === "." || threadId === ".." || /[\\/]/.test(threadId)) {
    throw new Error("invalid threadId");
  }
  return threadId;
}

function assertDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return date;
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

module.exports = { DREAM_TYPES, DreamStore, parseDreamFile };
