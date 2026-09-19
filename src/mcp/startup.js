const { fs, path, execFileSync, PROJECT_ROOT, log } = require("./core/shared");
function runPendingRebuilds() {
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) return;
  try {
    const output = execFileSync(process.execPath, [cli, "rebuild", "--run-pending", "--mcp-startup"], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    if (!/no pending rebuilds/.test(output)) log(`pending rebuild completed: ${output.trim().slice(-500)}`);
  } catch (error) {
    log(`pending rebuild failed and retained for retry: ${String(error.stderr || error.message).trim()}`);
  }
}


module.exports = { runPendingRebuilds };
