"use strict";

function resolveAutomaticActions(threadConfig = {}) {
  const modules = threadConfig.watcherModules || {};
  return {
    sync: Object.hasOwn(modules, "archive") ? modules.archive === true : threadConfig.automaticFullMining !== false,
    mine: Object.hasOwn(modules, "miner") ? modules.miner === true : threadConfig.automaticMemoryMaintenance !== false,
    compact: Object.hasOwn(modules, "compression") ? modules.compression === true : threadConfig.automaticCompression === true,
  };
}

function shouldAutoMineDate(date, {
  today,
  automaticMemoryMaintenance = false,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))) return false;
  return automaticMemoryMaintenance === true && date < today;
}

module.exports = { resolveAutomaticActions, shouldAutoMineDate };
