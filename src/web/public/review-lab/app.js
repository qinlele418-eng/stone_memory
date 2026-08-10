"use strict";

const RULE_KEYS = [
  "sourceAware",
  "relationshipPlatform",
  "emotional",
  "conflict",
  "intimacy",
  "countLimit",
  "strictBoundaries",
];

const RULE_LABELS = {
  sourceAware: "来源感知",
  relationshipPlatform: "关系归一与平台降噪",
  emotional: "情感优先",
  conflict: "冲突与吃醋归因",
  intimacy: "亲密抽取",
  countLimit: "每日 8–20 条",
  strictBoundaries: "严格 importance/features",
};

const PRESETS = {
  author: Object.fromEntries(RULE_KEYS.map(key => [key, false])),
  "daily-intimacy": Object.fromEntries(RULE_KEYS.map(key => [key, key === "intimacy"])),
  history: Object.fromEntries(RULE_KEYS.map(key => [key, true])),
};

const PRESET_LABELS = {
  author: "作者原版",
  "daily-intimacy": "日常亲密",
  history: "历史增强组合",
  custom: "自定义组合",
};

const state = {
  libraries: [],
  providers: [],
  models: [],
  dates: [],
  candidates: [],
  activeCandidateId: null,
  preset: "author",
};

const $ = selector => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[char]));
}

function status(message, kind = "info") {
  const target = $("#status");
  target.classList.remove("hidden");
  target.classList.toggle("has-error", kind === "error");
  target.innerHTML = `<strong>${kind === "error" ? "需要留意" : "正在处理"}</strong><p>${escapeHtml(message)}</p>`;
}

function clearStatus() {
  $("#status").classList.add("hidden");
}

function selectedModels() {
  return state.models.filter(model => model.enabled !== false);
}

function readRules() {
  return Object.fromEntries(RULE_KEYS.map(key => [key, !!document.querySelector(`[data-rule="${key}"]`)?.checked]));
}

function writeRules(rules) {
  for (const key of RULE_KEYS) {
    const input = document.querySelector(`[data-rule="${key}"]`);
    if (input) input.checked = !!rules[key];
  }
  updateRuleCount();
}

function updateRuleCount() {
  const count = Object.values(readRules()).filter(Boolean).length;
  $("#rule-count").textContent = `已选 ${count} / ${RULE_KEYS.length}`;
}

function renderPresetState() {
  document.querySelectorAll("[data-preset]").forEach(button => {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  });
}

function applyPreset(name) {
  if (!PRESETS[name]) return;
  state.preset = name;
  writeRules(PRESETS[name]);
  renderPresetState();
}

function switchToCustom() {
  state.preset = "custom";
  updateRuleCount();
  renderPresetState();
}

function updatePreviewButton() {
  const count = selectedModels().length;
  const button = $("#preview");
  if (button.disabled) return;
  button.textContent = count > 1 ? `用 ${count} 个模型生成 ${count} 份候选` : "生成候选预览";
}

function renderModels() {
  $("#models").innerHTML = state.models.length ? state.models.map(model => `<article class="model configured">
    <label><input type="checkbox" data-model-enabled="${escapeHtml(model.id)}" ${model.enabled === false ? "" : "checked"}>
      <span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.channel === "api"
      ? `API · ${model.provider} · ${model.model} · ${model.apiProfile === "optimized" ? "优化版" : "原始版"}`
        : `Subagent · ${model.runtime === "codex" ? "Codex" : "Claude Code"} · ${model.model}${model.reasoning ? ` · ${model.reasoning}` : ""}`)}</small></span>
    </label><button type="button" class="text-action" data-remove-model="${escapeHtml(model.id)}">移除</button>
  </article>`).join("") : '<div class="empty">还没有模型配置。请在上方至少添加一个。</div>';
  document.querySelectorAll("[data-model-enabled]").forEach(input => input.addEventListener("change", () => {
    const model = state.models.find(row => row.id === input.dataset.modelEnabled);
    if (model) model.enabled = input.checked;
    updatePreviewButton();
  }));
  document.querySelectorAll("[data-remove-model]").forEach(button => button.addEventListener("click", () => {
    state.models = state.models.filter(row => row.id !== button.dataset.removeModel);
    renderModels();
  }));
  updatePreviewButton();
}

function renderModelBuilder() {
  const channel = $("#model-channel").value;
  const runtime = $("#model-runtime").value;
  $("#runtime-field").classList.toggle("hidden", channel !== "subagent");
  $("#provider-field").classList.toggle("hidden", channel !== "api");
  $("#api-profile-field").classList.toggle("hidden", channel !== "api");
  $("#reasoning-field").classList.toggle("hidden", channel !== "subagent" || runtime !== "codex");
  $("#model-provider").innerHTML = state.providers.length
    ? state.providers.map(row => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.label)}</option>`).join("")
    : '<option value="">请先在设置中配置 API Provider</option>';
  if (channel === "api") {
    const provider = state.providers.find(row => row.id === $("#model-provider").value) || state.providers[0];
    if (provider?.defaultModel && !$("#model-name").value.trim()) $("#model-name").value = provider.defaultModel;
  }
}

function addModelConfiguration() {
  const channel = $("#model-channel").value;
  const runtime = $("#model-runtime").value;
  const provider = $("#model-provider").value;
  const apiProfile = channel === "api" ? $("#model-api-profile").value : null;
  const model = $("#model-name").value.trim();
  const reasoning = runtime === "codex" && channel === "subagent" ? $("#model-reasoning").value : "";
  if (!model) return status("请填写这个通道实际支持的模型名。", "error");
  if (channel === "api" && !provider) return status("请先在设置中配置一个可用的 API Provider。", "error");
  const label = $("#model-label").value.trim() || (channel === "api"
    ? `${provider} · ${model} · ${apiProfile === "optimized" ? "优化版" : "原始版"}`
    : `${runtime === "codex" ? "Codex" : "Claude Code"} · ${model}${reasoning ? ` · ${reasoning}` : ""}`);
  state.models.push({
    id: `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    channel, runtime: channel === "subagent" ? runtime : null,
    provider: channel === "api" ? provider : null, model, apiProfile,
    reasoning: reasoning || null, label, enabled: true,
  });
  $("#model-label").value = "";
  renderModels();
  clearStatus();
}

function renderLibraries() {
  const library = state.libraries[0];
  $("#library").innerHTML = library ? `<option value="${escapeHtml(library.threadId)}" selected>${escapeHtml(library.label || library.libraryName || "未命名记忆体")}</option>` : "";
  $("#current-library").textContent = library
    ? `${library.label || library.libraryName || "未命名记忆体"} · ${library.publicThreadId || library.threadId}`
    : "当前记忆体不可用";
}

async function loadDates() {
  const threadId = $("#library").value;
  const data = await api(`./api/dates?threadId=${encodeURIComponent(threadId)}`);
  state.dates = data.dates;
  $("#date").innerHTML = state.dates.map(row =>
    `<option value="${escapeHtml(row.date)}">${escapeHtml(row.date)} · ${row.messageCount} 条对话${row.feelingCount ? ` · 已有 ${row.feelingCount} 条摘要` : ""}</option>`
  ).join("");
  renderDateMeta();
  await loadExistingCandidates();
}

function renderDateMeta() {
  const row = state.dates.find(item => item.date === $("#date").value);
  $("#date-meta").textContent = row
    ? `${row.date}：${row.messageCount} 条对话，现有 ${row.feelingCount} 条摘要、${row.featureCount} 条特征。生成预览不会写入。`
    : "没有可挖掘日期。";
}

function latestPerModel(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    if (!map.has(candidate.model)) map.set(candidate.model, candidate);
  }
  return [...map.values()];
}

async function loadExistingCandidates() {
  const threadId = $("#library").value;
  const date = $("#date").value;
  if (!threadId || !date) return renderCandidates([]);
  const data = await api(`./api/candidates?threadId=${encodeURIComponent(threadId)}&date=${encodeURIComponent(date)}`);
  renderCandidates(latestPerModel(data.candidates));
}

function normalizedCandidateRules(candidate) {
  if (candidate.rules) return candidate.rules;
  const options = candidate.options || {};
  const historical = !!options.historical;
  return {
    sourceAware: historical,
    relationshipPlatform: historical,
    emotional: historical,
    conflict: historical,
    intimacy: !!options.intimacy,
    countLimit: !!options.countLimit,
    strictBoundaries: historical,
  };
}

function candidateStatus(candidate) {
  if (candidate.status === "applied") return "已写入";
  if (candidate.status === "discarded") return "已放弃";
  return "待确认";
}

function renderCandidateDetail(candidate) {
  const rules = normalizedCandidateRules(candidate);
  const activeRules = RULE_KEYS.filter(key => rules[key]).map(key => RULE_LABELS[key]);
  const feelings = candidate.feelings?.length
    ? `<ol class="memory-list">${candidate.feelings.map(row => `<li class="memory-row">${escapeHtml(row.content)}<small>importance ${row.importance}</small></li>`).join("")}</ol>`
    : '<div class="empty">这份候选没有 feelings。</div>';
  const features = candidate.features?.length
    ? `<ul class="memory-list">${candidate.features.map(row => `<li class="memory-row">${escapeHtml(row.content)}<small>${escapeHtml(row.category)} · importance ${row.importance}</small></li>`).join("")}</ul>`
    : '<div class="empty">这份候选没有 features。</div>';
  const chunks = (candidate.chunkReport || []).map(chunk => {
    const engine = chunk.channel === "api"
      ? [chunk.provider, chunk.model].filter(Boolean).join(" / ")
      : ["Subagent", chunk.runtime, chunk.model].filter(Boolean).join(" / ");
    const feelingRecovery = chunk.recoveryStatus === "format_repaired"
      ? "摘要 JSON 已由 Subagent 修复并通过复验"
      : chunk.recoveryStatus === "subagent_takeover"
        ? "摘要已由 Subagent 接管并通过复验"
        : "";
    const featureRecovery = chunk.featureRecoveryStatus === "format_repaired"
      ? "特征 JSON 已由 Subagent 修复并通过复验"
      : chunk.featureRecoveryStatus === "subagent_takeover"
        ? "特征已由 Subagent 接管并通过复验"
        : "";
    const recovery = [feelingRecovery, featureRecovery].filter(Boolean);
    return `<li>${escapeHtml(chunk.timeLabel || `第 ${chunk.index} 块`)} · ${chunk.messageCount || 0} 条 / ${Math.round((chunk.inputBytes || 0) / 1024)}KB → ${chunk.outputCount || 0} 条摘要${chunk.empty ? "（明确返回空数组）" : ""}${engine ? ` · ${escapeHtml(engine)}` : ""}${recovery.length ? `<strong> · ${recovery.map(escapeHtml).join("；")}</strong>` : ""}</li>`;
  }).join("");
  return `<div class="candidate-detail">
    <div class="candidate-head">
      <div><p class="eyebrow">SELECTED CANDIDATE</p><h2>${escapeHtml(candidate.modelLabel)}</h2>
      <p>原有 ${candidate.priorCounts.feelings} 条摘要、${candidate.priorCounts.features} 条特征；这份候选为 ${candidate.feelings.length} / ${candidate.features.length}。</p></div>
      <div class="badges">
        <span class="badge">${escapeHtml(PRESET_LABELS[candidate.preset] || "历史候选")}</span>
        <span class="badge">${escapeHtml(candidateStatus(candidate))}</span>
      </div>
    </div>
    <p class="rule-summary">${activeRules.length ? `已启用：${activeRules.map(escapeHtml).join("、")}` : "未追加规则，使用作者原版。"}</p>
    ${chunks ? `<details class="candidate-chunks"><summary>查看 ${candidate.chunkReport.length} 个分块结果</summary><ul>${chunks}</ul></details>` : ""}
    <div class="candidate-section"><h3>当天摘要 · ${candidate.feelings.length}</h3>${feelings}</div>
    <div class="candidate-section"><h3>人物特征 · ${candidate.features.length}</h3>${features}</div>
    ${candidate.trimmedFeelings ? `<p class="meta">超过上限的 ${candidate.trimmedFeelings} 条已从候选中截去。</p>` : ""}
    ${candidate.status === "review_pending" ? `<div class="candidate-actions">
      <button class="secondary" id="discard">放弃这份候选</button>
      <button class="danger" id="apply">采用这一份并替换当天记忆</button>
    </div>` : ""}
  </div>`;
}

function renderCandidates(candidates, preferredId = null) {
  state.candidates = candidates;
  const target = $("#candidate");
  if (!candidates.length) {
    state.activeCandidateId = null;
    target.classList.add("hidden");
    target.innerHTML = "";
    return;
  }
  const availableIds = new Set(candidates.map(candidate => candidate.id));
  state.activeCandidateId = availableIds.has(preferredId) ? preferredId
    : availableIds.has(state.activeCandidateId) ? state.activeCandidateId
      : candidates[0].id;
  const active = candidates.find(candidate => candidate.id === state.activeCandidateId) || candidates[0];
  target.classList.remove("hidden");
  target.innerHTML = `<div class="comparison-head">
      <div><p class="eyebrow">MODEL COMPARISON</p><h2>${escapeHtml(active.date)} · ${candidates.length} 份模型候选</h2></div>
      <p>候选互不合并；先对比，再采用其中一份。</p>
    </div>
    <div class="comparison-grid">${candidates.map(candidate => `
      <button class="comparison-card ${candidate.id === active.id ? "active" : ""}" data-candidate-id="${escapeHtml(candidate.id)}">
        <strong>${escapeHtml(candidate.modelLabel)}</strong>
        <span>${candidate.feelings.length} 条摘要 · ${candidate.features.length} 条特征</span>
        <small>${escapeHtml(candidateStatus(candidate))} · ${escapeHtml(PRESET_LABELS[candidate.preset] || "自定义组合")}</small>
      </button>`).join("")}
    </div>
    <div id="candidate-detail">${renderCandidateDetail(active)}</div>`;
  document.querySelectorAll("[data-candidate-id]").forEach(button => button.addEventListener("click", () => {
    renderCandidates(state.candidates, button.dataset.candidateId);
  }));
  $("#discard")?.addEventListener("click", discardCandidate);
  $("#apply")?.addEventListener("click", applyCandidate);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function compactRequestError(error) {
  const message = String(error?.message || error || "请求失败").replace(/\s+/g, " ").trim();
  if (/524|A timeout occurred|<!DOCTYPE html/i.test(message)) {
    return "连接等待超时，但服务器上的挖掘任务可能仍在继续。请勿立即重复生成，稍后刷新候选列表。";
  }
  return message.slice(0, 500);
}

async function waitForPreviewJob(initialJob, modelLabel, position, total) {
  const deadline = Date.now() + 35 * 60 * 1000;
  let networkFailures = 0;
  let job = initialJob;
  while (Date.now() < deadline) {
    if (job.status === "completed" && job.candidate) return job.candidate;
    if (job.status === "failed") throw new Error(job.error || "候选生成失败");
    const started = Date.parse(job.startedAt || job.createdAt || new Date().toISOString());
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const elapsed = elapsedSeconds >= 60
      ? `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`
      : `${elapsedSeconds} 秒`;
    status(`服务器正在用 ${modelLabel} 生成第 ${position}/${total} 份候选，已运行 ${elapsed}。可以等待；即使页面连接短暂断开，任务也会继续。`);
    await delay(2500);
    try {
      const data = await api(`./api/preview-jobs/${encodeURIComponent(job.id)}`);
      job = data.job;
      networkFailures = 0;
    } catch (error) {
      networkFailures++;
      if (networkFailures >= 12) throw new Error(compactRequestError(error));
      status(`与页面入口暂时断开，正在重新连接服务器任务（${networkFailures}/12）。不要重复点击生成。`);
      await delay(2500);
    }
  }
  throw new Error("页面等待超过 35 分钟；服务器任务可能仍在继续。请稍后刷新候选列表，不要立即重复生成。");
}

async function generatePreview() {
  const button = $("#preview");
  const models = selectedModels();
  if (!models.length) return status("请至少选择一个可用模型。", "error");
  const rules = readRules();
  const successes = [];
  const failures = [];
  button.disabled = true;
  try {
    status(`正在同时启动 ${models.length} 份独立候选。预览不会写入正式记忆。`);
    const tasks = models.map(async (model, index) => {
      const label = model.label;
      try {
        const data = await api("./api/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: $("#library").value,
            date: $("#date").value,
            profile: {
              channel: model.channel, runtime: model.runtime, provider: model.provider,
              model: model.model, reasoning: model.reasoning, label: model.label,
            },
            preset: state.preset,
            rules,
          }),
        });
        if (!data.job?.id) throw new Error("服务器没有返回预览任务号");
        const candidate = await waitForPreviewJob(data.job, label, index + 1, models.length);
        successes.push(candidate);
      } catch (error) {
        failures.push(`${label}：${compactRequestError(error)}`);
      }
    });
    await Promise.all(tasks);
    await loadExistingCandidates();
    if (state.candidates.length) $("#candidate").scrollIntoView({ behavior: "smooth", block: "start" });
    if (failures.length) {
      status(`已生成 ${successes.length} 份；${failures.length} 个模型失败。${failures.join("；")}`, "error");
    } else {
      clearStatus();
    }
  } finally {
    button.disabled = false;
    updatePreviewButton();
  }
}

function activeCandidate() {
  return state.candidates.find(candidate => candidate.id === state.activeCandidateId) || null;
}

async function discardCandidate() {
  const candidate = activeCandidate();
  if (!candidate || !confirm("放弃这份候选？现有正式记忆不会受到影响。")) return;
  try {
    await api(`./api/candidates/${encodeURIComponent(candidate.id)}/discard`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: $("#library").value }),
    });
    await loadExistingCandidates();
  } catch (error) {
    status(error.message, "error");
  }
}

async function applyCandidate() {
  const candidate = activeCandidate();
  if (!candidate) return;
  const message = `确认采用 ${candidate.modelLabel} 的候选，替换 ${candidate.date} 的正式记忆？\n\n写入前会备份 SQLite；其他模型候选会标记为已放弃。`;
  if (!confirm(message)) return;
  const button = $("#apply");
  button.disabled = true;
  button.textContent = "正在备份并写入……";
  try {
    const result = await api(`./api/candidates/${encodeURIComponent(candidate.id)}/apply`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: $("#library").value }),
    });
    status(`已经采用 ${candidate.modelLabel}，写入 ${result.date}：${result.feelings} 条摘要、${result.features} 条特征。备份：${result.backup.filename}`);
    await loadDates();
  } catch (error) {
    status(error.message, "error");
    button.disabled = false;
    button.textContent = "采用这一份并替换当天记忆";
  }
}

async function init() {
  try {
    const requestedThread = new URLSearchParams(location.search).get("threadId") || "";
    if (!requestedThread) throw new Error("缺少当前记忆体标识，请从 Stone Memory【开发者模式】重新进入。");
    const data = await api(`./api/libraries${requestedThread ? `?threadId=${encodeURIComponent(requestedThread)}` : ""}`);
    const currentLibrary = data.libraries.find(row => row.threadId === requestedThread);
    if (!currentLibrary) throw new Error("当前记忆体不存在或已被删除，请返回开发者模式重新选择。");
    state.libraries = [currentLibrary];
    state.providers = data.providers || [];
    renderLibraries();
    $("#library").value = requestedThread;
    renderModelBuilder();
    renderModels();
    applyPreset("author");
    if (!state.libraries.length) throw new Error("没有找到 Stone 记忆体");
    await loadDates();
    $("#date").addEventListener("change", async () => {
      renderDateMeta();
      await loadExistingCandidates();
    });
    document.querySelectorAll("[data-preset]").forEach(button => {
      if (button.dataset.preset === "custom") return;
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });
    document.querySelectorAll("[data-rule]").forEach(input => input.addEventListener("change", switchToCustom));
    $("#model-channel").addEventListener("change", renderModelBuilder);
    $("#model-runtime").addEventListener("change", renderModelBuilder);
    $("#model-provider").addEventListener("change", () => {
      const provider = state.providers.find(row => row.id === $("#model-provider").value);
      if (provider?.defaultModel) $("#model-name").value = provider.defaultModel;
    });
    $("#add-model").addEventListener("click", addModelConfiguration);
    $("#preview").addEventListener("click", generatePreview);
  } catch (error) {
    status(error.message, "error");
    $("#preview").disabled = true;
  }
}
