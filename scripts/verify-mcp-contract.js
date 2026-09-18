// Run protocol/provider checks on all CI platforms without touching runner HOME.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-ci-"));
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_SKIP_PENDING_REBUILDS: "1" };
  delete env.STMEM_DB_PATH;
  const result = spawnSync(process.execPath, ["--test", "test/mcp-core-contract.test.js", "test/mcp-protocol.test.js", "test/module-mcp-provider.test.js", "test/module-mcp-readers.test.js", "test/module-mcp-web.test.js", "test/module-mcp-canary.test.js", "test/deep-search-mcp.test.js", "test/notebook-mcp.test.js", "test/notebook-steward.test.js", "test/dream-mcp.test.js", "test/mcp-rebuild-preview.test.js", "test/mcp-mine-command.test.js"], {
    cwd: path.resolve(__dirname, ".."), env, stdio: "inherit", windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(home, { recursive: true, force: true }); }
