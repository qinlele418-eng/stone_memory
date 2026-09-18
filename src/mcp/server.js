const { startTransport } = require("./protocol");
function createHandler(registry) {
  const calls = new Map();
  return async (message, respond) => {
    const { id, method, params } = message;
    if (method === "initialize") {
      respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stmem-mcp", version: "2.0.0" } });
    } else if (method === "tools/list") {
      respond(id, { tools: registry.list() });
    } else if (method === "tools/call") {
      const controller = new AbortController();
      calls.set(id, controller);
      try { respond(id, await registry.call(params?.name, params?.arguments ?? {}, { signal: controller.signal })); }
      finally { calls.delete(id); }
    } else if (method === "notifications/cancelled") {
      calls.get(params?.requestId)?.abort();
    } else if (id !== undefined && id !== null) respond(id, {});
  };
}
function startServer(registry, transport) { return startTransport(createHandler(registry), transport); }
module.exports = { createHandler, startServer };
