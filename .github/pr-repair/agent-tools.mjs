import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand, runGit, readFileAt } from './git.mjs';
import {
  isSafeRelativePath,
  normalizeSafeRelativePath,
  redactErrorMessage,
  redactModelValue,
  redactSensitiveText,
  validateRepairResponse,
} from './contract.mjs';

export const AGENT_TOOL_LIMITS = Object.freeze({
  maxReadChars: 12_000,
  maxSearchChars: 8_000,
  maxDiffChars: 16_000,
  maxTestChars: 12_000,
  maxPatchChars: 10_000,
  maxReadLines: 240,
});

export async function runSandboxedTests({ cwd, runCommandImpl = runCommand, timeoutMs = 8 * 60 * 1_000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stone-memory-pr-agent-tests-'));
  const install = join(directory, 'install');
  const output = join(directory, 'output');
  await mkdir(install, { recursive: true });
  await mkdir(output, { recursive: true });
  const packageJson = join(cwd, 'package.json');
  const packageLock = join(cwd, 'package-lock.json');
  try {
    await cp(packageJson, join(install, 'package.json'));
    await cp(packageLock, join(install, 'package-lock.json'));
    const installResult = await runCommandImpl('docker', [
      'run', '--rm', '--init', '--user', `${process.getuid?.() || 0}:${process.getgid?.() || 0}`,
      '-v', `${install}:/install:rw`, '-w', '/install',
      '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache',
      '-e', 'GITHUB_TOKEN=', '-e', 'GH_TOKEN=', '-e', 'ZAI_API_KEY=',
      '-e', 'NPM_TOKEN=', '-e', 'NODE_AUTH_TOKEN=',
      '-e', 'ACTIONS_RUNTIME_TOKEN=', '-e', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN=',
      'node:22-bookworm', 'npm', 'ci', '--no-audit', '--no-fund',
    ], { cwd, timeoutMs });
    if (installResult.code !== 0) {
      return {
        command: 'npm test',
        exitCode: installResult.code,
        timedOut: installResult.timedOut,
        result: { total: 1, passed: 0, failed: 1, failures: [{ name: 'npm ci', error: '隔离依赖安装失败' }] },
        stderr: clip(redactSensitiveText(installResult.stderr || installResult.stdout), AGENT_TOOL_LIMITS.maxTestChars),
        passed: false,
      };
    }
    await rm(join(cwd, 'node_modules'), { recursive: true, force: true });
    await cp(join(install, 'node_modules'), join(cwd, 'node_modules'), { recursive: true });
    const reportPath = join(output, 'pr-repair-test.json');
    const runnerPath = fileURLToPath(new URL('./test-runner.mjs', import.meta.url));
    const testResult = await runCommandImpl('docker', [
      'run', '--rm', '--init', '--network', 'none', '--user', `${process.getuid?.() || 0}:${process.getgid?.() || 0}`,
      '-v', `${cwd}:/work:rw`, '-v', `${dirname(runnerPath)}:/tools:ro`, '-v', `${output}:/out:rw`,
      '-w', '/work', '-e', 'HOME=/tmp',
      '-e', 'GITHUB_TOKEN=', '-e', 'GH_TOKEN=', '-e', 'ZAI_API_KEY=',
      '-e', 'NPM_TOKEN=', '-e', 'NODE_AUTH_TOKEN=',
      '-e', 'ACTIONS_RUNTIME_TOKEN=', '-e', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN=',
      '-e', 'TEST_CWD=/work', '-e', 'TEST_REPORT_PATH=/out/pr-repair-test.json',
      'node:22-bookworm', 'node', '/tools/test-runner.mjs',
    ], { cwd, timeoutMs });
    try {
      return JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      return {
        command: 'npm test',
        exitCode: testResult.code,
        timedOut: testResult.timedOut,
        result: { total: 1, passed: 0, failed: 1, failures: [{ name: 'npm test', error: testResult.timedOut ? '隔离测试超时' : '隔离测试没有产生报告' }] },
        stderr: clip(redactSensitiveText(testResult.stderr || testResult.stdout), AGENT_TOOL_LIMITS.maxTestChars),
        passed: false,
      };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: '读取 repair worktree 的 git 状态、未解决冲突和三方 SHA。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '按行范围读取仓库内文件；不要一次读取大文件全文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: '在仓库内搜索符号、调用者、API 或测试引用；只返回有限匹配。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_show_file',
      description: '查看同一文件在 base、pr 或 main 版本中的内容，支持三方比较。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          revision: { type: 'string', enum: ['base', 'pr', 'main'] },
        },
        required: ['path', 'revision'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '查看当前工作区、暂存区或 base/pr 的有限 diff。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['working', 'staged', 'base_pr', 'main_pr'] },
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: '在当前 repair worktree 应用小范围 unified patch；这是唯一代码修改工具。',
      parameters: {
        type: 'object',
        properties: { patch: { type: 'string' } },
        required: ['patch'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: '运行受信任的相关/完整测试并返回脱敏后的有限结果。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['related', 'full'] },
          files: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '结束维修；repair_complete 只表示代码已修改且相关测试通过，不代表允许 push。',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['repair_complete', 'needs_human'] },
          summary: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['decision'],
        additionalProperties: false,
      },
    },
  },
]);

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[输出已截断]`;
}

function safeReadPath(root, file, { allowDirectory = false } = {}) {
  const normalized = normalizeSafeRelativePath(file);
  if (!normalized || normalized === '.') throw new Error(`拒绝读取不安全路径: ${file}`);
  const absoluteRoot = realpathSync(root);
  let current = absoluteRoot;
  for (const part of normalized.split('/')) {
    current = resolve(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { throw new Error(`文件不存在: ${normalized}`); }
    if (stat.isSymbolicLink()) throw new Error(`拒绝读取符号链接: ${normalized}`);
  }
  if (!allowDirectory && !lstatSync(current).isFile()) throw new Error(`目标不是普通文件: ${normalized}`);
  if (allowDirectory && !lstatSync(current).isDirectory() && !lstatSync(current).isFile()) throw new Error(`目标不是可搜索路径: ${normalized}`);
  return { normalized, absolute: current };
}

function safeSearchPath(root, file = '.') {
  const normalized = file === '.' ? '.' : normalizeSafeRelativePath(file);
  if (normalized === null || normalized === undefined) throw new Error(`拒绝搜索不安全路径: ${file}`);
  if (normalized === '.') return { normalized, absolute: realpathSync(root) };
  return safeReadPath(root, normalized, { allowDirectory: true });
}

function failureSummary(report) {
  const result = redactModelValue(report?.result || {});
  return {
    passed: report?.passed === true,
    command: report?.command,
    result: {
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      failures: Array.isArray(result.failures) ? result.failures.slice(0, 8) : [],
    },
    stderr: clip(redactSensitiveText(report?.stderr || ''), AGENT_TOOL_LIMITS.maxTestChars),
  };
}

export function createAgentTools({
  cwd,
  revisions = {},
  allowedFiles = [],
  runTestsImpl = runSandboxedTests,
  runGitImpl = runGit,
  runCommandImpl = runCommand,
  now = () => Date.now(),
} = {}) {
  if (!cwd) throw new Error('agent tools 缺少 repair worktree');
  const allowed = [...new Set(allowedFiles.map(normalizeSafeRelativePath).filter(Boolean))];
  const state = {
    startedAt: now(),
    changedFiles: [],
    lastTestPassed: false,
    readOnlyCalls: 0,
    patchCalls: 0,
    testCalls: 0,
  };

  async function getStatus() {
    const [status, unresolved, head] = await Promise.all([
      runGitImpl(['status', '--short', '--branch'], { cwd, timeoutMs: 30_000 }),
      runGitImpl(['diff', '--name-only', '--diff-filter=U'], { cwd, timeoutMs: 30_000 }),
      runGitImpl(['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 }),
    ]);
    return {
      ok: status.code === 0 && unresolved.code === 0 && head.code === 0,
      headSha: head.code === 0 ? head.stdout.trim() : null,
      baseSha: revisions.base || null,
      prSha: revisions.pr || null,
      mainSha: revisions.main || revisions.base || null,
      status: clip(redactSensitiveText(`${status.stdout}${status.stderr}`), 8_000),
      unresolved: unresolved.code === 0 ? unresolved.stdout.split(/\r?\n/).filter(Boolean) : [],
    };
  }

  async function readFileTool(args = {}) {
    const { normalized, absolute } = safeReadPath(cwd, args.path);
    const content = await readFile(absolute, 'utf8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line || 1));
    const requestedEnd = Number(args.end_line || Math.min(lines.length, start + AGENT_TOOL_LIMITS.maxReadLines - 1));
    const end = Math.min(lines.length, Math.max(start, requestedEnd), start + AGENT_TOOL_LIMITS.maxReadLines - 1);
    return { ok: true, path: normalized, startLine: start, endLine: end, content: clip(redactSensitiveText(lines.slice(start - 1, end).join('\n')), AGENT_TOOL_LIMITS.maxReadChars) };
  }

  async function searchCode(args = {}) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('search_code 缺少 query');
    const target = safeSearchPath(cwd, args.path || '.');
    const result = await runCommandImpl('rg', ['--no-heading', '--line-number', '--fixed-strings', '--max-count', '40', query, target.normalized], { cwd, timeoutMs: 30_000 });
    if (result.code !== 0 && result.code !== 1) throw new Error(redactErrorMessage(result.stderr || result.stdout || 'rg 搜索失败'));
    return { ok: true, query, path: target.normalized, matches: clip(redactSensitiveText(result.stdout), AGENT_TOOL_LIMITS.maxSearchChars), truncated: result.stdout.length > AGENT_TOOL_LIMITS.maxSearchChars };
  }

  async function gitShowFile(args = {}) {
    const { normalized } = safeReadPath(cwd, args.path);
    const revision = revisions[args.revision];
    if (!revision) throw new Error(`没有配置 revision: ${args.revision}`);
    const content = await readFileAt(cwd, revision, normalized);
    return { ok: content !== null, path: normalized, revision: args.revision, content: content === null ? '[文件不存在]' : clip(redactSensitiveText(content), AGENT_TOOL_LIMITS.maxReadChars) };
  }

  async function gitDiff(args = {}) {
    const path = args.path ? safeReadPath(cwd, args.path).normalized : null;
    const suffix = path ? ['--', path] : [];
    let gitArgs;
    if (args.scope === 'staged') gitArgs = ['diff', '--cached', '--no-ext-diff', '--unified=40', ...suffix];
    else if (args.scope === 'base_pr') gitArgs = ['diff', '--no-ext-diff', '--unified=40', `${revisions.base}...${revisions.pr}`, ...suffix];
    else if (args.scope === 'main_pr') gitArgs = ['diff', '--no-ext-diff', '--unified=40', `${revisions.main}...${revisions.pr}`, ...suffix];
    else gitArgs = ['diff', '--no-ext-diff', '--unified=40', ...suffix];
    const result = await runGitImpl(gitArgs, { cwd, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(redactErrorMessage(result.stderr || result.stdout || 'git diff 失败'));
    return { ok: true, scope: args.scope || 'working', path, diff: clip(redactSensitiveText(result.stdout), AGENT_TOOL_LIMITS.maxDiffChars), truncated: result.stdout.length > AGENT_TOOL_LIMITS.maxDiffChars };
  }

  async function applyPatchTool(args = {}) {
    const patch = String(args.patch || '');
    if (!patch || patch.length > AGENT_TOOL_LIMITS.maxPatchChars) throw new Error(`patch 不能为空且不得超过 ${AGENT_TOOL_LIMITS.maxPatchChars} 字符`);
    const validation = validateRepairResponse({ decision: 'repair', summary: 'agent patch', patch }, { allowedFiles: allowed });
    if (!validation.ok) throw new Error(validation.errors.join('；'));
    const directory = await mkdtemp(join(tmpdir(), 'stone-memory-pr-agent-'));
    const patchPath = join(directory, 'repair.patch');
    try {
      await writeFile(patchPath, patch, 'utf8');
      let result = await runGitImpl(['apply', '--3way', '--whitespace=nowarn', patchPath], { cwd, timeoutMs: 60_000 });
      if (result.code !== 0) {
        const unresolved = await runGitImpl(['diff', '--name-only', '--diff-filter=U'], { cwd, timeoutMs: 30_000 });
        if (unresolved.code === 0 && unresolved.stdout.trim()) {
          // git apply cannot use an unmerged index; the bounded patch utility only edits the
          // already-validated worktree path and never receives arbitrary shell input.
          result = await runCommandImpl('patch', ['--batch', '--forward', '--reject-file=-', '-p1', '--input', patchPath], { cwd, timeoutMs: 60_000 });
        }
      }
      if (result.code !== 0) return { ok: false, applied: false, error: clip(redactErrorMessage(result.stderr || result.stdout || 'git apply 失败'), 8_000) };
      const names = await runGitImpl(['diff', '--name-only'], { cwd, timeoutMs: 30_000 });
      state.changedFiles = names.code === 0 ? names.stdout.split(/\r?\n/).filter(Boolean) : validation.files;
      return { ok: true, applied: true, changedFiles: state.changedFiles };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function runTestsTool(args = {}) {
    if (args.mode !== 'related' && args.mode !== 'full') throw new Error('run_tests 的 mode 必须是 related 或 full');
    const report = await runTestsImpl({ cwd, timeoutMs: 8 * 60 * 1_000 });
    state.lastTestPassed = report.passed === true;
    return { ok: true, mode: 'full', requestedMode: args.mode, ...failureSummary(report) };
  }

  async function finishTool(args = {}) {
    if (!['repair_complete', 'needs_human'].includes(args.decision)) throw new Error('finish decision 无效');
    return { ok: true, status: args.decision, summary: clip(redactSensitiveText(args.summary || ''), 2_000), reason: clip(redactSensitiveText(args.reason || ''), 2_000) };
  }

  async function call(name, args = {}) {
    state.readOnlyCalls += 0;
    if (name === 'get_status') return getStatus();
    if (name === 'read_file') return readFileTool(args);
    if (name === 'search_code') return searchCode(args);
    if (name === 'git_show_file') return gitShowFile(args);
    if (name === 'git_diff') return gitDiff(args);
    if (name === 'apply_patch') return applyPatchTool(args);
    if (name === 'run_tests') return runTestsTool(args);
    if (name === 'finish') return finishTool(args);
    throw new Error(`拒绝未知工具: ${name}`);
  }

  return {
    definitions: TOOL_DEFINITIONS,
    call,
    snapshot() {
      return {
        ...state,
        elapsedMs: Math.max(0, now() - state.startedAt),
        changedFiles: [...state.changedFiles],
      };
    },
  };
}
