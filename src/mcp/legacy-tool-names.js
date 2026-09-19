// Host-owned compatibility exceptions for tools migrated out of Core.
// This is not a module allowlist. New modules use the generated namespace and
// never need an entry here. Providers cannot claim another module's old names.
const legacy = new Map([
  ["notebook-lab/status", "stmem_notebook_status"],
  ["notebook-lab/query", "stmem_notebook_query"],
  ["notebook-lab/read", "stmem_notebook_read"],
  ["notebook-lab/topic_manage", "stmem_notebook_topic_manage"],
  ["notebook-lab/write", "stmem_notebook_write"],
  ["notebook-lab/delegate", "stmem_notebook_delegate"],
  ["dream-lab/latest", "stmem_dream_latest"],
  ["dream-lab/status", "stmem_dream_status"],
  ["dream-lab/get", "stmem_dream_get"],
]);
function toolIdentity(moduleId, shortName) {
  const name = legacy.get(`${moduleId}/${shortName}`);
  return name
    ? { name, memoryArgument: "thread", legacy: true,
      readOnly: !["stmem_notebook_topic_manage", "stmem_notebook_write", "stmem_notebook_delegate"].includes(name),
      // Preserve the steward's 120s planning budget plus CLI validation/writes.
      timeoutMs: name === "stmem_notebook_delegate" ? 180000 : 30000 }
    : { name: `stmem_${moduleId.replaceAll("-", "_")}_${shortName}`, memoryArgument: "memoryId", legacy: false };
}
module.exports = { toolIdentity };
