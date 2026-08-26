import { spawn } from 'node:child_process';

export function runCommand(command, args = [], { cwd, env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs) : null;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export async function runGit(args, options = {}) {
  return runCommand('git', args, options);
}

export async function gitText(args, options = {}) {
  const result = await runGit(args, options);
  return result.code === 0 ? result.stdout.trimEnd() : '';
}

export async function fetchPullRequest(cwd, prNumber, { token } = {}) {
  const env = { ...process.env };
  if (token) {
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
  }
  return runGit([
    'fetch', '--no-tags', 'origin',
    `refs/pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`,
  ], { cwd, env });
}

export async function listChangedFiles(cwd, baseSha, headSha) {
  const result = await runGit(['diff', '--name-only', `${baseSha}...${headSha}`], { cwd });
  if (result.code !== 0) throw new Error(`git diff --name-only 失败: ${result.stderr || result.stdout || `退出码 ${result.code}`}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export async function diffCheck(cwd, baseSha, headSha) {
  const result = await runGit(['diff', '--check', `${baseSha}...${headSha}`], { cwd });
  return {
    ok: result.code === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
    exitCode: result.code,
    commandFailed: result.code > 1 || /(?:fatal|error):/i.test(`${result.stdout}${result.stderr}`),
  };
}

export async function mergeCheck(cwd, baseSha, headSha) {
  const checkout = await runGit(['checkout', '--detach', baseSha], { cwd });
  if (checkout.code !== 0) {
    return { clean: false, conflicted: false, conflictFiles: [], error: checkout.stderr || checkout.stdout };
  }

  const merge = await runGit([
    '-c', 'user.name=Stone Memory PR Repair',
    '-c', 'user.email=pr-repair@stone-memory.invalid',
    'merge', '--no-commit', '--no-ff', headSha,
  ], { cwd });

  if (merge.code !== 0) {
    const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd });
    const aborted = await runGit(['merge', '--abort'], { cwd });
    const error = `${merge.stdout}${merge.stderr}${aborted.code !== 0 ? `\nmerge --abort: ${aborted.stderr}` : ''}`.trim();
    return {
      clean: false,
      conflicted: conflicts.code === 0 && aborted.code === 0 && conflicts.stdout.trim() !== '',
      conflictFiles: conflicts.code === 0 ? conflicts.stdout.split(/\r?\n/).filter(Boolean) : [],
      error,
    };
  }

  const tree = await runGit(['write-tree'], { cwd });
  const aborted = await runGit(['merge', '--abort'], { cwd });
  if (tree.code !== 0 || aborted.code !== 0) return {
    clean: false,
    conflicted: false,
    conflictFiles: [],
    error: `${tree.stderr || tree.stdout}\n${aborted.stderr || aborted.stdout}`.trim(),
  };
  return {
    clean: true,
    conflicted: false,
    conflictFiles: [],
    treeSha: tree.code === 0 ? tree.stdout.trim() : null,
    error: null,
  };
}

export async function isAncestor(cwd, ancestor, descendant = 'HEAD') {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  return result.code === 0;
}

export async function isAncestorDetailed(cwd, ancestor, descendant = 'HEAD') {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  return {
    isAncestor: result.code === 0,
    commandFailed: result.code > 1,
    error: result.stderr || result.stdout || null,
  };
}

export async function patchEquivalentDetailed(cwd, upstream, head) {
  const result = await runGit(['cherry', upstream, head], { cwd });
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    equivalent: result.code === 0 && lines.length > 0 && lines.every((line) => line.startsWith('-')),
    commandFailed: result.code !== 0,
    commits: lines,
    error: result.stderr || result.stdout || null,
  };
}

export async function readFileAt(cwd, revision, file) {
  const result = await runGit(['show', `${revision}:${file}`], { cwd });
  return result.code === 0 ? result.stdout : null;
}
