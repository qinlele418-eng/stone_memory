function isSyntheticUserText(text) {
  const trimmed = String(text || "").trim();
  const withoutChatTimestamp = trimmed.replace(
    /^\[[^\]\r\n]+\]\s*(?:\r?\n)+/,
    "",
  );

  return (
    withoutChatTimestamp.startsWith("<recommended_plugins>") ||
    withoutChatTimestamp.startsWith("<environment_context>") ||
    withoutChatTimestamp.startsWith("SYSTEM ACTION MODE: internal trigger, not user chat.") ||
    withoutChatTimestamp.startsWith("WECHAT SESSION INSTRUCTIONS") ||
    withoutChatTimestamp.startsWith("Base directory for this skill:") ||
    withoutChatTimestamp.startsWith("<local-command-caveat>") ||
    withoutChatTimestamp.startsWith("<local-command-stdout>") ||
    withoutChatTimestamp.startsWith("<command-name>") ||
    withoutChatTimestamp.startsWith("<task-notification>") ||
    withoutChatTimestamp.startsWith("This session is being continued from a previous conversation that ran out of context.") ||
    withoutChatTimestamp === "Continue from where you left off." ||
    withoutChatTimestamp === "[Your previous response had no visible output. Please continue and produce a user-visible response.]" ||
    withoutChatTimestamp.startsWith("[Request interrupted by user") ||
    (
      withoutChatTimestamp.startsWith("Saved attachments:") &&
      withoutChatTimestamp.includes("Use the saved local files if they are needed for the request.")
    )
  );
}

function normalizeThreadMessage(msg) {
  if (!msg || !msg.timestamp || msg.type === "system") return null;

  let role = msg.type;
  let content = msg.message?.content;
  if (msg.type === "response_item" && msg.payload?.type === "message") {
    if (msg.payload.role === "developer") return null;
    role = msg.payload.role === "user" ? "user" : "assistant";
    content = msg.payload.content;
  }

  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter(block => block.type === "text" || block.type === "input_text" || block.type === "output_text")
      .map(block => block.text || "").join(" ").trim();
  }
  if (!text && msg.text) text = typeof msg.text === "string" ? msg.text : JSON.stringify(msg.text);
  if (!text) return null;
  if (role === "user" && isSyntheticUserText(text)) return null;
  return { timestamp: msg.timestamp, type: role || "user", text };
}

module.exports = { isSyntheticUserText, normalizeThreadMessage };
