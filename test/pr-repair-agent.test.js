import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_LIMITS, runRepairAgent, trustedFailurePaths } from '../.github/pr-repair/agent-runtime.mjs';
import { callZaiChat, DEFAULT_AGENT_MAX_TOKENS } from '../.github/pr-repair/zai-client.mjs';
import { createAgentTools } from '../.github/pr-repair/agent-tools.mjs';
import { runGit } from '../.github/pr-repair/git.mjs';

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scriptedClient(messages) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      const message = messages[index++];
      if (!message) throw new Error('scripted client ran out of responses');
      return { message, usage: { completion_tokens: 20 }, attempts: 1 };
    },
  };
}

function fakeTools({ remainingUnresolved = [] } = {}) {
  const calls = [];
  let lastTestPassed = false;
  let patchIndex = 0;
  return {
    calls,
    definitions: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'read_file') return { ok: true, content: 'const value = 1;\n' };
      if (name === 'apply_patch') {
        const unresolved = remainingUnresolved[patchIndex++] || [];
        return { ok: true, applied: true, changedFiles: ['src/example.js'], remainingUnresolved: unresolved };
      }
      if (name === 'run_tests') {
        lastTestPassed = true;
        return { ok: true, passed: true, result: { passed: 1, failed: 0 } };
      }
      if (name === 'finish') return { ok: true, status: args.decision, summary: args.summary };
      throw new Error(`unknown tool ${name}`);
    },
    snapshot() {
      return { readOnlyCalls: calls.filter(([name]) => name === 'read_file').length, patchCalls: calls.filter(([name]) => name === 'apply_patch').length, testCalls: calls.filter(([name]) => name === 'run_tests').length, lastTestPassed };
    },
  };
}

test('agent keeps one conversation and uses a bounded inspect-edit-test-finish loop', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/example.js', start_line: 1, end_line: 20 })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'apply_patch', { patch: 'diff --git a/src/example.js b/src/example.js\n' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'run_tests', { mode: 'related' })] },
    { role: 'assistant', tool_calls: [toolCall('4', 'finish', { decision: 'repair_complete', summary: '已修复并通过测试' })] },
  ]);
  const result = await runRepairAgent({
    task: '处理当前 main 与 PR 的冲突，直接修改代码并测试。',
    client,
    tools: fakeTools(),
  });

  assert.equal(result.status, 'repair_complete');
  assert.equal(result.metrics.logicalTurns, 2);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.at(-1).role, 'tool');
  assert.equal(result.metrics.maxLogicalTurns, AGENT_LIMITS.maxLogicalTurns);
});

test('runtime seeds initial failure evidence before model exploration', async () => {
  const calls = [];
  let testCalls = 0;
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'get_status', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'get_status') return { ok: true, unresolved: [] };
      if (name === 'run_tests') {
        testCalls += 1;
        return testCalls === 1
          ? {
            ok: true,
            passed: false,
            repairTargets: ['src/theme.js'],
            repairSources: [{ path: 'src/theme.js', content: 'const preset = "legacy";' }],
            result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'legacy' }] },
          }
          : { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      }
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/theme.js'], remainingUnresolved: [] };
      if (name === 'finish') return { ok: true, status: args.decision, summary: args.summary };
      return { ok: true, content: 'source' };
    },
    snapshot() { return {}; },
  };
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'apply_patch', { patch: 'diff --git a/src/theme.js b/src/theme.js\n' })] },
  ]);
  const result = await runRepairAgent({ task: '修复 CI 失败', client, tools, requiresPatch: true });

  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(calls.map(([name]) => name), ['get_status', 'run_tests', 'apply_patch', 'run_tests']);
  const checkpoint = client.calls[0].messages.find((message) => message.role === 'system' && /Runtime checkpoint/.test(message.content));
  assert.match(checkpoint.content, /latestTestSummary/);
  assert.match(checkpoint.content, /src\/theme\.js/);
  assert.equal(result.metrics.toolTrace[1].name, 'run_tests(initial)');
  assert.equal(result.metrics.toolTrace[2].name, 'apply_patch');
  assert.equal(result.metrics.successfulPatchCalls, 1);
});

test('trusted CI evidence skips initial testing and seeds the first related verification', async () => {
  const calls = [];
  const tools = {
    definitions: ['get_status', 'read_file', 'apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'get_status') return { ok: true, baseSha: 'base-sha', prSha: 'head-sha', mainSha: 'main-sha', unresolved: [] };
      if (name === 'read_file') return { ok: true, path: 'src/adapter.js', content: 'old contract' };
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/adapter.js'], remainingUnresolved: [] };
      return { ok: true, passed: true, mode: 'related', result: { total: 1, passed: 1, failed: 0, failures: [] } };
    },
    snapshot() { return { mutableFiles: ['src/adapter.js'], lastFailingTestFiles: ['test/adapter.test.js'] }; },
  };
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('read-main', 'read_file', { path: 'src/adapter.js' })] },
    { role: 'assistant', tool_calls: [toolCall('patch', 'apply_patch', { patch: 'diff --git a/src/adapter.js b/src/adapter.js\n' })] },
  ]);
  const result = await runRepairAgent({
    task: '修复可信 CI 失败', client, tools, requiresPatch: true,
    initialWorkState: {
      taskKind: 'ci_failure',
      trustedFailureEvidence: true,
      baseSha: 'base-sha', headSha: 'head-sha', currentMainSha: 'main-sha',
      latestFailureSummary: { failures: [{ file: 'test/adapter.test.js', error: 'old contract' }] },
      latestTestSummary: { passed: false, result: { failed: 1 } },
      latestRemoteCiSummary: [{ name: 'Test / Windows', conclusion: 'failure' }],
    },
  });

  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(calls.map(([name]) => name), ['get_status', 'read_file', 'apply_patch', 'run_tests']);
  const checkpoint = client.calls[0].messages.find((message) => /Runtime checkpoint/.test(message.content));
  assert.match(checkpoint.content, /main-sha/);
  assert.match(checkpoint.content, /head-sha/);
  assert.match(checkpoint.content, /test\/adapter\.test\.js/);
});

test('transient Z.AI timeout resumes the repair loop with preserved evidence', async () => {
  const calls = [];
  let modelCalls = 0;
  let testCalls = 0;
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'get_status', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
    ],
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'get_status') return { ok: true, unresolved: [] };
      if (name === 'run_tests') {
        testCalls += 1;
        return testCalls === 1
          ? { ok: true, passed: false, repairTargets: ['src/theme.js'], repairSources: [{ path: 'src/theme.js', content: 'legacy' }], result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'legacy' }] } }
          : { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      }
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/theme.js'], remainingUnresolved: [] };
      throw new Error(`unknown tool ${name}`);
    },
    snapshot() { return {}; },
  };
  const client = {
    calls: [],
    async complete(input) {
      this.calls.push(input);
      modelCalls += 1;
      if (modelCalls === 1) {
        const error = new Error('temporary timeout');
        error.code = 'timeout';
        throw error;
      }
      return { message: { role: 'assistant', tool_calls: [toolCall('patch-after-timeout', 'apply_patch', { patch: '*** Update File: src/theme.js\nfixed\n' })] }, usage: { completion_tokens: 20 }, attempts: 1 };
    },
  };
  const result = await runRepairAgent({ task: '修复 CI 失败', client, tools, requiresPatch: true });

  assert.equal(result.status, 'repair_complete');
  assert.equal(result.metrics.transientApiRecoveries, 1);
  assert.deepEqual(calls.map(([name]) => name), ['get_status', 'run_tests', 'apply_patch', 'run_tests']);
  assert.ok(result.metrics.auditTrace.some((event) => event.type === 'api_recovery'));
});

test('runtime audit trace preserves argument metadata and unchanged results without query bodies', async () => {
  const auditDirectory = await mkdtemp(join(tmpdir(), 'stone-memory-agent-audit-'));
  const auditPath = join(auditDirectory, 'agent-audit.json');
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('search-1', 'search_code', { query: 'legacy-name', path: 'src' })] },
    { role: 'assistant', tool_calls: [toolCall('search-2', 'search_code', { query: 'legacy-name', path: 'src' })] },
    { role: 'assistant', tool_calls: [toolCall('finish-1', 'finish', { decision: 'needs_human', reason: '证据不足' })] },
  ]);
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'search_code', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name, args) {
      if (name === 'search_code') return { ok: true, query: args.query, path: args.path, matches: 'src/example.js:1:legacy-name' };
      return { ok: true, status: args.decision, reason: args.reason };
    },
    snapshot() { return {}; },
  };
  const result = await runRepairAgent({ task: '审计重复搜索', client, tools, auditPath });

  assert.equal(result.status, 'needs_human');
  const [first, second, finish] = result.metrics.toolTrace;
  assert.deepEqual(first.arguments, {
    fieldNames: ['query', 'path'],
    values: {
      query: { omitted: true, totalChars: 'legacy-name'.length },
      path: { targetFile: 'src', totalChars: 'src'.length },
    },
  });
  assert.equal(first.queryChars, 'legacy-name'.length);
  assert.equal(second.unchanged, true);
  assert.deepEqual(second.result.matches, { omitted: true, totalChars: 'src/example.js:1:legacy-name'.length });
  assert.equal(finish.callId, 'finish-1');
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(audit.some((event) => event.type === 'final'));
  assert.equal(result.metrics.auditSchemaVersion, 1);
  assert.ok(audit.some((event) => event.type === 'model_response'));
  await rm(auditDirectory, { recursive: true, force: true });
});

test('append-only audit records payload metadata without persisting file content', async () => {
  const auditDirectory = await mkdtemp(join(tmpdir(), 'stone-memory-agent-audit-content-'));
  const auditPath = join(auditDirectory, 'agent-audit.jsonl');
  const privateContent = 'private-source-content-must-not-enter-artifact';
  const privateSearchMatch = 'private-search-match-must-not-enter-artifact';
  const privateConflictLine = 'private-conflict-line-must-not-enter-artifact';
  const tools = {
    definitions: ['read_file', 'search_code', 'get_status', 'finish'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name, args) {
      if (name === 'read_file') return { ok: true, path: 'src/example.js', content: privateContent };
      if (name === 'search_code') return { ok: true, matches: privateSearchMatch };
      if (name === 'get_status') return { ok: true, conflictDetails: [{ path: 'src/example.js', ours: privateConflictLine, theirs: privateConflictLine, before: privateConflictLine, after: privateConflictLine }] };
      return { ok: true, status: args.decision };
    },
    snapshot() { return {}; },
  };
  await runRepairAgent({
    task: 'audit privacy', tools, auditPath,
    client: scriptedClient([
      { role: 'assistant', tool_calls: [toolCall('read', 'read_file', { path: 'src/example.js' })] },
      { role: 'assistant', tool_calls: [toolCall('search', 'search_code', { query: 'secret' })] },
      { role: 'assistant', tool_calls: [toolCall('status', 'get_status', {})] },
      { role: 'assistant', tool_calls: [toolCall('finish', 'finish', { decision: 'needs_human', reason: 'stop' })] },
    ]),
  });
  const audit = await readFile(auditPath, 'utf8');
  assert.doesNotMatch(audit, new RegExp(privateContent));
  assert.doesNotMatch(audit, new RegExp(privateSearchMatch));
  assert.doesNotMatch(audit, new RegExp(privateConflictLine));
  assert.match(audit, /"omitted":true/);
  await rm(auditDirectory, { recursive: true, force: true });
});

test('artifacts omit model patch and source bodies while apply_patch receives the original patch', async () => {
  const auditDirectory = await mkdtemp(join(tmpdir(), 'stone-memory-agent-audit-model-body-'));
  const auditPath = join(auditDirectory, 'agent-audit.jsonl');
  const privatePatch = 'private-patch-body-must-not-enter-artifact';
  const privateModelText = 'private-model-body-must-not-enter-artifact';
  let appliedPatch = null;
  const tools = {
    definitions: ['apply_patch', 'run_tests', 'finish'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name, args) {
      if (name === 'apply_patch') {
        appliedPatch = args.patch;
        return { ok: true, applied: true, changedFiles: ['src/example.js'], remainingUnresolved: [] };
      }
      if (name === 'run_tests') return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0 } };
      return { ok: true, status: args.decision };
    },
    snapshot() { return {}; },
  };
  const result = await runRepairAgent({
    task: 'artifact privacy', tools, auditPath,
    client: scriptedClient([
      { role: 'assistant', content: privateModelText, tool_calls: [toolCall('patch', 'apply_patch', { patch: privatePatch, path: 'src/example.js' })] },
      { role: 'assistant', tool_calls: [toolCall('finish', 'finish', { decision: 'repair_complete', reason: 'verified' })] },
    ]),
  });
  assert.equal(appliedPatch, privatePatch);
  const artifact = `${await readFile(auditPath, 'utf8')}\n${JSON.stringify(result)}`;
  assert.doesNotMatch(artifact, new RegExp(privatePatch));
  assert.doesNotMatch(artifact, new RegExp(privateModelText));
  assert.match(artifact, /"patch"/);
  assert.match(artifact, /"totalChars":/);
  await rm(auditDirectory, { recursive: true, force: true });
});

test('artifacts omit model finish summaries and reasons', async () => {
  const auditDirectory = await mkdtemp(join(tmpdir(), 'stone-memory-agent-audit-finish-body-'));
  const auditPath = join(auditDirectory, 'agent-audit.jsonl');
  const privateSummary = 'private-finish-summary-must-not-enter-artifact';
  const privateReason = 'private-finish-reason-must-not-enter-artifact';
  const result = await runRepairAgent({
    task: 'finish privacy', auditPath,
    tools: {
      definitions: [{ type: 'function', function: { name: 'finish', parameters: { type: 'object' } } }],
      async call(name, args) { return { ok: true, status: args.decision, summary: args.summary, reason: args.reason }; },
      snapshot() { return {}; },
    },
    client: scriptedClient([
      { role: 'assistant', tool_calls: [toolCall('finish', 'finish', { decision: 'needs_human', summary: privateSummary, reason: privateReason })] },
    ]),
  });
  const artifact = `${await readFile(auditPath, 'utf8')}\n${JSON.stringify(result)}`;
  assert.doesNotMatch(artifact, new RegExp(privateSummary));
  assert.doesNotMatch(artifact, new RegExp(privateReason));
  assert.match(result.reason, /模型人工处理说明已省略/);
  await rm(auditDirectory, { recursive: true, force: true });
});

test('conservative provider budget refuses an oversized Chinese request before the API call', async () => {
  let calls = 0;
  const result = await runRepairAgent({
    task: '中文维修任务',
    tools: { definitions: [], async call() { throw new Error('unused'); }, snapshot() { return {}; } },
    client: { async complete() { calls += 1; throw new Error('must not call'); } },
    limits: { ...AGENT_LIMITS, providerContextTokens: 23_000, maxTokensPerTurn: 16_000, toolSchemaTokens: 4_000, inputSafetyTokens: 2_000 },
  });
  assert.equal(result.status, 'needs_human');
  assert.equal(calls, 0);
});

test('runtime forwards a complete tool result to the next model turn', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('read-1', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('finish-1', 'finish', { decision: 'needs_human', reason: 'done' })] },
  ]);
  const fullContent = 'evidence-'.repeat(3_000);
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name) {
      if (name === 'read_file') return { ok: true, path: 'src/example.js', content: fullContent };
      return { ok: true, status: 'needs_human' };
    },
    snapshot() { return {}; },
  };
  await runRepairAgent({ task: '保留完整证据', client, tools });
  const toolMessage = client.calls[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.length > 16_000);
  assert.match(toolMessage.content, /evidence-evidence/);
});

test('agent records and accepts a model completion without a runtime call gate', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'finish', { decision: 'repair_complete', summary: '过早完成' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('4', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('5', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('6', 'read_file', { path: 'src/example.js' })] },
  ]);
  const result = await runRepairAgent({ task: '修复冲突', client, tools: fakeTools(), limits: { ...AGENT_LIMITS, maxLogicalTurns: 5 } });

  assert.equal(result.status, 'repair_complete');
  assert.equal(result.metrics.logicalTurns, 2);
  assert.equal(result.metrics.toolTrace[1].name, 'finish');
  assert.equal(result.metrics.toolTrace[1].result.status, 'repair_complete');
});

test('failed tests get bundled source evidence while retaining a bounded repair loop', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'test/theme.test.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'run_tests', { mode: 'related' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'apply_patch', { patch: 'diff --git a/src/theme.js b/src/theme.js\n' })] },
  ]);
  let testCalls = 0;
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name) {
      if (name === 'read_file') return { ok: true, path: 'src/theme.js', repairTargets: ['src/theme.js'], content: 'const prefix = "--legacy-contract-";\n', relatedFiles: [{ path: 'src/theme.js', content: '...' }] };
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/theme.js'], remainingUnresolved: [] };
      if (name === 'run_tests') {
        testCalls += 1;
        return testCalls === 1
          ? { ok: true, passed: false, result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'legacy-contract' }] } }
          : { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      }
      return { ok: true, status: 'needs_human' };
    },
    snapshot() { return {}; },
  };
  const result = await runRepairAgent({ task: '修复 CI 失败', client, tools, limits: { ...AGENT_LIMITS, maxExploreTurns: 2 } });

  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(result.metrics.toolSequence, ['read_file', 'run_tests', 'apply_patch', 'run_tests(auto)']);
  const failureTools = client.calls[2].tools.map((tool) => tool.function.name);
  assert.equal(failureTools.includes('read_file'), true);
  assert.equal(failureTools.includes('apply_patch'), true);
});

test('automatic failed verification locks the next turn onto the new repair evidence', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/theme.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'apply_patch', { patch: 'diff --git a/src/theme.js b/src/theme.js\n' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'apply_patch', { patch: 'diff --git a/test/theme.test.js b/test/theme.test.js\n' })] },
  ]);
  let testCalls = 0;
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name) {
      if (name === 'read_file') return { ok: true, path: 'src/theme.js', repairTargets: ['src/theme.js'], content: 'const prefix = "--stone-theme-";\n' };
      if (name === 'apply_patch') {
        return { ok: true, applied: true, changedFiles: ['src/theme.js'], remainingUnresolved: [] };
      }
      if (name === 'run_tests') {
        testCalls += 1;
        return testCalls === 1
          ? {
            ok: true,
            passed: false,
            repairTargets: [],
            repairSources: [{ path: 'test/theme.test.js', content: 'legacy-contract', role: 'failing-test-evidence' }],
            result: { total: 2, passed: 1, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'legacy-contract' }] },
          }
          : { ok: true, passed: true, result: { total: 2, passed: 2, failed: 0, failures: [] } };
      }
      return { ok: true, status: 'needs_human' };
    },
    snapshot() { return {}; },
  };
  const result = await runRepairAgent({ task: '修复 CI 失败', client, tools });

  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(result.metrics.toolSequence, ['read_file', 'apply_patch', 'run_tests(auto)', 'apply_patch', 'run_tests(auto)']);
  assert.equal(client.calls[2].tools.some((tool) => tool.function.name === 'read_file'), true);
  assert.equal(client.calls[2].tools.some((tool) => tool.function.name === 'apply_patch'), true);
});

test('repeated reads remain available until the outer client or time budget ends', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/theme.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'apply_patch', { patch: 'diff --git a/src/theme.js b/src/theme.js\n' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'read_file', { path: 'test/theme.test.js' })] },
    { role: 'assistant', tool_calls: [toolCall('4', 'read_file', { path: 'test/theme.test.js' })] },
    { role: 'assistant', tool_calls: [toolCall('5', 'read_file', { path: 'test/theme.test.js' })] },
  ]);
  let testCalls = 0;
  const tools = {
    definitions: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name) {
      if (name === 'read_file') return { ok: true, path: 'src/theme.js', content: 'source' };
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/theme.js'], remainingUnresolved: [] };
      if (name === 'run_tests') {
        testCalls += 1;
        return { ok: true, passed: false, repairSources: [{ path: 'test/theme.test.js', content: 'failure evidence' }], result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'failure' }] } };
      }
      return { ok: true, status: 'needs_human' };
    },
    snapshot() { return {}; },
  };
  const result = await runRepairAgent({ task: '修复 CI 失败', client, tools });

  assert.equal(result.status, 'ai_unavailable');
  assert.match(result.reason, /scripted client ran out/);
  assert.equal(result.metrics.logicalTurns, 6);
  assert.equal(testCalls, 1);
});

test('agent finishes all unresolved conflict patches before running tests', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'apply_patch', { patch: 'first' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'apply_patch', { patch: 'second' })] },
  ]);
  const tools = fakeTools({ remainingUnresolved: [['src/other.js'], []] });
  const result = await runRepairAgent({ task: '处理多文件冲突', client, tools });

  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(tools.calls.map(([name]) => name), ['read_file', 'apply_patch', 'apply_patch', 'run_tests']);
  assert.deepEqual(result.metrics.toolSequence, ['read_file', 'apply_patch', 'apply_patch', 'run_tests(auto)']);
});

test('agent never exposes an unrestricted shell tool', async () => {
  const client = scriptedClient([{ role: 'assistant', tool_calls: [toolCall('1', 'finish', { decision: 'needs_human', reason: '停止' })] }]);
  const tools = fakeTools();
  const result = await runRepairAgent({ task: '停止', client, tools });
  assert.equal(result.status, 'needs_human');
  assert.equal(tools.definitions.some((tool) => tool.function.name === 'shell'), false);
});

test('Z.AI client preserves the requested per-turn output, disables thinking, and retries overload once', async () => {
  const requests = [];
  let calls = 0;
  const result = await callZaiChat({
    apiKey: 'test-key',
    messages: [{ role: 'user', content: '读取文件' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    maxTokens: 16_000,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, text: async () => JSON.stringify({ error: { code: '1302', message: 'busy' } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'glm-4.5-flash', usage: { completion_tokens: 3 }, choices: [{ message: { role: 'assistant', tool_calls: [] } }] }) };
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(requests[1].max_tokens, DEFAULT_AGENT_MAX_TOKENS);
  assert.deepEqual(requests[1].thinking, { type: 'disabled' });
  assert.equal(requests[1].tools.length, 1);
});

test('agent tools expose bounded file/diff/edit/test seams without a shell', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-tools-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.js'), 'const value = 1;\n');
    await git('add', 'example.js');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({
      cwd,
      revisions: { base: sha, pr: sha, main: sha },
      allowedFiles: ['example.js'],
      runTestsImpl: async () => ({ passed: true, command: 'npm test', result: { total: 1, passed: 1, failed: 0, failures: [] }, stderr: '' }),
    });
    const file = await tools.call('read_file', { path: 'example.js', start_line: 1, end_line: 2 });
    assert.match(file.content, /const value/);
    const patchResult = await tools.call('apply_patch', { patch: 'diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n' });
    assert.equal(patchResult.applied, true);
    const tests = await tools.call('run_tests', { mode: 'related' });
    assert.equal(tests.passed, true);
    assert.equal((await readFile(join(cwd, 'example.js'), 'utf8')).trim(), 'const value = 2;');
    assert.equal(tools.definitions.some((tool) => tool.function.name === 'shell'), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('related verification reuses the exact failing trusted test path', async () => {
  const calls = [];
  const tools = createAgentTools({
    cwd: process.cwd(),
    allowedFiles: ['src/adapter.js', 'test/adapter.test.js'],
    runTestsImpl: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { passed: false, command: 'npm test', result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/adapter.test.js', error: 'old contract' }] }, stderr: '', dependenciesPrepared: true }
        : { passed: true, command: 'node --test test/adapter.test.js', result: { total: 1, passed: 1, failed: 0, failures: [] }, stderr: '', dependenciesPrepared: true };
    },
  });
  const first = await tools.call('run_tests', { mode: 'related' });
  const second = await tools.call('run_tests', { mode: 'related' });

  assert.equal(first.mode, 'full');
  assert.equal(second.mode, 'related');
  assert.deepEqual(calls[1].files, ['test/adapter.test.js']);
  assert.equal(calls[1].dependenciesPrepared, true);
});

test('trusted initial CI test paths make the first related verification focused', async () => {
  const calls = [];
  const tools = createAgentTools({
    cwd: process.cwd(),
    allowedFiles: ['src/adapter.js', 'test/adapter.test.js'],
    knownFailingTestFiles: ['test/adapter.test.js'],
    runTestsImpl: async (input) => {
      calls.push(input);
      return { passed: true, command: 'node --test test/adapter.test.js', result: { total: 1, passed: 1, failed: 0, failures: [] }, stderr: '', dependenciesPrepared: true };
    },
  });

  const result = await tools.call('run_tests', { mode: 'related' });
  assert.equal(result.mode, 'related');
  assert.deepEqual(calls[0].files, ['test/adapter.test.js']);
  assert.equal(calls[0].dependenciesPrepared, false);
});

test('trusted remote evidence seeds exact test paths and failure-aware tool state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-trusted-evidence-'));
  try {
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'test'), { recursive: true });
    await writeFile(join(cwd, 'src', 'adapter.js'), 'export const contract = "old";\n');
    await writeFile(join(cwd, 'test', 'adapter.test.js'), 'test("adapter", () => {});\n');
    const evidence = [{ name: 'Test / Windows', summary: 'test/adapter.test.js failed', log: 'AssertionError at test/adapter.test.js:12' }];
    const paths = trustedFailurePaths(evidence);
    assert.deepEqual(paths, ['test/adapter.test.js']);
    assert.deepEqual(trustedFailurePaths([{ log: 'node_modules/private.test.js .git/private.test.js .env/private.test.js test/adapter.test.js' }]), ['test/adapter.test.js']);
    const tools = createAgentTools({
      cwd,
      allowedFiles: ['src/adapter.js', 'test/adapter.test.js'],
      knownFailureFiles: paths,
      knownFailingTestFiles: paths,
      initialFailureEvidence: evidence,
    });
    const read = await tools.call('read_file', { path: 'src/adapter.js' });
    assert.deepEqual(read.repairTargets, ['src/adapter.js']);
    assert.ok(read.failureEvidence.sources.some((source) => source.path === 'src/adapter.js'));
    assert.ok(read.failureEvidence.tests.some((source) => source.path === 'test/adapter.test.js'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('failed verification routes the next read to the first failing source file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-failure-routing-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'bin.stmem'), 'cli\n');
    await writeFile(join(cwd, 'src.js'), 'source\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({
      cwd,
      revisions: { base: sha, pr: sha, main: sha },
      allowedFiles: ['bin.stmem', 'src.js'],
      runTestsImpl: async () => ({
        passed: false,
        command: 'npm test',
        result: { total: 2, passed: 1, failed: 1, failures: [{ file: 'test/src.test.js', error: 'source regression' }] },
        stderr: '',
      }),
    });
    await tools.call('run_tests', { mode: 'related' });
    const defaultRead = await tools.call('read_file', { start_line: 1, end_line: 1 });
    assert.equal(defaultRead.path, 'src.js');
    const explicitRead = await tools.call('read_file', { path: 'bin.stmem', start_line: 1, end_line: 1 });
    assert.equal(explicitRead.path, 'bin.stmem');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('failed evidence returns matching allowed source files on the first follow-up read', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-evidence-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'test'), { recursive: true });
    await writeFile(join(cwd, 'src', 'theme.js'), 'const prefix = "--legacy-contract-";\n');
    await writeFile(join(cwd, 'test', 'theme.test.js'), 'test\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({
      cwd,
      revisions: { base: sha, pr: sha, main: sha },
      allowedFiles: ['src/theme.js', 'test/theme.test.js'],
      runTestsImpl: async () => ({
        passed: false,
        command: 'npm test',
        result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/theme.test.js', error: 'legacy-contract\\n\\ntrue !== false' }] },
        stderr: '',
      }),
    });
    const failed = await tools.call('run_tests', { mode: 'related' });
    assert.ok(failed.repairSources.some((source) => source.path === 'src/theme.js'));
    const search = await tools.call('search_code', {});
    assert.ok(search.repairSources.some((source) => source.path === 'src/theme.js'));
    const read = await tools.call('read_file', {});
    assert.equal(read.path, 'src/theme.js');
    assert.match(read.content, /legacy-contract/);
    assert.ok(read.failureEvidence.sources.some((source) => source.path === 'src/theme.js'));
    assert.ok(read.failureEvidence.tests.some((source) => source.path === 'test/theme.test.js'));
    assert.match(read.note, /首个失败源码目标/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent apply_patch can resolve an actual current-main conflict in the repair worktree', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-conflict-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), 'base\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'base');
    const baseSha = await git('rev-parse', 'HEAD');
    await git('switch', '-c', 'pr');
    await writeFile(join(cwd, 'example.txt'), 'pr\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'pr');
    const prSha = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    await writeFile(join(cwd, 'example.txt'), 'main\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'main');
    const mainSha = await git('rev-parse', 'HEAD');
    await git('switch', 'pr');
    const merge = await runGit(['merge', '--no-commit', '--no-ff', mainSha], { cwd });
    assert.notEqual(merge.code, 0);
    const conflictText = await readFile(join(cwd, 'example.txt'), 'utf8');
    assert.match(conflictText, /<<<<<<< HEAD/);
    assert.deepEqual(conflictText.split(/\n/), ['<<<<<<< HEAD', 'pr', '=======', 'main', `>>>>>>> ${mainSha}`, '']);
    const tools = createAgentTools({ cwd, revisions: { base: mainSha, pr: prSha, main: mainSha }, allowedFiles: ['example.txt'] });
    const status = await tools.call('get_status', {});
    assert.deepEqual(status.unresolved, ['example.txt']);
    assert.equal(status.conflictDetails[0].conflicts[0].startLine, 1);
    assert.equal(status.conflictDetails[0].conflicts[0].ours, 'pr');
    assert.equal(status.conflictDetails[0].conflicts[0].theirs, 'main');
    const result = await tools.call('apply_patch', {
      patch: `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,5 +1 @@\n-<<<<<<< HEAD\n-pr\n-=======\n-main\n->>>>>>> ${mainSha}\n+resolved\n`,
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.deepEqual(result.remainingUnresolved, []);
    assert.equal((await readFile(join(cwd, 'example.txt'), 'utf8')).trim(), 'resolved');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent apply_patch accepts the bounded Begin Patch format emitted by coding models', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-apply-format-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), '<<<<<<< HEAD\npr\n=======\nmain\n>>>>>>> main\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'conflict');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({
      cwd,
      revisions: { base: sha, pr: sha, main: sha },
      allowedFiles: ['example.txt'],
      runTestsImpl: async () => ({ passed: true, command: 'npm test', result: { total: 1, passed: 1, failed: 0, failures: [] }, stderr: '' }),
    });
    const status = await tools.call('get_status', {});
    assert.deepEqual(status.unresolved, ['example.txt']);
    const partial = await tools.call('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: example.txt\n@@\n pr\n+extra\n*** End Patch\n',
    });
    assert.equal(partial.applied, true, JSON.stringify(partial));
    assert.equal(partial.format, 'conflict-fallback');
    assert.deepEqual(partial.remainingUnresolved, []);
    await writeFile(join(cwd, 'example.txt'), '<<<<<<< HEAD\npr\n=======\nmain\n>>>>>>> main\n');
    await git('add', 'example.txt');
    const result = await tools.call('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: example.txt\n@@\n-<<<<<<< HEAD\n-pr\n-=======\n-main\n->>>>>>> main\n+resolved\n*** End Patch\n',
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent applies only the literal hunk requested by the model', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-identifier-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'theme.css'), '.alpha { color: var(--legacy-contract-ink); }\n.beta { color: var(--legacy-contract-canvas); }\n');
    await git('add', 'theme.css');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({ cwd, revisions: { base: sha, pr: sha, main: sha }, allowedFiles: ['theme.css'] });
    await tools.call('get_status', {});
    const result = await tools.call('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: theme.css\n@@\n-.alpha { color: var(--legacy-contract-ink); }\n+.alpha { color: var(--current-contract-ink); }\n*** End Patch\n',
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    const content = await readFile(join(cwd, 'theme.css'), 'utf8');
    assert.match(content, /legacy-contract-canvas/);
    assert.match(content, /current-contract-ink/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('malformed patch reports failure without changing the worktree', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-malformed-patch-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'adapter.js'), 'export const value = 1;\n');
    await git('add', 'adapter.js');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({ cwd, revisions: { base: sha, pr: sha, main: sha }, allowedFiles: ['adapter.js'] });
    await assert.rejects(
      tools.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: adapter.js\nnot a patch\n*** End Patch\n' }),
      /(?:apply_patch 格式错误|找不到要替换的原文)/,
    );
    assert.equal(await readFile(join(cwd, 'adapter.js'), 'utf8'), 'export const value = 1;\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent accepts a Begin Patch envelope with embedded unified file headers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-unified-envelope-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'theme.css'), '.alpha { color: var(--legacy-contract-ink); }\n');
    await git('add', 'theme.css');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({ cwd, revisions: { base: sha, pr: sha, main: sha }, allowedFiles: ['theme.css'] });
    const result = await tools.call('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: theme.css\n--- theme.css\n+++ theme.css\n@@ -1 +1 @@\n-.alpha { color: var(--legacy-contract-ink); }\n+.alpha { color: var(--current-contract-ink); }\n*** End Patch\n',
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.match(await readFile(join(cwd, 'theme.css'), 'utf8'), /current-contract-ink/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent accepts a single-file full replacement Update File envelope', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-full-envelope-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'theme.css'), '.alpha { color: var(--legacy-contract-ink); }\n');
    await git('add', 'theme.css');
    await git('commit', '-m', 'base');
    const sha = await git('rev-parse', 'HEAD');
    const tools = createAgentTools({ cwd, revisions: { base: sha, pr: sha, main: sha }, allowedFiles: ['theme.css'] });
    const result = await tools.call('apply_patch', {
      patch: '*** Update File: theme.css\n.alpha { color: var(--current-contract-ink); }\n',
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(await readFile(join(cwd, 'theme.css'), 'utf8'), '.alpha { color: var(--current-contract-ink); }\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('agent resolves a conflict when a model patch has a stale conflict footer', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-stale-footer-'));
  try {
    const git = async (...args) => {
      const result = await runGit(args, { cwd });
      assert.equal(result.code === 0 || args[0] === 'merge', true, `${args.join(' ')}\n${result.stderr}`);
      return result.stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), 'base\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    await git('switch', '-c', 'pr');
    await writeFile(join(cwd, 'example.txt'), 'pr\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'pr');
    const pr = await git('rev-parse', 'HEAD');
    await git('switch', 'main');
    await writeFile(join(cwd, 'example.txt'), 'main\n');
    await git('add', 'example.txt');
    await git('commit', '-m', 'main');
    const main = await git('rev-parse', 'HEAD');
    await git('switch', 'pr');
    await git('merge', '--no-commit', '--no-ff', main);
    const tools = createAgentTools({ cwd, revisions: { base, pr, main }, allowedFiles: ['example.txt'] });
    const result = await tools.call('apply_patch', { patch: '*** Begin Patch\n*** Update File: example.txt\n@@\n-<<<<<<< HEAD\n-pr\n-=======\n-main\n->>>>>>> stale-footer\n+resolved\n*** End Patch\n' });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
