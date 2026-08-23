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

function displayFile(file, cwd = process.cwd()) {
  const normalized = file.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  const root = cwd.replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return normalized === root ? '.' : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function location(value, cwd) {
  if (!value) return {};
  const match = scalar(value).match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) return { file: scalar(value) };
  return { file: displayFile(match[1], cwd), line: match[2], column: match[3] };
}

function parseFailure(name, lines, cwd) {
  return {
    name: name || 'Unnamed test',
    ...location(field(lines, 'location'), cwd),
    error: field(lines, 'error'),
    expected: field(lines, 'expected'),
    actual: field(lines, 'actual'),
  };
}

function lastCount(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : undefined;
}

export function parseTap(output, { cwd = process.cwd() } = {}) {
  const lines = String(output ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
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
    failures.push(parseFailure(match[1].trim(), details, cwd));
  }

  const passed = lastCount(output, 'pass') ?? 0;
  const failed = lastCount(output, 'fail') ?? failures.length;
  const total = lastCount(output, 'tests') ?? passed + failed;
  return { total, passed, failed, failures };
}

export function renderTap(result) {
  if (result.failed === 0) return `✅ ${result.total} tests passed\n`;
  const lines = [`❌ ${result.failed} ${result.failed === 1 ? 'test' : 'tests'} failed`, ''];
  for (const failure of result.failures ?? []) {
    lines.push(`### ${failure.name}`);
    if (failure.file) lines.push(`${failure.file}${failure.line ? `:${failure.line}` : ''}${failure.column ? `:${failure.column}` : ''}`);
    if (failure.error !== undefined) lines.push('', '**Error:**', '```text', String(failure.error), '```');
    if (failure.expected !== undefined) lines.push('', '**Expected:**', '```text', String(failure.expected), '```');
    if (failure.actual !== undefined) lines.push('', '**Actual:**', '```text', String(failure.actual), '```');
    lines.push('');
  }
  lines.push('### Summary', `${result.total} total / ${result.passed} passed / ${result.failed} failed`);
  return `${lines.join('\n')}\n`;
}

export { displayFile, field, location, scalar };
