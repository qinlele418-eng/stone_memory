"use strict";

const { listMemoryIds } = require("../config");

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function resolveMemoryArg(args = [], { required = true, allowDefault = true, configuredMemoryIds = null } = {}) {
  const memoryId = valueAfter(args, "--memory");
  const legacyThreadId = valueAfter(args, "--thread");
  if (memoryId && legacyThreadId && memoryId !== legacyThreadId) {
    throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
  }
  const configured = allowDefault ? (configuredMemoryIds || listMemoryIds()) : [];
  if (!memoryId && !legacyThreadId && allowDefault && configured.length > 1) {
    throw new Error(`存在多个记忆体，请显式指定 --memory <id>：${configured.join("、")}`);
  }
  const resolved = memoryId || legacyThreadId || (configured.length === 1 ? configured[0] : null) || null;
  if (!resolved && required) throw new Error("未指定记忆体，请使用 --memory <id>（兼容 --thread <id>）");
  return resolved;
}

module.exports = { valueAfter, resolveMemoryArg };
