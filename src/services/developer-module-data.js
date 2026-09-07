"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findModule, moduleDataDir, resolveInside } = require("./developer-module-contract");
const { moduleBackend, withMigrationLock } = require("./developer-module-migration-state");

function migrationOptionsFor(moduleId, threadId, options = {}) {
  const { manifest } = findModule(moduleId);
  return { moduleId, scope: manifest.scope, threadId: manifest.scope === "global" ? null : threadId, stateRoot: options.stateRoot };
}

function backendFor(moduleId, threadId, options = {}) {
  return moduleBackend(migrationOptionsFor(moduleId, threadId, options));
}

function readyBackendFor(moduleId, threadId, options = {}) {
  return backendFor(moduleId, threadId, options);
}

function withModuleMutation(moduleId, threadId, operation, options = {}) {
  const stateOptions = migrationOptionsFor(moduleId, threadId, options);
  return withMigrationLock(stateOptions, () => operation(moduleBackend(stateOptions)), options.lockOptions);
}

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
  return file ? { file, content: fs.readFileSync(file, encoding), legacy: file === legacy } : null;
}

module.exports = { migrationOptionsFor, backendFor, readyBackendFor, withModuleMutation, dataDirFor, dataPathFor, firstExisting, readFileWithFallback };
