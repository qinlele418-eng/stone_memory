"use strict";

const path = require("node:path");
const { runAutomaticDream } = require("../automatic-dream-hook");
const { watcherActions } = require("../watcher-runtime");

module.exports = {
  id: "dream",
  enabled: ({ threadConfig }) => watcherActions(threadConfig).dream,
  run: ({ threadId, date, today, force, projectRoot }) => runAutomaticDream({
    threadId,
    date,
    today,
    force,
    cliPath: path.join(projectRoot, "bin", "stmem"),
  }),
};
