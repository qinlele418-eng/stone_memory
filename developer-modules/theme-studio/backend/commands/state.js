"use strict";

const fs = require("node:fs");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function atomicJson(file, value) {
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function run(context, input = {}) {
  const themeFile = context.resolveDataPath("theme.json");
  const themesFile = context.resolveDataPath("themes.json");
  if (input.write === true) {
    atomicJson(themeFile, input.state?.theme ?? null);
    atomicJson(themesFile, Array.isArray(input.state?.customThemes) ? input.state.customThemes : []);
  }
  const exists = fs.existsSync(themeFile) || fs.existsSync(themesFile);
  return { exists, theme: readJson(themeFile, null), customThemes: readJson(themesFile, []) };
}

module.exports = { run };
