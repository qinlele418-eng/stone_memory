import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAgentTools } from './agent-tools.mjs';
import { callZaiChat, DEFAULT_ZAI_MODEL } from './zai-client.mjs';
import { redactErrorMessage, redactModelValue } from './contract.mjs';

export const AGENT_LIMITS = Object.freeze({
  maxLogicalTurns: 26,
  maxApiAttempts: 27,
  maxTokensPerTurn: 16_000,
  maxCompletionTokens: 128_000,
  maxHistoryChars: 1_000_000,
  maxReadOnlyCalls: 24,
  maxPatchCalls: 10,
  maxTestCalls: 5,
  maxToolCalls: 40,
  maxPatchChars: 10_000,
});

const READ_ONLY_TOOLS = new Set(['get_status', 'read_file', 'search_code', 'git_show_file', 'git_diff']);
const FINISH_TOOLS = new Set(['finish']);
// The model only needs a small amount of orientation before the first trusted
// test run.  Keeping this independent of the much larger total read budget
// prevents repeated reads of the same test file from starving the actual
// repair loop (and from making a large, slow model request).

export const REPAIR_AGENT_SYSTEM_PROMPT = [
  '你是 Stone Memory 的 PR 冲突维修 coding agent，不是 reviewer，也不是计划生成器。',
  '你的任务是直接在隔离 repair worktree 中读取代码、调查 current main 与 PR 的差异、修改代码并运行测试。远程 CI 的 Windows/macOS/Linux 失败证据也属于可信输入；若 Ubuntu 复现通过但远程平台仍失败，只根据具体断言做兼容性或命名修复，不要因本地测试通过就停止。',
  '必须保留 PR 的原始功能意图，只处理 current main 导致的冲突或明确的相关测试失败。',
  '冲突任务优先调用一次 get_status；其 conflictDetails 已集中给出所有未解决冲突块，ours 是 PR 侧、theirs 是 current main 侧，并带有前后文。不要逐个调用 git_show_file 来重新扫描这些冲突；读取集中结果后直接 apply_patch。每次 apply_patch 的结果会列出 remainingUnresolved；必须继续处理这些文件，直到列表为空。未解决冲突清空前不要调用 run_tests，先完成所有冲突文件；只有列表为空后才验证。每次读取若省略 path，runtime 会优先给出仍未解决的文件。CI 失败任务由 runtime 在首轮提供结构化测试报告、失败测试和相关源码；先利用这些证据修改，再按需读取和验证，不要把重复搜索当作进展。测试失败时，runtime 会依据失败报告自动返回相关源码、失败测试和 main/pr 参考；按需读取、修改并验证。冲突清空后每次成功 apply_patch 后 runtime 会自动运行一次相关测试，再根据结果继续。git_show_file 必须带 revision（base、pr 或 main），否则用 read_file。',
  'apply_patch 的 patch 参数不要用 Markdown 围栏；可用标准 unified diff，或严格使用 *** Begin Patch、*** Update File: 路径、@@、带 +/- 前缀的行、*** End Patch 格式。',
  '不要输出计划来代替修改，不要输出完整文件，不要为了让测试变绿而削弱或删除测试；如果失败测试本身属于允许的 PR 变更且明确断言了与 current main 合约不一致的旧行为，可以做等价的机械断言迁移。不要修改依赖入口、workflow、权限或凭据。',
  '不要 commit、push、approve、merge、close PR；这些动作由外层机械层完成。',
  '如果证据不足、需要产品决策或无法保守完成，调用 finish(decision="needs_human")。',
  '相关测试完成验证后再调用 finish(decision="repair_complete")；不要用普通文本描述下一步。',
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

function auditValue(value, maxChars = 64_000) {
  const redacted = redactModelValue(value);
  let serialized;
  try { serialized = JSON.stringify(redacted); } catch { return { auditError: '无法序列化审计值' }; }
  if (serialized.length <= maxChars) return redacted;
  return {
    truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

function testTrace(result) {
  return redactModelValue({
    command: result?.command,
    exitCode: result?.exitCode,
    timedOut: result?.timedOut,
    passed: result?.passed,
    result: result?.result,
    stderr: result?.stderr,
  });
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
    successfulPatchCalls: state.successfulPatchCalls,
    testCalls: state.testCalls,
    toolCalls: state.toolCalls,
    maxLogicalTurns: limits.maxLogicalTurns,
    maxApiAttempts: limits.maxApiAttempts,
    maxTokensPerTurn: limits.maxTokensPerTurn,
    maxCompletionTokens: limits.maxCompletionTokens,
    elapsedMs: Math.max(0, clock() - startedAt),
    toolSequence: [...(state.toolSequence || [])],
    toolTrace: [...(state.toolTrace || [])],
    turnTrace: [...(state.turnTrace || [])],
    auditTrace: [...(state.auditTrace || [])],
    auditSchemaVersion: 1,
  };
}

function finalResult(status, reason, state, limits, startedAt, clock = nowMs, extra = {}) {
  state.auditStatus = status;
  state.auditReason = reason ? redactErrorMessage(reason) : null;
  state.flushAudit?.('final', { status, reason: state.auditReason });
  return {
    version: 1,
    status,
    ...(reason ? { reason: redactErrorMessage(reason) } : {}),
    metrics: metrics(state, limits, startedAt, clock),
    ...extra,
  };
}

function exceeded() {
  // The GitHub job is the outer lifecycle boundary. The coding runtime must
  // not terminate exploration early and hide the model's actual behaviour.
  return null;
}

function gateToolCall(name, args, state, limits) {
  if (!name) return '工具调用缺少名称';
  // Do not impose exploration or call-count policy here.  The outer GitHub
  // job owns lifecycle cancellation; tool implementations still validate
  // paths, patch format, and test execution in the repair worktree.
  return null;
}

function availableDefinitions(definitions, state, limits) {
  return definitions;
}

function defaultTask({ diagnosis, reproduction = {} } = {}) {
  const compactFailure = (failure = {}) => ({
    name: failure.name,
    file: failure.file,
    line: failure.line,
    column: failure.column,
    error: failure.error,
    expected: failure.expected,
    actual: failure.actual,
    conclusion: failure.conclusion,
    summary: failure.summary,
    ...(failure.log ? { log: String(failure.log).slice(-6_000) } : {}),
  });
  const failures = (reproduction?.pr?.result?.failures || []).slice(0, 12).map(compactFailure);
  const remoteFailures = (reproduction?.remote?.failures || []).slice(0, 8).map(compactFailure);
  return [
    '请直接处理当前 PR 与 current main 的冲突或可信 CI 失败。不要只生成计划。',
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
      remoteFailures: remoteFailures.slice(0, 8),
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
  requiresPatch = false,
  auditPath = process.env.AGENT_AUDIT_PATH || null,
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
    successfulPatchCalls: 0,
    testCalls: 0,
    toolCalls: 0,
    toolSequence: [],
    toolTrace: [],
    turnTrace: [],
    auditTrace: [],
    auditStatus: 'running',
    auditReason: null,
    auditPath,
    pendingVerification: false,
    remainingUnresolved: [],
    lastTestPassed: false,
    failureReadCalls: 0,
    failureEvidenceDelivered: false,
    patchRetryRequired: false,
    rejectedToolCalls: 0,
    requirePatch: Boolean(requiresPatch),
    lastReadOnlySignature: null,
  };
  state.flushAudit = (type, payload = {}) => {
    state.auditTrace.push({
      sequence: state.auditTrace.length + 1,
      atMs: clock(),
      type,
      ...auditValue(payload, 16_000),
    });
    if (!state.auditPath) return;
    try {
      writeFileSync(state.auditPath, `${JSON.stringify({
        version: 1,
        status: state.auditStatus,
        reason: state.auditReason,
        updatedAt: new Date(clock()).toISOString(),
        metrics: metrics(state, limits, startedAt, clock),
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      state.auditWriteError = redactErrorMessage(error);
    }
  };
  const messages = [
    { role: 'system', content: REPAIR_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: String(task || '').slice(0, 24_000) },
  ];
  let lengthRetryUsed = false;

  // Reproduction already identified the failing PR state. Seed one trusted
  // status/test observation before asking the model to explore, so it receives
  // actionable evidence instead of having to guess which test or search query
  // to run. Conflict worktrees are left for the model to resolve first.
  const definitionNames = new Set(tools.definitions.map((tool) => tool?.function?.name));
  if (definitionNames.has('get_status') && definitionNames.has('run_tests')) {
    let initialStatus;
    try {
      initialStatus = await tools.call('get_status', {});
    } catch (error) {
      initialStatus = { ok: false, error: redactErrorMessage(error) };
    }
    state.toolCalls += 1;
    state.readOnlyCalls += 1;
    state.toolSequence.push('get_status(initial)');
    state.toolTrace.push({
      name: 'get_status(initial)',
      turn: 0,
      ok: initialStatus?.ok === true,
      applied: false,
      passed: false,
      result: auditValue(initialStatus),
      ...(initialStatus?.error ? { error: String(initialStatus.error).slice(0, 1_000) } : {}),
    });
    state.flushAudit('tool_result', { tool: 'get_status', phase: 'initial', result: initialStatus });
    if (Array.isArray(initialStatus?.unresolved)) state.remainingUnresolved = initialStatus.unresolved;
    if (initialStatus?.ok === true && state.remainingUnresolved.length === 0) {
      let initialTest;
      try {
        initialTest = await tools.call('run_tests', { mode: 'related' });
      } catch (error) {
        initialTest = { ok: false, passed: false, error: redactErrorMessage(error) };
      }
      state.toolCalls += 1;
      state.testCalls += 1;
      state.toolSequence.push('run_tests(initial)');
      state.lastTestPassed = initialTest?.passed === true;
      state.failureEvidenceDelivered = state.lastTestPassed !== true
        && ((Array.isArray(initialTest?.repairTargets) && initialTest.repairTargets.length > 0)
          || (Array.isArray(initialTest?.repairSources) && initialTest.repairSources.length > 0)
          || (initialTest?.result?.failures?.length > 0));
      state.toolTrace.push({
        name: 'run_tests(initial)',
        turn: 0,
        ok: initialTest?.ok === true,
        applied: false,
        passed: initialTest?.passed === true,
        result: auditValue(initialTest),
        ...(initialTest?.error ? { error: String(initialTest.error).slice(0, 1_000) } : {}),
        test: testTrace(initialTest),
      });
      state.flushAudit('tool_result', { tool: 'run_tests', phase: 'initial', result: initialTest });
      messages.push({
        role: 'system',
        content: [
          'runtime 首轮相关测试验证已完成。以下是可信证据，请直接据此调查并修改；不要把搜索本身当作进展。',
          safeJson({ status: initialStatus, test: initialTest }),
          initialTest?.passed !== true
            ? '测试未通过；失败测试和相关源码已在结果中提供，下一步优先 apply_patch，随后 run_tests 验证。'
            : state.requirePatch
              ? '本地测试通过但仍有远程 CI 失败证据；必须先分析远程断言并应用保守补丁，不能直接结束。'
              : '测试通过；若没有待处理的远程失败或冲突，才可结束。',
        ].join('\n'),
      });
    } else if (initialStatus?.ok === true && state.remainingUnresolved.length > 0) {
      messages.push({
        role: 'system',
        content: `runtime 首轮状态已提供，仍有未解决冲突：${safeJson(state.remainingUnresolved)}。先 apply_patch 清空冲突，再运行测试。`,
      });
    }
  }

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
        break;
      }
    } catch (error) {
      const errorMessage = redactErrorMessage(error);
      state.turnTrace.push({
        turn: state.logicalTurns,
        apiAttempts: state.apiAttempts,
        error: errorMessage,
        retryable: error?.code === 'token_limit' || error?.retryable === true,
      });
      state.flushAudit('api_error', { turn: state.logicalTurns, error: errorMessage });
      if (error?.code === 'token_limit' && !lengthRetryUsed) {
        lengthRetryUsed = true;
        state.apiAttempts += 1;
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
    state.turnTrace.push({
      turn: state.logicalTurns,
      apiAttempts: state.apiAttempts,
      completionTokens: Number(completion?.usage?.completion_tokens || 0),
      content: typeof message.content === 'string' ? message.content.slice(0, 2_000) : null,
      calls: calls.map((call) => ({
        name: call?.function?.name || null,
        arguments: typeof call?.function?.arguments === 'string'
          ? redactModelValue(call.function.arguments.slice(0, 4_000))
          : null,
      })),
    });
    state.flushAudit('model_response', {
      turn: state.logicalTurns,
      content: message.content,
      calls: calls.map((call) => ({
        id: call?.id || null,
        name: call?.function?.name || null,
        arguments: call?.function?.arguments || null,
      })),
    });
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
    let forcedStopReason = null;
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
          state.rejectedToolCalls += 1;
        } else {
          state.rejectedToolCalls = 0;
          state.toolCalls += 1;
          if (READ_ONLY_TOOLS.has(name)) state.readOnlyCalls += 1;
          if (['read_file', 'git_show_file', 'search_code'].includes(name) && state.testCalls > 0 && state.lastTestPassed !== true) state.failureReadCalls += 1;
          if (name === 'apply_patch') state.patchCalls += 1;
          if (name === 'run_tests') state.testCalls += 1;
          if (name === 'run_tests') explicitTestInTurn = true;
          try {
            result = await tools.call(name, args);
          } catch (error) {
            result = { ok: false, error: redactErrorMessage(error) };
          }
          if (name === 'apply_patch' && Array.isArray(result?.remainingUnresolved)) {
            state.remainingUnresolved = result.remainingUnresolved;
          }
          if (name === 'apply_patch') {
            state.failureReadCalls = 0;
            state.failureEvidenceDelivered = false;
            state.patchRetryRequired = result?.applied !== true;
            state.lastReadOnlySignature = null;
          }
          if (name === 'apply_patch' && result?.applied === true) {
            state.successfulPatchCalls += 1;
            state.pendingVerification = state.remainingUnresolved.length === 0;
            appliedInTurn = true;
          }
          if (name === 'run_tests') {
            state.lastTestPassed = result?.passed === true;
            state.pendingVerification = false;
            state.failureReadCalls = 0;
            // run_tests already returns the bounded failure report, repair
            // targets, and source snippets.  Mark that evidence as delivered
            // immediately so the next model turn edits instead of asking for
            // another copy of the same file.  A failed patch resets this flag
            // and opens one bounded read/diff retry cycle below.
            state.failureEvidenceDelivered = state.lastTestPassed !== true
              && ((Array.isArray(result?.repairTargets) && result.repairTargets.length > 0)
                || (Array.isArray(result?.repairSources) && result.repairSources.length > 0)
                || (result?.result?.failures?.length > 0));
            state.patchRetryRequired = false;
            state.lastReadOnlySignature = null;
          }
          if (['read_file', 'search_code', 'git_show_file'].includes(name)
            && state.testCalls > 0 && state.lastTestPassed !== true
            && Array.isArray(result?.repairTargets) && result.repairTargets.length > 0) {
            state.failureEvidenceDelivered = true;
          }
        }
      }
      const serialized = safeJson(result);
      const readOnlySignature = `${name}:${serialized}`;
      const unchangedReadOnly = READ_ONLY_TOOLS.has(name)
        && state.lastReadOnlySignature === readOnlySignature;
      if (READ_ONLY_TOOLS.has(name)) state.lastReadOnlySignature = readOnlySignature;
      state.toolTrace.push({
        name,
        turn: state.logicalTurns,
        callId: call.id || null,
        ...(args === null ? { argumentsInvalid: true } : { arguments: redactModelValue(args) }),
        ok: result?.ok === true,
        applied: result?.applied === true,
        passed: result?.passed === true,
        result: auditValue(result),
        ...(READ_ONLY_TOOLS.has(name) && result?.path ? { path: result.path } : {}),
        ...(name === 'search_code' && typeof args?.query === 'string' ? { query: args.query.slice(0, 300) } : {}),
        ...(unchangedReadOnly ? { unchanged: true } : {}),
        ...(result?.error ? { error: String(result.error).slice(0, 1_000) } : {}),
        ...(name === 'apply_patch' && Array.isArray(result?.remainingUnresolved) ? { remainingUnresolved: result.remainingUnresolved } : {}),
        ...(name === 'run_tests' ? { test: testTrace(result) } : {}),
      });
      state.flushAudit('tool_result', {
        turn: state.logicalTurns,
        tool: name,
        callId: call.id || null,
        arguments: args,
        result,
        unchanged: unchangedReadOnly,
      });
      messages.push({ role: 'tool', tool_call_id: call.id || `${name}-${state.toolCalls}`, content: serialized });
      if (args === null) {
        messages.push({
          role: 'system',
          content: '上一次工具参数不是合法 JSON。请修正参数格式后继续，不要重复同一只读调用。',
        });
      } else if (unchangedReadOnly) {
        messages.push({
          role: 'system',
          content: '本次只读结果与上一相同调用完全一致，没有产生新证据。请转入 apply_patch 或 run_tests；只有明确的新路径/查询才继续读取。',
        });
      }
      if (name === 'finish' && result?.ok === true) finished = result;
      if (forcedStopReason) break;
    }

    if (forcedStopReason) return finalResult('needs_human', forcedStopReason, state, limits, startedAt, clock);

    if (appliedInTurn && state.remainingUnresolved.length === 0 && !explicitTestInTurn) {
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
      state.failureReadCalls = 0;
      // An automatic verification is still a real verification.  When it
      // exposes a new failure, carry its bounded repair evidence into the
      // next model turn just like an explicit run_tests call.  Without this
      // transition the model regained the full read/search surface after a
      // successful patch, reread the same files, and could spend the rest of
      // the Z.AI request budget exploring instead of fixing the new failure.
      state.failureEvidenceDelivered = state.lastTestPassed !== true
        && ((Array.isArray(automaticTest?.repairTargets) && automaticTest.repairTargets.length > 0)
          || (Array.isArray(automaticTest?.repairSources) && automaticTest.repairSources.length > 0)
          || (automaticTest?.result?.failures?.length > 0));
      state.patchRetryRequired = false;
      state.toolTrace.push({
        name: 'run_tests(auto)',
        turn: state.logicalTurns,
        callId: `auto-test-${state.toolCalls}`,
        ok: automaticTest?.ok === true,
        passed: automaticTest?.passed === true,
        result: auditValue(automaticTest),
        ...(automaticTest?.error ? { error: String(automaticTest.error).slice(0, 1_000) } : {}),
        test: testTrace(automaticTest),
      });
      state.flushAudit('tool_result', {
        turn: state.logicalTurns,
        tool: 'run_tests',
        phase: 'automatic_verification',
        callId: `auto-test-${state.toolCalls}`,
        result: automaticTest,
      });
      messages.push({
        role: 'tool',
        tool_call_id: `auto-test-${state.toolCalls}`,
          content: safeJson({ automatic: true, ...automaticTest }),
      });
      if (automaticTest?.passed !== true && state.failureEvidenceDelivered) {
        messages.push({
          role: 'system',
          content: '自动复测已返回失败报告和相关文件内容；继续使用任何必要的受限工具完成修复。',
        });
      }
    }

    if (!finished && appliedInTurn && state.lastTestPassed === true) {
      return finalResult('repair_complete', null, state, limits, startedAt, clock, {
        summary: '代码修改已应用，隔离相关测试通过，运行时自动完成维修。',
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
  const mutableFiles = [...new Set([
    ...(diagnosis.changedFiles || []),
    ...(diagnosis.merge?.conflictFiles || []),
  ])];
  const tools = createAgentTools({
    cwd,
    revisions: {
      base: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
      pr: diagnosis.pr?.headSha,
      main: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
    },
    allowedFiles,
    mutableFiles,
  });
  const result = await runRepairAgent({
    task: buildAgentTask({ diagnosis, reproduction }),
    client: defaultClient(),
    tools,
    requiresPatch: (reproduction?.remote?.failures || []).length > 0,
  });
  const output = process.env.AGENT_RESULT_PATH || 'pr-repair-agent-result.json';
  writeFileSync(output, `${JSON.stringify({ ...result, model: process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL, changedFiles: tools.snapshot?.().changedFiles || [] }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'ai_unavailable') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
