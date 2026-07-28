#!/usr/bin/env node
/**
 * stmem mine — 挖掘 feelings + features
 *
 * 默认按线程配置的 minerMode 走 (api/subagent)，
 * 也可用 --api / --subagent 临时覆盖。
 *
 * 用法:
 *   stmem mine [--thread <id>] [--date <YYYY-MM-DD>]
 *   stmem mine [--thread <id>] --all
 *   stmem mine [--thread <id>] --api          # 临时走 API
 *   stmem mine [--thread <id>] --subagent     # 临时走 subagent
 *   stmem mine [--thread <id>] --targeted --batch-file <json>
 */
const fs = require("fs");
const path = require("path");
const { MemoryMiner } = require("../src/services/memory-miner");
const { getCfg, getThreadDir, listThreadIds, loadConfig } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { requiresRemine, shouldAttempt } = require("../src/services/mining-state");

function resolveApiConfig(tid, forceApi, forceSub, { diagnostic = false, model = "" } = {}) {
  if (forceSub) return {};  // 强制 subagent

  const tc = loadConfig()[tid] || {};
  const mode = forceApi ? "api" : (tc.minerMode || "subagent");
  if (mode !== "api") return {};

  const provider = tc.apiProvider || "deepseek";
  const globalKeys = loadConfig().apiKeys || {};
  const cred = globalKeys[provider] || {};
  const baseUrl = cred.baseUrl || (provider === "deepseek" ? "https://api.deepseek.com" : "");
  if (!cred || !cred.key) {
    if (diagnostic) return { apiKey: "", baseUrl, model: cred.model || "", provider };
    if (forceApi) throw new Error(`API 模式未找到 ${provider} 的 API Key`);
    console.warn(`[stmem] 线程 ${tid} 配置了 api 模式但未找到 ${provider} 的 key，回退 subagent`);
    return {};
  }
  const selectedModel = String(model || cred.model || "").trim();
  if (!selectedModel) {
    if (diagnostic) return { apiKey: cred.key, baseUrl, model: "", provider };
    throw new Error(`API 模式缺少 ${provider} 模型名。请在创建记忆体或设置页填写上游实际可用的模型名`);
  }
  if (!baseUrl) {
    if (diagnostic) return { apiKey: cred.key, baseUrl: "", model: String(cred.model).trim(), provider };
    throw new Error(`API 模式缺少 ${provider} Base URL。非 DeepSeek 服务必须填写兼容 chat/completions 的地址`);
  }

  return {
    apiKey: cred.key,
    baseUrl,
    model: selectedModel,
  };
}

function processFile(tid) {
  return path.join(getThreadDir(tid), "logs", "mining-process.json");
}

function registerMiningProcess(tid, date, mode) {
  const file = processFile(tid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, threadId: tid, date, mode, startedAt: new Date().toISOString() }, null, 2));
}

function clearMiningProcess(tid) {
  try { fs.unlinkSync(processFile(tid)); } catch {}
}

function stopMiningProcess(tid) {
  const file = processFile(tid);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { stopped: false, code: "MINING_NOT_RUNNING", reason: "当前没有登记中的挖掘进程" }; }
  try {
    process.kill(Number(state.pid), "SIGTERM");
    try { fs.rmSync(path.join(getThreadDir(tid), "memory", `.mining-lock-${state.date}`), { recursive: true, force: true }); } catch {}
    try {
      const store = new MemoryStore({ memoryDir: path.join(getThreadDir(tid), "memory"), threadId: tid });
      const current = store.getDayState(state.date);
      store.setDayState(state.date, {
        status: "failed",
        attempt: current?.attempt || 0,
        errorCode: "MINING_CANCELLED",
        errorMessage: "用户手动停止挖掘",
        failedAt: new Date().toISOString(),
        nextRetryAt: new Date().toISOString(),
      });
      store.close();
    } catch {}
    clearMiningProcess(tid);
    return { stopped: true, code: "MINING_STOP_REQUESTED", pid: state.pid, date: state.date };
  } catch (error) {
    clearMiningProcess(tid);
    return { stopped: false, code: "MINING_PROCESS_STALE", reason: error.message, pid: state.pid, date: state.date };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf("--date");
  const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : "";
  const allMode = args.includes("--all");
  const forceApi = args.includes("--api");
  const forceSub = args.includes("--subagent");
  const force = args.includes("--force");
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? String(args[modelIdx + 1] || "").trim() : "";
  const targeted = args.includes("--targeted");
  const check = args.includes("--check");
  const stop = args.includes("--stop");
  const jsonOutput = args.includes("--json");
  const batchIdx = args.indexOf("--batch-file");
  const threadIdx = args.indexOf("--thread");
  const tid = threadIdx >= 0 ? args[threadIdx + 1] : listThreadIds()[0];
  if (!tid) throw new Error("未指定线程，请用 --thread <id> 或先 stmem init");
  const memoryDir = path.join(getThreadDir(tid), "memory");

  if (stop) {
    const result = stopMiningProcess(tid);
    console.log(jsonOutput ? JSON.stringify(result, null, 2) : (result.stopped ? `已请求停止 ${result.date} 的挖掘` : result.reason));
    if (!result.stopped && result.code !== "MINING_NOT_RUNNING") process.exitCode = 1;
    return;
  }

  const deepseekConfig = resolveApiConfig(tid, forceApi, forceSub, { diagnostic: check, model });
  const modeLabel = deepseekConfig.apiKey ? `api (${deepseekConfig.baseUrl})` : "subagent";

  const miner = new MemoryMiner({
    memoryDir,
    threadId: tid,
    deepseekConfig,
    personaConfig: {
      aiName: getCfg("ai", tid),
      userName: getCfg("user", tid),
      userGender: getCfg("userGender", tid, "female"),
      purpose: getCfg("purpose", tid),
    },
  });

  if (check) {
    const date = targetDate || miner._yesterday();
    const result = await miner.diagnose(date);
    console.log(jsonOutput ? JSON.stringify({ date, mode: deepseekConfig.apiKey || forceApi ? "api" : "subagent", ...result }, null, 2)
      : `挖掘自检 ${result.ok ? "通过" : "失败"}（${result.code}）\n${result.reason}\n\n实际返回：\n${result.actualResponse?.content || result.actualResponse?.body || "（无响应内容）"}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (targeted) {
    if (batchIdx < 0 || !args[batchIdx + 1]) throw new Error("精准补挖需要 --batch-file <json>");
    const payload = JSON.parse(fs.readFileSync(path.resolve(args[batchIdx + 1]), "utf8"));
    const date = String(payload.date || targetDate || "");
    const timestamps = new Set(Array.isArray(payload.timestamps) ? payload.timestamps.map(String) : []);
    if (!timestamps.size) throw new Error("精准补挖没有选中对话");
    const messages = miner.store.listMessages({ date }).filter(row => timestamps.has(row.timestamp));
    if (messages.length !== timestamps.size) throw new Error("部分所选对话已不存在，请刷新后重试");
    const result = await miner.mineTargeted(date, messages, { instruction: String(payload.instruction || "") });
    console.log(JSON.stringify({ status: "completed", date, feelingCount: result.feelings.length }));
  } else if (allMode) {
    const allDates = miner.store.listMessageDates();
    if (!allDates.length) { console.log("[stmem] SQLite messages 无数据"); process.exit(0); }
    const miningState = miner._readState();

    const bjToday = (() => {
      const bj = new Date(Date.now() + 8 * 3600 * 1000);
      return bj.toISOString().slice(0, 10);
    })();

    const pending = allDates.filter(d => {
      if (d >= bjToday) return false;
      const messages = miner.store.listMessages({ date: d });
      return shouldAttempt(miningState, d, messages) || requiresRemine(miningState, d, messages);
    });
    if (!pending.length) { console.log("[stmem] 所有日期已挖掘完毕"); process.exit(0); }

    console.log(`[stmem] 待挖掘: ${pending.length} 天 (${pending[0]} ~ ${pending[pending.length-1]}) (${modeLabel})`);
    let ok = 0, empty = 0, fail = 0;
    for (const d of pending) {
      try {
        console.log(`\n[stmem] --- ${d} ---`);
        registerMiningProcess(tid, d, modeLabel);
        const messages = miner.store.listMessages({ date: d });
        const result = await miner.mine(d, { force: force || requiresRemine(miningState, d, messages) });
        if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
        if (["completed", "already_completed"].includes(result.status)) ok++;
        else if (result.status === "completed_empty") empty++;
        else throw new Error(`unexpected status: ${result.status}`);
      } catch (e) {
        console.error(`[stmem] ${d} 失败: ${e.message}`);
        fail++;
      } finally {
        clearMiningProcess(tid);
      }
    }
    console.log(`\n[stmem] 完成: ${ok} 有结果, ${empty} 无需记录, ${fail} 失败`);
    if (fail) process.exitCode = 1;
  } else {
    console.log(`[stmem] mining ${targetDate || "昨天"} (${modeLabel})...`);
    try {
      registerMiningProcess(tid, targetDate || miner._yesterday(), modeLabel);
      const result = await miner.mine(targetDate, { force });
      if (result.status === "locked") throw new Error(`${result.errorCode}: date is locked`);
      console.log(`[stmem] ${result.status}.`);
    } finally {
      clearMiningProcess(tid);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { resolveApiConfig, stopMiningProcess };
