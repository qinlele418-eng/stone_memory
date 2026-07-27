function isInjectedMemoryBlock(text) {
  // 旧版 archive 曾把长文本截到 2000 字，导致部分注入块缺失闭合标签。
  // <memory_context> 是 rebuild 专用块头；只判断消息开头，避免漏掉这些历史残片。
  return /^\s*<memory_context>(?:\s*\n|$)/i.test(String(text || ""));
}

module.exports = { isInjectedMemoryBlock };
