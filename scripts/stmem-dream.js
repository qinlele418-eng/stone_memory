"use strict";

const { DreamService } = require("../src/services/dream-service");

function runDreamCommand(args = process.argv.slice(2), {
  serviceFactory = () => new DreamService(),
  writeLine = line => console.log(line),
} = {}) {
  const threadId = optionValue(args, "--thread");
  const date = optionValue(args, "--date");
  if (!threadId) throw new Error("dream command requires --thread <id>");
  if (!date) throw new Error("dream command requires --date <YYYY-MM-DD>");

  const result = serviceFactory().generate({ threadId, date });
  writeLine(JSON.stringify({
    status: result.status,
    threadId,
    date,
    dreamType: result.dream?.dreamType || null,
  }));
  return result;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

module.exports = { runDreamCommand };
