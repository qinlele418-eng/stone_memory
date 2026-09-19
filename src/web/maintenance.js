const { compactTermTimelineReport } = require("../services/term-timeline-report");

function timelineCommandArgs(threadId, terms, { from = "", to = "" } = {}) {
  const cleaned = [...new Set((terms || []).map(term => String(term).trim()).filter(Boolean))];
  if (cleaned.length < 1 || cleaned.length > 3) throw new Error("时间轴每次请选择 1～3 个关键词");
  if (cleaned.some(term => term.length > 64)) throw new Error("时间轴关键词过长");
  const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to)) throw new Error("时间范围格式无效");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
  const args = ["term-timeline", "--thread", threadId, "--terms", cleaned.join(","), "--json", "--compact-json"];
  if (from) args.push("--from", from);
  if (to) args.push("--to", to);
  return args;
}

function compressionCommandArgs(threadId, { kind = "compact", apply = false, mode = "subagent", from = "", to = "", afterDays = 90 } = {}) {
  if (!["compact", "hidden"].includes(kind)) throw new Error("未知压缩类型");
  const args = [kind, "--thread", threadId, "--json"];
  if (kind === "compact") {
    if ((from && !to) || (!from && to)) throw new Error("精确压缩窗口需要同时提供开始和结束日期");
    if (from) args.push("--from", from, "--to", to);
    if (apply) args.push(mode === "api" ? "--api" : "--subagent", "--apply");
  } else {
    const days = Math.max(1, Math.min(3650, Number(afterDays) || 90));
    args.push("--after-days", String(days));
    if (apply) args.push("--apply");
  }
  return args;
}

function compactTimelineReport(data) {
  return compactTermTimelineReport(data);
}

module.exports = { timelineCommandArgs, compressionCommandArgs, compactTimelineReport };
