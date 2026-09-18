// Host-owned compatibility exceptions for tools migrated out of Core.
// This is not a module allowlist. New modules use the generated namespace and
// never need an entry here. Providers cannot claim another module's old names.
const legacy = new Map([
  ["notebook-lab/status", "stmem_notebook_status"],
  ["notebook-lab/query", "stmem_notebook_query"],
  ["notebook-lab/read", "stmem_notebook_read"],
]);
function toolIdentity(moduleId, shortName) {
  const name = legacy.get(`${moduleId}/${shortName}`);
  return name
    ? { name, memoryArgument: "thread", legacy: true }
    : { name: `stmem_${moduleId.replaceAll("-", "_")}_${shortName}`, memoryArgument: "memoryId", legacy: false };
}
module.exports = { toolIdentity };
