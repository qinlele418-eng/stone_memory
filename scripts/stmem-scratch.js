"use strict";

const fs = require("node:fs");
const { ScratchRewardService } = require("../src/services/scratch-reward-service");

function runScratchCommand(args = process.argv.slice(2), {
  serviceFactory = () => new ScratchRewardService(),
  writeLine = line => console.log(line),
} = {}) {
  const action = String(args[0] || "inspect");
  const threadId = optionValue(args, "--thread");
  if (!threadId) throw new Error("scratch command requires --thread <id>");
  const service = serviceFactory();

  if (action === "inspect") {
    const result = service.inspect(threadId);
    writeLine(JSON.stringify(result));
    return result;
  }

  if (action === "settings") {
    const input = readBatch(args);
    service.updateSettings(threadId, input);
    const result = service.inspect(threadId);
    writeLine(JSON.stringify(result));
    return result;
  }

  if (action === "generate") {
    const input = readBatch(args);
    return service.generate({
      threadId,
      colors: input.colors,
      exclusions: input.exclusions,
    }).then(result => {
      writeLine(JSON.stringify(result));
      return result;
    });
  }

  throw new Error(`unknown scratch action: ${action}`);
}

function readBatch(args) {
  const file = optionValue(args, "--batch-file");
  if (!file) throw new Error("scratch action requires --batch-file <json>");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

module.exports = { runScratchCommand };
