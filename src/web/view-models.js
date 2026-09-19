const { isArchiveConversation } = require("../services/thread-ingest");

function previewRows(source, page = 1) {
  // 用户在这里确认的是最终进入 archive 的纯对话，而不是线程文件的内部事件。
  // session_meta、工具状态、推理元数据等没有 message 的原始记录由现有清洗链过滤，
  // 不应伪装成“无法识别”的坏数据污染预览。
  const validRows = source.records.filter(record => !record.excludedReason && isArchiveConversation(record.message)).map((record, index) => ({
    index,
    timestamp: record.message.timestamp,
    role: record.message.type,
    context: record.message.text,
    valid: true,
  }));
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(validRows.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { page: current, pageSize, totalPages, rows: validRows.slice((current - 1) * pageSize, current * pageSize) };
}

function paginate(items, page = 1, pageSize = 20) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  return { page: current, pageSize, totalPages, total: items.length, rows: items.slice((current - 1) * pageSize, current * pageSize) };
}

function buildConversationCalendar(counts, page = 1) {
  const byDate = new Map(counts.map(row => [row.date, Number(row.count) || 0]));
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return { page: 1, totalPages: 1, month: null, leadingBlanks: 0, days: [] };
  const firstMonth = dates[0].slice(0, 7), lastMonth = dates.at(-1).slice(0, 7);
  const [firstYear, firstIndex] = firstMonth.split("-").map(Number);
  const [lastYear, lastIndex] = lastMonth.split("-").map(Number);
  const totalPages = (lastYear - firstYear) * 12 + lastIndex - firstIndex + 1;
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const monthDate = new Date(Date.UTC(lastYear, lastIndex - current, 1));
  const year = monthDate.getUTCFullYear(), monthIndex = monthDate.getUTCMonth();
  const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const dayCount = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    return { date, count: byDate.get(date) || 0 };
  });
  return { page: current, totalPages, month, leadingBlanks: new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(), days };
}

module.exports = { previewRows, paginate, buildConversationCalendar };
