import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAgentTools } from './agent-tools.mjs';
import { callZaiChat, DEFAULT_ZAI_MODEL } from './zai-client.mjs';
import { redactErrorMessage, redactModelValue } from './contract.mjs';

export const AGENT_LIMITS = Object.freeze({
  maxLogicalTurns: 6,
  maxExploreTurns: 2,
  maxApiAttempts: 7,
  maxTokensPerTurn: 4_096,
  maxCompletionTokens: 24_576,
  maxHistoryChars: 48_000,
  maxToolCalls: 16,
  maxReadOnlyCalls: 10,
  maxPatchCalls: 2,
  maxTestCalls: 2,
  maxPatchChars: 10_000,
  maxElapsedMs: 12 * 60 * 1_000,
});

const READ_ONLY_TOOLS = new Set(['get_status', 'read_file', 'search_code', 'git_show_file', 'git_diff']);
const FINISH_TOOLS = new Set(['finish']);

export const REPAIR_AGENT_SYSTEM_PROMPT = [
  '你是 Stone Memory 的 PR 冲突维修 coding agent，不是 reviewer，也不是计划生成器。',
  '你的任务是直接在隔离 repair worktree 中读取代码、调查 current main 与 PR 的差异、修改代码并运行测试。',
  '必须保留 PR 的原始功能意图，只处理 current main 导致的冲突或明确的相关测试失败。',
  '先使用只读工具获取证据；最多探索两回合后必须直接 apply_patch。每次成功 apply_patch 后 runtime 会自动运行一次相关测试，再根据结果继续。',
  '不要输出计划来代替修改，不要输出完整文件，不要修改测试、依赖入口、workflow、权限或凭据。',
  '不要 commit、push、approve、merge、close PR；这些动作由外层机械层完成。',
  '如果证据不足、需要产品决策、预算耗尽或无法保守完成，调用 finish(decision="needs_human")。',
  '只有相关测试通过且冲突已经解决时，才能调用 finish(decision="repair_complete")。',
  '每次响应优先调用工具；不要用普通文本描述下一步。',
].join('\n');

function nowMs() {
  return Date.now();
}

function estimateTokens(value) {
  return Math.ceil(String(value ?? '').length / 4);
}

function safeJson(value) {
  try { return JSON.stringify(redactModelValue(value)); } catch { return '{"error":"无法序列化工具结果"}'; }
}

function toolArguments(call) {
  const raw = call?.function?.arguments ?? '{}';
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function groupConversation(messages) {
  const groups = [];
  let current = [];
  for (const message of messages.slice(2)) {
    if (message.role === 'assistant' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function compactMessages(messages, snapshot, limits) {
  const base = messages.slice(0, 2);
  const groups = groupConversation(messages);
  const checkpoint = {
    role: 'system',
    content: `Runtime checkpoint（旧工具结果已压缩，仅保留事实）：${safeJson(snapshot)}`,
  };
  const kept = [];
  let chars = base.reduce((sum, item) => sum + safeJson(item).length, 0) + safeJson(checkpoint).length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const groupChars = group.reduce((sum, item) => sum + safeJson(item).length, 0);
    if (kept.length > 0 && chars + groupChars > limits.maxHistoryChars) break;
    kept.unshift(group);
    chars += groupChars;
  }
  return [...base, checkpoint, ...kept.flat()];
}

function metrics(state, limits, startedAt, clock = nowMs) {
  return {
    logicalTurns: state.logicalTurns,
    apiAttempts: state.apiAttempts,
    completionTokens: state.completionTokens,
    readOnlyCalls: state.readOnlyCalls,
    patchCalls: state.patchCalls,
    testCalls: state.testCalls,
    toolCalls: state.toolCalls,
    maxLogicalTurns: limits.maxLogicalTurns,
    maxApiAttempts: limits.maxApiAttempts,
    maxTokensPerTurn: limits.maxTokensPerTurn,
    maxCompletionTokens: limits.maxCompletionTokens,
    elapsedMs: Math.max(0, clock() - startedAt),
    toolSequence: [...(state.toolSequence || [])],
    toolTrace: [...(state.toolTrace || [])],
  };
}

function finalResult(status, reason, state, limits, startedAt, clock = nowMs, extra = {}) {
  return {
    version: 1,
    status,
    ...(reason ? { reason: redactErrorMessage(reason) } : {}),
    metrics: metrics(state, limits, startedAt, clock),
    ...extra,
  };
}

function exceeded(state, limits, startedAt, clock = nowMs) {
  if (state.logicalTurns >= limits.maxLogicalTurns) return '模型回合上限';
  if (state.apiAttempts >= limits.maxApiAttempts) return '模型 API 请求达到硬上限';
  if (state.completionTokens >= limits.maxCompletionTokens) return '模型总输出 token 达到硬上限';
  if (clock() - startedAt >= limits.maxElapsedMs) return '维修运行时间达到硬上限';
  if (state.toolCalls >= limits.maxToolCalls) return '工具调用达到硬上限';
  return null;
}

function gateToolCall(name, args, state, limits) {
  if (!name) return '工具调用缺少名称';
  if (state.toolCalls >= limits.maxToolCalls) return '工具调用达到硬上限';
  if (READ_ONLY_TOOLS.has(name) && state.readOnlyCalls >= limits.maxReadOnlyCalls) return '只读工具调用达到硬上限';
  if (READ_ONLY_TOOLS.has(name) && state.patchCalls === 0 && state.logicalTurns > limits.maxExploreTurns) return '探索回合达到上限，请直接 apply_patch 或 needs_human';
  if (name === 'apply_patch') {
    if (state.readOnlyCalls < 1) return '必须先通过只读工具调查代码，再 apply_patch';
    if (state.patchCalls >= limits.maxPatchCalls) return '修改批次达到硬上限';
    if (state.pendingVerification) return '上一个 patch 尚未运行测试，不能继续修改';
    if (typeof args?.patch !== 'string' || args.patch.length > limits.maxPatchChars) return `patch 必须是字符串且不超过 ${limits.maxPatchChars} 字符`;
  }
  if (name === 'run_tests') {
    if (state.testCalls >= limits.maxTestCalls) return '测试调用达到硬上限';
  }
  if (name === 'finish' && args?.decision === 'repair_complete' && state.lastTestPassed !== true) {
    return 'repair_complete 必须在相关测试通过后调用';
  }
  return null;
}

function availableDefinitions(definitions, state, limits) {
  if (state.patchCalls === 0 && state.logicalTurns > limits.maxExploreTurns) {
    return definitions.filter((tool) => ['apply_patch', 'run_tests', 'finish'].includes(tool?.function?.name));
  }
  return definitions;
}

function defaultTask({ diagnosis, reproduction = {} } = {}) {
  const failures = reproduction?.pr?.result?.failures || [];
  return [
    '请直接处理当前 PR 与 current main 的冲突。不要只生成计划。',
    '机械事实：',
    safeJson({
      pr: {
        number: diagnosis?.pr?.number,
        title: diagnosis?.pr?.title,
        baseRef: diagnosis?.pr?.baseRef,
        headRef: diagnosis?.pr?.headRef,
        headSha: diagnosis?.pr?.headSha,
      },
      prKind: diagnosis?.prKind,
      currentMainSha: diagnosis?.currentMainSha,
      nextAction: diagnosis?.nextAction,
      merge: diagnosis?.merge,
      changedFiles: diagnosis?.changedFiles,
      checks: diagnosis?.checks,
      diffCheck: diagnosis?.diffCheck,
      bugEvidence: diagnosis?.bugEvidence,
      failures: failures.slice(0, 12),
    }),
    'repair worktree 已由机械层准备；使用工具自己读取需要的上下文。',
  ].join('\n\n');
}

export function buildAgentTask(input = {}) {
  return defaultTask(input);
}

export async function runRepairAgent({
  task,
  client,
  tools,
  limits = AGENT_LIMITS,
  clock = nowMs,
} = {}) {
  if (!client || typeof client.complete !== 'function') throw new Error('ReAct runtime 缺少 client.complete');
  if (!tools || !Array.isArray(tools.definitions) || typeof tools.call !== 'function') throw new Error('ReAct runtime 缺少受限工具集');

  const startedAt = clock();
  const state = {
    logicalTurns: 0,
    apiAttempts: 0,
    completionTokens: 0,
    readOnlyCalls: 0,
    patchCalls: 0,
    testCalls: 0,
    toolCalls: 0,
    toolSequence: [],
    toolTrace: [],
    pendingVerification: false,
    lastTestPassed: false,
  };
  const messages = [
    { role: 'system', content: REPAIR_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: String(task || '').slice(0, 24_000) },
  ];
  let lengthRetryUsed = false;

  while (true) {
    const limitReason = exceeded(state, limits, startedAt, clock);
    if (limitReason) return finalResult('needs_human', limitReason, state, limits, startedAt, clock);

    state.logicalTurns += 1;
    let completion;
    try {
      while (true) {
        const requestMessages = compactMessages(messages, tools.snapshot?.() || {}, limits);
        completion = await client.complete({
          messages: requestMessages,
          tools: availableDefinitions(tools.definitions, state, limits),
          maxTokens: limits.maxTokensPerTurn,
        });
        state.apiAttempts += Number(completion?.attempts || 1);
        const usageTokens = Number(completion?.usage?.completion_tokens || 0);
        state.completionTokens += usageTokens || estimateTokens(completion?.message);
        if (state.apiAttempts > limits.maxApiAttempts) return finalResult('needs_human', '模型 API 请求达到硬上限', state, limits, startedAt, clock);
        if (state.completionTokens > limits.maxCompletionTokens) return finalResult('needs_human', '模型总输出 token 达到硬上限', state, limits, startedAt, clock);
        break;
      }
    } catch (error) {
      if (error?.code === 'token_limit' && !lengthRetryUsed) {
        lengthRetryUsed = true;
        state.apiAttempts += 1;
        if (state.apiAttempts > limits.maxApiAttempts) return finalResult('needs_human', '模型 API 请求达到硬上限', state, limits, startedAt, clock);
        messages.splice(2, messages.length - 2, {
          role: 'system',
          content: '上一次响应达到 token 上限。请立即缩小操作：只调用一个必要工具，或调用 finish(decision="needs_human")。',
        });
        continue;
      }
      return finalResult('ai_unavailable', redactErrorMessage(error), state, limits, startedAt, clock);
    }

    const message = completion?.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      return finalResult('needs_human', '模型没有调用受限工具，拒绝把普通文本当作修复结果', state, limits, startedAt, clock);
    }
    if (calls.some((call) => !call?.function?.name)) {
      return finalResult('needs_human', '模型返回了无效工具调用', state, limits, startedAt, clock);
    }
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });

    let finished = null;
    let appliedInTurn = false;
    let explicitTestInTurn = false;
    for (const call of calls) {
      const name = call.function.name;
      state.toolSequence.push(name);
      const args = toolArguments(call);
      let result;
      if (args === null) {
        result = { ok: false, error: '工具参数不是合法 JSON' };
      } else {
        const gateError = gateToolCall(name, args, state, limits);
        if (gateError) {
          result = { ok: false, error: gateError };
        } else {
          state.toolCalls += 1;
          if (READ_ONLY_TOOLS.has(name)) state.readOnlyCalls += 1;
          if (name === 'apply_patch') state.patchCalls += 1;
          if (name === 'run_tests') state.testCalls += 1;
          if (name === 'run_tests') explicitTestInTurn = true;
          try {
            result = await tools.call(name, args);
          } catch (error) {
            result = { ok: false, error: redactErrorMessage(error) };
          }
          if (name === 'apply_patch' && result?.applied === true) {
            state.pendingVerification = true;
            appliedInTurn = true;
          }
          if (name === 'run_tests') {
            state.lastTestPassed = result?.passed === true;
            state.pendingVerification = false;
          }
        }
      }
      state.toolTrace.push({
        name,
        ok: result?.ok === true,
        applied: result?.applied === true,
        passed: result?.passed === true,
        ...(result?.error ? { error: String(result.error).slice(0, 1_000) } : {}),
      });
      const serialized = safeJson(result);
      messages.push({ role: 'tool', tool_call_id: call.id || `${name}-${state.toolCalls}`, content: serialized.slice(0, 16_000) });
      if (name === 'finish' && result?.ok === true) finished = result;
    }

    if (appliedInTurn && !explicitTestInTurn && state.testCalls < limits.maxTestCalls) {
      state.testCalls += 1;
      state.toolCalls += 1;
      state.toolSequence.push('run_tests(auto)');
      let automaticTest;
      try {
        automaticTest = await tools.call('run_tests', { mode: 'related' });
      } catch (error) {
        automaticTest = { ok: false, passed: false, error: redactErrorMessage(error) };
      }
      state.lastTestPassed = automaticTest?.passed === true;
      state.pendingVerification = false;
      state.toolTrace.push({
        name: 'run_tests(auto)',
        ok: automaticTest?.ok === true,
        passed: automaticTest?.passed === true,
        ...(automaticTest?.error ? { error: String(automaticTest.error).slice(0, 1_000) } : {}),
      });
      messages.push({
        role: 'tool',
        tool_call_id: `auto-test-${state.toolCalls}`,
        content: safeJson({ automatic: true, ...automaticTest }).slice(0, 16_000),
      });
    }

    if (finished) {
      if (finished.status === 'repair_complete') {
        return finalResult('repair_complete', null, state, limits, startedAt, clock, { summary: finished.summary || '' });
      }
      return finalResult('needs_human', finished.reason || finished.summary || '模型请求人工处理', state, limits, startedAt, clock, { summary: finished.summary || '' });
    }
  }
}

function defaultClient({ apiKey = process.env.ZAI_API_KEY, model = process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL } = {}) {
  return {
    complete: (input) => callZaiChat({ ...input, apiKey, model }),
  };
}

export async function main() {
  const diagnosis = JSON.parse(readFileSync(process.env.DIAGNOSIS_PATH || 'pr-repair-diagnosis.json', 'utf8'));
  let reproduction = {};
  try { reproduction = JSON.parse(readFileSync(process.env.REPRODUCTION_PATH || 'pr-repair-reproduction.json', 'utf8')); } catch { /* conflict-only */ }
  const cwd = process.env.REPAIR_WORKTREE || process.cwd();
  const allowedFiles = [...new Set([
    ...(diagnosis.changedFiles || []),
    ...(diagnosis.merge?.conflictFiles || []),
    ...(reproduction?.pr?.result?.failures || []).map((failure) => failure.file).filter(Boolean),
  ])];
  const tools = createAgentTools({
    cwd,
    revisions: {
      base: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
      pr: diagnosis.pr?.headSha,
      main: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
    },
    allowedFiles,
  });
  const result = await runRepairAgent({
    task: buildAgentTask({ diagnosis, reproduction }),
    client: defaultClient(),
    tools,
  });
  const output = process.env.AGENT_RESULT_PATH || 'pr-repair-agent-result.json';
  writeFileSync(output, `${JSON.stringify({ ...result, model: process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL, changedFiles: tools.snapshot?.().changedFiles || [] }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'ai_unavailable') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
