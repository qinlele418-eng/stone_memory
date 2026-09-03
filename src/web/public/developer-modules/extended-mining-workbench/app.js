"use strict";

const moduleApi = window.StoneDeveloperModule;
const LAST_PROFILE_KEY = "stone-extended-mining-workbench-last-profile-v1";
const RULES_KEY = "stone-extended-mining-workbench-rules-v1";
const state = {
  threadId: moduleApi?.threadId || "",
  library: null,
  providers: [],
  dates: [],
  selectedDates: new Set(),
  month: null,
  rangeMode: false,
  rangeStart: null,
  activeBatch: null,
  pollTimer: null,
  candidates: [],
  activeCandidateId: null,
  activeFormalDate: null,
  tab: "formal",
};

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[character]));

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function showStatus(message = "", kind = "info") {
  const node = $("#status");
  node.classList.toggle("hidden", !message);
  node.classList.toggle("error", kind === "error");
  node.textContent = message;
}

function readJsonStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}

function syncSettingsLabel(details) {
  const label = details.querySelector("[data-settings-label]");
  if (label) label.textContent = details.open
    ? (label.dataset.openLabel || "收起设置")
    : (label.dataset.closedLabel || "展开设置");
}

function selectedDateArray() {
  return [...state.selectedDates].sort();
}

function dateGroups(values, max) {
  const groups = [];
  let current = [];
  for (const date of [...new Set(values)].sort()) {
    const previous = current.at(-1);
    const consecutive = !previous || new Date(`${date}T00:00:00Z`) - new Date(`${previous}T00:00:00Z`) === 86400000;
    if (current.length && (!consecutive || current.length >= max)) {
      groups.push(current);
      current = [];
    }
    current.push(date);
  }
  if (current.length) groups.push(current);
  return groups;
}

function monthLabel(month) {
  const [year, value] = month.split("-");
  return `${year} 年 ${Number(value)} 月`;
}

function shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

function renderCalendar() {
  if (!state.month) return;
  $("#calendar-title").textContent = monthLabel(state.month);
  const [year, month] = state.month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDate = new Map(state.dates.map(row => [row.date, row]));
  const cells = Array.from({ length: firstWeekday }, () => '<span class="day blank"></span>');
  for (let day = 1; day <= dayCount; day++) {
    const date = `${state.month}-${String(day).padStart(2, "0")}`;
    const row = byDate.get(date);
    const available = Boolean(row);
    const selected = state.selectedDates.has(date);
    const edge = date === state.rangeStart || (selected && state.rangeMode && date === selectedDateArray().at(-1));
    cells.push(`<button type="button" class="day ${selected ? "selected" : ""} ${edge ? "range-edge" : ""}" data-date="${date}" ${available ? "" : "disabled"} aria-pressed="${selected}" aria-label="${date}" title="${date}"><span class="day-number">${day}</span></button>`);
  }
  $("#calendar").innerHTML = cells.join("");
  document.querySelectorAll(".day[data-date]:not(:disabled)").forEach(button => {
    button.onclick = () => selectDate(button.dataset.date);
  });
}

function selectDate(date) {
  if (!state.rangeMode) {
    state.selectedDates.has(date) ? state.selectedDates.delete(date) : state.selectedDates.add(date);
    state.rangeStart = null;
  } else if (!state.rangeStart) {
    state.rangeStart = date;
    state.selectedDates = new Set([date]);
  } else {
    const [start, end] = [state.rangeStart, date].sort();
    state.selectedDates = new Set(state.dates.map(row => row.date).filter(value => value >= start && value <= end));
    state.rangeStart = null;
  }
  renderSelection();
}

function renderSelection() {
  renderCalendar();
  const picked = selectedDateArray();
  const note = $("#selection-note");
  if (state.rangeMode && state.rangeStart) note.textContent = `起点 ${state.rangeStart}，请再选结束日期`;
  else if (picked.length > 1) note.textContent = `已选 ${picked.length} 天：${picked[0]} 至 ${picked.at(-1)}`;
  else if (picked.length === 1) note.textContent = `已选 ${picked[0]}`;
  else note.textContent = state.rangeMode ? "请选择起始日期" : "可自由选择单日或多日";
  renderRecommendation();
  renderPlan();
  renderFormalDates();
  loadCandidates().catch(error => showStatus(error.message, "error"));
}

function currentChannel() {
  return document.querySelector('input[name="channel"]:checked')?.value || "";
}

function currentProfile() {
  const channel = currentChannel();
  if (channel === "subagent") {
    const runtime = $("#cli-runtime").value;
    const model = $("#cli-model").value.trim();
    if (!runtime || !model) return null;
    return {
      channel,
      runtime,
      model,
      reasoning: runtime === "codex" ? ($("#cli-reasoning").value || null) : null,
      label: `${runtime} · ${model}`,
    };
  }
  if (channel === "api") {
    const provider = $("#api-provider").value;
    const model = $("#api-model").value.trim();
    if (!provider || !model) return null;
    return {
      channel,
      provider,
      model,
      apiProfile: $("#api-profile").value,
      label: `${provider} · ${model}`,
    };
  }
  return null;
}

function saveLastProfile() {
  const profile = currentProfile();
  if (profile) localStorage.setItem(LAST_PROFILE_KEY, JSON.stringify(profile));
}

function renderModelFields() {
  const channel = currentChannel();
  $("#cli-fields").classList.toggle("hidden", channel !== "subagent");
  $("#api-fields").classList.toggle("hidden", channel !== "api");
  const runtime = $("#cli-runtime").value;
  $("#reasoning-field").classList.toggle("hidden", runtime !== "codex");
  const profile = currentProfile();
  $("#model-summary").textContent = profile ? profile.label : "尚未选择";
  saveLastProfile();
  renderPlan();
}

function restoreLastProfile() {
  const last = readJsonStorage(LAST_PROFILE_KEY, null);
  if (!last || !["api", "subagent"].includes(last.channel)) return;
  const radio = document.querySelector(`input[name="channel"][value="${last.channel}"]`);
  if (!radio || (last.channel === "api" && !state.providers.some(row => row.id === last.provider))) return;
  radio.checked = true;
  if (last.channel === "subagent") {
    $("#cli-model").value = last.model || "";
    $("#cli-reasoning").value = last.reasoning || "";
  } else {
    $("#api-provider").value = last.provider || "";
    $("#api-model").value = last.model || "";
    $("#api-profile").value = last.apiProfile || "raw";
  }
  renderModelFields();
}

function renderRecommendation() {
  const selected = new Set(selectedDateArray());
  const rows = state.dates.filter(row => selected.has(row.date));
  const node = $("#recommendation");
  if (!rows.length) {
    node.textContent = "选择日期后给出不调用 AI 的本地推荐。";
    return;
  }
  const average = rows.reduce((total, row) => total + Number(row.messageCount || 0), 0) / rows.length;
  const groupDays = average > 180 ? 2 : 3;
  const chunkKb = average > 300 ? 50 : 100;
  const groups = dateGroups(rows.map(row => row.date), groupDays).length;
  const parallel = groups > 1 ? 2 : 1;
  node.innerHTML = `<strong>本地推荐：${groupDays} 天一组 · ${chunkKb} KB · ${parallel} 路</strong><br><small>只看日期和消息数量，不读取正文、不调用 AI。</small><br><button type="button" class="quiet-action" id="apply-recommendation">采用推荐</button>`;
  $("#apply-recommendation").onclick = () => {
    $("#group-days").value = String(groupDays);
    $("#chunk-kb").value = String(chunkKb);
    $("#parallel").value = String(parallel);
    renderPlan();
  };
}

function selectedRules() {
  return Object.fromEntries([...document.querySelectorAll("[data-rule]")].map(input => [input.dataset.rule, input.checked]));
}

function saveRules() {
  localStorage.setItem(RULES_KEY, JSON.stringify({
    rules: selectedRules(),
    additionalInstruction: $("#additional-instruction").value,
  }));
  const count = Object.values(selectedRules()).filter(Boolean).length;
  $("#rule-summary").textContent = count ? `${count} 项附加规则` : "作者原版";
}

function restoreRules() {
  const saved = readJsonStorage(RULES_KEY, {});
  document.querySelectorAll("[data-rule]").forEach(input => {
    input.checked = saved.rules?.[input.dataset.rule] === true;
  });
  $("#additional-instruction").value = String(saved.additionalInstruction || "").slice(0, 4000);
  saveRules();
}

function renderPlan() {
  const dates = selectedDateArray();
  const profile = currentProfile();
  const groups = dateGroups(dates, Number($("#group-days").value));
  const node = $("#plan");
  if (!dates.length || !profile) {
    node.textContent = "请选择至少一个日期和一个 API 或本机 CLI 模型。";
    $("#start-batch").disabled = true;
    return;
  }
  const singles = groups.filter(group => group.length === 1).length;
  node.innerHTML = `<strong>执行前预览</strong><p>${dates.length} 天 → ${groups.length} 个任务${singles ? `，其中 ${singles} 个单日任务` : ""}；使用 ${escapeHtml(profile.label)}，最多同时 ${$("#parallel").value} 路。</p>`;
  $("#start-batch").disabled = false;
}

async function startBatch() {
  const profile = currentProfile();
  const dates = selectedDateArray();
  if (!profile || !dates.length) return;
  saveLastProfile();
  $("#start-batch").disabled = true;
  try {
    const result = await api("/review-lab/api/batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: state.threadId,
        dates,
        profile,
        groupDays: Number($("#group-days").value),
        chunkKb: $("#chunk-kb").value === "auto" ? "auto" : Number($("#chunk-kb").value),
        parallel: Number($("#parallel").value),
        rules: selectedRules(),
        additionalInstruction: $("#additional-instruction").value.trim(),
      }),
    });
    renderBatch(result.batch);
    schedulePoll();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    renderPlan();
  }
}

function taskStatus(status) {
  return ({ queued: "排队", running: "运行中", completed: "完成", completed_empty: "完成（无候选）", failed: "失败" })[status] || status;
}

function renderBatch(batch) {
  state.activeBatch = batch;
  const completed = batch.tasks.filter(task => ["completed", "completed_empty"].includes(task.status)).length;
  const failures = batch.tasks.filter(task => task.status === "failed").length;
  $("#batch-status").innerHTML = `<div class="plan"><strong>本次批量：${completed}/${batch.tasks.length} 完成${failures ? `，${failures} 个失败` : ""}</strong></div>${batch.tasks.map(task => `<article class="history-task ${task.status}"><span><strong>${task.dates.map(escapeHtml).join(" 至 ")}</strong><small>${taskStatus(task.status)}${task.error ? ` · ${escapeHtml(task.error)}` : ""}</small></span></article>`).join("")}${failures && !["queued", "running"].includes(batch.status) ? '<button type="button" class="quiet-action" id="retry-batch">只重试失败任务</button>' : ""}`;
  $("#retry-batch")?.addEventListener("click", retryBatch);
  if (["queued", "running"].includes(batch.status)) schedulePoll();
  else {
    stopPoll();
    loadCandidates().catch(error => showStatus(error.message, "error"));
  }
}

function stopPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function schedulePoll() {
  stopPoll();
  state.pollTimer = setTimeout(refreshBatch, 2000);
}

async function refreshBatch() {
  if (!state.activeBatch?.id) return;
  try {
    const result = await api(`/review-lab/api/batches/${encodeURIComponent(state.activeBatch.id)}?threadId=${encodeURIComponent(state.threadId)}`);
    renderBatch(result.batch);
  } catch (error) {
    showStatus(error.message, "error");
    stopPoll();
  }
}

async function retryBatch() {
  if (!state.activeBatch?.id) return;
  await api(`/review-lab/api/batches/${encodeURIComponent(state.activeBatch.id)}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: state.threadId }),
  });
  state.activeBatch.status = "queued";
  schedulePoll();
}

async function loadCandidates() {
  const result = await api(`/review-lab/api/candidates?threadId=${encodeURIComponent(state.threadId)}`);
  const selected = new Set(selectedDateArray());
  state.candidates = (result.candidates || []).filter(candidate => !selected.size || selected.has(candidate.date));
  renderCandidates();
}

function renderCandidates() {
  const node = $("#candidate-list");
  if (!state.candidates.length) {
    node.innerHTML = '<p class="empty">所选日期还没有候选。</p>';
    $("#candidate-detail").innerHTML = '<p class="empty">运行批量挖掘后在这里审阅。</p>';
    return;
  }
  node.innerHTML = state.candidates.map(candidate => `<button type="button" class="candidate-card ${candidate.id === state.activeCandidateId ? "active" : ""}" data-candidate="${escapeHtml(candidate.id)}"><strong>${escapeHtml(candidate.date)} · ${escapeHtml(candidate.modelLabel)}</strong><br><small>${candidate.feelings.length} 条 feelings · ${candidate.features.length} 条 features · ${candidate.status === "review_pending" ? "待审阅" : candidate.status}</small></button>`).join("");
  document.querySelectorAll("[data-candidate]").forEach(button => {
    button.onclick = () => openCandidate(button.dataset.candidate);
  });
}

function memoryList(title, rows) {
  return `<section class="memory-group"><h3>${title}</h3>${rows.length ? `<ol>${rows.map(row => `<li>${escapeHtml(row.content)}</li>`).join("")}</ol>` : '<p class="empty">没有内容</p>'}</section>`;
}

function openCandidate(id) {
  state.activeCandidateId = id;
  renderCandidates();
  const candidate = state.candidates.find(row => row.id === id);
  if (!candidate) return;
  const pending = candidate.status === "review_pending";
  $("#candidate-detail").innerHTML = `<h2>${escapeHtml(candidate.date)} · ${escapeHtml(candidate.modelLabel)}</h2>${memoryList("Feelings", candidate.feelings)}${memoryList("Features", candidate.features)}${pending ? `<div class="candidate-actions"><button type="button" class="quiet-action" id="discard-candidate">放弃候选</button><button type="button" class="primary-action" id="apply-candidate">正式采用</button></div>` : ""}`;
  $("#discard-candidate")?.addEventListener("click", () => candidateAction(candidate, "discard"));
  $("#apply-candidate")?.addEventListener("click", () => candidateAction(candidate, "apply"));
}

async function candidateAction(candidate, action) {
  if (action === "apply" && !confirm(`正式采用 ${candidate.date} 的这份候选？\n\n会经过正式 CLI、备份和原文指纹复验；不会自动 rebuild。`)) return;
  if (action === "discard" && !confirm("放弃这份候选？")) return;
  try {
    await api(`/review-lab/api/candidates/${encodeURIComponent(candidate.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: state.threadId }),
    });
    await Promise.all([loadCandidates(), loadDates()]);
    if (action === "apply") {
      switchTab("formal");
      state.activeFormalDate = candidate.date;
      await loadFormalDetail();
    }
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function renderFormalDates() {
  const selected = selectedDateArray();
  const dates = selected.length ? selected : state.dates.slice(0, 7).map(row => row.date);
  if (!dates.includes(state.activeFormalDate)) state.activeFormalDate = selected.length ? dates.at(-1) : dates[0] || null;
  $("#formal-dates").innerHTML = dates.map(date => `<button type="button" class="${date === state.activeFormalDate ? "active" : ""}" data-formal-date="${date}">${date.slice(5)}</button>`).join("");
  document.querySelectorAll("[data-formal-date]").forEach(button => {
    button.onclick = () => {
      state.activeFormalDate = button.dataset.formalDate;
      renderFormalDates();
      loadFormalDetail().catch(error => showStatus(error.message, "error"));
    };
  });
  if (state.tab === "formal") loadFormalDetail().catch(error => showStatus(error.message, "error"));
}

async function loadFormalDetail() {
  if (!state.activeFormalDate) {
    $("#formal-detail").innerHTML = '<p class="empty">请先选择日期。</p>';
    return;
  }
  const result = await api(`/api/libraries/${encodeURIComponent(state.threadId)}/mining/day?date=${encodeURIComponent(state.activeFormalDate)}`);
  $("#formal-detail").innerHTML = `<h2>${escapeHtml(result.date)}</h2>${memoryList("正式 Feelings", result.feelings || [])}${memoryList("正式 Features", result.features || [])}`;
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  $("#candidates-view").classList.toggle("hidden", tab !== "candidates");
  $("#formal-view").classList.toggle("hidden", tab !== "formal");
  renderCalendar();
  if (tab === "formal") loadFormalDetail().catch(error => showStatus(error.message, "error"));
}

async function loadDates() {
  const result = await api(`/review-lab/api/dates?threadId=${encodeURIComponent(state.threadId)}`);
  state.dates = result.dates || [];
  state.selectedDates = new Set(selectedDateArray().filter(date => state.dates.some(row => row.date === date)));
  if (!state.month) state.month = state.dates[0]?.date.slice(0, 7) || new Date().toISOString().slice(0, 7);
  renderSelection();
}

function wireUi() {
  document.querySelectorAll("details.settings").forEach(details => {
    syncSettingsLabel(details);
    details.addEventListener("toggle", () => syncSettingsLabel(details));
  });
  $("#refresh").onclick = () => Promise.all([loadDates(), loadCandidates()]).catch(error => showStatus(error.message, "error"));
  $("#previous-month").onclick = () => { state.month = shiftMonth(state.month, -1); renderCalendar(); };
  $("#next-month").onclick = () => { state.month = shiftMonth(state.month, 1); renderCalendar(); };
  $("#select-pending").onclick = () => {
    state.selectedDates = new Set(state.dates.filter(row => !Number(row.feelingCount)).map(row => row.date));
    state.rangeStart = null;
    renderSelection();
  };
  $("#range-toggle").onclick = () => {
    state.rangeMode = !state.rangeMode;
    state.rangeStart = null;
    $("#range-toggle").setAttribute("aria-pressed", String(state.rangeMode));
    renderSelection();
  };
  $("#clear-dates").onclick = () => {
    state.selectedDates.clear();
    state.rangeStart = null;
    renderSelection();
  };
  document.querySelectorAll('input[name="channel"]').forEach(input => input.onchange = renderModelFields);
  ["#cli-runtime", "#cli-model", "#cli-reasoning", "#api-provider", "#api-model", "#api-profile"].forEach(selector => {
    $(selector).addEventListener("change", renderModelFields);
    $(selector).addEventListener("input", renderModelFields);
  });
  $("#api-provider").addEventListener("change", () => {
    const provider = state.providers.find(row => row.id === $("#api-provider").value);
    if (provider?.defaultModel && !$("#api-model").value.trim()) $("#api-model").value = provider.defaultModel;
    renderModelFields();
  });
  ["#group-days", "#chunk-kb", "#parallel"].forEach(selector => $(selector).onchange = renderPlan);
  document.querySelectorAll("[data-rule]").forEach(input => input.onchange = saveRules);
  $("#additional-instruction").oninput = saveRules;
  $("#reset-rules").onclick = () => {
    document.querySelectorAll("[data-rule]").forEach(input => { input.checked = false; });
    $("#additional-instruction").value = "";
    saveRules();
  };
  $("#start-batch").onclick = startBatch;
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => switchTab(button.dataset.tab));
}

async function init() {
  if (!state.threadId) throw new Error("缺少当前记忆体标识，请从 Stone Memory 插件工坊进入。");
  wireUi();
  const libraryResult = await api(`/review-lab/api/libraries?threadId=${encodeURIComponent(state.threadId)}`);
  state.library = libraryResult.libraries?.[0] || null;
  state.providers = libraryResult.providers || [];
  $("#library-meta").textContent = state.library ? `${state.library.label} · 与 Stone Memory 共用本地数据` : "当前记忆体不可用";
  const runtime = state.library?.runtime || "";
  $("#cli-runtime").innerHTML = runtime ? `<option value="${escapeHtml(runtime)}">${escapeHtml(runtime)}</option>` : '<option value="">未配置</option>';
  $("#cli-runtime-label").textContent = runtime ? `当前 runtime：${runtime}` : "当前记忆体未配置 runtime";
  $("#api-provider").innerHTML = state.providers.length
    ? state.providers.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join("")
    : '<option value="">未配置 API Provider</option>';
  const firstProvider = state.providers[0];
  if (firstProvider?.defaultModel) $("#api-model").value = firstProvider.defaultModel;
  restoreRules();
  restoreLastProfile();
  await Promise.all([loadDates(), loadCandidates()]);
  const batches = await api(`/review-lab/api/batches?threadId=${encodeURIComponent(state.threadId)}`);
  if (batches.batches?.[0]) renderBatch(batches.batches[0]);
  switchTab("formal");
}

init().catch(error => showStatus(error.message, "error"));
