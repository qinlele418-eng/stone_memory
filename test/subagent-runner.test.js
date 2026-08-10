const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendCodexMcpConfig,
  buildStdinInvocation,
  extractSubagentFailure,
  resolveWorkingDirectory,
} = require("../src/services/subagent-runner");

test("subagent failures keep the final machine diagnostic and omit echoed prompts", () => {
  const error = {
    status: 1,
    stderr: [
      "OpenAI Codex v0.144.0",
      "user",
      "private conversation text that mentions a model",
      "ERROR: context window exceeded for this request",
    ].join("\n"),
  };

  assert.equal(
    extractSubagentFailure(error),
    "ERROR: context window exceeded for this request",
  );
});

test("subagent failures without a diagnostic expose only the exit status", () => {
  const error = {
    status: 7,
    stderr: "OpenAI Codex v0.144.0\nuser\nprivate conversation text",
  };

  assert.equal(
    extractSubagentFailure(error),
    "subagent process exited without a model response (exit 7)",
  );
});

test("subagents accept only an existing explicit working directory", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-subagent-cwd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveWorkingDirectory(dir), dir);
  assert.throws(() => resolveWorkingDirectory(path.join(dir, "missing")), /existing directory/);
});

test("Codex receives a temporary MCP config without changing user config", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      stone_memory_search: {
        command: "/usr/bin/node",
        args: ["/tmp/mcp-server.js"],
        cwd: "/tmp",
        env: { STMEM_SEARCH_ONLY: "1", STMEM_THREAD_ID: "thread-test" },
      },
    },
  }));
  const args = [];
  appendCodexMcpConfig(args, configPath);
  const joined = args.join(" ");
  assert.match(joined, /mcp_servers\.stone_memory_search\.command/);
  assert.match(joined, /STMEM_SEARCH_ONLY/);
  assert.match(joined, /STMEM_THREAD_ID/);
  assert.match(joined, /default_tools_approval_mode/);
});

test("Claude deep search receives only its explicitly allowed MCP tools", () => {
  const invocation = buildStdinInvocation("claude", {
    mcpConfig: "/tmp/deep-search-mcp.json",
    strictMcpConfig: true,
    permissionMode: "auto",
    allowedTools: [
      "mcp__stone_memory_search__memory_keyword_search",
      "mcp__stone_memory_search__memory_archive_context",
    ],
  });
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  const permissionIndex = invocation.args.indexOf("--permission-mode");
  assert.deepEqual(invocation.args.slice(permissionIndex, permissionIndex + 2), [
    "--permission-mode",
    "auto",
  ]);
  assert.ok(invocation.args.includes(
    "--allowedTools=mcp__stone_memory_search__memory_keyword_search,mcp__stone_memory_search__memory_archive_context",
  ));
});
