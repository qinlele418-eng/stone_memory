const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendCodexMcpConfig,
  appendCodexProviderConfig,
  buildStdinInvocation,
  codexProviderFromConfig,
  extractSubagentFailure,
  normalizeClaudeInvocation,
  resolveWorkingDirectory,
} = require("../src/services/subagent-runner");

test("Claude subagents keep print mode and restore OAuth compatibility for legacy bare config", () => {
  const invocation = normalizeClaudeInvocation({
    file: "claude",
    args: ["-p", "--bare"],
    env: {},
  }, {});
  assert.deepEqual(invocation.args, ["-p"]);
});

test("Claude subagents retain bare mode when an explicit API credential is present", () => {
  const invocation = normalizeClaudeInvocation({
    file: "claude",
    args: ["-p", "--bare"],
    env: {},
  }, { ANTHROPIC_API_KEY: "test-key" });
  assert.deepEqual(invocation.args, ["-p", "--bare"]);
});

test("Claude runtime commands can carry an explicit API credential inline", () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const invocation = buildStdinInvocation("claude", {
      env: { ANTHROPIC_API_KEY: "test-key" },
    });
    assert.ok(invocation.args.includes("-p"));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("Claude subagents add explicit print mode instead of relying on redirected stdin", () => {
  const invocation = normalizeClaudeInvocation({ file: "claude", args: [], env: {} }, {});
  assert.deepEqual(invocation.args, ["-p"]);
});

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
      other_server: {
        command: "/usr/bin/other-mcp-server",
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
  const approvedToolConfigs = args.filter(arg => /\.tools\.[^.]+\.approval_mode="approve"$/.test(arg));
  assert.deepEqual(approvedToolConfigs, [
    'mcp_servers.stone_memory_search.tools.memory_keyword_search.approval_mode="approve"',
    'mcp_servers.stone_memory_search.tools.memory_archive_context.approval_mode="approve"',
  ]);
  assert.doesNotMatch(joined, /mcp_servers\.other_server\.tools\..*\.approval_mode="approve"/);
});

test("Codex reuses an existing OpenAI API provider without exposing its key in argv", () => {
  const provider = codexProviderFromConfig({
    thread: { apiProvider: "openai" },
    apiKeys: { openai: { key: "secret-key", baseUrl: "https://api.openai.com", model: "gpt-test" } },
  }, "thread");
  assert.deepEqual(provider, {
    provider: "openai",
    key: "secret-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    wireApi: "responses",
  });
  const args = [];
  appendCodexProviderConfig(args, provider);
  const joined = args.join(" ");
  assert.match(joined, /model_provider/);
  assert.match(joined, /STMEM_CODEX_API_KEY/);
  assert.doesNotMatch(joined, /secret-key/);
});

test("Codex refuses to misroute Chat-Completions-only providers through Responses", () => {
  assert.equal(codexProviderFromConfig({
    thread: { apiProvider: "deepseek" },
    apiKeys: { deepseek: { key: "secret", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } },
  }, "thread"), null);
  assert.ok(codexProviderFromConfig({
    thread: { apiProvider: "proxy" },
    apiKeys: { proxy: { key: "secret", baseUrl: "https://proxy.example/v1", model: "gpt-test", wireApi: "responses" } },
  }, "thread"));
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
