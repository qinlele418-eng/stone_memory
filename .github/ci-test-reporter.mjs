import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function scalar(value) {
  const text = value.trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function field(lines, name) {
  const index = lines.findIndex((line) => new RegExp(`^\\s{2}${name}:`).test(line));
  if (index < 0) return undefined;

  const first = lines[index].slice(lines[index].indexOf(':') + 1).trim();
  if (first !== '|' && first !== '|-') return scalar(first);

  const values = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line && !line.startsWith('    ')) break;
    values.push(line.startsWith('    ') ? line.slice(4) : '');
  }
  while (values.at(-1) === '') values.pop();
  return values.join('\n');
}

function location(value) {
  if (!value) return {};
  const match = scalar(value).match(/^(.*):(\d+)(?::(\d+))?$/);
  if (!match) return { file: scalar(value) };
  return { file: displayFile(match[1]), line: match[2], column: match[3] };
}

function displayFile(file) {
  const normalized = file.replaceAll('\\', '/');
  const root = process.cwd().replaceAll('\\', '/').replace(/\/$/, '');
  return normalized === root ? '.' : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function parseFailure(name, lines) {
  return {
    name: name || 'Unnamed test',
    ...location(field(lines, 'location')),
    error: field(lines, 'error'),
    expected: field(lines, 'expected'),
    actual: field(lines, 'actual'),
  };
}

function lastCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : undefined;
}

function parseTap(output) {
  const lines = output.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const failures = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^not ok(?:\s+\d+)?(?:\s+-\s+)?(.*)$/);
    if (!match) continue;

    const details = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^(?:not )?ok(?:\s+\d+)?(?:\s+-\s+)?/.test(lines[cursor])) break;
      if (/^1\.\./.test(lines[cursor])) break;
      if (/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+\s*$/.test(lines[cursor])) break;
      details.push(lines[cursor]);
    }
    failures.push(parseFailure(match[1].trim(), details));
  }

  const passed = lastCount(output, 'pass') ?? 0;
  const failed = lastCount(output, 'fail') ?? failures.length;
  const total = lastCount(output, 'tests') ?? passed + failed;
  return { total, passed, failed, failures };
}

function codeBlock(value) {
  if (value === undefined || value === '') return [];
  return ['```text', String(value), '```'];
}

function render(result) {
  const failed = result.failed;
  if (failed === 0) return `✅ ${result.total} tests passed\n`;

  const lines = [`❌ ${failed} ${failed === 1 ? 'test' : 'tests'} failed`, ''];
  for (const failure of result.failures) {
    lines.push(`### ${failure.name}`);
    if (failure.file) {
      lines.push(`${failure.file}${failure.line ? `:${failure.line}` : ''}${failure.column ? `:${failure.column}` : ''}`);
    }
    if (failure.error !== undefined) lines.push('', '**Error:**', ...codeBlock(failure.error));
    if (failure.expected !== undefined) lines.push('', '**Expected:**', ...codeBlock(failure.expected));
    if (failure.actual !== undefined) lines.push('', '**Actual:**', ...codeBlock(failure.actual));
    lines.push('');
  }
  lines.push('### Summary', `${result.total} total / ${result.passed} passed / ${result.failed} failed`);
  return `${lines.join('\n')}\n`;
}

function publish(result) {
  const output = render(result);
  process.stdout.write(`\n${output}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, output);
  } catch (error) {
    process.stderr.write(`Unable to write GitHub step summary: ${error.message}\n`);
  }
}

const child = spawn(npmCommand, ['test'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});
let stdout = '';
let spawnError;

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('error', (error) => {
  spawnError = error;
});
child.on('close', (code) => {
  const result = parseTap(stdout);
  if (spawnError) {
    result.failed = Math.max(result.failed, 1);
    result.total = Math.max(result.total, 1);
    result.failures.push({ name: 'npm test', error: spawnError.message });
  } else if (code !== 0 && result.failed === 0) {
    result.failed = 1;
    result.total = Math.max(result.total, 1);
    result.failures.push({ name: 'npm test', error: `npm test exited with code ${code}` });
  }
  publish(result);
  process.exitCode = code ?? 1;
});
