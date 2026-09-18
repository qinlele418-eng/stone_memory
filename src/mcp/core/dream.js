const { DreamReader, loadConfig, resolveThread } = require("./shared");

function resolveDreamRead(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveThread(args, cfg);
  return { reader: new DreamReader(), threadId: resolved.threadId };
}

function toolDreamLatest(args) {
  const { reader, threadId } = resolveDreamRead(args);
  const dream = reader.latest(threadId);
  return JSON.stringify(dream || {
    threadId,
    date: null,
    dreamType: null,
    title: "",
    body: "",
    found: false,
    message: "暂无梦境",
  });
}

function toolDreamStatus(args) {
  const { reader, threadId } = resolveDreamRead(args);
  return JSON.stringify(reader.coverage(threadId));
}

function toolDreamGet(args) {
  const { reader, threadId } = resolveDreamRead(args);
  const dream = reader.get(threadId, args.date);
  return JSON.stringify(dream || {
    threadId,
    date: args.date,
    dreamType: null,
    title: "",
    body: "",
    found: false,
    message: "指定日期没有梦境",
  });
}


module.exports = { resolveDreamRead, toolDreamLatest, toolDreamStatus, toolDreamGet };
