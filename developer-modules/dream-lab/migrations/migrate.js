"use strict";
const { migrate } = require("../../../src/services/developer-module-migrations");
function run(context, input = {}) { return migrate(context, input); }
module.exports = { run };
