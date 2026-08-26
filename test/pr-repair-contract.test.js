import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChecks,
  classifyPrKind,
  isSafeRelativePath,
  validateRepairResponse,
  redactSensitiveText,
} from '../.github/pr-repair/contract.mjs';

test('PR repair treats only completed successful conclusions as green', () => {
  const result = classifyChecks([
    { name: 'Linux', status: 'completed', conclusion: 'success' },
    { name: 'Windows', status: 'completed', conclusion: 'skipped' },
    { name: 'macOS', status: 'completed', conclusion: 'neutral' },
  ]);
  assert.equal(result.allGreen, true);
  assert.equal(result.red, false);

  const red = classifyChecks([
    { name: 'Linux', status: 'completed', conclusion: 'failure' },
    { name: 'Windows', status: 'in_progress', conclusion: null },
  ]);
  assert.equal(red.allGreen, false);
  assert.equal(red.failures[0].name, 'Linux');
  assert.equal(red.pending[0].name, 'Windows');
});

test('PR repair classification is conservative', () => {
  assert.equal(classifyPrKind({ title: 'fix: handle stale cache' }), 'bugfix');
  assert.equal(classifyPrKind({ title: 'feat: add timeline view' }), 'non_bugfix');
  assert.equal(classifyPrKind({ title: 'Please review this change' }), 'unknown');
});

test('repair paths cannot escape the repository or modify automation', () => {
  assert.equal(isSafeRelativePath('src/services/example.js'), true);
  assert.equal(isSafeRelativePath('../outside.js'), false);
  assert.equal(isSafeRelativePath('.github/workflows/ci.yml'), false);
  assert.equal(isSafeRelativePath('.github/actions/check/action.yml'), false);
  assert.equal(isSafeRelativePath('.github/pr-repair/zai.mjs'), false);
  assert.equal(isSafeRelativePath('/tmp/outside.js'), false);
});

test('repair response rejects test skipping and files outside the evidence set', () => {
  const result = validateRepairResponse({
    decision: 'repair',
    summary: 'bad',
    patch: [
      'diff --git a/test/example.test.js b/test/example.test.js',
      '+++ b/test/example.test.js',
      '@@',
      '+test.skip("hide failure")',
    ].join('\n'),
  }, { allowedFiles: ['test/example.test.js'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /跳过测试/);
  assert.match(result.errors.join('\n'), /禁止自动修改测试/);

  const outside = validateRepairResponse({
    decision: 'repair',
    summary: 'bad',
    changes: [{ path: 'src/other.js', content: 'x' }],
  }, { allowedFiles: ['src/expected.js'] });
  assert.equal(outside.ok, false);
  assert.match(outside.errors.join('\n'), /上下文之外/);
});

test('repair response validates full-file content and fails closed on an empty allowlist', () => {
  const content = validateRepairResponse({
    decision: 'repair',
    summary: 'bad',
    changes: [{ path: 'src/example.js', content: 'test.skip("hide failure")\n' }],
  }, { allowedFiles: ['src/example.js'] });
  assert.equal(content.ok, false);
  assert.match(content.errors.join('\n'), /跳过测试/);

  const empty = validateRepairResponse({
    decision: 'repair',
    summary: 'bad',
    changes: [{ path: 'src/example.js', content: 'safe\n' }],
  });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join('\n'), /允许修改文件/);
});

test('unified patches without a diff-git header still obey the file allowlist', () => {
  const result = validateRepairResponse({
    decision: 'repair',
    summary: 'bad',
    patch: '--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@\n+run: true\n',
  }, { allowedFiles: ['src/example.js'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /不安全路径|上下文之外/);
});

test('model context redaction covers JSON credentials and bearer tokens', () => {
  const redacted = redactSensitiveText('{"password":"abc123","authorization":"Bearer abc.def","access_token":"refresh-me","client_secret":"private-me"}');
  assert.doesNotMatch(redacted, /abc123|abc\.def/);
  assert.doesNotMatch(redacted, /refresh-me|private-me/);
  assert.match(redacted, /已脱敏/);
});

test('repair response rejects credential-shaped model output', () => {
  const result = validateRepairResponse({
    decision: 'repair',
    summary: 'use access_token: leaked-value',
    changes: [{ path: 'src/example.js', content: 'safe\n' }],
  }, { allowedFiles: ['src/example.js'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /凭据/);
});
