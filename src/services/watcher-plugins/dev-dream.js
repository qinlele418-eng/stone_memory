"use strict";

const path = require("node:path");
const { runAutomaticDream } = require("../automatic-dream-hook");
const { backendFor } = require("../developer-module-data");
const { watcherActions } = require("../watcher-runtime");

function enabled({ threadId, threadConfig = {} }) {
  const explicit = threadConfig.watcherModules?.["dev-dream"] === true;
  if (!explicit && !watcherActions(threadConfig).dream) return false;
  try { return backendFor("dream-lab", threadId, { stateRoot: threadConfig.migrationStateRoot }) === "module"; } catch { return false; }
}

module.exports = {
  id: "dev-dream",
  enabled,
  run: ({ threadId, date, today, force, projectRoot }) => runAutomaticDream({
    threadId, date, today, force, cliPath: path.join(projectRoot, "bin", "stmem"),
  }),
};
