"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIRECTORY = path.join(__dirname, "watcher-plugins");

function loadPostMiningHooks(directory = DEFAULT_DIRECTORY) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => require(path.join(directory, entry.name)))
    .filter(plugin => plugin && typeof plugin.run === "function")
    .sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
}

function runPostMiningHooks(context, { hooks = loadPostMiningHooks() } = {}) {
  return hooks.map(plugin => {
    const id = String(plugin.id || "anonymous");
    if (typeof plugin.enabled === "function" && !plugin.enabled(context)) {
      return { id, attempted: false, ok: false };
    }
    try {
      return { id, ...plugin.run(context) };
    } catch (error) {
      return { id, attempted: true, ok: false, error };
    }
  });
}

module.exports = { loadPostMiningHooks, runPostMiningHooks };
