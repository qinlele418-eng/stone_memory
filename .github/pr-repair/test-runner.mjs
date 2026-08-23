import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from './git.mjs';
import { parseTap } from './tap.mjs';
import { redactSensitiveText } from './contract.mjs';

function sanitizedEnv() {
  const env = { ...process.env };
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ZAI_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    delete env[name];
  }
  return env;
}

export async function runTests({ cwd = process.cwd(), timeoutMs = 1_800_000 } = {}) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return {
      command: 'npm test',
      exitCode: 1,
      timedOut: false,
      result: { total: 1, passed: 0, failed: 1, failures: [{ name: 'test entry', error: '无法读取有效 package.json' }] },
      stderr: '',
      passed: false,
    };
  }
  if (packageJson?.scripts?.test !== 'node --test') {
    return {
      command: 'npm test',
      exitCode: 1,
      timedOut: false,
      result: { total: 1, passed: 0, failed: 1, failures: [{ name: 'test entry', error: 'package.json 的 test 入口不是受信任的 node --test' }] },
      stderr: '',
      passed: false,
    };
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runCommand(npmCommand, ['test'], {
    cwd,
    env: sanitizedEnv(),
    timeoutMs,
  });
  const parsed = parseTap(result.stdout, { cwd });
  parsed.failures = parsed.failures.map((failure) => Object.fromEntries(
    Object.entries(failure).map(([key, value]) => [key, typeof value === 'string' ? redactSensitiveText(value) : value]),
  ));
  if (result.code !== 0 && parsed.failed === 0) {
    parsed.failed = 1;
    parsed.total = Math.max(parsed.total, 1);
    parsed.failures.push({ name: 'npm test', error: result.timedOut ? 'npm test 超时' : `npm test 退出码 ${result.code}` });
  }
  const tapValid = /^TAP version\s+\d+/m.test(result.stdout) && /^1\.\.\d+/m.test(result.stdout) && parsed.total > 0;
  if (result.code === 0 && !tapValid) {
    parsed.failed = Math.max(parsed.failed, 1);
    parsed.total = Math.max(parsed.total, 1);
    parsed.failures.push({ name: 'npm test', error: '测试命令没有产生有效的 TAP 测试证据' });
  }
  return {
    command: 'npm test',
    exitCode: result.code,
    timedOut: result.timedOut,
    result: parsed,
    stderr: redactSensitiveText(result.stderr.slice(-12_000)),
    passed: result.code === 0 && !result.timedOut && tapValid && parsed.failed === 0,
  };
}

export async function main() {
  const report = await runTests({
    cwd: process.env.TEST_CWD || process.cwd(),
    timeoutMs: Number(process.env.TEST_TIMEOUT_MS || 1_800_000),
  });
  const output = process.env.TEST_REPORT_PATH || 'pr-repair-test.json';
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
