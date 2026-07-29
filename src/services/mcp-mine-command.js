function buildMcpMineArgs(cli, threadId, args = {}) {
  const result = [cli, "mine"];
  if (args.date) result.push("--date", String(args.date));
  if (threadId) result.push("--thread", String(threadId));
  if (args.force === true) result.push("--force");
  return result;
}

module.exports = { buildMcpMineArgs };
