"use strict";

/**
 * R2：pando import_only 无会话原件时的 rebuild_preview 降级预览。
 *
 * pando Binding 由宿主工作区持有会话（无 sessionDir/session 原件），无法做
 * full/ 会话重建式 dry-run。此预览基于已导入记忆体 DB 的当前内容与保留水位
 * 生成只读报告，文本明示口径；rebuild apply 对 pando 的拒绝语义不放松。
 */

const path = require("node:path");
const { getCfg, getThreadDir } = require("../config");
const {
  readFeelings,
  readMessageDates,
  readMessagesStamp,
} = require("../storage/memory-reader");

const DB_PREVIEW_MARKER = "pando import_only 无会话原件，此为 DB 口径预览";

function renderDbRebuildPreview(threadId, { windowDays = null } = {}, deps = {}) {
  const getThreadDirImpl = deps.getThreadDirImpl || getThreadDir;
  const readFeelingsImpl = deps.readFeelingsImpl || readFeelings;
  const readMessageDatesImpl = deps.readMessageDatesImpl || readMessageDates;
  const readMessagesStampImpl = deps.readMessagesStampImpl || readMessagesStamp;

  const memoryDir = path.join(getThreadDirImpl(threadId), "memory");
  const stamp = readMessagesStampImpl(memoryDir, { threadId });
  const dates = readMessageDatesImpl(memoryDir, { threadId });
  const injectableFeelings = readFeelingsImpl(memoryDir, { threadId, forInjection: true });
  const effectiveWindowDays = Number(windowDays ?? getCfg("windowDays", threadId, 1)) || 1;
  const latestFeelingDate = injectableFeelings
    .map(feeling => feeling.sourceDate)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  const lines = [];
  lines.push("[rebuild] DB 口径降级预览（dry-run，未写入任何文件）");
  lines.push(`  口径声明:          ${DB_PREVIEW_MARKER}`);
  lines.push("                     会话重建（full/ 原件 + UUID 链）口径不可用；rebuild --apply 对 pando 仍被拒绝。");
  lines.push(`  Memory:            ${threadId}`);
  lines.push(`  Messages (DB):     ${stamp?.count ?? 0} 条 / ${dates.length} 天`);
  if (dates.length) lines.push(`  Date range:        ${dates[0]} → ${dates[dates.length - 1]}`);
  lines.push(`  Feelings (DB):     ${injectableFeelings.length} 条可注入（hidden 除外）`);
  lines.push(`  Retain watermark:  ${latestFeelingDate ? `最近 feeling @ ${latestFeelingDate}` : "无（feelings 为空）"}`);
  lines.push(`  Window:            ${effectiveWindowDays} 天（active-days 口径参考）`);
  return lines.join("\n");
}

module.exports = { DB_PREVIEW_MARKER, renderDbRebuildPreview };
