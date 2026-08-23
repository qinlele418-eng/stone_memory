import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyRepair, commitAgentRepair } from '../.github/pr-repair/apply.mjs';
import { runGit } from '../.github/pr-repair/git.mjs';

async function git(cwd, ...args) {
  const result = await runGit(args, { cwd });
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

test('apply creates one append-only deterministic repair commit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-pr-repair-test-'));
  try {
    await git(cwd, 'init', '-b', 'main');
    await git(cwd, 'config', 'user.name', 'test');
    await git(cwd, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), 'base\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'base');
    const baseSha = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'switch', '-c', 'pr');
    await writeFile(join(cwd, 'example.txt'), 'broken   \n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'pr change');
    const headSha = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'remote', 'add', 'origin', cwd);

    const result = await applyRepair({
      cwd,
      prNumber: 99,
      baseSha,
      headSha,
      diagnosis: {
        currentMainSha: baseSha,
        nextAction: 'deterministic_diff_check',
        changedFiles: ['example.txt'],
        merge: null,
        pr: { number: 99, headSha },
      },
      plan: {
        decision: 'repair',
        summary: '清理尾随空白',
        changes: [{ path: 'example.txt', content: 'broken\n' }],
      },
    });
    assert.equal(result.status, 'repair_success', JSON.stringify(result));
    assert.equal(await git(cwd, 'rev-parse', 'HEAD^'), headSha);
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'broken\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('apply resolves a current-main conflict in an append-only merge commit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-pr-repair-conflict-'));
  try {
    await git(cwd, 'init', '-b', 'main');
    await git(cwd, 'config', 'user.name', 'test');
    await git(cwd, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), 'base\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'base');
    await git(cwd, 'switch', '-c', 'pr');
    await writeFile(join(cwd, 'example.txt'), 'pr\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'pr change');
    const headSha = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'switch', 'main');
    await writeFile(join(cwd, 'example.txt'), 'main\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'main change');
    const baseSha = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'remote', 'add', 'origin', cwd);

    const result = await applyRepair({
      cwd,
      prNumber: 100,
      baseSha,
      headSha,
      diagnosis: {
        currentMainSha: baseSha,
        nextAction: 'ai_conflict',
        changedFiles: ['example.txt'],
        merge: { conflictFiles: ['example.txt'] },
        pr: { number: 100, headSha },
      },
      plan: {
        decision: 'repair',
        summary: '保留 PR 意图并适配 current main',
        changes: [{ path: 'example.txt', content: 'resolved\n' }],
        model: 'glm-4.7-flash',
      },
    });
    assert.equal(result.status, 'repair_success', JSON.stringify(result));
    assert.equal(result.mergeCommit, true);
    assert.equal(await git(cwd, 'rev-parse', 'HEAD^1'), headSha);
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('bugfix repair stops without touching the PR when current main already fixed it', async () => {
  const result = await applyRepair({
    cwd: '/tmp',
    prNumber: 101,
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    diagnosis: {
      prKind: 'bugfix',
      currentMainSha: 'b'.repeat(40),
      pr: { number: 101, headSha: 'c'.repeat(40) },
      changedFiles: [],
    },
    plan: { decision: 'needs_human', bugStatus: 'already_fixed', reason: 'current main 已修复' },
  });
  assert.equal(result.status, 'bug_already_fixed');
});

test('agent workspace commit preserves the PR head ancestor and rejects out-of-scope files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stone-memory-agent-commit-'));
  try {
    await git(cwd, 'init', '-b', 'main');
    await git(cwd, 'config', 'user.name', 'test');
    await git(cwd, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(cwd, 'example.txt'), 'base\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'base');
    const baseSha = await git(cwd, 'rev-parse', 'HEAD');
    await git(cwd, 'switch', '-c', 'pr');
    await writeFile(join(cwd, 'example.txt'), 'pr\n');
    await git(cwd, 'add', 'example.txt');
    await git(cwd, 'commit', '-m', 'pr');
    const headSha = await git(cwd, 'rev-parse', 'HEAD');
    await writeFile(join(cwd, 'example.txt'), 'resolved\n');
    const diagnosis = { currentMainSha: baseSha, changedFiles: ['example.txt'], pr: { number: 102, headSha } };
    const result = await commitAgentRepair({ cwd, diagnosis, summary: '直接完成冲突修复', model: 'glm-4.5-flash' });
    assert.equal(result.status, 'repair_success', JSON.stringify(result));
    assert.equal(await git(cwd, 'rev-parse', 'HEAD^'), headSha);
    assert.equal(await readFile(join(cwd, 'example.txt'), 'utf8'), 'resolved\n');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
