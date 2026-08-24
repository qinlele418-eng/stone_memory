import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createAgentTools } from './agent-tools.mjs';
import { callZaiChat, DEFAULT_ZAI_MODEL } from './zai-client.mjs';
import { redactErrorMessage, redactModelValue } from './contract.mjs';

export const AGENT_LIMITS = Object.freeze({
  maxLogicalTurns: 26,
  maxApiAttempts: 27,
  maxTokensPerTurn: 16_000,
  // Provider input sizing is configuration, not a history-length policy. The
  // request budget reserves the requested completion, tool schemas, and a
  // safety margin from the provider context window before every API call.
  providerContextTokens: Number(process.env.ZAI_CONTEXT_TOKENS || 128_000),
  toolSchemaTokens: Number(process.env.ZAI_TOOL_SCHEMA_TOKENS || 8_000),
  inputSafetyTokens: Number(process.env.ZAI_INPUT_SAFETY_TOKENS || 4_000),
  maxInputChars: null,
  maxRecentGroups: 6,
  maxToolResultChars: 24_000,
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
  '先用 get_status 和 checkpoint 了解当前事实。冲突必须全部清除后再运行测试；apply_patch 的结果会给出 remainingUnresolved。CI 失败任务的 checkpoint 包含可信测试与远程 CI 证据。根据需要自由读取、搜索、比较 main/pr 版本、修改并验证；不要把重复读取当作修复。git_show_file 必须带 revision（base、pr 或 main），否则用 read_file。',
  'apply_patch 的 patch 参数不要用 Markdown 围栏；可用标准 unified diff，或严格使用 *** Begin Patch、*** Update File: 路径、@@、带 +/- 前缀的行、*** End Patch 格式。',
  '不要输出计划来代替修改，不要输出完整文件，不要为了让测试变绿而削弱或删除测试；如果失败测试本身属于允许的 PR 变更且明确断言了与 current main 合约不一致的旧行为，可以做等价的机械断言迁移。不要修改依赖入口、workflow、权限或凭据。',
  '不要 commit、push、approve、merge、close PR；这些动作由外层机械层完成。',
  '如果证据不足、需要产品决策或无法保守完成，调用 finish(decision="needs_human")。',
  '完成代码修改后，结束前主动用 git_diff 复核最终改动，按 git diff --check 的标准清除行尾空格等空白问题；发现问题先用 apply_patch 修正，再运行相关测试并调用 finish(decision="repair_complete")。不要用普通文本描述下一步。',
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

const AUDIT_BODY_FIELDS = new Set([
  'content', 'log', 'stderr', 'stdout', 'diff', 'patch', 'preview',
  'repairSources', 'failureEvidence', 'relatedFiles', 'references', 'matches', 'query', 'summary', 'reason',
  // Conflict and search responses can embed original source lines under these
  // keys. The artifact only needs to record that content existed, not retain it.
  'ours', 'theirs', 'before', 'after',
]);

function auditSummary(value, field = '') {
  if (typeof value === 'string') {
    if (AUDIT_BODY_FIELDS.has(field)) return { omitted: true, totalChars: value.length };
    return value.length <= 2_000 ? value : { truncated: true, totalChars: value.length, preview: value.slice(0, 2_000) };
  }
  if (Array.isArray(value)) {
    if (AUDIT_BODY_FIELDS.has(field)) return { omitted: true, count: value.length };
    return value.slice(0, 20).map((item) => auditSummary(item));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, auditSummary(item, key)]));
}

function auditValue(value, maxChars = 64_000) {
  const redacted = auditSummary(redactModelValue(value));
  let serialized;
  try { serialized = JSON.stringify(redacted); } catch { return { auditError: '无法序列化审计值' }; }
  if (serialized.length <= maxChars) return redacted;
  return {
    truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

function patchTargetFiles(patch) {
  const files = new Set();
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    const beginPatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    const diffHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    const fileHeader = line.match(/^(?:---|\+\+\+) (.+?)(?:\t.*)?$/);
    if (beginPatch) files.add(beginPatch[1].trim());
    if (diffHeader) {
      files.add(diffHeader[1]);
      files.add(diffHeader[2]);
    }
    if (fileHeader && fileHeader[1] !== '/dev/null') files.add(fileHeader[1].replace(/^[ab]\//, ''));
  }
  return [...files].slice(0, 20);
}

function auditArguments(args, raw = '') {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { invalidJson: true, totalChars: String(raw ?? '').length };
  }
  const values = {};
  for (const [key, value] of Object.entries(args).slice(0, 20)) {
    if (key === 'patch') {
      values[key] = { omitted: true, totalChars: String(value ?? '').length, targetFiles: patchTargetFiles(value) };
    } else if (key === 'path' && typeof value === 'string') {
      values[key] = { targetFile: value, totalChars: value.length };
    } else if (typeof value === 'string') {
      values[key] = { omitted: true, totalChars: value.length };
    } else if (Array.isArray(value)) {
      values[key] = { omitted: true, count: value.length };
    } else if (value && typeof value === 'object') {
      values[key] = { omitted: true, fieldNames: Object.keys(value).slice(0, 20) };
    } else {
      values[key] = value;
    }
  }
  return { fieldNames: Object.keys(args).slice(0, 20), values };
}

function auditModelCall(call) {
  const raw = call?.function?.arguments ?? '';
  return {
    id: call?.id || null,
    name: call?.function?.name || null,
    arguments: auditArguments(toolArguments(call), raw),
  };
}

function omittedModelText(value, label) {
  const totalChars = String(value ?? '').length;
  return totalChars > 0 ? `${label}已省略（${totalChars} chars）` : '';
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

function inputBudgetChars(limits) {
  if (Number.isFinite(limits.maxInputChars) && limits.maxInputChars > 0) return Math.floor(limits.maxInputChars);
  const inputTokens = Math.max(1, Number(limits.providerContextTokens || 0)
    - Number(limits.maxTokensPerTurn || 0)
    - Number(limits.toolSchemaTokens || 0)
    - Number(limits.inputSafetyTokens || 0));
  // Mixed Chinese/ASCII input can approach one token per character. Use that
  // conservative ceiling unless a synthetic character budget is explicit.
  return inputTokens;
}

function boundedValue(value, maxChars) {
  const serialized = safeJson(value);
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, Math.max(0, maxChars - 180)),
    continuation: 'Historical payload omitted; use the tool again for an exact safe page.',
  };
}

function checkpointState(snapshot, workState, limits) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const current = {
    taskKind: workState.taskKind || source.taskKind || null,
    baseSha: workState.baseSha || source.baseSha || null,
    headSha: workState.headSha || source.headSha || source.prSha || null,
    currentMainSha: workState.currentMainSha || source.currentMainSha || source.mainSha || null,
    mutableFiles: source.mutableFiles || workState.mutableFiles || [],
    unresolvedConflicts: workState.unresolvedConflicts || source.unresolvedConflicts || source.unresolved || [],
    changedFiles: workState.changedFiles || source.changedFiles || [],
    currentDiff: workState.currentDiff || source.currentDiff || null,
    latestTestSummary: workState.latestTestSummary || source.latestTestSummary || null,
    latestFailureSummary: workState.latestFailureSummary || source.latestFailureSummary || null,
    latestRemoteCiSummary: workState.latestRemoteCiSummary || source.latestRemoteCiSummary || null,
    recentFileViews: workState.recentFileViews || source.recentFileViews || [],
    lastPatchResult: workState.lastPatchResult || source.lastPatchResult || null,
  };
  return boundedValue(current, Math.max(1_200, Math.floor(inputBudgetChars(limits) * 0.35)));
}

function compactMessages(messages, snapshot, workState, definitions, limits) {
  const base = messages.slice(0, 2);
  const groups = groupConversation(messages);
  let checkpoint = {
    role: 'system',
    content: `Runtime checkpoint（旧工具结果已压缩，仅保留当前事实）：${safeJson(checkpointState(snapshot, workState, limits))}`,
  };
  const budget = inputBudgetChars(limits);
  const kept = [];
  for (let index = groups.length - 1; index >= 0 && kept.length < limits.maxRecentGroups; index -= 1) {
    const group = groups[index];
    kept.unshift(group);
    const candidate = [...base, checkpoint, ...kept.flat()];
    if (safeJson({ messages: candidate, tools: definitions, maxTokens: limits.maxTokensPerTurn }).length > budget) {
      kept.shift();
      break;
    }
  }
  let result = [...base, checkpoint, ...kept.flat()];
  let serializedChars = safeJson({ messages: result, tools: definitions, maxTokens: limits.maxTokensPerTurn }).length;
  if (serializedChars > budget) {
    const baseChars = safeJson({ messages: base, tools: definitions, maxTokens: limits.maxTokensPerTurn }).length;
    const availableCheckpointChars = Math.max(256, budget - baseChars - 120);
    checkpoint = {
      role: 'system',
      content: `Runtime checkpoint（仅保留身份与最新状态）：${safeJson(boundedValue(checkpointState(snapshot, workState, limits), availableCheckpointChars))}`,
    };
    result = [...base, checkpoint];
    serializedChars = safeJson({ messages: result, tools: definitions, maxTokens: limits.maxTokensPerTurn }).length;
  }
  return {
    messages: result,
    budget,
    serializedChars,
    compactedGroups: Math.max(0, groups.length - kept.length),
    retainedGroups: kept.length,
    checkpointChars: safeJson(checkpoint).length,
    overBudget: serializedChars > budget,
  };
}

function metrics(state, limits, startedAt, clock = nowMs) {
  return {
    logicalTurns: state.logicalTurns,
    apiAttempts: state.apiAttempts,
    completionTokens: state.completionTokens,
    transientApiRecoveries: state.transientApiRecoveries,
    readOnlyCalls: state.readOnlyCalls,
    patchCalls: state.patchCalls,
    successfulPatchCalls: state.successfulPatchCalls,
    testCalls: state.testCalls,
    toolCalls: state.toolCalls,
    maxLogicalTurns: limits.maxLogicalTurns,
    maxApiAttempts: limits.maxApiAttempts,
    maxTokensPerTurn: limits.maxTokensPerTurn,
    providerContextTokens: limits.providerContextTokens,
    inputBudgetChars: inputBudgetChars(limits),
    contextHighWaterChars: state.contextHighWaterChars,
    contextCompactions: state.contextCompactions,
    largestToolResultChars: state.largestToolResultChars,
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

function isRecoverableApiError(error) {
  return error?.code === 'timeout'
    || error?.retryable === true
    || [408, 429, 500, 502, 503, 504].includes(Number(error?.status));
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
  initialWorkState = {},
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
    transientApiRecoveries: 0,
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
    formatRepairAttempts: 0,
    formatCorrectionPending: false,
    rejectedToolCalls: 0,
    requirePatch: Boolean(requiresPatch),
    lastReadOnlySignature: null,
    workState: { recentFileViews: [], ...initialWorkState },
    contextHighWaterChars: 0,
    contextCompactions: 0,
    largestToolResultChars: 0,
  };
  state.flushAudit = (type, payload = {}) => {
    const event = {
      sequence: state.auditTrace.length + 1,
      atMs: clock(),
      type,
      payload: auditValue(payload, 16_000),
    };
    // The result file keeps a small diagnostic index. The append-only JSONL
    // stream is the complete redacted audit and is never used as model memory.
    state.auditTrace.push(event);
    if (!state.auditPath) return;
    try {
      appendFileSync(state.auditPath, `${JSON.stringify({ version: 2, ...event })}\n`, 'utf8');
    } catch (error) {
      state.auditWriteError = redactErrorMessage(error);
    }
  };
  const messages = [
    { role: 'system', content: REPAIR_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: String(task || '').slice(0, 24_000) },
  ];
  const updateWorkState = (name, result) => {
    if (!result || typeof result !== 'object') return;
    if (name === 'get_status') {
      state.workState.baseSha = result.baseSha || state.workState.baseSha;
      state.workState.headSha = result.prSha || result.headSha || state.workState.headSha;
      state.workState.currentMainSha = result.mainSha || state.workState.currentMainSha;
      if (Array.isArray(result.unresolved)) state.workState.unresolvedConflicts = result.unresolved;
    }
    if (name === 'read_file' && result.path) {
      const view = { path: result.path, startLine: result.startLine, endLine: result.endLine, content: boundedValue(result.content || '', 4_000) };
      const prior = (state.workState.recentFileViews || []).filter((item) => item.path !== result.path);
      state.workState.recentFileViews = [...prior, view].slice(-6);
    }
    if (name === 'git_diff') state.workState.currentDiff = boundedValue(result.diff || '', 8_000);
    if (name === 'apply_patch') {
      state.workState.lastPatchResult = boundedValue(result, 4_000);
      if (Array.isArray(result.changedFiles)) state.workState.changedFiles = result.changedFiles;
      if (Array.isArray(result.remainingUnresolved)) state.workState.unresolvedConflicts = result.remainingUnresolved;
    }
    if (name === 'run_tests') {
      state.workState.latestTestSummary = boundedValue({ passed: result.passed, result: result.result, stderr: result.stderr }, 8_000);
      state.workState.latestFailureSummary = result.passed === true ? null : boundedValue({ failures: result?.result?.failures || [], repairTargets: result.repairTargets || [] }, 6_000);
    }
  };
  const modelToolResult = (result) => {
    const serialized = safeJson(result);
    state.largestToolResultChars = Math.max(state.largestToolResultChars, serialized.length);
    return safeJson(boundedValue(result, limits.maxToolResultChars));
  };
  const requestFormatCorrection = async () => {
    if (typeof tools.checkFinalDiff !== 'function') return { clean: true };
    state.toolCalls += 1;
    state.readOnlyCalls += 1;
    state.toolSequence.push('check_diff(final)');
    let result;
    try {
      result = await tools.checkFinalDiff();
    } catch (error) {
      result = { ok: false, checkedFiles: [], errors: [redactErrorMessage(error)] };
    }
    state.workState.finalDiffCheck = boundedValue(result, 4_000);
    state.toolTrace.push({
      name: 'check_diff(final)',
      turn: state.logicalTurns,
      ok: result?.ok === true,
      result: auditValue(result),
      ...(result?.errors?.length ? { error: result.errors.join('\n').slice(0, 4_000) } : {}),
    });
    state.flushAudit('tool_result', {
      turn: state.logicalTurns,
      tool: 'check_diff',
      phase: 'final_validation',
      result,
    });
    if (result?.ok === true) return { clean: true };
    if (state.formatRepairAttempts >= 1) return { clean: false, exhausted: true, result };
    state.formatRepairAttempts += 1;
    state.formatCorrectionPending = true;
    state.lastTestPassed = false;
    state.pendingVerification = true;
    const errors = Array.isArray(result?.errors) && result.errors.length > 0
      ? result.errors.join('\n')
      : 'git diff --check 未通过，但没有返回可显示的错误文本';
    messages.push({
      role: 'user',
      content: [
        '你上一轮修改造成了机械格式检查失败。当前修改尚未提交，请在同一 repair worktree 中自己修正。',
        `受影响文件：${(result?.checkedFiles || []).join(', ') || '未知'}`,
        '具体错误：',
        errors,
        '只修复这些格式问题；修完后重新运行相关测试，再完成维修。',
      ].join('\n'),
    });
    state.flushAudit('format_repair_feedback', {
      turn: state.logicalTurns,
      attempt: state.formatRepairAttempts,
      checkedFiles: result?.checkedFiles || [],
      errors: result?.errors || [],
    });
    return { clean: false, retry: true, result };
  };

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
    updateWorkState('get_status', initialStatus);
    if (Array.isArray(initialStatus?.unresolved)) state.remainingUnresolved = initialStatus.unresolved;
    const trustedCiFailure = state.workState.taskKind === 'ci_failure'
      && state.workState.trustedFailureEvidence === true;
    if (initialStatus?.ok === true && state.remainingUnresolved.length === 0 && !trustedCiFailure) {
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
      updateWorkState('run_tests', initialTest);
    }
  }

  while (true) {
    const limitReason = exceeded(state, limits, startedAt, clock);
    if (limitReason) return finalResult('needs_human', limitReason, state, limits, startedAt, clock);

    state.logicalTurns += 1;
    let completion;
    try {
      while (true) {
        const request = compactMessages(messages, tools.snapshot?.() || {}, state.workState, tools.definitions, limits);
        state.contextHighWaterChars = Math.max(state.contextHighWaterChars, request.serializedChars);
        state.contextCompactions += request.compactedGroups;
        state.flushAudit('request_context', {
          turn: state.logicalTurns,
          serializedChars: request.serializedChars,
          inputBudgetChars: request.budget,
          checkpointChars: request.checkpointChars,
          retainedRecentGroups: request.retainedGroups,
          compactedGroups: request.compactedGroups,
        });
        if (request.overBudget) {
          return finalResult('needs_human', '配置的 provider 输入预算不足以容纳系统提示和受限工具契约', state, limits, startedAt, clock);
        }
        completion = await client.complete({
          messages: request.messages,
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
      if (isRecoverableApiError(error)) {
        state.transientApiRecoveries += 1;
        state.flushAudit('api_recovery', {
          turn: state.logicalTurns,
          recovery: state.transientApiRecoveries,
        });
        continue;
      }
      return finalResult('ai_unavailable', redactErrorMessage(error), state, limits, startedAt, clock);
    }

    const message = completion?.message || {};
    const isFormatCorrectionTurn = state.formatCorrectionPending;
    state.formatCorrectionPending = false;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    state.turnTrace.push({
      turn: state.logicalTurns,
      apiAttempts: state.apiAttempts,
      completionTokens: Number(completion?.usage?.completion_tokens || 0),
      content: auditSummary(message.content, 'content'),
      calls: calls.map(auditModelCall),
    });
    state.flushAudit('model_response', {
      turn: state.logicalTurns,
      content: message.content,
      calls: calls.map(auditModelCall),
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
    let patchNeedsVerification = false;
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
            patchNeedsVerification = true;
          }
          if (name === 'run_tests') {
            state.lastTestPassed = result?.passed === true;
            state.pendingVerification = false;
            patchNeedsVerification = false;
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
      updateWorkState(name, result);
      const serialized = modelToolResult(result);
      const readOnlySignature = `${name}:${serialized}`;
      const unchangedReadOnly = READ_ONLY_TOOLS.has(name)
        && state.lastReadOnlySignature === readOnlySignature;
      if (READ_ONLY_TOOLS.has(name)) state.lastReadOnlySignature = readOnlySignature;
      state.toolTrace.push({
        name,
        turn: state.logicalTurns,
        callId: call.id || null,
        ...(args === null ? { argumentsInvalid: true } : { arguments: auditArguments(args, call.function.arguments) }),
        ok: result?.ok === true,
        applied: result?.applied === true,
        passed: result?.passed === true,
        result: auditValue(result),
        ...(READ_ONLY_TOOLS.has(name) && result?.path ? { path: result.path } : {}),
        ...(name === 'search_code' && typeof args?.query === 'string' ? { queryChars: args.query.length } : {}),
        ...(unchangedReadOnly ? { unchanged: true } : {}),
        ...(result?.error ? { error: String(result.error).slice(0, 1_000) } : {}),
        ...(name === 'apply_patch' && Array.isArray(result?.remainingUnresolved) ? { remainingUnresolved: result.remainingUnresolved } : {}),
        ...(name === 'run_tests' ? { test: testTrace(result) } : {}),
      });
      state.flushAudit('tool_result', {
        turn: state.logicalTurns,
        tool: name,
        callId: call.id || null,
        arguments: auditArguments(args, call.function.arguments),
        result,
        unchanged: unchangedReadOnly,
      });
      messages.push({ role: 'tool', tool_call_id: call.id || `${name}-${state.toolCalls}`, content: serialized });
      // Bad arguments and duplicate reads remain visible in the tool result
      // and audit. Do not inject behavioural nag messages into model memory.
      if (name === 'finish' && result?.ok === true) finished = result;
      if (forcedStopReason) break;
    }

    if (forcedStopReason) return finalResult('needs_human', forcedStopReason, state, limits, startedAt, clock);

    if (patchNeedsVerification && state.remainingUnresolved.length === 0) {
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
      updateWorkState('run_tests', automaticTest);
      messages.push({
        role: 'tool',
        tool_call_id: `auto-test-${state.toolCalls}`,
        content: modelToolResult({ automatic: true, ...automaticTest }),
      });
    }

    if (isFormatCorrectionTurn && (!appliedInTurn || state.lastTestPassed !== true)) {
      return finalResult('needs_human', '格式反馈后的唯一修正回合没有产出通过验证的修复', state, limits, startedAt, clock);
    }

    if (!finished && appliedInTurn && state.lastTestPassed === true) {
      const formatCheck = await requestFormatCorrection();
      if (formatCheck.retry) continue;
      if (formatCheck.exhausted) {
        return finalResult('needs_human', '模型第二次修改后格式检查仍未通过', state, limits, startedAt, clock);
      }
      return finalResult('repair_complete', null, state, limits, startedAt, clock, {
        summary: '代码修改已应用，隔离相关测试通过，运行时自动完成维修。',
      });
    }

    if (finished) {
      if (finished.status === 'repair_complete') {
        const formatCheck = await requestFormatCorrection();
        if (formatCheck.retry) continue;
        if (formatCheck.exhausted) {
          return finalResult('needs_human', '模型第二次修改后格式检查仍未通过', state, limits, startedAt, clock);
        }
        return finalResult('repair_complete', null, state, limits, startedAt, clock, {
          summary: omittedModelText(finished.summary, '模型完成说明'),
        });
      }
      return finalResult('needs_human', omittedModelText(finished.reason || finished.summary, '模型人工处理说明') || '模型请求人工处理', state, limits, startedAt, clock, {
        summary: omittedModelText(finished.summary, '模型完成说明'),
      });
    }
  }
}

function defaultClient({ apiKey = process.env.ZAI_API_KEY, model = process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL } = {}) {
  return {
    complete: (input) => callZaiChat({ ...input, apiKey, model }),
  };
}

export function trustedFailurePaths(failures = []) {
  const paths = [];
  for (const failure of failures) {
    if (typeof failure?.file === 'string') paths.push(failure.file);
    const text = `${failure?.name || ''}\n${failure?.summary || ''}\n${failure?.log || ''}`;
    for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:c?m?js|json|css|md|test\.[A-Za-z0-9]+))/g)) {
      paths.push(match[1]);
    }
  }
  return [...new Set(paths.filter((path) => (
    !path.startsWith('/')
    && !path.split('/').includes('..')
    && !/(?:^|\/)(?:\.git|node_modules)(?:\/|$)|(?:^|\/)\.env(?:[./]|$)/.test(path)
  )))];
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
  const trustedFailures = [
    ...(reproduction?.pr?.result?.failures || []),
    ...(reproduction?.remote?.failures || []),
    ...(diagnosis?.checks?.failureEvidence || []),
  ];
  const knownFailureFiles = trustedFailurePaths(trustedFailures);
  const knownFailingTestFiles = knownFailureFiles
    .filter((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(file)
      || /\.(?:test|spec)\.[^/]+$/i.test(file));
  const trustedFailureEvidence = reproduction?.relation === 'pr_related_failure'
    && trustedFailures.length > 0;
  const tools = createAgentTools({
    cwd,
    revisions: {
      base: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
      pr: diagnosis.pr?.headSha,
      main: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
    },
    allowedFiles,
    mutableFiles,
    knownFailingTestFiles,
    knownFailureFiles,
    initialFailureEvidence: trustedFailureEvidence ? trustedFailures : [],
  });
  const result = await runRepairAgent({
    task: buildAgentTask({ diagnosis, reproduction }),
    client: defaultClient(),
    tools,
    requiresPatch: (reproduction?.remote?.failures || []).length > 0,
    initialWorkState: {
      taskKind: diagnosis?.nextAction === 'ai_conflict' ? 'merge_conflict' : 'ci_failure',
      baseSha: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
      headSha: diagnosis.pr?.headSha,
      currentMainSha: diagnosis.currentMainSha || diagnosis.pr?.baseSha,
      mutableFiles,
      latestRemoteCiSummary: reproduction?.remote?.failures || diagnosis?.checks?.failureEvidence || [],
      latestFailureSummary: trustedFailureEvidence ? { failures: trustedFailures } : null,
      latestTestSummary: trustedFailureEvidence ? {
        passed: reproduction?.pr?.passed === true,
        command: reproduction?.pr?.command,
        result: reproduction?.pr?.result || null,
      } : null,
      trustedFailureEvidence,
    },
  });
  const output = process.env.AGENT_RESULT_PATH || 'pr-repair-agent-result.json';
  writeFileSync(output, `${JSON.stringify({ ...result, model: process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL, changedFiles: tools.snapshot?.().changedFiles || [] }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'ai_unavailable') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
