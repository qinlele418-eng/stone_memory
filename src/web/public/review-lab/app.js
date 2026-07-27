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
  return [...document.querySelectorAll('input[name="model"]:checked')].map(input => input.value);
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
  let selectedDefault = false;
  $("#models").innerHTML = state.models.map(model => {
    const checked = model.available && !selectedDefault;
    if (checked) selectedDefault = true;
    return `<label class="model">
      <input type="checkbox" name="model" value="${escapeHtml(model.id)}"
        ${checked ? "checked" : ""} ${model.available ? "" : "disabled"}>
      <span><strong>${escapeHtml(model.label)}</strong>
      <small>${escapeHtml(model.available ? model.detail : "当前没有可用凭据")}</small></span>
    </label>`;
  }).join("");
  document.querySelectorAll('input[name="model"]').forEach(input => input.addEventListener("change", updatePreviewButton));
  updatePreviewButton();
}

function renderLibraries() {
  $("#library").innerHTML = state.libraries.map(library =>
    `<option value="${escapeHtml(library.threadId)}">${escapeHtml(library.label || library.libraryName || "未命名记忆体")} · ${escapeHtml(library.publicThreadId || library.threadId)}</option>`
  ).join("");
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
    const tasks = models.map(async (modelId, index) => {
      const model = state.models.find(item => item.id === modelId);
      const label = model?.label || modelId;
      try {
        const data = await api("./api/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: $("#library").value,
            date: $("#date").value,
            model: modelId,
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
    const data = await api(`./api/libraries${requestedThread ? `?threadId=${encodeURIComponent(requestedThread)}` : ""}`);
    state.libraries = data.libraries;
    state.models = data.models;
    renderLibraries();
    if (requestedThread && state.libraries.some(row => row.threadId === requestedThread)) $("#library").value = requestedThread;
    renderModels();
    applyPreset("author");
    if (!state.libraries.length) throw new Error("没有找到 Stone 记忆体");
    await loadDates();
    $("#library").addEventListener("change", async () => {
      const selected = $("#library").value;
      const refreshed = await api(`./api/libraries?threadId=${encodeURIComponent(selected)}`);
      state.models = refreshed.models;
      renderModels();
      await loadDates();
    });
    $("#date").addEventListener("change", async () => {
      renderDateMeta();
      await loadExistingCandidates();
    });
    document.querySelectorAll("[data-preset]").forEach(button => {
      if (button.dataset.preset === "custom") return;
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });
    document.querySelectorAll("[data-rule]").forEach(input => input.addEventListener("change", switchToCustom));
    $("#preview").addEventListener("click", generatePreview);
  } catch (error) {
    status(error.message, "error");
    $("#preview").disabled = true;
  }
}
