import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MAX_REPAIR_ROUNDS, redactErrorMessage, redactModelValue, validateRepairResponse } from './contract.mjs';

export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const DEFAULT_ZAI_MODEL = 'glm-4.7-flash';

export const REPAIR_SYSTEM_PROMPT = [
  '你是 Stone Memory 的 PR 红灯维修工具，不是 reviewer。',
  '只处理 current main 演进造成的合并冲突、兼容问题或明确测试失败；必须保留原 PR 功能意图。',
  '不得新增功能、重构产品设计、决定是否合并、删除或跳过测试、弱化断言、关闭 lint、修改 workflow。',
  '如果需要重新设计修复层级、证据不足，或问题超出当前红灯原因，必须返回 decision=needs_human。',
  '对于 bugfix PR，必须先判断 bugStatus：still_exists、already_fixed 或 unknown；无法高置信度判断就返回 needs_human。',
  '只返回 JSON，不要 Markdown 代码围栏：',
  '{"decision":"repair|needs_human","bugStatus":"still_exists|already_fixed|unknown（仅 bugfix）","bugEvidence":"bugfix 的具体当前 main 证据（仅 bugfix）","summary":"中文摘要","changes":[{"path":"仓库相对路径","content":"完整的新文件内容"}],"patch":"可选 unified diff","reason":"停止原因"}',
  'changes 和 patch 至少提供一个。优先使用 changes，并提供受影响文件的完整文本。',
].join('\n');

function responseText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return typeof content === 'string' ? content : '';
}

export function parseRepairResponse(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('GLM 返回的内容不是可解析的 JSON');
  }
}

export function buildRepairPrompt({ diagnosis, reproduction = {}, context, round = 1 } = {}) {
  if (round < 1 || round > MAX_REPAIR_ROUNDS) throw new Error(`repair round 必须在 1-${MAX_REPAIR_ROUNDS} 之间`);
  const compactDiagnosis = {
    pr: {
      number: diagnosis?.pr?.number,
      title: diagnosis?.pr?.title,
      baseRef: diagnosis?.pr?.baseRef,
      headRef: diagnosis?.pr?.headRef,
    },
    prKind: diagnosis?.prKind,
    currentMainSha: diagnosis?.currentMainSha,
    checks: diagnosis?.checks,
    merge: diagnosis?.merge,
    diffCheck: diagnosis?.diffCheck,
    bugEvidence: diagnosis?.bugEvidence,
    changedFiles: diagnosis?.changedFiles,
    nextAction: diagnosis?.nextAction,
  };
  return [
    REPAIR_SYSTEM_PROMPT,
    `这是第 ${round}/${MAX_REPAIR_ROUNDS} 轮本地维修尝试。`,
    '机械诊断（事实，不要扩大问题范围）：',
    JSON.stringify(compactDiagnosis, null, 2),
    '测试复现结果：',
    JSON.stringify(redactModelValue(reproduction), null, 2),
    '局部代码、diff 与失败证据：',
    JSON.stringify(redactModelValue(context), null, 2),
    '请只返回约定 JSON。若无法在当前文件和证据范围内保守维修，返回 needs_human。',
  ].join('\n\n');
}

export async function callZai({
  prompt,
  apiKey = process.env.ZAI_API_KEY,
  baseUrl = process.env.ZAI_BASE_URL || DEFAULT_ZAI_BASE_URL,
  model = process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL,
  maxTokens = Number(process.env.ZAI_MAX_TOKENS || 16_000),
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  if (!apiKey) throw new Error('缺少 ZAI_API_KEY');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    const responseTextBody = await response.text();
    let body;
    try { body = JSON.parse(responseTextBody); } catch { body = null; }
    if (!response.ok) {
      const code = body?.error?.code || body?.code || 'unknown';
      const message = body?.error?.message || body?.message || '无业务错误详情';
      throw new Error(`Z.AI API 请求失败（HTTP ${response.status}, code ${code}: ${message}）`);
    }
    if (body?.choices?.[0]?.finish_reason === 'length') throw new Error('Z.AI 模型响应达到 token 上限，按 fail-closed 处理');
    const text = responseText(body);
    if (!text) throw new Error('Z.AI 返回中没有模型文本');
    return { model: body.model || model, text };
  } catch (error) {
    throw new Error(redactErrorMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function generateRepairPlan({ input, round = 1, ...options } = {}) {
  if (input?.externalModelDataAllowed !== true) throw new Error('未明确允许向外部模型发送 PR 内容');
  const prompt = buildRepairPrompt({ ...input, round });
  const completion = await callZai({ prompt, ...options });
  const response = parseRepairResponse(completion.text);
  if (input?.diagnosis?.prKind === 'bugfix' && !['still_exists', 'already_fixed', 'unknown'].includes(response.bugStatus)) {
    throw new Error('bugfix 维修响应缺少合法 bugStatus，按 fail-closed 处理');
  }
  if (input?.diagnosis?.prKind === 'bugfix' && response.decision === 'repair' && typeof response.bugEvidence !== 'string') {
    throw new Error('bugfix repair 缺少具体 current main 证据，按 fail-closed 处理');
  }
  if (input?.diagnosis?.prKind === 'bugfix' && response.decision === 'repair' && response.bugStatus !== 'still_exists') {
    throw new Error('bugfix 只有在 bugStatus=still_exists 时才允许 repair');
  }
  const validation = validateRepairResponse(response, { allowedFiles: input?.context?.changedFiles });
  if (!validation.ok) throw new Error(`模型维修响应未通过安全校验：${validation.errors.join('；')}`);
  return { ...response, model: completion.model, round, files: validation.files };
}

export async function main() {
  const input = JSON.parse(readFileSync(process.env.REPAIR_INPUT_PATH || 'pr-repair-context.json', 'utf8'));
  const output = process.env.REPAIR_PLAN_PATH || 'pr-repair-plan.json';
  const round = Number(process.env.REPAIR_ROUND || 1);
  let result;
  try {
    result = await generateRepairPlan({ input, round });
  } catch (error) {
    result = { status: 'ai_unavailable', decision: 'needs_human', reason: redactErrorMessage(error), round };
    process.exitCode = 1;
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ decision: result.decision, round: result.round, files: result.files || [] })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
