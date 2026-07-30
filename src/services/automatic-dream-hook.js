"use strict";

const { execFileSync: defaultExecFileSync } = require("node:child_process");
const path = require("node:path");

function shouldRunAutomaticDream({ date, today, force = false }) {
  if (force) return false;
  return date === previousDate(today);
}

function runAutomaticDream({
  threadId,
  date,
  today,
  force = false,
  cliPath,
  execFileSync = defaultExecFileSync,
}) {
  if (!shouldRunAutomaticDream({ date, today, force })) {
    return { attempted: false, ok: false };
  }

  try {
    const output = execFileSync(process.execPath, [
      cliPath,
      "dream",
      "--thread",
      threadId,
      "--date",
      date,
    ], {
      cwd: path.dirname(path.dirname(cliPath)),
      encoding: "utf8",
      timeout: 600_000,
      windowsHide: true,
      shell: false,
    });
    return { attempted: true, ok: true, output: String(output || "").trim() };
  } catch (error) {
    return { attempted: true, ok: false, error };
  }
}

function previousDate(date) {
  const text = String(date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("today must be YYYY-MM-DD");
  const value = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== text) {
    throw new Error("today must be YYYY-MM-DD");
  }
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

module.exports = { runAutomaticDream, shouldRunAutomaticDream };
