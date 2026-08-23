import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_LIMITS, runRepairAgent } from '../.github/pr-repair/agent-runtime.mjs';
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

function fakeTools() {
  const calls = [];
  let lastTestPassed = false;
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
      if (name === 'apply_patch') return { ok: true, applied: true, changedFiles: ['src/example.js'] };
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
  assert.equal(result.metrics.logicalTurns, 4);
  assert.equal(client.calls.length, 4);
  assert.equal(client.calls[1].messages.at(-1).role, 'tool');
  assert.equal(client.calls[2].messages.at(-1).role, 'tool');
  assert.equal(result.metrics.maxLogicalTurns, AGENT_LIMITS.maxLogicalTurns);
});

test('agent rejects a repair completion before a passing test and fails closed at the turn cap', async () => {
  const client = scriptedClient([
    { role: 'assistant', tool_calls: [toolCall('1', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('2', 'finish', { decision: 'repair_complete', summary: '过早完成' })] },
    { role: 'assistant', tool_calls: [toolCall('3', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('4', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('5', 'read_file', { path: 'src/example.js' })] },
    { role: 'assistant', tool_calls: [toolCall('6', 'read_file', { path: 'src/example.js' })] },
  ]);
  const result = await runRepairAgent({ task: '修复冲突', client, tools: fakeTools(), limits: { ...AGENT_LIMITS, maxLogicalTurns: 5 } });

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /回合上限|repair_complete/);
  assert.equal(result.metrics.logicalTurns, 5);
  assert.deepEqual(client.calls[2].tools.map((tool) => tool.function.name), ['apply_patch', 'run_tests', 'finish']);
});

test('agent never exposes an unrestricted shell tool', async () => {
  const client = scriptedClient([{ role: 'assistant', tool_calls: [toolCall('1', 'finish', { decision: 'needs_human', reason: '停止' })] }]);
  const tools = fakeTools();
  const result = await runRepairAgent({ task: '停止', client, tools });
  assert.equal(result.status, 'needs_human');
  assert.equal(tools.definitions.some((tool) => tool.function.name === 'shell'), false);
});

test('Z.AI client hard-caps per-turn output, disables thinking, and retries overload once', async () => {
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
    const result = await tools.call('apply_patch', {
      patch: `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,5 +1 @@\n-<<<<<<< HEAD\n-pr\n-=======\n-main\n->>>>>>> ${mainSha}\n+resolved\n`,
    });
    assert.equal(result.applied, true, JSON.stringify(result));
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
    const result = await tools.call('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: example.txt\n@@\n-<<<<<<< HEAD\n-pr\n-=======\n-main\n->>>>>>> main\n+resolved\n*** End Patch\n',
    });
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'resolved\n');
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
