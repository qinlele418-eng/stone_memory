import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_LIMITS, runRepairAgent } from '../.github/pr-repair/agent-runtime.mjs';

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function replayTools() {
  const changedFiles = new Set();
  let testNumber = 0;
  let lastRead = null;
  return {
    definitions: [
      { type: 'function', function: { name: 'get_status', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'git_diff', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'run_tests', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'finish', parameters: { type: 'object' } } },
    ],
    async call(name, args) {
      if (name === 'get_status') return { ok: true, baseSha: 'base-sha', prSha: 'pr-sha', mainSha: 'main-sha', unresolved: [] };
      if (name === 'read_file') {
        lastRead = args.path;
        return { ok: true, path: args.path, content: `${args.path}\n${'source '.repeat(900)}` };
      }
      if (name === 'git_diff') return { ok: true, scope: 'working', diff: 'diff --git a/src/adapter.js b/src/adapter.js\n+compatibility fix\n' };
      if (name === 'apply_patch') {
        changedFiles.add('src/adapter.js');
        return { ok: true, applied: true, changedFiles: [...changedFiles], remainingUnresolved: [] };
      }
      if (name === 'run_tests') {
        testNumber += 1;
        return testNumber === 1
          ? { ok: true, passed: false, result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/adapter.test.js', error: 'old contract' }] } }
          : { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      }
      return { ok: true, status: args.decision };
    },
    snapshot() {
      return {
        taskKind: 'ci_failure',
        currentMainSha: 'main-sha',
        headSha: 'pr-sha',
        unresolvedConflicts: [],
        changedFiles: [...changedFiles],
        currentDiff: changedFiles.size ? 'diff --git a/src/adapter.js b/src/adapter.js\n+compatibility fix\n' : '',
        latestFailureSummary: testNumber === 1 ? 'test/adapter.test.js: old contract' : null,
        recentFileViews: lastRead ? [{ path: lastRead, content: 'current source' }] : [],
      };
    },
  };
}

test('long replay keeps current truth within the configured request budget', async () => {
  const responses = [];
  for (let index = 0; index < 105; index += 1) {
    responses.push({ role: 'assistant', tool_calls: [toolCall(`read-${index}`, 'read_file', { path: `src/module-${index}.js` })] });
  }
  responses.push({ role: 'assistant', tool_calls: [toolCall('diff', 'git_diff', { scope: 'working' })] });
  responses.push({ role: 'assistant', tool_calls: [toolCall('patch', 'apply_patch', { patch: 'diff --git a/src/adapter.js b/src/adapter.js\n' })] });
  const calls = [];
  const client = {
    async complete(input) {
      calls.push(input);
      const response = responses.shift();
      if (!response) throw new Error('replay ran out of model responses');
      return { message: response, usage: { completion_tokens: 10 }, attempts: 1 };
    },
  };

  const result = await runRepairAgent({
    task: 'synthetic clean CI failure',
    client,
    tools: replayTools(),
    requiresPatch: true,
    limits: { ...AGENT_LIMITS, maxInputChars: 12_000, maxRecentGroups: 3, maxToolResultChars: 1_200 },
  });

  assert.equal(result.status, 'repair_complete');
  assert.ok(calls.length > 100);
  for (const call of calls) assert.ok(JSON.stringify(call.messages).length <= 12_000);
  assert.ok(result.metrics.contextCompactions > 0);
  assert.ok(result.metrics.contextHighWaterChars <= 12_000);
  const lastRequest = calls.at(-1);
  const checkpoint = lastRequest.messages.find((message) => message.role === 'system' && /Runtime checkpoint/.test(message.content));
  assert.match(checkpoint.content, /src\/adapter\.js/);
  assert.match(checkpoint.content, /compatibility fix/);
  assert.equal(checkpoint.content.includes('module-0.js'), false);
});

test('timeout replay rebuilds from current work state without adding transport history', async () => {
  let callNumber = 0;
  const client = {
    calls: [],
    async complete(input) {
      this.calls.push(input);
      callNumber += 1;
      if (callNumber === 1) return { message: { role: 'assistant', tool_calls: [toolCall('read', 'read_file', { path: 'src/adapter.js' })] }, usage: { completion_tokens: 10 } };
      if (callNumber === 2) {
        const error = new Error('timeout');
        error.code = 'timeout';
        throw error;
      }
      return { message: { role: 'assistant', tool_calls: [toolCall('patch', 'apply_patch', { patch: 'diff --git a/src/adapter.js b/src/adapter.js\n' })] }, usage: { completion_tokens: 10 } };
    },
  };
  const result = await runRepairAgent({ task: 'synthetic recovery', client, tools: replayTools(), requiresPatch: true });

  assert.equal(result.status, 'repair_complete');
  assert.equal(result.metrics.transientApiRecoveries, 1);
  assert.equal(client.calls.length, 3);
  assert.match(client.calls[2].messages.find((message) => /Runtime checkpoint/.test(message.content)).content, /src\/adapter\.js/);
  assert.equal(client.calls[2].messages.some((message) => /timeout|通信失败/.test(String(message.content))), false);
  assert.ok(result.metrics.auditTrace.some((event) => event.type === 'api_recovery'));
});

test('patch-before-timeout replay retains the applied diff and latest failure', async () => {
  let testCalls = 0;
  let providerCalls = 0;
  const tools = replayTools();
  const originalCall = tools.call;
  tools.call = async (name, args) => {
    if (name !== 'run_tests') return originalCall(name, args);
    testCalls += 1;
    return testCalls === 1
      ? { ok: true, passed: false, result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/adapter.test.js', error: 'old contract' }] } }
      : testCalls === 2
        ? { ok: true, passed: false, result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'test/adapter.test.js', error: 'still failing' }] } }
        : { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
  };
  const client = {
    calls: [],
    async complete(input) {
      this.calls.push(input);
      providerCalls += 1;
      if (providerCalls === 1) return { message: { role: 'assistant', tool_calls: [toolCall('first-patch', 'apply_patch', { patch: 'first' })] }, usage: { completion_tokens: 10 } };
      if (providerCalls === 2) { const error = new Error('timeout'); error.code = 'timeout'; throw error; }
      return { message: { role: 'assistant', tool_calls: [toolCall('second-patch', 'apply_patch', { patch: 'second' })] }, usage: { completion_tokens: 10 } };
    },
  };
  const result = await runRepairAgent({ task: 'synthetic patch recovery', client, tools, requiresPatch: true });
  assert.equal(result.status, 'repair_complete');
  assert.equal(result.metrics.transientApiRecoveries, 1);
  const recoveryRequest = client.calls[2];
  const checkpoint = recoveryRequest.messages.find((message) => /Runtime checkpoint/.test(message.content));
  assert.match(checkpoint.content, /compatibility fix/);
  assert.match(checkpoint.content, /still failing/);
});

test('normal CI-failure replay reads main, patches, runs focused verification, and finishes', async () => {
  const calls = [];
  const tools = {
    definitions: ['read_file', 'git_show_file', 'search_code', 'apply_patch', 'run_tests', 'finish'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'run_tests') return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/adapter.js'], remainingUnresolved: [] };
      if (name === 'finish') return { ok: true, status: args.decision, summary: args.summary };
      return { ok: true, path: args.path, content: 'current compatibility contract' };
    },
    snapshot() { return { taskKind: 'ci_failure', baseSha: 'base', headSha: 'head', currentMainSha: 'main', mutableFiles: ['src/adapter.js'], unresolvedConflicts: [], changedFiles: ['src/adapter.js'], currentDiff: 'diff --git a/src/adapter.js b/src/adapter.js' }; },
  };
  const scripted = [
    [toolCall('main', 'git_show_file', { path: 'src/reference.js', revision: 'main' })],
    [toolCall('read', 'read_file', { path: 'src/adapter.js' })],
    [toolCall('search', 'search_code', { query: 'compatibility', path: 'src' })],
    [
      toolCall('patch', 'apply_patch', { patch: 'diff --git a/src/adapter.js b/src/adapter.js\n' }),
      toolCall('test', 'run_tests', { mode: 'related' }),
      toolCall('finish', 'finish', { decision: 'repair_complete', summary: 'synthetic repair' }),
    ],
  ];
  const result = await runRepairAgent({
    task: 'synthetic clean CI failure', tools, requiresPatch: true,
    client: { async complete() {
      return { message: { role: 'assistant', tool_calls: scripted.shift() }, usage: { completion_tokens: 10 } };
    } },
  });
  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(calls.map(([name]) => name), ['git_show_file', 'read_file', 'search_code', 'apply_patch', 'run_tests', 'finish']);
});

test('a final diff-check failure wakes the same model once with exact format evidence', async () => {
  const calls = [];
  let patchCount = 0;
  let checkCount = 0;
  const tools = {
    definitions: ['apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      calls.push(name);
      if (name === 'apply_patch') {
        patchCount += 1;
        return { ok: true, applied: true, changedFiles: ['README.md'], remainingUnresolved: [] };
      }
      return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
    },
    async checkFinalDiff() {
      checkCount += 1;
      return checkCount === 1
        ? { ok: false, checkedFiles: ['README.md'], errors: ['README.md:2: trailing whitespace.'] }
        : { ok: true, checkedFiles: ['README.md'], errors: [] };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: [], changedFiles: ['README.md'] }; },
  };
  const client = {
    calls: [],
    async complete(input) {
      this.calls.push(input);
      if (this.calls.length === 1) {
        return { message: { role: 'assistant', tool_calls: [toolCall('first-patch', 'apply_patch', { patch: 'first' })] }, usage: { completion_tokens: 10 } };
      }
      assert.match(input.messages.at(-1).content, /README\.md:2: trailing whitespace/);
      assert.match(input.messages.at(-1).content, /你上一轮修改造成/);
      return { message: { role: 'assistant', tool_calls: [toolCall('format-fix', 'apply_patch', { patch: 'second' })] }, usage: { completion_tokens: 10 } };
    },
  };

  const result = await runRepairAgent({ task: 'synthetic format repair', client, tools });

  assert.equal(result.status, 'repair_complete');
  assert.equal(checkCount, 2);
  assert.deepEqual(calls, ['apply_patch', 'run_tests', 'apply_patch', 'run_tests']);
  assert.equal(client.calls.length, 2);
});

test('a second final diff-check failure stops after the one corrective model turn', async () => {
  let patchCount = 0;
  let checkCount = 0;
  const tools = {
    definitions: ['apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      if (name === 'apply_patch') {
        patchCount += 1;
        return { ok: true, applied: true, changedFiles: ['README.md'], remainingUnresolved: [] };
      }
      return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
    },
    async checkFinalDiff() {
      checkCount += 1;
      return { ok: false, checkedFiles: ['README.md'], errors: ['README.md:2: trailing whitespace.'] };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: [], changedFiles: ['README.md'] }; },
  };
  const client = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return { message: { role: 'assistant', tool_calls: [toolCall(`patch-${this.calls}`, 'apply_patch', { patch: 'format fix' })] }, usage: { completion_tokens: 10 } };
    },
  };

  const result = await runRepairAgent({ task: 'synthetic format repair', client, tools });

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /格式检查仍未通过/);
  assert.equal(checkCount, 2);
  assert.equal(patchCount, 2);
  assert.equal(client.calls, 2);
});

test('the one format-correction turn cannot spend a third model call reading first', async () => {
  let checkCount = 0;
  const tools = {
    definitions: ['read_file', 'apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['README.md'], remainingUnresolved: [] };
      if (name === 'run_tests') return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
      return { ok: true, path: 'README.md', content: 'source' };
    },
    async checkFinalDiff() {
      checkCount += 1;
      return { ok: false, checkedFiles: ['README.md'], errors: ['README.md:2: trailing whitespace.'] };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: [], changedFiles: ['README.md'] }; },
  };
  const client = {
    calls: 0,
    async complete() {
      this.calls += 1;
      const name = this.calls === 1 ? 'apply_patch' : 'read_file';
      return { message: { role: 'assistant', tool_calls: [toolCall(`call-${this.calls}`, name, name === 'read_file' ? { path: 'README.md' } : { patch: 'first' })] }, usage: { completion_tokens: 10 } };
    },
  };

  const result = await runRepairAgent({ task: 'synthetic format repair', client, tools });

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /唯一修正回合/);
  assert.equal(checkCount, 1);
  assert.equal(client.calls, 2);
});

test('a failed test in the one format-correction turn cannot request a third model call', async () => {
  let testCount = 0;
  let checkCount = 0;
  const tools = {
    definitions: ['apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['README.md'], remainingUnresolved: [] };
      testCount += 1;
      return testCount === 1
        ? { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } }
        : { ok: true, passed: false, result: { total: 1, passed: 0, failed: 1, failures: [{ file: 'README.md', error: 'still broken' }] } };
    },
    async checkFinalDiff() {
      checkCount += 1;
      return { ok: false, checkedFiles: ['README.md'], errors: ['README.md:2: trailing whitespace.'] };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: [], changedFiles: ['README.md'] }; },
  };
  const client = {
    calls: 0,
    async complete() {
      this.calls += 1;
      return { message: { role: 'assistant', tool_calls: [toolCall(`patch-${this.calls}`, 'apply_patch', { patch: 'format fix' })] }, usage: { completion_tokens: 10 } };
    },
  };

  const result = await runRepairAgent({ task: 'synthetic format repair', client, tools });

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /唯一修正回合/);
  assert.equal(checkCount, 1);
  assert.equal(client.calls, 2);
});

test('a patch after an explicit correction test receives a fresh automatic verification', async () => {
  const calls = [];
  let checkCount = 0;
  const tools = {
    definitions: ['apply_patch', 'run_tests'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      calls.push(name);
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['README.md'], remainingUnresolved: [] };
      return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
    },
    async checkFinalDiff() {
      checkCount += 1;
      return checkCount === 1
        ? { ok: false, checkedFiles: ['README.md'], errors: ['README.md:2: trailing whitespace.'] }
        : { ok: true, checkedFiles: ['README.md'], errors: [] };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: [], changedFiles: ['README.md'] }; },
  };
  const client = {
    calls: 0,
    async complete() {
      this.calls += 1;
      const toolsForTurn = this.calls === 1
        ? [toolCall('first-patch', 'apply_patch', { patch: 'first' })]
        : [
          toolCall('format-fix-one', 'apply_patch', { patch: 'first format fix' }),
          toolCall('format-test', 'run_tests', { mode: 'related' }),
          toolCall('format-fix-two', 'apply_patch', { patch: 'second format fix' }),
        ];
      return { message: { role: 'assistant', tool_calls: toolsForTurn }, usage: { completion_tokens: 10 } };
    },
  };

  const result = await runRepairAgent({ task: 'synthetic format repair', client, tools });

  assert.equal(result.status, 'repair_complete');
  assert.equal(client.calls, 2);
  assert.deepEqual(calls, ['apply_patch', 'run_tests', 'apply_patch', 'run_tests', 'apply_patch', 'run_tests']);
});

test('conflict replay clears every file before verification', async () => {
  const calls = [];
  let patchCount = 0;
  const tools = {
    definitions: ['get_status', 'run_tests', 'apply_patch'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    async call(name) {
      calls.push(name);
      if (name === 'get_status') return { ok: true, unresolved: ['src/one.js', 'src/two.js'], baseSha: 'base', prSha: 'head', mainSha: 'main' };
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/one.js', 'src/two.js'], remainingUnresolved: patchCount++ === 0 ? ['src/two.js'] : [] };
      return { ok: true, passed: true, result: { total: 1, passed: 1, failed: 0, failures: [] } };
    },
    snapshot() { return { taskKind: 'merge_conflict', unresolvedConflicts: patchCount === 0 ? ['src/one.js', 'src/two.js'] : patchCount === 1 ? ['src/two.js'] : [], changedFiles: ['src/one.js', 'src/two.js'] }; },
  };
  const responses = [toolCall('one', 'apply_patch', { patch: 'first' }), toolCall('two', 'apply_patch', { patch: 'second' })];
  const result = await runRepairAgent({ task: 'synthetic multi-file conflict', tools, client: { async complete() { return { message: { role: 'assistant', tool_calls: [responses.shift()] }, usage: { completion_tokens: 10 } }; } } });
  assert.equal(result.status, 'repair_complete');
  assert.deepEqual(calls, ['get_status', 'apply_patch', 'apply_patch', 'run_tests']);
});
