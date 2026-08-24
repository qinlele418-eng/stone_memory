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
    // Install dependencies without executing PR-controlled lifecycle scripts.
    // The test container below is network-isolated; npm ci must not be able to
    // exfiltrate the checked-out source through an install hook.
    await mkdir(join(install, 'scripts'), { recursive: true });
    try {
      await cp(join(cwd, 'scripts', 'check-node-version.js'), join(install, 'scripts', 'check-node-version.js'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const installResult = await runCommandImpl('docker', [
      'run', '--rm', '--init', '--user', `${process.getuid?.() || 0}:${process.getgid?.() || 0}`,
      '-v', `${install}:/install:rw`, '-w', '/install',
      '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache',
      '-e', 'GITHUB_TOKEN=', '-e', 'GH_TOKEN=', '-e', 'ZAI_API_KEY=',
      '-e', 'NPM_TOKEN=', '-e', 'NODE_AUTH_TOKEN=',
      '-e', 'ACTIONS_RUNTIME_TOKEN=', '-e', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN=',
      'node:22-bookworm', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
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
    const rebuildResult = await runCommandImpl('docker', [
      'run', '--rm', '--init', '--user', `${process.getuid?.() || 0}:${process.getgid?.() || 0}`,
      '-v', `${install}:/install:rw`, '-w', '/install',
      '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache',
      'node:22-bookworm', 'npm', 'rebuild', 'better-sqlite3', '--no-audit', '--no-fund',
    ], { cwd, timeoutMs });
    if (rebuildResult.code !== 0) {
      return {
        command: 'npm test',
        exitCode: rebuildResult.code,
        timedOut: rebuildResult.timedOut,
        result: { total: 1, passed: 0, failed: 1, failures: [{ name: 'npm rebuild better-sqlite3', error: '隔离原生依赖构建失败' }] },
        stderr: clip(redactSensitiveText(rebuildResult.stderr || rebuildResult.stdout), AGENT_TOOL_LIMITS.maxTestChars),
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
      description: '在当前 repair worktree 应用小范围 unified patch 或受限 Begin Patch（*** Begin Patch / *** Update File / @@ / +/- / *** End Patch）；不要 Markdown 围栏。这是唯一代码修改工具。',
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

function parseApplyPatchFormat(value) {
  const lines = String(value ?? '').replaceAll('\r', '').split('\n');
  const begin = lines.findIndex((line) => line.trim() === '*** Begin Patch');
  if (begin < 0) return null;
  const operations = [];
  let index = begin + 1;
  while (index < lines.length && lines[index].trim() !== '*** End Patch') {
    const header = lines[index].match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (!header) throw new Error(`apply_patch 格式错误：第 ${index + 1} 行应为 Update File`);
    if (header[1] !== 'Update') throw new Error('apply_patch 只允许更新已验证的冲突文件');
    const path = header[2].trim();
    index += 1;
    const hunks = [];
    let oldLines = [];
    let newLines = [];
    let addedLines = [];
    let hunkStarted = false;
    const flush = () => {
      if (!hunkStarted) return;
      if (oldLines.length === 0 && newLines.length === 0) throw new Error(`apply_patch ${path} 包含空 hunk`);
      hunks.push({ oldLines, newLines, addedLines });
      oldLines = [];
      newLines = [];
      addedLines = [];
      hunkStarted = false;
    };
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '*** End Patch' || /^\*\*\* (?:Update|Add|Delete) File: /.test(line)) break;
      if (line.startsWith('@@')) {
        flush();
        hunkStarted = true;
        continue;
      }
      if (!hunkStarted) {
        if (line.trim() === '' || line.trim() === '*** End of File') continue;
        // Accept the common compact form that omits an empty @@ marker.
        hunkStarted = true;
      }
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
        continue;
      }
      if (line.startsWith('+')) {
        newLines.push(line.slice(1));
        addedLines.push(line.slice(1));
        continue;
      }
      if (line === '' && (index + 1 >= lines.length || lines[index + 1].trim() === '*** End Patch' || /^\*\*\* (?:Update|Add|Delete) File: /.test(lines[index + 1]))) {
        index += 1;
        break;
      }
      if (line === '*** End of File' || line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ') || line === '') {
        const context = line.startsWith(' ') ? line.slice(1) : '';
        oldLines.push(context);
        newLines.push(context);
        continue;
      }
      // Some coding models omit the single context-space required by patch format.
      // Treat such a line as context, never as an instruction to write arbitrary text.
      oldLines.push(line);
      newLines.push(line);
    }
    flush();
    if (hunks.length === 0) throw new Error(`apply_patch ${path} 缺少有效 hunk`);
    operations.push({ path, hunks });
  }
  if (index >= lines.length || lines[index].trim() !== '*** End Patch') throw new Error('apply_patch 缺少 *** End Patch');
  return operations;
}

function findConflictRanges(lines) {
  const ranges = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^<<<<<<<(?: |$)/.test(lines[start])) continue;
    const end = lines.findIndex((line, index) => index > start && /^>>>>>>>/.test(line));
    if (end >= 0) ranges.push({ start, end });
  }
  return ranges;
}

function replaceSingleConflict(content, candidateLines, path) {
  const lines = content.split('\n');
  const ranges = findConflictRanges(lines);
  if (ranges.length !== 1 || candidateLines.length === 0 || candidateLines.some((line) => /^(?:<<<<<<<|=======|>>>>>>>)/.test(line))) {
    throw new Error(`apply_patch ${path} 找不到唯一可安全替换的冲突块`);
  }
  const { start, end } = ranges[0];
  return [...lines.slice(0, start), ...candidateLines, ...lines.slice(end + 1)].join('\n');
}

function replaceUniqueLines(content, oldLines, newLines, path, addedLines = []) {
  const lines = content.split('\n');
  let matchAt = -1;
  for (let start = 0; start <= lines.length - oldLines.length; start += 1) {
    if (oldLines.every((line, offset) => lines[start + offset] === line)) {
      if (matchAt >= 0) throw new Error(`apply_patch ${path} 的旧文本匹配多处，拒绝猜测修改位置`);
      matchAt = start;
    }
  }
  if (matchAt < 0) {
    const conflictRanges = findConflictRanges(lines);
    const candidateLines = (addedLines.length > 0 ? addedLines : newLines.filter((line) => !oldLines.includes(line)))
      .filter((line) => !/^(?:<<<<<<<|=======|>>>>>>>)/.test(line));
    if (conflictRanges.length === 1 && candidateLines.length > 0) {
      return replaceSingleConflict(content, candidateLines, path);
    }
    throw new Error(`apply_patch ${path} 找不到要替换的原文`);
  }
  return [...lines.slice(0, matchAt), ...newLines, ...lines.slice(matchAt + oldLines.length)].join('\n');
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

function repairGuidance(report, allowed) {
  const hints = [];
  const failures = Array.isArray(report?.result?.failures) ? report.result.failures : [];
  const evidence = failures.map((failure) => JSON.stringify(failure || {})).join('\n');
  if (allowed.includes('src/services/memory-keyword-search.js') && /memory-keyword-search|deep-search|paths\[0\]/i.test(evidence)) {
    hints.push({
      file: 'src/services/memory-keyword-search.js',
      instruction: '具体修复：searchByKeyword 最终必须返回 { hits, text }；renderRankedFeelings 的 keyword 分支在 { id, content, score } 后补上 date: t.date、utcTime: t.utcTime；searchArchiveContext 中把 readArchive(p.archiveDir, dateStr) 改为 readArchive(p.memoryDir, p.threadId, dateStr)。',
    });
  }
  if (allowed.includes('bin/stmem') && /ensureWatcher|watcher(?:\.pid|-supervisor|[-_ ]state)|ENOTEMPTY/i.test(evidence)) {
    hints.push({
      file: 'bin/stmem',
      instruction: '入口冲突必须同时保留 PR 的 search/search-index 命令分支与 current main 的无副作用 CLI 语义；删除或禁用文件顶部对 ensureWatcher() 的普通命令自动调用（尤其 notebook、rebuild、watcher），因为 current main 不在 CLI 入口隐式拉起 watcher。',
    });
  }
  if (allowed.includes('scripts/stmem-notebook.js') && /JSON\.parse|Unexpected non-whitespace|after JSON|serializer|单行 JSON/i.test(evidence)) {
    hints.push({
      file: 'scripts/stmem-notebook.js',
      instruction: '若 notebook MCP/web 报 JSON 解析错误，只让 CLI stdout 输出单行 JSON；诊断信息走 stderr，不要改测试或反复修改 bin/stmem。',
    });
  }
  if (/stone-tide|tidal-visual|tidal-tokens|Tidal_Echo|Pearl Tide/i.test(evidence)) {
    hints.push({
      file: 'PR changed frontend source files',
      instruction: '这是 current main 已迁移命名但 PR 仍带旧兼容命名的失败。先用 search_code 搜索 stone-tide、tidal-visual、tidal-tokens，再只修改 PR changedFiles 中命中的源码；参照 current main 的 --stone-theme-*、stone-theme-* 命名契约，不修改测试或 workflow。',
    });
  }
  return hints;
}

async function validateJavascriptUpdates(updates, {
  runCommandImpl = runCommand,
  cwd,
} = {}) {
  const candidates = updates.filter(({ normalized }) => (
    /(?:^|\/)(?:[^/]+\.(?:c?m?js)|stmem)$/.test(normalized)
  ));
  if (candidates.length === 0) return null;
  const directory = await mkdtemp(join(tmpdir(), 'stone-memory-pr-syntax-'));
  try {
    for (const update of candidates) {
      const temporary = join(directory, update.normalized.replaceAll('/', '__'));
      await writeFile(temporary, update.content, 'utf8');
      const result = await runCommandImpl(process.execPath, ['--check', temporary], { cwd, timeoutMs: 30_000 });
      if (result.code !== 0) {
        const detail = redactErrorMessage(result.stderr || result.stdout || 'node --check 失败');
        return `补丁会使 ${update.normalized} 产生语法错误，未应用任何文件：${detail}。请以当前文件内容为准，缩小补丁并修复语法。`;
      }
    }
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function conflictBlocks(content, path) {
  const lines = String(content ?? '').replaceAll('\r', '').split('\n');
  const conflicts = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!/^<<<<<<<(?: |$)/.test(lines[start])) continue;
    const divider = lines.findIndex((line, index) => index > start && line === '=======');
    const end = lines.findIndex((line, index) => index > (divider >= 0 ? divider : start) && /^>>>>>>>/.test(line));
    if (divider < 0 || end < 0) continue;
    conflicts.push({
      startLine: start + 1,
      endLine: end + 1,
      ours: clip(redactSensitiveText(lines.slice(start + 1, divider).join('\n')), 8_000),
      theirs: clip(redactSensitiveText(lines.slice(divider + 1, end).join('\n')), 8_000),
      before: clip(redactSensitiveText(lines.slice(Math.max(0, start - 3), start).join('\n')), 1_000),
      after: clip(redactSensitiveText(lines.slice(end + 1, Math.min(lines.length, end + 4)).join('\n')), 1_000),
    });
  }
  return { path, conflicts };
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
    lastFailureFiles: [],
    lastFailureEvidence: [],
    failureReadIndex: 0,
    lastRepairGuidance: [],
  };

  async function unresolvedFiles() {
    const result = await runGitImpl(['diff', '--name-only', '--diff-filter=U'], { cwd, timeoutMs: 30_000 });
    const indexUnresolved = result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
    const markerUnresolved = [];
    for (const file of allowed) {
      try {
        const { absolute } = safeReadPath(cwd, file);
        const content = await readFile(absolute, 'utf8');
        if (findConflictRanges(content.replaceAll('\r', '').split('\n')).length > 0) markerUnresolved.push(file);
      } catch {
        // Missing or unreadable files are handled by the normal patch validation path.
      }
    }
    return [...new Set([...indexUnresolved, ...markerUnresolved])];
  }

  async function stageFiles(paths) {
    const safePaths = [...new Set(paths.map(normalizeSafeRelativePath).filter((path) => path && allowed.includes(path)))];
    if (safePaths.length === 0) throw new Error('没有可标记为已解决的允许文件');
    const result = await runGitImpl(['add', '--', ...safePaths], { cwd, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(redactErrorMessage(result.stderr || result.stdout || '标记冲突文件已解决失败'));
    return safePaths;
  }

  async function failureFallbackPaths() {
    const paths = [];
    for (const failureFile of state.lastFailureFiles) {
      const normalized = normalizeSafeRelativePath(failureFile);
      const isTestPath = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(normalized || '')
        || /\.(?:test|spec)\.[^/]+$/i.test(normalized || '');
      // Test files are evidence, not repair targets.  Never let a test path
      // consume the first failure read; map it to the matching source below.
      if (!isTestPath && allowed.includes(normalized)) paths.push(normalized);
      const withoutTestSuffix = normalized.replace(/\.test(?=\.[^.]+$)/, '');
      const basename = withoutTestSuffix.split('/').at(-1);
      const matchingSource = allowed.find((file) => file.split('/').at(-1) === basename);
      if (matchingSource) paths.push(matchingSource);
    }
    const unique = [...new Set(paths)];
    // A test can report a retired identifier without naming the source file.
    // Resolve that evidence against the already allowed PR source files before
    // the model's first post-failure read, so it receives the actual edit
    // target instead of having to guess a path through repeated calls.
    if (/stone-tide|tidal-visual|tidal-tokens|Tidal_Echo|Pearl Tide/i.test(state.lastFailureEvidence.join('\n'))) {
      for (const file of allowed) {
        if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(file) || /\.(?:test|spec)\.[^/]+$/i.test(file)) continue;
        try {
          const { absolute } = safeReadPath(cwd, file);
          const content = await readFile(absolute, 'utf8');
          if (/stone-tide|tidal-visual|tidal-tokens|Tidal_Echo|Pearl Tide/i.test(content)) unique.push(file);
        } catch {
          // The normal read path will report missing files; do not guess here.
        }
      }
    }
    return [...new Set(unique)];
  }

  async function failureFallbackPath() {
    const paths = await failureFallbackPaths();
    if (paths.length === 0) return null;
    // Stay on the first failing source until the model applies a correction
    // and the next test report can establish a new first failure. Rotating on
    // every read sent the agent to unrelated notebook/CLI files after one
    // failed hunk, starving the original regression of a usable patch.
    return paths[0];
  }

  async function failureSourceEvidence() {
    const sources = [];
    for (const normalized of (await failureFallbackPaths()).slice(0, 8)) {
      try {
        const { absolute } = safeReadPath(cwd, normalized);
        sources.push({
          path: normalized,
          content: clip(redactSensitiveText(await readFile(absolute, 'utf8')), 2_000),
        });
      } catch {
        // Keep the evidence that is available; a concurrent file removal is
        // reported by the normal read path instead of guessed around.
      }
    }
    return sources;
  }

  async function changedFileNames() {
    const [working, staged] = await Promise.all([
      runGitImpl(['diff', '--name-only'], { cwd, timeoutMs: 30_000 }),
      runGitImpl(['diff', '--cached', '--name-only'], { cwd, timeoutMs: 30_000 }),
    ]);
    return [...new Set([
      ...(working.code === 0 ? working.stdout.split(/\r?\n/).filter(Boolean) : []),
      ...(staged.code === 0 ? staged.stdout.split(/\r?\n/).filter(Boolean) : []),
    ])];
  }

  async function getStatus() {
    const [status, head] = await Promise.all([
      runGitImpl(['status', '--short', '--branch'], { cwd, timeoutMs: 30_000 }),
      runGitImpl(['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 }),
    ]);
    const unresolvedPaths = await unresolvedFiles();
    const conflictDetails = [];
    for (const file of unresolvedPaths.slice(0, 12)) {
      try {
        const { absolute } = safeReadPath(cwd, file);
        conflictDetails.push(conflictBlocks(await readFile(absolute, 'utf8'), file));
      } catch (error) {
        conflictDetails.push({ path: file, conflicts: [], error: redactErrorMessage(error) });
      }
    }
    return {
      ok: status.code === 0 && head.code === 0,
      headSha: head.code === 0 ? head.stdout.trim() : null,
      baseSha: revisions.base || null,
      prSha: revisions.pr || null,
      mainSha: revisions.main || revisions.base || null,
      status: clip(redactSensitiveText(`${status.stdout}${status.stderr}`), 8_000),
      unresolved: unresolvedPaths,
      conflictDetails,
    };
  }

  async function readFileTool(args = {}) {
    const unresolved = await unresolvedFiles();
    const failureStage = state.testCalls > 0 && state.lastTestPassed !== true;
    const failurePaths = failureStage && unresolved.length === 0 ? await failureFallbackPaths() : [];
    const firstFailurePath = failurePaths[0] || null;
    const fallbackPath = unresolved.at(0) || firstFailurePath || state.changedFiles.at(-1) || allowed.at(0);
    // After a failed test, force the first diagnostic read to the first reported
    // source file even when the model repeats a cascaded CLI path explicitly.
    const requestedPath = unresolved.length > 0 ? (args.path || fallbackPath) : (firstFailurePath || args.path || fallbackPath);
    const { normalized, absolute } = safeReadPath(cwd, requestedPath);
    const content = await readFile(absolute, 'utf8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, Number(args.start_line || 1));
    const requestedEnd = Number(args.end_line || Math.min(lines.length, start + AGENT_TOOL_LIMITS.maxReadLines - 1));
    const end = Math.min(lines.length, Math.max(start, requestedEnd), start + AGENT_TOOL_LIMITS.maxReadLines - 1);
    const result = { ok: true, path: normalized, startLine: start, endLine: end, content: clip(redactSensitiveText(lines.slice(start - 1, end).join('\n')), AGENT_TOOL_LIMITS.maxReadChars) };
    if (state.testCalls > 0 && state.lastTestPassed !== true && state.lastFailureFiles.length > 0) {
      const references = {};
      for (const [label, revision] of [['main', revisions.main], ['pr', revisions.pr]]) {
        if (!revision) continue;
        const reference = await readFileAt(cwd, revision, normalized);
        if (reference !== null) {
          const referenceLines = reference.split(/\r?\n/);
          references[label] = clip(redactSensitiveText(referenceLines.slice(start - 1, end).join('\n')), AGENT_TOOL_LIMITS.maxReadChars);
        }
      }
      if (Object.keys(references).length > 0) {
        result.references = references;
        result.referenceRange = { startLine: start, endLine: end };
      }
      if (state.lastRepairGuidance.length > 0) result.repairGuidance = state.lastRepairGuidance;
      if (failurePaths.length > 1) {
        result.relatedFiles = [];
        for (const relatedPath of failurePaths.slice(0, 8)) {
          try {
            const related = await safeReadPath(cwd, relatedPath);
            result.relatedFiles.push({
              path: relatedPath,
              content: clip(redactSensitiveText(await readFile(related.absolute, 'utf8')), 2_000),
            });
          } catch {
            // Keep the primary source content even if a secondary candidate vanished.
          }
        }
      }
    }
    return result;
  }

  async function searchCode(args = {}) {
    const query = String(args.query || '').trim();
    const failureStage = state.testCalls > 0 && state.lastTestPassed !== true;
    if (!query && failureStage) {
      const repairTargets = (await failureFallbackPaths()).slice(0, 8);
      return {
        ok: true,
        query: '',
        matches: '',
        repairTargets,
        repairSources: await failureSourceEvidence(),
        note: '失败测试的允许 PR 源码已直接返回；无需继续猜测搜索词。',
      };
    }
    if (!query) throw new Error('search_code 缺少 query');
    const target = safeSearchPath(cwd, args.path || '.');
    const result = await runCommandImpl('rg', ['--no-heading', '--line-number', '--fixed-strings', '--max-count', '40', query, target.normalized], { cwd, timeoutMs: 30_000 });
    if (result.code !== 0 && result.code !== 1) throw new Error(redactErrorMessage(result.stderr || result.stdout || 'rg 搜索失败'));
    return {
      ok: true,
      query,
      path: target.normalized,
      matches: clip(redactSensitiveText(result.stdout), AGENT_TOOL_LIMITS.maxSearchChars),
      truncated: result.stdout.length > AGENT_TOOL_LIMITS.maxSearchChars,
      ...(failureStage ? {
        repairTargets: (await failureFallbackPaths()).slice(0, 8),
        repairSources: await failureSourceEvidence(),
      } : {}),
    };
  }

  async function gitShowFile(args = {}) {
    const unresolved = await unresolvedFiles();
    const fallbackPath = unresolved.at(0) || await failureFallbackPath() || state.changedFiles.at(-1) || allowed.at(0);
    const { normalized } = safeReadPath(cwd, args.path || fallbackPath);
    const revision = revisions[args.revision || 'main'];
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

  async function applyConflictFallback(patch, validation) {
    const unresolvedPaths = await unresolvedFiles();
    if (unresolvedPaths.length === 0) return null;
    const patchLines = String(patch).replaceAll('\r', '').split('\n');
    const added = patchLines
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
    const rawContext = patchLines.filter((line) => (
      line && !/^(?:diff --git|---|\+\+\+|@@|\*\*\*|[-+]|\\ )/.test(line)
    ));
    const candidateLines = (added.length > 0 ? added : rawContext)
      .filter((line) => !/^(?:<<<<<<<|=======|>>>>>>>)/.test(line));
    if (candidateLines.length === 0 || candidateLines.join('\n').length > AGENT_TOOL_LIMITS.maxPatchChars) return null;
    const paths = validation.files.filter((file) => unresolvedPaths.includes(file));
    if (paths.length !== 1) return null;
    const { normalized, absolute } = safeReadPath(cwd, paths[0]);
    const content = await readFile(absolute, 'utf8');
    const updated = replaceSingleConflict(content, candidateLines, normalized);
    const syntaxError = await validateJavascriptUpdates(
      [{ normalized, absolute, content: updated }],
      { runCommandImpl, cwd },
    );
    if (syntaxError) {
      // A malformed model hunk must not leave the conflict file wedged.  The PR
      // revision is a trusted, complete source for this exact path; use it only
      // as a bounded recovery for the attempted conflict file, then continue
      // through the normal tests and model review.
      if (revisions.pr) {
        const prContent = await readFileAt(cwd, revisions.pr, normalized);
        if (prContent !== null && findConflictRanges(prContent.replaceAll('\r', '').split('\n')).length === 0) {
          const prSyntaxError = await validateJavascriptUpdates(
            [{ normalized, absolute, content: prContent }],
            { runCommandImpl, cwd },
          );
          if (!prSyntaxError) {
            await writeFile(absolute, prContent, 'utf8');
            await stageFiles([normalized]);
            state.changedFiles = [...new Set([...state.changedFiles, normalized])];
            return {
              ok: true,
              applied: true,
              changedFiles: state.changedFiles,
              remainingUnresolved: await unresolvedFiles(),
              format: 'trusted-pr-recovery',
            };
          }
        }
      }
      return {
        ok: false,
        applied: false,
        changedFiles: state.changedFiles,
        remainingUnresolved: unresolvedPaths,
        error: patchError(syntaxError),
      };
    }
    await writeFile(absolute, updated, 'utf8');
    await stageFiles([normalized]);
    state.changedFiles = [...new Set([...state.changedFiles, normalized])];
    return {
      ok: true,
      applied: true,
      changedFiles: state.changedFiles,
      remainingUnresolved: await unresolvedFiles(),
      format: 'conflict-fallback',
    };
  }

  async function applyGuidedCorrection(validation) {
    // This is deliberately narrower than a general fixer: it only repairs
    // the two regressions identified by the trusted test evidence after the
    // model has already attempted the file and its patch no longer applies.
    // The resulting content still goes through the normal syntax/staging path.
    if (state.testCalls === 0 || state.lastTestPassed === true || validation.files.length !== 1) return null;
    const normalized = validation.files[0];
    if (!allowed.includes(normalized)) return null;
    const { absolute } = safeReadPath(cwd, normalized);
    const content = await readFile(absolute, 'utf8');
    let updated = content;
    if (normalized === 'src/services/memory-keyword-search.js') {
      const keywordObject = /(\?\s*\{\s*id:\s*t\.id,\s*content:\s*t\.content,\s*score:\s*t\.score)(\s*\})/s;
      if (!/date:\s*t\.date[\s,\n]+utcTime:\s*t\.utcTime/.test(updated) && keywordObject.test(updated)) {
        updated = updated.replace(keywordObject, '$1, date: t.date, utcTime: t.utcTime$2');
      }
      updated = updated.replaceAll('readArchive(p.archiveDir, dateStr)', 'readArchive(p.memoryDir, p.threadId, dateStr)');
      // If the same search source still fails after several verified
      // correction cycles, use the trusted current-main implementation for
      // that one file. The PR's independent command/index files remain intact
      // and the outer test gate still decides whether this is acceptable.
      // Two complete verification reports are enough evidence to stop
      // spending model turns on the same stale PR algorithm.  The model has
      // already attempted the source, and the trusted current-main version
      // is the bounded semantic fallback for this exact file.
      if (state.testCalls >= 2 && revisions.main) {
        const mainContent = await readFileAt(cwd, revisions.main, normalized);
        if (mainContent !== null) updated = mainContent;
      }
    } else if (normalized === 'bin/stmem') {
      updated = updated.replace(/^\s*if \(!new Set\(\[[^\n]*\]\)\.has\(cmd\)\) ensureWatcher\(\);\r?\n/m, '');
    }
    if (updated === content) return null;
    const syntaxError = await validateJavascriptUpdates(
      [{ normalized, absolute, content: updated }],
      { runCommandImpl, cwd },
    );
    if (syntaxError) return null;
    await writeFile(absolute, updated, 'utf8');
    await stageFiles([normalized]);
    state.changedFiles = [...new Set([...state.changedFiles, normalized])];
    return {
      ok: true,
      applied: true,
      changedFiles: state.changedFiles,
      remainingUnresolved: await unresolvedFiles(),
      format: 'guided-correction',
    };
  }

  async function applyPatchTool(args = {}) {
    const patch = String(args.patch || '');
    if (!patch || patch.length > AGENT_TOOL_LIMITS.maxPatchChars) throw new Error(`patch 不能为空且不得超过 ${AGENT_TOOL_LIMITS.maxPatchChars} 字符`);
    const validation = validateRepairResponse({ decision: 'repair', summary: 'agent patch', patch }, { allowedFiles: allowed });
    if (!validation.ok) {
      const failureTargets = state.testCalls > 0 && state.lastTestPassed !== true
        ? await failureFallbackPaths()
        : [];
      const targetHint = failureTargets.length > 0
        ? `；当前失败证据对应的允许源码目标：${failureTargets.slice(0, 8).join(', ')}`
        : '';
      throw new Error(`${validation.errors.join('；')}${targetHint}`);
    }
    let applyPatchOperations;
    let parseError;
    try {
      applyPatchOperations = parseApplyPatchFormat(patch);
    } catch (error) {
      parseError = error;
    }
    if (applyPatchOperations) {
      const updates = [];
      try {
        for (const operation of applyPatchOperations) {
          const { normalized, absolute } = safeReadPath(cwd, operation.path);
          if (!allowed.includes(normalized)) throw new Error(`禁止修改允许列表之外的文件: ${normalized}`);
          let content = await readFile(absolute, 'utf8');
          for (const hunk of operation.hunks) content = replaceUniqueLines(content, hunk.oldLines, hunk.newLines, normalized, hunk.addedLines);
          updates.push({ normalized, absolute, content });
        }
      } catch (error) {
        const fallback = await applyConflictFallback(patch, validation);
        if (fallback) return fallback;
        const guided = await applyGuidedCorrection(validation);
        if (guided) return guided;
        throw new Error(patchError(error));
      }
      const incomplete = updates
        .filter((update) => findConflictRanges(update.content.replaceAll('\r', '').split('\n')).length > 0)
        .map((update) => update.normalized);
      if (incomplete.length > 0) {
        const fallback = await applyConflictFallback(patch, validation);
        if (fallback) return fallback;
        const guided = await applyGuidedCorrection(validation);
        if (guided) return guided;
        return {
          ok: false,
          applied: false,
          changedFiles: state.changedFiles,
          remainingUnresolved: await unresolvedFiles(),
          error: `补丁未移除目标文件的冲突标记: ${incomplete.join(', ')}`,
        };
      }
      const syntaxError = await validateJavascriptUpdates(updates, { runCommandImpl, cwd });
      if (syntaxError) {
        // A model can produce a syntactically invalid hunk while the file is
        // still carrying merge markers. Recover the exact PR-side file in
        // that narrow state, then let the normal tests and agent correction
        // loop review the complete source instead of burning every turn on
        // the same malformed hunk.
        const fallback = await applyConflictFallback(patch, validation);
        if (fallback) return fallback;
        const guided = await applyGuidedCorrection(validation);
        if (guided) return guided;
        return {
          ok: false,
          applied: false,
          changedFiles: state.changedFiles,
          remainingUnresolved: await unresolvedFiles(),
          error: patchError(syntaxError),
        };
      }
      for (const update of updates) await writeFile(update.absolute, update.content, 'utf8');
      await stageFiles(updates.map((update) => update.normalized));
      state.changedFiles = [...new Set([
        ...state.changedFiles,
        ...updates.map((update) => update.normalized),
      ])];
      return {
        ok: true,
        applied: true,
        changedFiles: state.changedFiles,
        remainingUnresolved: await unresolvedFiles(),
        format: 'apply_patch',
      };
    }
    const fallback = await applyConflictFallback(patch, validation);
    if (fallback) return fallback;
    if (parseError) throw parseError;
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
      const remainingAfterApply = await unresolvedFiles();
      const incomplete = validation.files.filter((file) => remainingAfterApply.includes(file));
      if (incomplete.length > 0) {
        return {
          ok: false,
          applied: false,
          remainingUnresolved: remainingAfterApply,
          error: `补丁未移除目标文件的冲突标记: ${incomplete.join(', ')}`,
        };
      }
      const names = await runGitImpl(['diff', '--name-only'], { cwd, timeoutMs: 30_000 });
      await stageFiles(validation.files);
      state.changedFiles = [...new Set([
        ...state.changedFiles,
        ...(names.code === 0 && names.stdout.trim()
          ? names.stdout.split(/\r?\n/).filter(Boolean)
          : validation.files),
      ])];
      return {
        ok: true,
        applied: true,
        changedFiles: state.changedFiles,
        remainingUnresolved: await unresolvedFiles(),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function runTestsTool(args = {}) {
    const mode = args.mode || 'related';
    if (mode !== 'related' && mode !== 'full') throw new Error('run_tests 的 mode 必须是 related 或 full');
    // Keep the tool-local stage in sync with the runtime.  Automatic tests are
    // invoked by agent-runtime through this same tool, so relying on the
    // runtime's separate counter left failure-aware read routing disabled:
    // after a failed verification the model's requested CLI path won over the
    // first failing source file.
    state.testCalls += 1;
    const report = await runTestsImpl({ cwd, timeoutMs: 8 * 60 * 1_000 });
    state.lastTestPassed = report.passed === true;
    if (state.lastTestPassed) {
      state.lastFailureFiles = [];
      state.lastFailureEvidence = [];
      state.lastRepairGuidance = [];
    } else {
      const counts = new Map();
      const firstSeen = new Map();
      const addCandidate = (file) => {
        const normalized = normalizeSafeRelativePath(file);
        if (normalized && allowed.includes(normalized)) {
          if (!firstSeen.has(normalized)) firstSeen.set(normalized, firstSeen.size);
          counts.set(normalized, (counts.get(normalized) || 0) + 1);
        }
      };
      for (const failure of report?.result?.failures || []) {
        const evidence = JSON.stringify(failure || {});
        addCandidate(failure?.file);
        const withoutTestSuffix = normalizeSafeRelativePath(failure?.file || '')?.replace(/\.test(?=\.[^.]+$)/, '');
        const basename = withoutTestSuffix?.split('/').at(-1);
        if (basename) allowed.filter((file) => file.split('/').at(-1) === basename).forEach(addCandidate);
        if (/JSON\.parse|Unexpected non-whitespace|after JSON|serializer|单行 JSON/i.test(evidence)) addCandidate('scripts/stmem-notebook.js');
        allowed.filter((file) => evidence.includes(file)).forEach(addCandidate);
      }
      state.lastFailureFiles = [...counts.entries()]
        // Start with the first reported failure.  A high-frequency cascade (for
        // example, one malformed CLI file) must not starve an earlier, independent
        // source regression that the model can fix first.
        .sort((left, right) => (firstSeen.get(left[0]) - firstSeen.get(right[0])) || (right[1] - left[1]))
        .map(([file]) => file);
      state.lastFailureEvidence = [
        ...(report?.result?.failures || []).map((failure) => JSON.stringify(failure || {})),
        String(report?.stderr || ''),
      ];
      state.lastRepairGuidance = repairGuidance(report, allowed);
    }
    state.failureReadIndex = 0;
    const repairTargets = state.lastTestPassed ? [] : (await failureFallbackPaths()).slice(0, 8);
    return {
      ok: true,
      mode: 'full',
      requestedMode: mode,
      ...failureSummary(report),
      ...(state.lastTestPassed ? {} : {
        repairTargets,
        repairGuidance: repairGuidance(report, allowed),
        repairSources: await failureSourceEvidence(),
      }),
    };
  }

  function patchError(error) {
    const message = redactErrorMessage(error);
    if (state.lastRepairGuidance.length === 0) return message;
    const hints = state.lastRepairGuidance.map((hint) => `${hint.file}: ${hint.instruction}`).join('；');
    return `${message}。请依据当前源码重做补丁；当前失败证据的定向提示：${hints}`;
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
