/**
 * 统一 subagent 调用入口 — 从 stmem.json 的 runtimes 配置拼命令，不硬编码任何 CLI。
 *
 * stmem.json 配置示例:
 *   "runtimes": {
 *     "claude": {
 *       "command": "claude -p --bare",
 *       "flags": {
 *         "systemPrompt": "--system-prompt-file",
 *         "mcpConfig": "--mcp-config",
 *         "model": "--model"
 *       }
 *     },
 *     "codex": { "command": "codex exec" }
 *   }
 *
 * 用法:
 *   const { runSubagent } = require("./subagent-runner");
 *   const result = await runSubagent(prompt, { threadId, opsFile, mcpConfig, model, timeout });
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { loadConfig, getCfg, getThreadDir } = require("../config");
const { commandInvocation, appendOption, resolveExecutableInvocation } = require("../lib/command-invocation");

const BUILTIN_RUNTIMES = {
  claude: {
    command: "claude -p --bare",
    flags: {
      systemPrompt: "--system-prompt-file",
      mcpConfig: "--mcp-config",
      model: "--model",
    },
  },
  codex: {
    command: "codex exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules --color never",
    flags: {
      model: "-m",
    },
    // Codex 没有 --system-prompt-file，ops 内容由 runSubagent 内联到 prompt
  },
};

function getRuntimeConfig(runtimeName) {
  const cfg = loadConfig();
  const runtimes = cfg.runtimes || {};
  return runtimes[runtimeName] || BUILTIN_RUNTIMES[runtimeName] || null;
}

/** 为指定线程解析占位符 → 实际路径 */
function resolvePlaceholders(threadId) {
  const dir = getThreadDir(threadId);
  const memDir = path.join(dir, "memory");
  const gender = getCfg("userGender", threadId, "unspecified");
  const subjectPronoun = gender === "female" ? "她" : gender === "male" ? "他" : "TA";
  const relationshipTimeline = getCfg("relationshipTimeline", threadId, []);
  return {
    "{aiName}":             getCfg("ai", threadId, "AI"),
    "{userName}":           getCfg("user", threadId, "用户"),
    "{subjectPronoun}":     subjectPronoun,
    "{relationshipTimeline}": Array.isArray(relationshipTimeline) && relationshipTimeline.length
      ? relationshipTimeline.map(row => `- ${String(row).trim()}`).join("\n")
      : "（未填写）",
    "{{retainConfig}}":    path.join(memDir, "retain-config.json"),
    "{{archiveDir}}":      path.join(memDir, "archive"),
    "{{memoryDir}}":       memDir,
    "{{threadDir}}":       dir,
  };
}

function buildCommand(runtimeName, prompt, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);

  const { opsFile, mcpConfig, model } = opts;
  const flags = rt.flags || {};

  let cmd = rt.command;

  if (opsFile && flags.systemPrompt && fs.existsSync(opsFile)) {
    cmd += ` ${flags.systemPrompt} "${opsFile}"`;
  }
  if (mcpConfig && flags.mcpConfig) {
    cmd += ` ${flags.mcpConfig} "${mcpConfig}"`;
  }
  if (model && flags.model) {
    cmd += ` ${flags.model} ${model}`;
  }

  cmd += ` ${JSON.stringify(String(prompt || ""))}`;
  return cmd;
}

function buildStdinCmd(runtimeName, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);
  const flags = rt.flags || {};
  let cmd = rt.command.replace(/\s*-p/, "");
  if (opts.opsFile && flags.systemPrompt && fs.existsSync(opts.opsFile)) {
    cmd += ` ${flags.systemPrompt} "${opts.opsFile}"`;
  }
  if (opts.mcpConfig && flags.mcpConfig) {
    cmd += ` ${flags.mcpConfig} "${opts.mcpConfig}"`;
  }
  if (opts.model && flags.model) {
    if (!/^[A-Za-z0-9._:/+-]{1,128}$/.test(String(opts.model))) {
      throw new Error("model name contains unsupported characters");
    }
    cmd += ` ${flags.model} ${opts.model}`;
  }
  if (opts.reasoning) {
    if (runtimeName !== "codex") throw new Error("reasoning effort is only supported by the Codex subagent");
    if (!["minimal", "low", "medium", "high", "xhigh"].includes(opts.reasoning)) {
      throw new Error("unsupported Codex reasoning effort");
    }
    cmd += ` -c model_reasoning_effort=${JSON.stringify(opts.reasoning)}`;
  }
  return cmd;
}

function buildStdinInvocation(runtimeName, opts = {}) {
  const rt = getRuntimeConfig(runtimeName);
  if (!rt) throw new Error(`Unknown runtime: ${runtimeName}. Add it to stmem.json → runtimes.`);
  const flags = rt.flags || {};
  const invocation = commandInvocation(rt.command, { remove: ["-p"] });
  if (opts.opsFile && flags.systemPrompt && fs.existsSync(opts.opsFile)) {
    appendOption(invocation.args, flags.systemPrompt, opts.opsFile);
  }
  if (opts.mcpConfig && flags.mcpConfig) {
    appendOption(invocation.args, flags.mcpConfig, opts.mcpConfig);
  } else if (opts.mcpConfig && runtimeName === "codex") {
    appendCodexMcpConfig(invocation.args, opts.mcpConfig);
  }
  if (runtimeName === "claude" && opts.strictMcpConfig) {
    invocation.args.push("--strict-mcp-config");
  }
  if (runtimeName === "claude" && opts.permissionMode) {
    appendOption(invocation.args, "--permission-mode", opts.permissionMode);
  }
  if (runtimeName === "claude" && Array.isArray(opts.allowedTools) && opts.allowedTools.length) {
    invocation.args.push(`--allowedTools=${opts.allowedTools.join(",")}`);
  }
  if (opts.model && flags.model) {
    if (!/^[A-Za-z0-9._:/+-]{1,128}$/.test(String(opts.model))) {
      throw new Error("model name contains unsupported characters");
    }
    appendOption(invocation.args, flags.model, opts.model);
  }
  if (opts.reasoning) {
    if (runtimeName !== "codex") throw new Error("reasoning effort is only supported by the Codex subagent");
    if (!["minimal", "low", "medium", "high", "xhigh"].includes(opts.reasoning)) {
      throw new Error("unsupported Codex reasoning effort");
    }
    appendOption(invocation.args, "-c", `model_reasoning_effort=${JSON.stringify(opts.reasoning)}`);
  }
  return invocation;
}

function resolveWorkingDirectory(cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return undefined;
  const resolved = path.resolve(String(cwd));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("subagent cwd must be an existing directory");
  }
  return resolved;
}

function appendCodexMcpConfig(args, configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const servers = config.mcpServers || config.mcp_servers || {};
  for (const [rawName, server] of Object.entries(servers)) {
    const name = String(rawName).replace(/[^A-Za-z0-9_-]/g, "_");
    if (!name || !server?.command) continue;
    appendOption(args, "-c", `mcp_servers.${name}.command=${JSON.stringify(String(server.command))}`);
    if (Array.isArray(server.args)) {
      appendOption(args, "-c", `mcp_servers.${name}.args=${JSON.stringify(server.args.map(String))}`);
    }
    if (server.cwd) appendOption(args, "-c", `mcp_servers.${name}.cwd=${JSON.stringify(String(server.cwd))}`);
    for (const [key, value] of Object.entries(server.env || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      appendOption(args, "-c", `mcp_servers.${name}.env.${key}=${JSON.stringify(String(value))}`);
    }
    appendOption(args, "-c", `mcp_servers.${name}.required=true`);
    appendOption(args, "-c", `mcp_servers.${name}.default_tools_approval_mode="auto"`);
  }
}

/**
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.threadId]
 * @param {string} [opts.opsFile]         — ops 文档路径，内部自动替换 {{placeholders}}
 * @param {string} [opts.mcpConfig]
 * @param {string} [opts.model]
 * @param {number} [opts.timeout=600000]
 */
function runSubagent(prompt, opts = {}) {
  const { threadId, mcpConfig, model, reasoning, timeout = 600_000 } = opts;
  let { opsFile } = opts;
  const runtimeName = opts.runtime || getCfg("runtime", threadId, "claude");
  if (!["claude", "codex"].includes(runtimeName)) throw new Error(`Unsupported subagent runtime: ${runtimeName}`);

  // 替换 ops 文件中的 {{placeholders}} → 线程实际路径
  if (opsFile && threadId && fs.existsSync(opsFile)) {
    const raw = fs.readFileSync(opsFile, "utf8");
    const subs = resolvePlaceholders(threadId);
    let content = raw;
    for (const [ph, real] of Object.entries(subs)) {
      content = content.split(ph).join(real);
    }
    const tmpDir = path.join(getThreadDir(threadId), "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, path.basename(opsFile));
    fs.writeFileSync(tmpFile, content, "utf8");
    opsFile = tmpFile;
  }

  const rt = getRuntimeConfig(runtimeName);
  const flags = rt?.flags || {};

  // 运行时没有 systemPrompt flag（如 Codex）→ ops 内容内联到 prompt
  let finalPrompt = prompt;
  if (opsFile && !flags.systemPrompt && fs.existsSync(opsFile)) {
    const opsContent = fs.readFileSync(opsFile, "utf8");
    finalPrompt = `${opsContent}\n\n---\n\n${prompt}`;
  }

  const baseInvocation = buildStdinInvocation(runtimeName, {
    ...opts, opsFile, mcpConfig, model, reasoning,
  });
  const childEnv = { ...process.env, ...(baseInvocation.env || {}) };
  const invocation = resolveExecutableInvocation(baseInvocation, { env: childEnv });
  const childCwd = resolveWorkingDirectory(opts.cwd);
  try {
    const out = execFileSync(invocation.file, invocation.args, {
      input: finalPrompt,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: childEnv,
      cwd: childCwd,
      windowsHide: true,
    });
    if (!out || !out.trim()) {
      const err = new Error("subagent returned empty output");
      err.code = "OUTPUT_EMPTY";
      throw err;
    }
    return out.trim();
  } catch (error) {
    const wrapped = new Error(extractSubagentFailure(error));
    wrapped.code = error?.code || "SUBAGENT_PROCESS_FAILED";
    throw wrapped;
  }
}

function extractSubagentFailure(error) {
  if (error?.code === "OUTPUT_EMPTY") {
    return "subagent returned empty output";
  }
  const stderr = String(error?.stderr || "");
  const stdout = String(error?.stdout || "");
  const diagnosticLines = `${stderr}\n${stdout}`
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /^(?:error|fatal|warning):/iu.test(line)
      || /(?:rate limit|context window|model unavailable|stream disconnected|unauthorized|forbidden|timed out|connection (?:failed|closed)|quota exceeded|request failed|HTTP [45]\d\d)/iu.test(line))
    .slice(-6);
  if (diagnosticLines.length) {
    return diagnosticLines.join(" ").slice(0, 800);
  }
  const exitCode = error?.status ?? error?.code;
  const suffix = exitCode !== undefined && exitCode !== null ? ` (exit ${exitCode})` : "";
  return `subagent process exited without a model response${suffix}`;
}

module.exports = {
  runSubagent,
  buildCommand,
  buildStdinCmd,
  buildStdinInvocation,
  appendCodexMcpConfig,
  getRuntimeConfig,
  resolvePlaceholders,
  resolveWorkingDirectory,
  extractSubagentFailure,
};
