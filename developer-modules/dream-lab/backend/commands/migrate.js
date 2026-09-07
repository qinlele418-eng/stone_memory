"use strict";

const { migrate, rollback } = require("../../migrations/migrate");

function run(context, input = {}) {
  return input.action === "rollback" ? rollback(context) : migrate(context, input);
}

module.exports = { run };
