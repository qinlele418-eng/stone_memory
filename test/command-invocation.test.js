const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCommandLine,
  commandInvocation,
  appendOption,
  resolveExecutableInvocation,
} = require("../src/lib/command-invocation");
const { resolveMcpThread } = require("../src/services/mcp-thread-resolution");

test("runtime commands become executable and argument arrays without shell expansion", () => {
  assert.deepEqual(parseCommandLine('codex exec --profile "memory worker"'), [
    "codex", "exec", "--profile", "memory worker",
  ]);
  assert.deepEqual(parseCommandLine('"C:\\Program Files\\Codex\\codex.exe" exec'), [
    "C:\\Program Files\\Codex\\codex.exe", "exec",
  ]);
  const invocation = commandInvocation("claude -p --bare", { remove: ["-p"] });
  appendOption(invocation.args, "--model", "model; touch /tmp/unsafe");
  assert.deepEqual(invocation, {
    file: "claude",
    args: ["--bare", "--model", "model; touch /tmp/unsafe"],
    env: {},
  });
});

test("leading environment assignments are passed separately from the executable", () => {
  assert.deepEqual(commandInvocation("STMEM_MINER=1 claude -p --bare", { remove: ["-p"] }), {
    file: "claude",
    args: ["--bare"],
    env: { STMEM_MINER: "1" },
  });
  assert.deepEqual(commandInvocation("A=1 B=2 codex exec"), {
    file: "codex",
    args: ["exec"],
    env: { A: "1", B: "2" },
  });
  assert.deepEqual(commandInvocation("claude --flag FOO=bar"), {
    file: "claude",
    args: ["--flag", "FOO=bar"],
    env: {},
  });
  assert.throws(() => commandInvocation("ONLY=env"), /runtime command is empty/);
});

test("runtime command parser rejects malformed quoting", () => {
  assert.throws(() => parseCommandLine('codex exec "unfinished'), /unclosed quote/);
});

test("Windows runtime resolution unwraps an npm Codex shim without invoking a shell", () => {
  const npmDir = "C:\\Users\\tester\\AppData\\Roaming\\npm";
  const shim = `${npmDir}\\codex.CMD`;
  const launcher = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const files = new Map([
    [shim.toLowerCase(), [
      "@ECHO off",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join("\r\n")],
    [launcher.toLowerCase(), "// fixture"],
  ]);

  const resolved = resolveExecutableInvocation(
    { file: "codex", args: ["exec", "--ephemeral"] },
    {
      platform: "win32",
      env: { Path: npmDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: file => files.has(file.toLowerCase()),
      readFileSync: file => files.get(file.toLowerCase()),
    },
  );

  assert.deepEqual(resolved, {
    file: "C:\\Program Files\\nodejs\\node.exe",
    args: [launcher, "exec", "--ephemeral"],
  });
});

test("Windows runtime resolution preserves PATH precedence over a later executable", () => {
  const npmDir = "C:\\npm";
  const nativeDir = "C:\\WindowsApps";
  const shim = `${npmDir}\\codex.CMD`;
  const launcher = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const files = new Map([
    [shim.toLowerCase(), '"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'],
    [launcher.toLowerCase(), "// fixture"],
    [`${nativeDir}\\codex.EXE`.toLowerCase(), "native"],
  ]);

  const resolved = resolveExecutableInvocation(
    { file: "codex", args: ["exec"] },
    {
      platform: "win32",
      env: { PATH: `${npmDir};${nativeDir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      nodePath: "C:\\node.exe",
      existsSync: file => files.has(file.toLowerCase()),
      readFileSync: file => files.get(file.toLowerCase()),
    },
  );

  assert.deepEqual(resolved, {
    file: "C:\\node.exe",
    args: [launcher, "exec"],
  });
});

test("MCP thread resolution requires explicit binding when multiple memories exist", () => {
  const cfg = { qiheng: {}, chengxu: {} };
  assert.equal(resolveMcpThread({ thread: "qiheng" }, cfg, ["qiheng", "chengxu"], {}), "qiheng");
  assert.equal(resolveMcpThread({}, cfg, ["qiheng", "chengxu"], { STMEM_THREAD_ID: "chengxu" }), "chengxu");
  assert.throws(() => resolveMcpThread({}, cfg, ["qiheng", "chengxu"], {}), /显式指定 thread/);
  assert.equal(resolveMcpThread({}, { qiheng: {} }, ["qiheng"], {}), "qiheng");
  assert.throws(() => resolveMcpThread({ thread: "missing" }, cfg, ["qiheng", "chengxu"], {}), /未配置线程/);
});
