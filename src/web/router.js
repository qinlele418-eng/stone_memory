const { handleDeveloperModules } = require("./routes/developer-modules");
const { handleScratch } = require("./routes/scratch");
const { handleReview } = require("./routes/review");
const { handleLibraries, handleLibraryDelete } = require("./routes/libraries");
const { handleDreams } = require("./routes/dreams");
const { handleNotebooks } = require("./routes/notebooks");
const { handleMining } = require("./routes/mining");
const { handleMemory, handleMemoryActions } = require("./routes/memory");
const { handleConversations } = require("./routes/conversations");
const { handleMaintenance } = require("./routes/maintenance");
const { handleRebuild } = require("./routes/rebuild");
const { handleImports } = require("./routes/imports");
const { NOT_HANDLED } = require("./route-result");
const { error } = require("./http-io");

// Preserve the original matching order, including method fallthrough.
const handlers = [
  handleDeveloperModules,
  handleScratch,
  handleReview,
  handleLibraries,
  handleDreams,
  handleNotebooks,
  handleLibraryDelete,
  handleMining,
  handleMemory,
  handleConversations,
  handleMaintenance,
  handleMemoryActions,
  handleRebuild,
  handleImports,
];

async function handleApi(req, res, url) {
  for (const handle of handlers) {
    const result = await handle(req, res, url);
    if (result !== NOT_HANDLED) return result;
  }
  return error(res, 404, "接口不存在");
}

module.exports = { handleApi };
