"use strict";

const path = require("node:path");
const { runAutomaticDream } = require("../automatic-dream-hook");

module.exports = {
  id: "dream",
  enabled: ({ threadConfig }) => threadConfig?.automaticDream === true,
  run: ({ threadId, date, today, force, projectRoot }) => runAutomaticDream({
    threadId,
    date,
    today,
    force,
    cliPath: path.join(projectRoot, "bin", "stmem"),
  }),
};
