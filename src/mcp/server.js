const { startTransport } = require("./protocol");
function createHandler(registry) {
  return (message, respond) => {
    const { id, method, params } = message;
    if (method === "initialize") {
      respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stmem-mcp", version: "2.0.0" } });
    } else if (method === "tools/list") {
      respond(id, { tools: registry.list() });
    } else if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      respond(id, registry.call(name, args));
    } else if (id !== undefined && id !== null) respond(id, {});
  };
}
function startServer(registry, transport) { return startTransport(createHandler(registry), transport); }
module.exports = { createHandler, startServer };
