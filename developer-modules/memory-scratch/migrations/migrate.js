"use strict";
const { migrationPlan, legacySources, applyLegacyMigration } = require("../../../src/services/developer-module-runtime");
function run(context, input = {}) { const plan = migrationPlan(context, legacySources(context)); return input.apply === true ? applyLegacyMigration(context) : { ...plan, applied: false }; }
module.exports = { run };
