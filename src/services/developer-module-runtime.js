"use strict";

const fs = require("node:fs");
const { findModule, resolveInside, createModuleContext } = require("./developer-module-contract");

function loadCommand(module, action) {
  const command = module.manifest.entry?.commands?.[action];
  if (!command) throw new Error(`developer module ${module.id} does not expose action ${action}`);
  const file = resolveInside(module.moduleDir, command, `command ${action}`);
  if (!fs.existsSync(file)) throw new Error(`developer module command is missing: ${module.id}/${action}`);
  const implementation = require(file);
  if (typeof implementation.run !== "function") throw new Error(`developer module command must export run(context, input): ${module.id}/${action}`);
  return implementation;
}

async function runModuleAction({ moduleId, action, threadId, input = {}, dataRoot } = {}) {
  const module = findModule(moduleId);
  const context = createModuleContext(module.manifest, { threadId, dataRoot });
  const implementation = loadCommand(module, action);
  return implementation.run(context, input);
}

module.exports = { loadCommand, runModuleAction };
