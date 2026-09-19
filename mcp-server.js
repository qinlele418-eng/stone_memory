#!/usr/bin/env node
const { Registry } = require("./src/mcp/registry");
const core = require("./src/mcp/core");
const { startServer } = require("./src/mcp/server");
const { runPendingRebuilds } = require("./src/mcp/startup");
const restricted = process.env.STMEM_SEARCH_ONLY === "1" || process.env.STMEM_NOTEBOOK_STEWARD === "1";
if (!restricted && process.env.STMEM_SKIP_PENDING_REBUILDS !== "1") runPendingRebuilds();
const registry = new Registry();
registry.registerCore(core);
if (!restricted) require("./src/mcp/module-provider-loader").loadModuleProviders(registry);
startServer(registry);
