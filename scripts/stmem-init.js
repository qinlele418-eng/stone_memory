#!/usr/bin/env node
/**
 * stmem init — 交互式初始化新线程
 *
 * 用法:
 *   stmem init --thread <id>                    交互式
 *   stmem init --batch-file <path>              安全读取机器配置
 *   stmem init --batch-file <path> --validate   只校验，不写入
 *   stmem init --template [--runtime codex]     输出机器可填写模板
 *   stmem init --schema                         输出 JSON Schema
 *   stmem init --help                           帮助
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { watcherServiceContent } = require("../src/lib/systemd-watcher-service");
const readline = require("readline");

const STONE = path.join(os.homedir(), ".stone_memory");
const cfgFile = path.join(STONE, "stmem.json");
const {
  createThread, validateThreadInput, validateSessionBinding, normalizeName,
} = require("../src/services/thread-setup");
const { INIT_SCHEMA, buildInitTemplate } = require("../src/services/init-contract");
const { processMatches } = require("../src/lib/process-identity");

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); }
  catch { return {}; }
}

async function askRequired(rl, question, existingVal) {
  while (true) {
    const suffix = existingVal ? ` [${existingVal}]` : "";
    const answer = await new Promise(resolve => {
      rl.question(`${question}${suffix}: `, resolve);
    });
    const val = answer.trim() || existingVal || "";
    if (val) return val;
    console.log("  此项为必填，请输入。");
  }
}

async function askOptionalNumber(rl, question, existingVal, defaultVal) {
  const d = existingVal ?? defaultVal;
  const suffix = ` [${d}]`;
  const answer = await new Promise(resolve => {
    rl.question(`${question}${suffix}: `, resolve);
  });
  return parseInt(answer.trim() || String(d), 10) || d;
}

async function askOptional(rl, question, defaultVal) {
  const answer = await new Promise(resolve => {
    rl.question(`${question} [${defaultVal}]: `, resolve);
  });
  return answer.trim() || defaultVal;
}

async function interactiveInit(threadId) {
  const cfg = loadCfg();
  const existing = cfg[threadId] || {};

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n初始化线程: ${threadId}\n`);

  const ai = await askRequired(rl, "AI 名字", existing.ai);
  const user = await askRequired(rl, "用户名字", existing.user);
  let label;
  while (true) {
    label = await askRequired(rl, "记忆体名字（控制台显示名称）", existing.label);
    const duplicate = Object.entries(cfg).find(([id, item]) => id !== threadId && item && typeof item === "object" && normalizeName(item.label || id) === normalizeName(label));
    if (!duplicate) break;
    console.log(`  已经存在名为“${label}”的记忆体，请换一个名字。`);
  }
  const userGender = await askRequired(rl, "用户性别 (male/female)", existing.userGender);
  const runtime = await askRequired(rl, "运行时 (claude/codex)", existing.runtime);
  const purpose = await askRequired(rl, "用途 (accompany/coding/study)", existing.purpose);
  const defaultSessionDir = runtime === "codex" ? path.join(os.homedir(), ".codex", "sessions") : existing.sessionDir;
  const sessionDir = await askRequired(rl, "线程文件搜索目录（会递归查找）", existing.sessionDir || defaultSessionDir);
  const minerMode = await askRequired(rl, "挖掘模式 (api/subagent)", existing.minerMode || "subagent");
  let apiProvider = existing.apiProvider || "", apiKey = "", baseUrl = "", model = "";
  if (minerMode === "api") {
    apiProvider = await askRequired(rl, "API 厂商 (deepseek/openai/anthropic)", existing.apiProvider || "deepseek");
    // 填写 API key
    const existingKey = (cfg.apiKeys?.[apiProvider]?.key) || "";
    apiKey = await askRequired(rl, `  ${apiProvider} API Key`, existingKey);
    const defaultBaseUrl = { deepseek: "https://api.deepseek.com", openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" }[apiProvider] || "";
    const existingBaseUrl = cfg.apiKeys?.[apiProvider]?.baseUrl || "";
    baseUrl = await askOptional(rl, `  ${apiProvider} Base URL (回车默认)`, existingBaseUrl || defaultBaseUrl);
    model = await askRequired(rl, `  ${apiProvider} 模型名（必须与上游实际名称一致）`, cfg.apiKeys?.[apiProvider]?.model || "");
  }
  const windowDays = await askOptionalNumber(rl, "rebuild 窗口天数", existing.windowDays, 3);
  const keepToolPairs = await askOptionalNumber(rl, "保留工具对数", existing.keepToolPairs, 30);

  rl.close();

  return { threadId, libraryName: label, ai, user, userGender, runtime, purpose, sessionDir, minerMode,
    apiProvider, apiKey, baseUrl, model, windowDays, keepToolPairs,
    automaticFullMining: existing.automaticFullMining !== false,
    automaticMemoryMaintenance: existing.automaticMemoryMaintenance !== false,
    automaticCompression: existing.automaticCompression === true };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--template")) {
    const runtimeIndex = args.indexOf("--runtime");
    console.log(JSON.stringify(buildInitTemplate(runtimeIndex >= 0 ? args[runtimeIndex + 1] : "codex"), null, 2));
    return;
  }
  if (args.includes("--schema")) {
    console.log(JSON.stringify(INIT_SCHEMA, null, 2));
    return;
  }
  const threadIdx = args.indexOf("--thread");
  const argumentThreadId = threadIdx >= 0 ? args[threadIdx + 1] : null;

  let input;
  if (args.includes("--batch") || args.includes("--batch-file")) {
    const raw = args.includes("--batch-file")
      ? JSON.parse(fs.readFileSync(args[args.indexOf("--batch-file") + 1], "utf8"))
      : JSON.parse(args[args.indexOf("--batch") + 1] || "{}");
    if (argumentThreadId && raw.threadId && argumentThreadId !== raw.threadId) {
      throw new Error(`--thread (${argumentThreadId}) 与 batch 文件中的 threadId (${raw.threadId}) 不一致`);
    }
    const threadId = argumentThreadId || raw.threadId;
    if (!threadId) throw new Error("batch 文件必须填写真实 threadId");
    input = { ...raw, threadId, libraryName: raw.libraryName || raw.label || threadId };
    if (args.includes("--validate")) {
      validateThreadInput(input, loadCfg(), { allowExisting: true });
      const sessionFile = validateSessionBinding(input);
      console.log(JSON.stringify({
        valid: true, threadId, libraryName: input.libraryName,
        sessionDir: input.sessionDir, sessionFile,
      }, null, 2));
      return;
    }
  } else {
    if (!argumentThreadId) {
      console.log("用法:\n"
        + "  stmem init --thread <真实线程ID>\n"
        + "  stmem init --template --runtime codex\n"
        + "  stmem init --batch-file <json> --validate\n"
        + "  stmem init --batch-file <json>");
      process.exit(1);
    }
    input = await interactiveInit(argumentThreadId);
  }
  const tc = createThread(input, { allowExisting: true });

  console.log(`\n✅ 初始化完成`);
  console.log(`   AI: ${tc.ai}  用户: ${tc.user}`);
  console.log(`   运行时: ${tc.runtime}  用途: ${tc.purpose}`);
  console.log(`   记忆目录: ${tc.directory}`);
  console.log(`   已绑定线程文件: ${tc.sessionFile}`);

  // 全局开关只作为总闸；任一线程明确启用自动任务时打开总闸，
  // 实际是否挖掘仍由 watcher 逐线程读取 automatic* 配置决定。
  if (tc.automaticFullMining || tc.automaticMemoryMaintenance || tc.automaticCompression) {
    try { fs.rmSync(path.join(STONE, ".watcher-off"), { force: true }); } catch {}
    try { fs.rmSync(path.join(STONE, ".miner-off"), { force: true }); } catch {}
  }

  // 自动启动 watcher
  startWatcher();
}

function startWatcher() {
  const { spawn } = require("child_process");
  const watcherScript = path.join(__dirname, "watcher-supervisor.js");
  const pidFile = path.join(STONE, "watcher.pid");

  if (!fs.existsSync(watcherScript)) return;

  // systemd (仅 Linux)
  if (process.platform !== "win32") {
    const serviceDir = path.join(os.homedir(), ".config", "systemd", "user");
    const serviceFile = path.join(serviceDir, "stmem-watcher.service");
    try {
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(serviceFile, watcherServiceContent({
        nodePath: process.execPath,
        watcherScript,
        home: os.homedir(),
        pidFile,
      }));
      const { execSync: es } = require("child_process");
      try {
        es("systemctl --user daemon-reload 2>/dev/null", { stdio: "pipe" });
        es("systemctl --user enable stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
        es("systemctl --user start stmem-watcher.service 2>/dev/null", { stdio: "pipe" });
        console.log("   systemd service 已启用");
        return;
      } catch {}
    } catch {}
  } else {
    // Windows: 创建 .bat + 自动后台启动
    const batDir = path.join(os.homedir(), "AppData", "Local", "stmem");
    const batPath = path.join(batDir, "watcher-start.bat");
    const logFile = path.join(STONE, "watcher.log");
    try {
      fs.mkdirSync(batDir, { recursive: true });
      fs.writeFileSync(batPath, `@echo off\r\nstart /B node "${watcherScript}" > "${logFile}" 2>&1\r\n`);
      // 检查是否已在运行
      try {
        const oldPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        if (processMatches(oldPid, "watcher-supervisor.js")) { console.log("   watcher 已在运行"); return; }
      } catch {}
      // 后台启动
      const w = spawn(process.execPath, [watcherScript], {
        detached: true, stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      w.unref();
      fs.writeFileSync(pidFile, String(w.pid));
      console.log(`   watcher 已启动 (pid ${w.pid})`);
      console.log(`   启动脚本: ${batPath}`);
      console.log("   加入开机自启: 将此快捷方式放入 shell:startup 文件夹");
      return;
    } catch (err) {
      console.log(`   watcher 启动失败: ${err.message}，请手动运行 watcher`);
      return;
    }
  }

  // fallback: 直接后台启动
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (processMatches(oldPid, "watcher-supervisor.js")) { console.log(`   watcher 已在运行 (pid ${oldPid})`); return; }
  } catch {}
  const w = spawn(process.execPath, [watcherScript], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  w.unref();
  fs.writeFileSync(pidFile, String(w.pid));
  console.log(`   watcher 已启动 (pid ${w.pid})`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
