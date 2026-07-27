"use strict";

state.selections = { feelings: new Set(), features: new Set() };
state.edits = new Map();
state.evidence = null;
state.editingKey = null;

function resetSelections() {
  state.selections = { feelings: new Set(), features: new Set() };
  state.edits = new Map();
  state.evidence = null;
  state.editingKey = null;
}

function pickKey(candidateId, kind, index) {
  return `${candidateId}::${kind}::${index}`;
}

function parsePickKey(key) {
  const [candidateId, kind, rawIndex] = String(key).split("::");
  return { candidateId, kind, index: Number(rawIndex) };
}
function editDraft(key) {
  return [...document.querySelectorAll("[data-edit-draft]")]
    .find(element => element.dataset.editDraft === key) || null;
}

function selectedEntries() {
  const entries = [];
  let selectionOrder = 0;
  for (const kind of ["feelings", "features"]) {
    for (const key of state.selections[kind]) {
      const reference = parsePickKey(key);
      const candidate = state.candidates.find(item => item.id === reference.candidateId);
      const row = candidate?.[kind]?.[reference.index];
      if (candidate && row) {
        const editedContent = kind === "feelings" ? state.edits.get(key) : null;
        entries.push({
          ...reference,
          key,
          candidate,
          originalRow: row,
          row: editedContent == null ? row : { ...row, content: editedContent },
          edited: editedContent != null && editedContent !== row.content,
          selectionOrder: selectionOrder++,
        });
      }
    }
  }
  const feelings = entries.filter(entry => entry.kind === "feelings").sort((left, right) => {
    const leftTime = Date.parse(left.originalRow.eventTime || "");
    const rightTime = Date.parse(right.originalRow.eventTime || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    return left.selectionOrder - right.selectionOrder;
  });
  return feelings.concat(entries.filter(entry => entry.kind === "features"));
}

function canonicalText(value, stripNegation = false) {
  let text = String(value || "")
    .replace(/^\s*\d{1,2}月\d{1,2}日[，,、\s]*/, "")
    .toLowerCase();
  if (stripNegation) text = text.replace(/不是|并非|不会|不能|没有|没|不|无/g, "");
  return text.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]—…·]/g, "");
}

function charBigrams(value, stripNegation = false) {
  const text = canonicalText(value, stripNegation);
  if (text.length < 2) return new Set(text ? [text] : []);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}

function textSimilarity(left, right, stripNegation = false) {
  const a = canonicalText(left, stripNegation);
  const b = canonicalText(right, stripNegation);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a))) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const leftSet = charBigrams(left, stripNegation);
  const rightSet = charBigrams(right, stripNegation);
  let shared = 0;
  for (const value of leftSet) if (rightSet.has(value)) shared++;
  return leftSet.size + rightSet.size ? (2 * shared) / (leftSet.size + rightSet.size) : 0;
}

function hasNegation(value) {
  return /不是|并非|不会|不能|没有|没|不|无/.test(String(value || ""));
}

function analyzeSelection() {
  const entries = selectedEntries();
  const duplicateKeys = new Set();
  const conflictKeys = new Set();
  let duplicatePairs = 0;
  let conflictPairs = 0;
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (left.kind !== right.kind || left.candidateId === right.candidateId) continue;
      const similarity = textSimilarity(left.row.content, right.row.content);
      if (similarity >= 0.58) {
        duplicatePairs++;
        duplicateKeys.add(left.key);
        duplicateKeys.add(right.key);
      }
      const contradictionSimilarity = textSimilarity(left.row.content, right.row.content, true);
      if (hasNegation(left.row.content) !== hasNegation(right.row.content) && contradictionSimilarity >= 0.64) {
        conflictPairs++;
        conflictKeys.add(left.key);
        conflictKeys.add(right.key);
      }
    }
  }
  return { entries, duplicateKeys, conflictKeys, duplicatePairs, conflictPairs };
}

function selectedCount(kind) {
  return state.selections[kind].size;
}

function selectCandidateItems(candidate, checked) {
  for (const kind of ["feelings", "features"]) {
    (candidate[kind] || []).forEach((row, index) => {
      const key = pickKey(candidate.id, kind, index);
      if (checked) state.selections[kind].add(key);
      else state.selections[kind].delete(key);
    });
  }
  renderCandidates(state.candidates, candidate.id);
}

function memoryRowHtml(candidate, kind, row, index, analysis) {
  const key = pickKey(candidate.id, kind, index);
  const checked = state.selections[kind].has(key);
  const pickable = candidate.status === "review_pending" && candidate.model !== "hybrid";
  const flags = [
    analysis.duplicateKeys.has(key) ? '<span class="item-flag duplicate">可能重复</span>' : "",
    analysis.conflictKeys.has(key) ? '<span class="item-flag conflict">可能冲突</span>' : "",
  ].join("");
  const meta = kind === "feelings"
    ? `importance ${row.importance}`
    : `${escapeHtml(row.category)} · importance ${row.importance}`;
  if (!pickable) {
    return `<li class="memory-row">${escapeHtml(row.content)}<small>${meta}</small>${flags}</li>`;
  }
  return `<li class="memory-row pick-row ${checked ? "selected" : ""}">
    <label>
      <input type="checkbox" data-pick-kind="${kind}" data-pick-index="${index}" data-pick-candidate="${escapeHtml(candidate.id)}" ${checked ? "checked" : ""}>
      <span>${escapeHtml(row.content)}<small>${meta}</small>${flags}</span>
    </label>
  </li>`;
}

function hybridProvenanceHtml(candidate, kind, index) {
  const source = candidate.hybrid?.selectionProvenance?.[kind]?.[index];
  return source ? `<span class="source-chip">${escapeHtml(source.modelLabel)}</span>` : "";
}

function renderHybridMemoryRows(candidate, kind) {
  return (candidate[kind] || []).map((row, index) => {
    const meta = kind === "feelings"
      ? `importance ${row.importance}`
      : `${escapeHtml(row.category)} · importance ${row.importance}`;
    return `<li class="memory-row">${escapeHtml(row.content)}<small>${meta} ${hybridProvenanceHtml(candidate, kind, index)}</small></li>`;
  }).join("");
}

renderCandidateDetail = function renderCandidateDetailMixed(candidate, analysis = analyzeSelection()) {
  const rules = normalizedCandidateRules(candidate);
  const activeRules = RULE_KEYS.filter(key => rules[key]).map(key => RULE_LABELS[key]);
  const isHybrid = candidate.model === "hybrid";
  const feelings = candidate.feelings?.length
    ? `<ol class="memory-list">${isHybrid ? renderHybridMemoryRows(candidate, "feelings") : candidate.feelings.map((row, index) => memoryRowHtml(candidate, "feelings", row, index, analysis)).join("")}</ol>`
    : '<div class="empty">这份候选没有 feelings。</div>';
  const features = candidate.features?.length
    ? `<ul class="memory-list">${isHybrid ? renderHybridMemoryRows(candidate, "features") : candidate.features.map((row, index) => memoryRowHtml(candidate, "features", row, index, analysis)).join("")}</ul>`
    : '<div class="empty">这份候选没有 features。</div>';
  const chooser = candidate.status === "review_pending" && !isHybrid
    ? `<div class="candidate-pick-tools"><span>从这一份里逐条挑选</span><div><button class="tiny secondary" id="pick-all">全选本模型</button><button class="tiny secondary" id="pick-none">清空本模型</button></div></div>`
    : "";
  const sourceSummary = isHybrid
    ? `<p class="rule-summary">混合来源：${candidate.hybrid.modelLabels.map(escapeHtml).join("、")}。每条保持原模型完整表述，没有拼接或改写句子。</p>`
    : `<p class="rule-summary">${activeRules.length ? `已启用：${activeRules.map(escapeHtml).join("、")}` : "未追加规则，使用作者原版。"}</p>`;
  const applyLabel = isHybrid ? "采用混合精选并替换当天记忆" : "采用这一份并替换当天记忆";
  return `<div class="candidate-detail">
    <div class="candidate-head">
      <div><p class="eyebrow">${isHybrid ? "MIXED PREVIEW" : "SELECTED CANDIDATE"}</p><h2>${escapeHtml(candidate.modelLabel)}</h2>
      <p>原有 ${candidate.priorCounts.feelings} 条摘要、${candidate.priorCounts.features} 条特征；这份候选为 ${candidate.feelings.length} / ${candidate.features.length}。</p></div>
      <div class="badges">
        <span class="badge">${isHybrid ? "逐条混合" : escapeHtml(PRESET_LABELS[candidate.preset] || "历史候选")}</span>
        <span class="badge">${escapeHtml(candidateStatus(candidate))}</span>
      </div>
    </div>
    ${sourceSummary}${chooser}
    <div class="candidate-section"><h3>当天摘要 · ${candidate.feelings.length}</h3>${feelings}</div>
    <div class="candidate-section"><h3>人物特征 · ${candidate.features.length}</h3>${features}</div>
    ${candidate.trimmedFeelings ? `<p class="meta">超过上限的 ${candidate.trimmedFeelings} 条已从候选中截去。</p>` : ""}
    ${candidate.status === "review_pending" ? `<div class="candidate-actions">
      <button class="secondary" id="discard">放弃这份候选</button>
      <button class="danger" id="apply">${applyLabel}</button>
    </div>` : ""}
  </div>`;
};

function selectedByModel(entries) {
  const map = new Map();
  for (const entry of entries) {
    const current = map.get(entry.candidate.modelLabel) || { feelings: 0, features: 0 };
    current[entry.kind]++;
    map.set(entry.candidate.modelLabel, current);
  }
  return map;
}

function hybridCountLimitEnabled(entries) {
  return entries.some(entry => !!normalizedCandidateRules(entry.candidate).countLimit);
}

function renderHybridTray(analysis) {
  const sourceCandidates = state.candidates.filter(candidate => candidate.status === "review_pending" && candidate.model !== "hybrid");
  if (!sourceCandidates.length) return "";
  const { entries, duplicatePairs, conflictPairs } = analysis;
  const feelings = selectedCount("feelings");
  const features = selectedCount("features");
  const countLimit = hybridCountLimitEnabled(entries);
  const tooMany = countLimit && feelings > 20;
  const shortOfTarget = countLimit && feelings > 0 && feelings < 8;
  const byModel = selectedByModel(entries);
  const modelSummary = [...byModel.entries()].map(([label, counts]) =>
    `<span class="mix-chip"><strong>${escapeHtml(label)}</strong>${counts.feelings} 摘要 · ${counts.features} 特征</span>`
  ).join("") || '<span class="meta">还没有选择条目。</span>';
  const warnings = [
    duplicatePairs ? `<span class="mix-warning">${duplicatePairs} 组可能重复</span>` : "",
    conflictPairs ? `<span class="mix-warning conflict">${conflictPairs} 组可能冲突，请人工比较</span>` : "",
    tooMany ? '<span class="mix-warning conflict">已超过 20 条上限</span>' : "",
    shortOfTarget ? '<span class="mix-note">当前少于 8 条；证据不足时仍可保留</span>' : "",
  ].filter(Boolean).join("");
  const selectedPreview = entries.length
    ? `<ol class="mix-preview-list">${entries.map(entry => `<li>
        <div class="mix-preview-content">
          <div><span class="source-chip">${escapeHtml(entry.candidate.modelLabel)}</span>${entry.edited ? '<span class="item-flag edited">已修改 · 原版保留</span>' : ""}${escapeHtml(entry.row.content)}</div>
          ${entry.kind === "feelings" ? `<div class="mix-row-tools">
            <button class="text-action" data-start-edit="${escapeHtml(entry.key)}">${entry.edited ? "继续修改" : "编辑摘要"}</button>
            ${entry.edited ? `<button class="text-action" data-restore-pick="${escapeHtml(entry.key)}">恢复模型原版</button>` : ""}
            <button class="text-action" data-evidence-pick="${escapeHtml(entry.key)}">查看时间附近原文</button>
          </div>
          ${state.editingKey === entry.key ? `<div class="inline-summary-editor">
            <label for="summary-edit-${escapeHtml(entry.key)}">修改摘要</label>
            <small>请保留开头的完整日期和具体时间。修改只作用于混合稿，模型原版不会被覆盖。</small>
            <textarea id="summary-edit-${escapeHtml(entry.key)}" data-edit-draft="${escapeHtml(entry.key)}" rows="5" maxlength="2000">${escapeHtml(entry.row.content)}</textarea>
            <details><summary>查看模型原版</summary><p>${escapeHtml(entry.originalRow.content)}</p></details>
            <div class="inline-editor-actions">
              <button class="primary small" data-save-edit="${escapeHtml(entry.key)}">保存修改</button>
              <button class="secondary small" data-cancel-edit="${escapeHtml(entry.key)}">取消</button>
              ${entry.edited ? `<button class="text-action" data-restore-edit="${escapeHtml(entry.key)}">恢复模型原版</button>` : ""}
            </div>
          </div>` : ""}` : ""}
        </div>
        <button class="remove-pick" data-remove-pick="${escapeHtml(entry.key)}" title="从混合稿移除">×</button>
      </li>`).join("")}</ol>`
    : '<div class="empty">在任一模型候选中勾选条目，这里会实时组成混合稿。</div>';
  const evidence = state.evidence
    ? `<aside class="evidence-panel">
        <div class="evidence-head"><div><strong>时间附近原文</strong><small>${escapeHtml(state.evidence.note || "")}</small></div><button class="text-action" id="close-evidence">关闭</button></div>
        ${state.evidence.rows?.length ? state.evidence.rows.map(row => `<article><time>${escapeHtml(formatEvidenceTime(row.timestamp))}</time><b>${escapeHtml(evidenceRole(row.role))}</b><p>${escapeHtml(row.text)}</p></article>`).join("") : '<div class="empty">没有找到可显示的附近原文。</div>'}
      </aside>`
    : "";
  return `<section class="mix-studio">
    <div class="mix-studio-head"><div><p class="eyebrow">MIX & MATCH</p><h2>混合精选台</h2></div><strong>${feelings} 条摘要 · ${features} 条特征</strong></div>
    <div class="mix-layout">
      <div class="mix-controls">
        <p>每条只保留一个模型的完整原句，不做半句拼接。</p>
        <div class="mix-models">${modelSummary}</div>
        <div class="mix-alerts">${warnings}</div>
        <div class="mix-actions">
          <button class="secondary" id="smart-dedupe" ${duplicatePairs ? "" : "disabled"}>智能去重</button>
          <button class="secondary" id="clear-mix" ${entries.length ? "" : "disabled"}>全部清空</button>
          <button class="primary" id="create-hybrid" ${!entries.length || tooMany ? "disabled" : ""}>生成混合预览</button>
        </div>
        <small>${countLimit ? "沿用候选的每日 8–20 条规则；最终混合摘要最多 20 条。" : "当前候选未启用每日条数限制。"}</small>
      </div>
      <div class="mix-preview"><h3>实时混合稿</h3>${selectedPreview}${evidence}</div>
    </div>
  </section>`;
}

function bindMixedCandidateEvents(active) {
  document.querySelectorAll("[data-candidate-id]").forEach(button => button.addEventListener("click", () => {
    renderCandidates(state.candidates, button.dataset.candidateId);
  }));
  document.querySelectorAll("[data-pick-kind]").forEach(input => input.addEventListener("change", event => {
    const target = event.currentTarget;
    const kind = target.dataset.pickKind;
    const key = pickKey(target.dataset.pickCandidate, kind, Number(target.dataset.pickIndex));
    if (target.checked) state.selections[kind].add(key);
    else {
      state.selections[kind].delete(key);
      state.edits.delete(key);
      if (state.editingKey === key) state.editingKey = null;
    }
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-remove-pick]").forEach(button => button.addEventListener("click", () => {
    const parsed = parsePickKey(button.dataset.removePick);
    state.selections[parsed.kind].delete(button.dataset.removePick);
    state.edits.delete(button.dataset.removePick);
    if (state.editingKey === button.dataset.removePick) state.editingKey = null;
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-start-edit]").forEach(button => button.addEventListener("click", () => {
    state.editingKey = button.dataset.startEdit;
    renderCandidates(state.candidates, active.id);
    const editor = editDraft(state.editingKey);
    editor?.focus();
    if (editor) editor.setSelectionRange(editor.value.length, editor.value.length);
  }));
  document.querySelectorAll("[data-save-edit]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.saveEdit;
    const content = String(editDraft(key)?.value || "").trim();
    if (!content) return status("摘要不能为空。", "error");
    state.edits.set(key, content);
    state.editingKey = null;
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-cancel-edit]").forEach(button => button.addEventListener("click", () => {
    state.editingKey = null;
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-restore-edit]").forEach(button => button.addEventListener("click", () => {
    state.edits.delete(button.dataset.restoreEdit);
    state.editingKey = null;
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-restore-pick]").forEach(button => button.addEventListener("click", () => {
    state.edits.delete(button.dataset.restorePick);
    if (state.editingKey === button.dataset.restorePick) state.editingKey = null;
    renderCandidates(state.candidates, active.id);
  }));
  document.querySelectorAll("[data-evidence-pick]").forEach(button => button.addEventListener("click", async () => {
    const entry = selectedEntries().find(item => item.key === button.dataset.evidencePick);
    if (!entry) return;
    button.disabled = true;
    try {
      state.evidence = await api(`./api/candidates/${encodeURIComponent(entry.candidateId)}/evidence?kind=feelings&index=${entry.index}&threadId=${encodeURIComponent($("#library").value)}`);
      renderCandidates(state.candidates, active.id);
    } catch (error) {
      status(error.message, "error");
      button.disabled = false;
    }
  }));
  $("#close-evidence")?.addEventListener("click", () => {
    state.evidence = null;
    renderCandidates(state.candidates, active.id);
  });
  $("#pick-all")?.addEventListener("click", () => selectCandidateItems(active, true));
  $("#pick-none")?.addEventListener("click", () => selectCandidateItems(active, false));
  $("#smart-dedupe")?.addEventListener("click", smartDedupe);
  $("#clear-mix")?.addEventListener("click", () => {
    resetSelections();
    renderCandidates(state.candidates, active.id);
  });
  $("#create-hybrid")?.addEventListener("click", createHybridPreview);
  $("#discard")?.addEventListener("click", discardCandidate);
  $("#apply")?.addEventListener("click", applyCandidate);
}

renderCandidates = function renderCandidatesMixed(candidates, preferredId = null) {
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
  const analysis = analyzeSelection();
  target.classList.remove("hidden");
  target.innerHTML = `<div class="comparison-head">
      <div><p class="eyebrow">MODEL COMPARISON</p><h2>${escapeHtml(active.date)} · ${candidates.length} 份候选</h2></div>
      <p>可以整份采用，也可以从不同模型逐条挑选，先组成混合预览再确认。</p>
    </div>
    <div class="comparison-grid">${candidates.map(candidate => `
      <button class="comparison-card ${candidate.id === active.id ? "active" : ""} ${candidate.model === "hybrid" ? "hybrid" : ""}" data-candidate-id="${escapeHtml(candidate.id)}">
        <strong>${escapeHtml(candidate.modelLabel)}</strong>
        <span>${candidate.feelings.length} 条摘要 · ${candidate.features.length} 条特征</span>
        <small>${escapeHtml(candidateStatus(candidate))} · ${candidate.model === "hybrid" ? "逐条精选" : escapeHtml(PRESET_LABELS[candidate.preset] || "自定义组合")}</small>
      </button>`).join("")}
    </div>
    <div id="candidate-detail">${renderCandidateDetail(active, analysis)}</div>
    ${renderHybridTray(analysis)}`;
  bindMixedCandidateEvents(active);
};

function smartDedupe() {
  const entries = selectedEntries();
  let removed = 0;
  for (const kind of ["feelings", "features"]) {
    const kept = [];
    for (const entry of entries.filter(item => item.kind === kind)) {
      if (kept.some(previous => textSimilarity(previous.row.content, entry.row.content) >= 0.58)) {
        state.selections[kind].delete(entry.key);
        state.edits.delete(entry.key);
        if (state.editingKey === entry.key) state.editingKey = null;
        removed++;
      } else {
        kept.push(entry);
      }
    }
  }
  status(`智能去重已取消 ${removed} 条可能重复项；没有改写任何内容。`);
  renderCandidates(state.candidates, state.activeCandidateId);
}

const loadExistingCandidatesBase = loadExistingCandidates;
loadExistingCandidates = async function loadExistingCandidatesMixed() {
  resetSelections();
  return loadExistingCandidatesBase();
};

const generatePreviewBase = generatePreview;
generatePreview = async function generatePreviewMixed() {
  resetSelections();
  return generatePreviewBase();
};

function hybridSelectionPayload() {
  return Object.fromEntries(["feelings", "features"].map(kind => [
    kind,
    [...state.selections[kind]].map(key => {
      const { candidateId, index } = parsePickKey(key);
      const value = { candidateId, index };
      if (kind === "feelings" && state.edits.has(key)) value.content = state.edits.get(key);
      return value;
    }),
  ]));
}

function formatEvidenceTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : String(value || "");
}

function evidenceRole(role) {
  return role === "assistant" ? "AI" : role === "user" ? "用户" : String(role || "对话");
}

async function createHybridPreview() {
  const entries = selectedEntries();
  if (!entries.length) return status("请先从模型候选中选择记忆条目。", "error");
  const button = $("#create-hybrid");
  const enforceCountLimit = hybridCountLimitEnabled(entries);
  button.disabled = true;
  button.textContent = "正在整理混合稿……";
  try {
    const data = await api("./api/hybrid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: $("#library").value,
        date: $("#date").value,
        selection: hybridSelectionPayload(),
        enforceCountLimit,
      }),
    });
    const others = state.candidates.filter(candidate => candidate.model !== "hybrid");
    resetSelections();
    renderCandidates([data.candidate, ...others], data.candidate.id);
    status(`混合预览已生成：${data.candidate.feelings.length} 条摘要、${data.candidate.features.length} 条特征。尚未写入正式记忆。`);
    $("#candidate").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    status(error.message, "error");
    button.disabled = false;
    button.textContent = "生成混合预览";
  }
}

const applyCandidateBase = applyCandidate;
applyCandidate = async function applyCandidateMixed() {
  const candidate = activeCandidate();
  if (!candidate || candidate.model !== "hybrid") return applyCandidateBase();
  const message = `确认采用${candidate.modelLabel}，替换 ${candidate.date} 的正式记忆？\n\n写入前会备份 SQLite；同一天其他待确认候选会标记为已放弃。`;
  if (!confirm(message)) return;
  const button = $("#apply");
  button.disabled = true;
  button.textContent = "正在备份并写入……";
  try {
    const result = await api(`./api/candidates/${encodeURIComponent(candidate.id)}/apply`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: $("#library").value }),
    });
    status(`已经采用${candidate.modelLabel}，写入 ${result.date}：${result.feelings} 条摘要、${result.features} 条特征。备份：${result.backup.filename}`);
    await loadDates();
  } catch (error) {
    status(error.message, "error");
    button.disabled = false;
    button.textContent = "采用混合精选并替换当天记忆";
  }
};

init();
