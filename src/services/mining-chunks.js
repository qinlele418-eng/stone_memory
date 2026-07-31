const DEFAULT_MAX_MINING_CHUNK_BYTES = 50 * 1024;
const DEFAULT_DIALOGUE_GAP_MS = 5 * 60 * 1000;

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function messageTime(message) {
  const value = new Date(message?.timestamp || "").getTime();
  return Number.isFinite(value) ? value : null;
}

function renderedBytes(messages, render) {
  return byteLength(render(messages));
}

function hardSplitSession(messages, render, maxBytes) {
  const chunks = [];
  let current = [];
  for (const message of messages) {
    const candidate = [...current, message];
    if (current.length && renderedBytes(candidate, render) > maxBytes) {
      chunks.push(current);
      current = [message];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function splitMiningMessages(messages, {
  maxBytes = DEFAULT_MAX_MINING_CHUNK_BYTES,
  gapMs = DEFAULT_DIALOGUE_GAP_MS,
  render,
} = {}) {
  if (!Array.isArray(messages) || !messages.length) return [];
  if (typeof render !== "function") throw new Error("splitMiningMessages requires render(messages)");
  if (renderedBytes(messages, render) <= maxBytes) return [messages.slice()];

  // 先按真实对话空档形成 session，再尽量把相邻 session 装进同一个 50KB 块。
  const sessions = [];
  let session = [messages[0]];
  for (let index = 1; index < messages.length; index++) {
    const previous = messageTime(messages[index - 1]);
    const current = messageTime(messages[index]);
    if (previous !== null && current !== null && current - previous > gapMs) {
      sessions.push(session);
      session = [];
    }
    session.push(messages[index]);
  }
  if (session.length) sessions.push(session);

  const chunks = [];
  let pending = [];
  for (const group of sessions) {
    if (renderedBytes(group, render) > maxBytes) {
      // 硬切只封存已经装满的部分；最后一个未满块继续作为下一轮
      // pending，避免把 1～3KB 的中途尾巴提前变成独立模型请求。
      const split = hardSplitSession([...pending, ...group], render, maxBytes);
      chunks.push(...split.slice(0, -1));
      pending = split.at(-1) || [];
      continue;
    }
    const candidate = [...pending, ...group];
    if (pending.length && renderedBytes(candidate, render) > maxBytes) {
      chunks.push(pending);
      pending = group.slice();
    } else {
      pending = candidate;
    }
  }
  if (pending.length) chunks.push(pending);
  return chunks;
}

module.exports = {
  DEFAULT_MAX_MINING_CHUNK_BYTES,
  DEFAULT_DIALOGUE_GAP_MS,
  splitMiningMessages,
  byteLength,
};
