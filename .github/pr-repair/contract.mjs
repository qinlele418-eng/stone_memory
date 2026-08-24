export const MAX_REPAIR_ROUNDS = 3;

export const REPAIR_STATES = Object.freeze([
  'skipped_green',
  'bug_already_fixed',
  'repair_not_needed',
  'branch_not_writable',
  'main_ci_failure',
  'ai_unavailable',
  'repair_success',
  'repair_failed',
  'ci_still_red',
  'needs_human',
]);

const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'stale',
  'timed_out',
]);

const SUCCESS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

const BUGFIX_PATTERN = /(^|[^a-z])(fix|bugfix|bug|regression|hotfix)([^a-z]|$)|修复|故障|回归/i;
const FEATURE_PATTERN = /(^|[^a-z])(feat|feature|docs?|chore|refactor|test|build|ci)([^a-z]|$)|文档|功能|重构|测试/i;

export function classifyChecks(checkRuns = []) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const pending = [];
  const failures = [];
  const unknown = [];

  for (const run of runs) {
    const status = String(run?.status ?? '').toLowerCase();
    const conclusion = run?.conclusion == null ? null : String(run.conclusion).toLowerCase();
    const name = run?.name || run?.app?.name || 'Unnamed check';

    if (status !== 'completed' || conclusion === null) {
      pending.push({ name, status, conclusion });
      continue;
    }
    if (FAILURE_CONCLUSIONS.has(conclusion)) {
      failures.push({ name, status, conclusion, detailsUrl: run.details_url ?? null });
      continue;
    }
    if (!SUCCESS_CONCLUSIONS.has(conclusion)) {
      unknown.push({ name, status, conclusion });
    }
  }

  return {
    count: runs.length,
    hasChecks: runs.length > 0,
    allGreen: runs.length > 0 && pending.length === 0 && failures.length === 0 && unknown.length === 0,
    red: failures.length > 0 || unknown.length > 0,
    pending,
    failures,
    unknown,
  };
}

export function classifyPrKind({ title = '', body = '', labels = [] } = {}) {
  const labelText = (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter(Boolean)
    .join(' ');
  const text = `${title}\n${body}\n${labelText}`;
  if (BUGFIX_PATTERN.test(text)) return 'bugfix';
  if (FEATURE_PATTERN.test(text)) return 'non_bugfix';
  return 'unknown';
}

export function isSafeRelativePath(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 240) return false;
  if (file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return false;
  const normalized = file.replaceAll('\\', '/');
  if (normalized.split('/').includes('..')) return false;
  if (normalized === '.git' || normalized.startsWith('.git/')) return false;
  if (normalized === '.github' || normalized.startsWith('.github/')) return false;
  if (normalized === '.github/pr-repair' || normalized.startsWith('.github/pr-repair/')) return false;
  if (normalized === '.github/workflows' || normalized.startsWith('.github/workflows/')) return false;
  return true;
}

export function normalizeSafeRelativePath(file) {
  if (!isSafeRelativePath(file)) return null;
  return file.replaceAll('\\', '/');
}

function isTestPath(file) {
  const normalized = normalizeSafeRelativePath(file);
  return Boolean(normalized && (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i.test(normalized)
    || /\.(?:test|spec)\.[^/]+$/i.test(normalized)));
}

const MODEL_SECRET_PATTERNS = [
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9_-]{16,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|access_token|refresh_token|client_secret|private_key|signing_secret|cookie|session)["']?\s*:\s*["'])(?:\\.|[^"'])*(["'])/gi,
  /\b(?:ZAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key|access_token|refresh_token|client_secret|private_key|signing_secret|cookie|session)\s*[:=]\s*['"]?[^\s,'"}]+/gi,
];

export function redactSensitiveText(value) {
  let text = String(value ?? '');
  for (const [index, pattern] of MODEL_SECRET_PATTERNS.entries()) {
    text = index === 3 ? text.replace(pattern, '$1[已脱敏]$2') : text.replace(pattern, '[已脱敏]');
  }
  return text;
}

export function redactModelValue(value, depth = 0) {
  if (depth > 6) return '[已截断]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactModelValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 100)) {
      if (/^(?:token|password|secret|api[_-]?key|authorization|access_token|refresh_token|client_secret|private_key|signing_secret|cookie|session)$/i.test(key)) result[key] = '[已脱敏]';
      else result[key] = redactModelValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function changedPathsFromPatch(patch) {
  const paths = new Set();
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) {
      paths.add(match[1]);
      paths.add(match[2]);
      continue;
    }
    const header = line.match(/^(?:---|\+\+\+) (.+?)(?:\t.*)?$/);
    if (header && header[1] !== '/dev/null') paths.add(header[1].replace(/^[ab]\//, ''));
    const applyPatchHeader = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (applyPatchHeader) paths.add(applyPatchHeader[1].trim());
  }
  return [...paths];
}

function addedLines(patch) {
  return String(patch ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
}

export function validateRepairResponse(response, { allowedFiles = [], mutableTestFiles = [] } = {}) {
  const errors = [];
  if (!response || typeof response !== 'object') errors.push('模型响应不是 JSON 对象');
  const decision = response?.decision;
  if (!['repair', 'needs_human'].includes(decision)) errors.push('decision 必须是 repair 或 needs_human');
  if (decision === 'repair' && typeof response?.summary !== 'string') errors.push('repair 必须提供 summary');

  const changes = Array.isArray(response?.changes) ? response.changes : [];
  const patch = typeof response?.patch === 'string' ? response.patch : '';
  if (decision === 'repair' && changes.length === 0 && patch.trim() === '') {
    errors.push('repair 必须提供 changes 或 patch');
  }
  const allowedInput = Array.isArray(allowedFiles) ? allowedFiles : [];
  const mutableTests = new Set((Array.isArray(mutableTestFiles) ? mutableTestFiles : [])
    .map(normalizeSafeRelativePath)
    .filter(Boolean));
  if (decision === 'repair' && allowedInput.length === 0) errors.push('没有已验证的允许修改文件，拒绝自动 repair');
  if (changes.length > 20) errors.push('一次 repair 最多修改 20 个文件');

  const paths = new Set(changedPathsFromPatch(patch));
  for (const change of changes) {
    if (!change || typeof change.path !== 'string') {
      errors.push('每个 changes 项必须包含 path');
      continue;
    }
    paths.add(change.path);
    if (typeof change.content !== 'string') errors.push(`文件 ${change.path} 缺少完整 content`);
    if (typeof change.content === 'string' && change.content.length > 200_000) errors.push(`文件 ${change.path} 内容过大`);
  }

  const safePaths = [...paths].map(normalizeSafeRelativePath).filter(Boolean);
  for (const path of paths) if (!normalizeSafeRelativePath(path)) errors.push(`禁止修改不安全路径: ${path}`);
  for (const path of safePaths) {
    if (/^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(path)) {
      errors.push(`禁止修改测试或依赖入口: ${path}`);
    } else if (isTestPath(path) && !mutableTests.has(path)) {
      errors.push(`禁止自动修改测试: 非 PR 测试文件 ${path}`);
    }
  }

  const allowed = new Set(allowedInput.map(normalizeSafeRelativePath).filter(Boolean));
  for (const path of safePaths) if (!allowed.has(path)) errors.push(`模型修改了上下文之外的文件: ${path}`);

  const lines = addedLines(patch);
  const forbiddenAddedLine = /\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\beslint-disable\b|\bassert\.(?:ok|equal)\s*\(\s*true\b/;
  const contentLines = changes.flatMap((change) => typeof change?.content === 'string' ? change.content.split(/\r?\n/) : []);
  if ([...lines, ...contentLines].some((line) => forbiddenAddedLine.test(line))) {
    errors.push('禁止通过跳过测试、弱化断言或关闭 lint 来换取变绿');
  }
  const modelText = JSON.stringify({ summary: response?.summary, reason: response?.reason, changes, patch });
  if (redactSensitiveText(modelText) !== modelText) errors.push('模型响应疑似包含凭据，拒绝写入或外发');
  if (patch.length > 300_000) errors.push('patch 过大');
  if (lines.length > 1_000) errors.push('单次 repair 的 patch 行数过大');

  return { ok: errors.length === 0, errors, files: safePaths };
}

export function redactErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message)
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(ZAI_API_KEY|GH_TOKEN|GITHUB_TOKEN)=\S+/g, '$1=[redacted]');
}
