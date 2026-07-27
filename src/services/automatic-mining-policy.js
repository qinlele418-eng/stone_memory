"use strict";

function shouldAutoMineDate(date, {
  createdDate,
  automaticFullMining = false,
  automaticMemoryMaintenance = false,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(createdDate || ""))) return false;
  // Full mining is the bootstrap lane: conversations that already existed when
  // the memory body was registered. Ongoing dates belong only to maintenance.
  if (automaticFullMining && date <= createdDate) return true;
  if (automaticMemoryMaintenance && date >= createdDate) return true;
  return false;
}

module.exports = { shouldAutoMineDate };
