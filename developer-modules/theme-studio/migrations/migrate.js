"use strict";
const { migrationPlan, writeMigrationReceipt } = require("../../../src/services/developer-module-runtime");
function run(context, input = {}) { const plan = migrationPlan(context); return input.apply === true ? { ...plan, receipt: writeMigrationReceipt(context, plan), applied: true } : { ...plan, applied: false }; }
module.exports = { run };
