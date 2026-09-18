const { executeNotebookModuleCommand } = require("../../../../src/services/notebook-module-command");
module.exports = {
  run(context, input) {
    return executeNotebookModuleCommand(input.action, context.threadId, input.payload);
  },
};
