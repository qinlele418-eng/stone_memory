"use strict";

const path = require("node:path");
const { runAutomaticDream } = require("../automatic-dream-hook");
const { watcherActions } = require("../watcher-runtime");
const { backendFor } = require("../developer-module-data");

function governedDreamEnabled({ threadId, threadConfig = {} }) {
  const explicit = threadConfig.watcherModules?.["dev-dream"] === true;
  if (!explicit && !watcherActions(threadConfig).dream) return false;
  try { return backendFor("dream-lab", threadId, { stateRoot: threadConfig.migrationStateRoot }) === "module"; } catch { return false; }
}

module.exports = {
  id: "dream",
  enabled: context => watcherActions(context.threadConfig).dream && !governedDreamEnabled(context),
  run: ({ threadId, date, today, force, projectRoot }) => runAutomaticDream({
    threadId,
    date,
    today,
    force,
    cliPath: path.join(projectRoot, "bin", "stmem"),
  }),
};
