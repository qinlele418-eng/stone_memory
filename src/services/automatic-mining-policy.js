"use strict";

function resolveAutomaticActions(threadConfig = {}) {
  return {
    sync: threadConfig.automaticFullMining !== false,
    mine: threadConfig.automaticMemoryMaintenance !== false,
    compact: threadConfig.automaticCompression === true,
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
