const { fs, path, execFileSync, buildMcpMineArgs, PROJECT_ROOT, loadConfig, resolveThread } = require("./shared");

function toolMine(args) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const tid = resolved?.threadId || args.thread;
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) throw new Error("找不到 stmem CLI");
  const mineArgs = buildMcpMineArgs(cli, tid, args);
  try {
    const out = execFileSync(process.execPath, mineArgs, {
      encoding: "utf8", timeout: 600_000, cwd: PROJECT_ROOT, windowsHide: true,
    });
    return out.trim().slice(-1000) || "挖掘完成";
  } catch (err) {
    throw new Error(`挖掘失败: ${String(err.stderr || err.message).trim()}`);
  }
}


module.exports = { toolMine };
