"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findModule, moduleDataDir, resolveInside } = require("./developer-module-contract");

function dataDirFor(moduleId, threadId, options = {}) {
  const { manifest } = findModule(moduleId);
  return moduleDataDir(manifest, { threadId, dataRoot: options.dataRoot });
}

function dataPathFor(moduleId, threadId, relativePath, options = {}) {
  return resolveInside(dataDirFor(moduleId, threadId, options), relativePath, "module data path");
}

function firstExisting(paths) {
  return paths.find(file => file && fs.existsSync(file)) || null;
}

function readFileWithFallback(primary, legacy, encoding = "utf8") {
  const file = firstExisting([primary, legacy]);
  if (!file) return null;
  return { file, content: fs.readFileSync(file, encoding), legacy: file === legacy };
}

function listDirectoriesWithFallback(primary, legacy) {
  return [...new Set([primary, legacy].filter(Boolean).filter(fs.existsSync))];
}

module.exports = {
  dataDirFor,
  dataPathFor,
  firstExisting,
  readFileWithFallback,
  listDirectoriesWithFallback,
};
