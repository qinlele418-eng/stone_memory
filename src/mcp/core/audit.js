const { fs, path, execFileSync, getThreadDir, readDatabaseFeelings, PROJECT_ROOT, feelingDate, loadConfig, resolveThread } = require("./shared");

function auditResolvePaths(args) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const tid = resolved?.threadId || args.thread;
  if (!tid) throw new Error("无法确定线程 ID");
  const dir = getThreadDir(tid);
  return {
    threadId: tid,
    memoryDir: path.join(dir, "memory"),
    auditMarksFile: path.join(dir, "memory", "audit-marks.json"),
    retainConfigFile: path.join(dir, "memory", "retain-config.json"),
  };
}

function auditReadFeelings(p) {
  return readDatabaseFeelings(p.memoryDir, { threadId: p.threadId });
}

function auditLoadMarks(p) {
  try { return JSON.parse(fs.readFileSync(p.auditMarksFile, "utf8")); }
  catch { return { lastCutoffDate: new Date().getFullYear() + "-01-01", retainMarks: {} }; }
}

function auditSaveMarks(p, data) {
  const temp = `${p.auditMarksFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, p.auditMarksFile);
}

function toolAuditList(args) {
  try {
    const p = auditResolvePaths(args);
    const marks = auditLoadMarks(p);
    marks.retainMarks = marks.retainMarks || {};
    const lastCutoff = marks.lastCutoffDate || `${new Date().getFullYear()}-01-01`;
    const entries = auditReadFeelings(p);
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const byDate = {};
    for (const e of entries) {
      const m = (e.content || "").match(/^(\d+)月(\d+)日/);
      const dateKey = e.sourceDate || (m ? feelingDate(m[1], m[2], e) : "unknown");
      if (dateKey <= lastCutoff) continue;
      if (!byDate[dateKey]) byDate[dateKey] = [];
      let tag = "";
      const isR = retainIds.has(e.id), isE = eventIds.has(e.id);
      if (isR && isE) tag = "[原文+事件]";
      else if (isR) tag = "[原文]";
      else if (isE) tag = "[事件]";
      byDate[dateKey].push({ seq: e.seq, id: e.id, content: e.content, tag });
    }
    const unreviewed = Object.keys(byDate).sort();
    if (unreviewed.length === 0) return `截止 ${lastCutoff}，全部已审。`;

    const preamble = [
      "睡前记忆巡检。以下是上次审计之后的新摘要。",
      "",
      "每条看一遍。两种锚点：",
      "  type: retain → 原文锚点，这句对话不能丢，rebuild 时保留原文",
      "  type: event → 事件锚点，标记长期关键事件，供生命周期保护和巡检使用",
      "  已标记的条目显示 [原文]、[事件] 或 [原文+事件]",
      "",
      "不用每条都标。只标真正重要的。",
      "",
      `截止: ${lastCutoff}，${unreviewed.length} 条未审`,
      "",
    ].join("\n");
    const lines = [preamble, "| # | 日期 | 类型 | 摘要 |", "|---|------|------|------|"];
    for (const d of unreviewed) {
      for (const f of byDate[d]) {
        lines.push(`| ${f.seq || "?"} | ${d} | ${f.tag || ""} | ${f.content.slice(0, 70)}... |`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    throw new Error(`audit_list 失败: ${err.message}`);
  }
}

function toolAuditMark(args) {
  try {
    const p = auditResolvePaths(args);
    const marks = auditLoadMarks(p);
    marks.retainMarks = marks.retainMarks || {};
    const cutoffDate = (args.cutoffDate || "").trim();
    const numbers = Array.isArray(args.numbers) ? args.numbers.filter(n => Number.isInteger(n)) : [];
    const anchorType = args.type === "event" ? "event" : "retain";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) throw new Error("cutoffDate 必须是 YYYY-MM-DD");
    if (cutoffDate && cutoffDate > (marks.lastCutoffDate || "")) marks.lastCutoffDate = cutoffDate;

    const entries = auditReadFeelings(p);
    const seqToId = {};
    for (const e of entries) { if (typeof e.seq === "number") seqToId[e.seq] = e.id; }
    const feelingIds = numbers.map(n => seqToId[n]).filter(Boolean);
    if (feelingIds.length !== numbers.length) {
      const missing = numbers.filter(number => !seqToId[number]);
      throw new Error(`找不到摘要序号：${missing.join(", ")}`);
    }

    if (feelingIds.length > 0) {
      const cli = path.join(PROJECT_ROOT, "bin", "stmem");
      const tmpDir = path.join(p.memoryDir, "..", "tmp");
      const batchFile = path.join(tmpDir, `mcp-audit-anchor-${process.pid}-${Date.now()}.json`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        fs.writeFileSync(batchFile, JSON.stringify({
          items: feelingIds.map(id => ({ id, type: anchorType, enabled: true })),
        }), { encoding: "utf8", mode: 0o600 });
        execFileSync(process.execPath, [
          cli, "memory", "anchor", "--thread", p.threadId, "--batch-file", batchFile,
        ], { encoding: "utf8", timeout: 30_000, cwd: PROJECT_ROOT, windowsHide: true });
      } finally {
        try { fs.unlinkSync(batchFile); } catch {}
      }
    }
    for (const id of feelingIds) marks.retainMarks[id] = true;
    auditSaveMarks(p, marks);
    const label = anchorType === "event" ? "事件锚点" : "原文锚点";
    return `截止 ${cutoffDate}，标记${label} #${numbers.join(", #")}`;
  } catch (err) {
    throw new Error(`audit_mark 失败: ${err.message}`);
  }
}

function toolAuditQuery(args) {
  try {
    const p = auditResolvePaths(args);
    const date = (args.date || "").trim();
    const keyword = (args.keyword || "").trim().toLowerCase();
    if (!date && !keyword) return "请提供 date 或 keyword。";
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const all = auditReadFeelings(p);
    let results = all;
    if (date) {
      results = results.filter(f => {
        const m = (f.content || "").match(/^(\d+)月(\d+)日/);
        return f.sourceDate === date || (m && feelingDate(m[1], m[2], f) === date);
      });
    }
    if (keyword) results = results.filter(f => (f.content || "").toLowerCase().includes(keyword));
    if (results.length === 0) return "未找到匹配的记忆。";
    const lines = [`找到 ${results.length} 条：`, ""];
    results.forEach(f => {
      let tag = "";
      const isR = retainIds.has(f.id), isE = eventIds.has(f.id);
      if (isR && isE) tag = " [原文+事件锚点]";
      else if (isR) tag = " [原文锚点]";
      else if (isE) tag = " [事件锚点]";
      lines.push(`### #${f.seq || "?"}${tag}`);
      lines.push(f.content);
      lines.push("");
    });
    return lines.join("\n");
  } catch (err) {
    throw new Error(`audit_query 失败: ${err.message}`);
  }
}


module.exports = { auditResolvePaths, auditReadFeelings, auditLoadMarks, auditSaveMarks, toolAuditList, toolAuditMark, toolAuditQuery };
