const test = require("node:test");
const assert = require("node:assert/strict");
const { isSyntheticUserText, normalizeThreadMessage } = require("../src/lib/thread-message");

test("normalizes Codex response_item messages and ignores developer messages", () => {
  const rows = [
    { timestamp: "2026-05-12T16:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "用户消息" }] } },
    { timestamp: "2026-05-12T16:02:00Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "系统指令" }] } },
    { timestamp: "2026-05-12T16:03:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "助手回复" }] } },
  ];
  const normalized = rows.map(normalizeThreadMessage).filter(Boolean);
  assert.deepEqual(normalized.map(row => [row.type, row.text]), [
    ["user", "用户消息"],
    ["assistant", "助手回复"],
  ]);
});

test("filters Codex synthetic user wrappers without dropping real user text", () => {
  const timestamp = "2026-07-24T16:00:00Z";
  const syntheticTexts = [
    "<recommended_plugins>\nplugin metadata",
    "<environment_context>\nworkspace metadata",
    "[2026-07-24 16:00]\n\nSYSTEM ACTION MODE: internal trigger, not user chat.\nTrigger:\nluna comes to mind again.",
    "[2026-07-24 16:00]\n\nSaved attachments:\n- [file] /tmp/a.pdf\nUse the saved local files if they are needed for the request.",
    "WECHAT SESSION INSTRUCTIONS\nsystem prompt",
    "Base directory for this skill: /tmp/skills/example\nskill instructions",
    "<local-command-caveat>generated locally</local-command-caveat>",
    "<local-command-stdout>command output</local-command-stdout>",
    "<command-name>/model</command-name>",
    "<task-notification><status>completed</status></task-notification>",
    "This session is being continued from a previous conversation that ran out of context. The summary below...",
    "Continue from where you left off.",
    "[Your previous response had no visible output. Please continue and produce a user-visible response.]",
    "[Request interrupted by user for tool use]",
  ];

  for (const text of syntheticTexts) {
    assert.equal(isSyntheticUserText(text), true);
    assert.equal(normalizeThreadMessage({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }), null);
  }

  const realText = "[2026-07-24 16:00]\n\n帮我审查一下这个规划";
  assert.equal(isSyntheticUserText(realText), false);
  assert.equal(normalizeThreadMessage({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: realText }],
    },
  }).text, realText);
});
