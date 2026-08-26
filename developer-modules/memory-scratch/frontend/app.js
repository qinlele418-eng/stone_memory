(() => {
  "use strict";

  const moduleApi = window.StoneDeveloperModule;
  const threadId = moduleApi?.threadId || "";
  const COLORS = ["gray", "blue", "pink", "silver", "gold"];
  const COLOR_INFO = {
    gray: { label: "灰色石头", short: "跨时回声", description: "两条跨时间但相关、importance ≥ 3 的记忆" },
    blue: { label: "蓝色石头", short: "最近来信", description: "根据最近一次挖掘日的 feelings 写一封信" },
    pink: { label: "粉色石头", short: "久未提起", description: "超过 30 天没有再次出现的重要旧事" },
    silver: { label: "银色石头", short: "未完待续", description: "一条未完成承诺或 AI 仍想继续的事" },
    gold: { label: "金色石头", short: "记忆专题", description: "近期高频主题的完整 Deep Search 时间线" },
  };
  const DECOY_ICONS = ["star", "letter", "leaf", "moon", "clock", "wave", "spark", "thread"];
  const SCRATCH_THRESHOLD = 58;
  const $ = selector => document.querySelector(selector);
  const ui = {
    libraryName: $("#library-name"),
    ticketNumber: $("#ticket-number"),
    playArea: $("#play-area"),
    symbolGrid: $("#symbol-grid"),
    canvas: $("#scratch-layer"),
    hint: $("#scratch-hint"),
    progress: $("#scratch-progress"),
    percent: $("#scratch-percent"),
    status: $("#module-status"),
    reveal: $("#reveal-ticket"),
    newTicket: $("#new-ticket"),
    guide: $("#stone-guide-list"),
    settlement: $("#settlement"),
    settlementCount: $("#settlement-count"),
    settlementState: $("#settlement-state"),
    rewards: $("#reward-list"),
    copy: $("#copy-result"),
    retry: $("#retry-result"),
    next: $("#next-ticket"),
    settingsForm: $("#reward-settings"),
    settingsGrid: $("#settings-grid"),
    settingsStatus: $("#settings-status"),
  };
  const state = {
    library: null,
    contract: null,
    ticketIndex: 0,
    ticket: null,
    rewards: [],
    generating: false,
    pointerActive: false,
    lastPoint: null,
    progress: 0,
    progressFrame: null,
    seen: { terms: [], feelingIds: [] },
  };

  function sessionKey(name) {
    return `stone-scratch:${threadId}:${name}`;
  }

  function loadSessionState() {
    try {
      state.seen = { ...state.seen, ...JSON.parse(sessionStorage.getItem(sessionKey("seen")) || "{}") };
    } catch {}
  }

  function saveSessionState() {
    try { sessionStorage.setItem(sessionKey("seen"), JSON.stringify(state.seen)); } catch {}
  }

  function lastTicketWasBlank() {
    try { return sessionStorage.getItem(sessionKey("last-blank")) === "1"; }
    catch { return false; }
  }

  function rememberBlank(value) {
    try { sessionStorage.setItem(sessionKey("last-blank"), value ? "1" : "0"); } catch {}
  }

  function stoneSvg(color, className = "") {
    return `<svg class="stone-icon stone-${escapeHtml(color)} ${escapeHtml(className)}" viewBox="0 0 72 64" aria-hidden="true">
      <path class="stone-rock" d="M13 56c0-16 5-31 13-39 6-6 14-9 24-7 11 2 18 10 21 20 3 9 2 18-1 26z"/>
      <path class="stone-moss" d="M17 36c6-2 9-9 15-9 7 0 9 6 15 4 7-2 10-10 16-8 4 1 7 5 9 9-3-12-11-20-22-22-10-2-18 1-24 7-5 5-8 12-10 20z"/>
      <path class="stone-stem" d="M47 11c0-5 2-8 5-11"/>
      <path class="stone-leaf" d="M52 5c-5 0-8-2-8-6 5-1 8 1 8 6z"/>
      <g class="stone-flower" transform="translate(55 1)">
        <ellipse rx="5" ry="3" transform="translate(5 0)"/><ellipse rx="5" ry="3" transform="rotate(72) translate(5 0)"/>
        <ellipse rx="5" ry="3" transform="rotate(144) translate(5 0)"/><ellipse rx="5" ry="3" transform="rotate(216) translate(5 0)"/>
        <ellipse rx="5" ry="3" transform="rotate(288) translate(5 0)"/><circle r="2.5"/>
      </g>
    </svg>`;
  }

  function decoySvg(icon) {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><use href="#icon-${escapeHtml(icon)}"></use></svg>`;
  }

  async function initialize() {
    loadSessionState();
    bindEvents();
    if (!threadId) {
      setStatus("缺少当前记忆体，请返回开发者模块后重新进入。", true);
      disableTicket(true);
      return;
    }
    try {
      const [library, contract] = await Promise.all([
        moduleApi.currentLibrary(),
        moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/scratch`),
      ]);
      state.library = library;
      state.contract = contract;
      ui.libraryName.textContent = library?.libraryName || library?.label || "当前记忆体";
      renderGuide();
      renderSettings();
      createTicket();
    } catch (error) {
      setStatus(error.message, true);
      disableTicket(true);
    }
  }

  function bindEvents() {
    ui.reveal.addEventListener("click", revealTicket);
    ui.newTicket.addEventListener("click", createTicket);
    ui.next.addEventListener("click", createTicket);
    ui.copy.addEventListener("click", copyResult);
    ui.retry.addEventListener("click", retryFailedRewards);
    ui.settingsForm.addEventListener("submit", saveSettings);
    ui.canvas.addEventListener("pointerdown", pointerDown);
    ui.canvas.addEventListener("pointermove", pointerMove);
    ui.canvas.addEventListener("pointerup", pointerUp);
    ui.canvas.addEventListener("pointercancel", pointerUp);
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (state.ticket && !state.ticket.revealed && state.progress === 0) drawFoil();
      }).observe(ui.playArea);
    }
  }

  function renderGuide() {
    const weights = state.contract?.probabilities?.colors || {};
    ui.guide.innerHTML = COLORS.map(color => {
      const eligibility = state.contract.eligibility[color];
      return `<div class="guide-row ${eligibility.available ? "" : "unavailable"}" title="${escapeHtml(eligibility.reason)}">${stoneSvg(color)}<div><strong>${escapeHtml(COLOR_INFO[color].label)}</strong><small>${escapeHtml(COLOR_INFO[color].description)}</small></div><span>${Number(weights[color]) || 0}%</span></div>`;
    }).join("");
  }

  function renderSettings() {
    const rewards = state.contract?.settings?.rewards || {};
    ui.settingsGrid.innerHTML = COLORS.map(color => `<div class="settings-field">${stoneSvg(color)}<label>${escapeHtml(COLOR_INFO[color].label)}<textarea name="${escapeHtml(color)}" maxlength="2000" placeholder="留空时使用：${escapeHtml(COLOR_INFO[color].description)}">${escapeHtml(rewards[color] || "")}</textarea></label></div>`).join("");
  }

  async function saveSettings(event) {
    event.preventDefault();
    const submit = ui.settingsForm.querySelector("button[type=submit]");
    submit.disabled = true;
    ui.settingsStatus.className = "";
    ui.settingsStatus.textContent = "正在保存…";
    const form = new FormData(ui.settingsForm);
    const rewards = Object.fromEntries(COLORS.map(color => [color, String(form.get(color) || "")]));
    try {
      state.contract = await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/scratch/settings`, {
        method: "PATCH",
        body: JSON.stringify({ rewards }),
      });
      renderGuide();
      renderSettings();
      ui.settingsStatus.textContent = "已按当前记忆体保存。";
      createTicket();
    } catch (error) {
      ui.settingsStatus.className = "error";
      ui.settingsStatus.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  }

  function createTicket() {
    if (!state.contract || state.generating) return;
    const availableColors = COLORS.filter(color => state.contract.eligibility[color]?.available);
    if (!availableColors.length) {
      setStatus("当前记忆还不足以生成默认奖励；可以先在下方设置自定义奖励。", true);
      disableTicket(true);
      return;
    }
    state.ticketIndex += 1;
    const count = Math.min(rollCount(lastTicketWasBlank()), availableColors.length);
    const colors = weightedColors(availableColors, count);
    state.ticket = { colors, revealed: false, settled: false };
    state.rewards = [];
    state.progress = 0;
    ui.ticketNumber.textContent = `第 ${state.ticketIndex} 张`;
    renderTicketSymbols(colors);
    resetScratchLayer();
    ui.settlement.hidden = true;
    ui.rewards.innerHTML = "";
    ui.copy.disabled = true;
    ui.retry.hidden = true;
    disableTicket(false);
    setStatus(colors.length ? "票面已封好，刮开寻找开花石。" : "这张票也许很安静，刮开才知道。", false);
  }

  function rollCount(forceWin) {
    const rows = (state.contract.probabilities.counts || []).filter(row => !forceWin || Number(row.count) > 0);
    return Number(weightedChoice(rows.map(row => ({ value: row.count, weight: row.weight }))));
  }

  function weightedColors(available, count) {
    const pool = available.map(color => ({ value: color, weight: state.contract.probabilities.colors[color] || 0 }));
    const selected = [];
    while (selected.length < count && pool.length) {
      const color = weightedChoice(pool);
      selected.push(color);
      pool.splice(pool.findIndex(row => row.value === color), 1);
    }
    return selected;
  }

  function weightedChoice(rows) {
    const total = rows.reduce((sum, row) => sum + Number(row.weight || 0), 0);
    let roll = randomFraction() * total;
    for (const row of rows) {
      roll -= Number(row.weight || 0);
      if (roll < 0) return row.value;
    }
    return rows.at(-1)?.value;
  }

  function randomFraction() {
    if (window.crypto?.getRandomValues) {
      const value = new Uint32Array(1);
      window.crypto.getRandomValues(value);
      return value[0] / 4294967296;
    }
    return Math.random();
  }

  function shuffled(values) {
    const rows = [...values];
    for (let index = rows.length - 1; index > 0; index--) {
      const swap = Math.floor(randomFraction() * (index + 1));
      [rows[index], rows[swap]] = [rows[swap], rows[index]];
    }
    return rows;
  }

  function renderTicketSymbols(colors) {
    const prizePositions = new Set(shuffled(Array.from({ length: 20 }, (_, index) => index)).slice(0, colors.length));
    const colorQueue = shuffled(colors);
    let prizeIndex = 0;
    ui.symbolGrid.innerHTML = Array.from({ length: 20 }, (_, index) => {
      if (prizePositions.has(index)) {
        const color = colorQueue[prizeIndex++];
        return `<div class="symbol-cell prize" data-color="${escapeHtml(color)}" aria-label="${escapeHtml(COLOR_INFO[color].label)}">${stoneSvg(color)}</div>`;
      }
      const icon = DECOY_ICONS[Math.floor(randomFraction() * DECOY_ICONS.length)];
      return `<div class="symbol-cell decoy" aria-label="装饰图标">${decoySvg(icon)}</div>`;
    }).join("");
    ui.symbolGrid.setAttribute("aria-hidden", "true");
  }

  function resetScratchLayer() {
    state.pointerActive = false;
    state.lastPoint = null;
    updateProgress(0);
    ui.canvas.style.opacity = "1";
    ui.canvas.style.pointerEvents = "auto";
    ui.hint.classList.remove("hidden");
    requestAnimationFrame(drawFoil);
  }

  function drawFoil() {
    if (!state.ticket || state.ticket.revealed) return;
    const rectangle = ui.playArea.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(rectangle.width * ratio);
    ui.canvas.height = Math.round(rectangle.height * ratio);
    const context = ui.canvas.getContext("2d", { willReadFrequently: true });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const theme = getComputedStyle(document.documentElement);
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    const foil = context.createLinearGradient(0, 0, rectangle.width, rectangle.height);
    foil.addColorStop(0, theme.getPropertyValue("--stone-theme-accent-strong").trim());
    foil.addColorStop(1, theme.getPropertyValue("--stone-theme-ink").trim());
    context.fillStyle = foil;
    context.fillRect(0, 0, rectangle.width, rectangle.height);
    context.strokeStyle = theme.getPropertyValue("--stone-theme-accent").trim();
    context.lineWidth = 1;
    context.globalAlpha = .72;
    for (let offset = -rectangle.height; offset < rectangle.width; offset += 22) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset + rectangle.height, rectangle.height);
      context.stroke();
    }
    context.globalAlpha = 1;
    context.fillStyle = theme.getPropertyValue("--stone-theme-canvas-warm").trim();
    const font = theme.getPropertyValue("--stone-theme-font-body").trim();
    context.font = `800 14px ${font}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("STONE MEMORY · 刮开涂层", rectangle.width / 2, rectangle.height / 2);
  }

  function pointerDown(event) {
    if (!state.ticket || state.ticket.revealed) return;
    event.preventDefault();
    state.pointerActive = true;
    state.lastPoint = pointerPosition(event);
    try { ui.canvas.setPointerCapture(event.pointerId); } catch {}
    ui.hint.classList.add("hidden");
    scratchAt(state.lastPoint, state.lastPoint);
  }

  function pointerMove(event) {
    if (!state.pointerActive || state.ticket?.revealed) return;
    event.preventDefault();
    const point = pointerPosition(event);
    scratchAt(state.lastPoint, point);
    state.lastPoint = point;
  }

  function pointerUp(event) {
    if (!state.pointerActive) return;
    state.pointerActive = false;
    state.lastPoint = null;
    try { ui.canvas.releasePointerCapture(event.pointerId); } catch {}
    scheduleProgressCheck();
  }

  function pointerPosition(event) {
    const rectangle = ui.canvas.getBoundingClientRect();
    return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
  }

  function scratchAt(from, to) {
    const context = ui.canvas.getContext("2d", { willReadFrequently: true });
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.lineWidth = Math.max(34, Math.min(ui.canvas.clientWidth, ui.canvas.clientHeight) * .09);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
    scheduleProgressCheck();
  }

  function scheduleProgressCheck() {
    if (state.progressFrame) return;
    state.progressFrame = requestAnimationFrame(() => {
      state.progressFrame = null;
      const progress = measuredScratchProgress();
      updateProgress(progress);
      if (progress >= SCRATCH_THRESHOLD) revealTicket();
    });
  }

  function measuredScratchProgress() {
    const context = ui.canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, ui.canvas.width, ui.canvas.height).data;
    const stride = Math.max(4, Math.round((window.devicePixelRatio || 1) * 10)) * 4;
    let sampled = 0;
    let cleared = 0;
    for (let index = 3; index < pixels.length; index += stride) {
      sampled += 1;
      if (pixels[index] < 40) cleared += 1;
    }
    return sampled ? Math.round(cleared / sampled * 100) : 0;
  }

  function updateProgress(value) {
    state.progress = Math.max(0, Math.min(100, Math.round(value)));
    ui.progress.value = state.progress;
    ui.percent.textContent = `${state.progress}%`;
  }

  function revealTicket() {
    if (!state.ticket || state.ticket.revealed) return;
    state.ticket.revealed = true;
    state.pointerActive = false;
    const context = ui.canvas.getContext("2d");
    context.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    ui.canvas.style.opacity = "0";
    ui.canvas.style.pointerEvents = "none";
    ui.hint.classList.add("hidden");
    ui.symbolGrid.setAttribute("aria-hidden", "false");
    updateProgress(100);
    rememberBlank(state.ticket.colors.length === 0);
    settleTicket();
  }

  function settleTicket() {
    if (state.ticket.settled) return;
    state.ticket.settled = true;
    ui.settlement.hidden = false;
    ui.settlementCount.textContent = `${state.ticket.colors.length} 颗石头`;
    ui.settlement.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!state.ticket.colors.length) {
      state.rewards = [];
      ui.settlementState.innerHTML = `<div class="empty-result">${stoneSvg("gray")}<div><strong>谢谢参与</strong><p>这张票没有开花石，下一张已经触发保底。</p></div></div>`;
      ui.rewards.innerHTML = "";
      ui.copy.disabled = false;
      setStatus("本张结算完成：谢谢参与。", false);
      return;
    }
    generateRewards(state.ticket.colors, false);
  }

  async function generateRewards(colors, merge) {
    state.generating = true;
    setGeneratingControls(true);
    ui.settlementState.textContent = colors.some(color => ["blue", "silver", "gold"].includes(color))
      ? `开花石已找到，${state.contract.generationMode === "api" ? "API" : "Subagent"} 正在准备奖励；可以停留在本页等待。`
      : "正在从当前记忆体取出奖励…";
    if (!merge) {
      state.rewards = [];
      renderRewardPlaceholders(colors);
    }
    try {
      const response = await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/scratch/generate`, {
        method: "POST",
        body: JSON.stringify({ colors, exclusions: state.seen }),
      });
      const result = await pollJob(response.job.id);
      if (merge) {
        const replacements = new Map(result.rewards.map(reward => [reward.color, reward]));
        state.rewards = state.rewards.map(reward => replacements.get(reward.color) || reward);
      } else {
        state.rewards = result.rewards || [];
      }
      rememberSeenRewards(state.rewards);
      renderRewards();
      const failed = state.rewards.filter(reward => reward.error);
      ui.settlementState.textContent = failed.length
        ? `${state.rewards.length - failed.length} 份奖励已完成，${failed.length} 份可以单独重试。`
        : "全部奖励已经结算，可以复制结果。";
      setStatus(failed.length ? "部分奖励生成失败，已保留完成内容。" : "本张结算完成。", failed.length > 0);
    } catch (error) {
      ui.settlementState.textContent = `结算失败：${error.message}`;
      state.rewards = colors.map(color => ({ color, label: COLOR_INFO[color].label, title: COLOR_INFO[color].short, error: error.message, body: "", sources: [] }));
      renderRewards();
      setStatus(error.message, true);
    } finally {
      state.generating = false;
      setGeneratingControls(false);
    }
  }

  async function pollJob(jobId) {
    for (;;) {
      const response = await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/scratch/jobs/${encodeURIComponent(jobId)}`);
      if (response.job.status === "completed") return response.job.result;
      if (response.job.status === "failed") throw new Error(response.job.error || "奖励生成失败");
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
  }

  function renderRewardPlaceholders(colors) {
    ui.rewards.innerHTML = colors.map(color => `<article class="reward-card">${stoneSvg(color)}<div><span class="reward-kind">${escapeHtml(COLOR_INFO[color].label)}</span><h3>${escapeHtml(COLOR_INFO[color].short)}</h3><p class="reward-body">正在准备…</p></div></article>`).join("");
  }

  function renderRewards() {
    ui.rewards.innerHTML = state.rewards.map(reward => {
      const sources = (reward.sources || []).map(source => `<blockquote><strong>${escapeHtml(source.sourceDate)} · importance ${Number(source.importance) || 0}</strong>${escapeHtml(source.content)}</blockquote>`).join("");
      return `<article class="reward-card ${reward.error ? "failed" : ""}">${stoneSvg(reward.color)}<div><span class="reward-kind">${escapeHtml(reward.label || COLOR_INFO[reward.color].label)}</span><h3>${escapeHtml(reward.title || COLOR_INFO[reward.color].short)}</h3><p class="reward-body">${escapeHtml(reward.error || reward.body || "暂无内容")}</p>${sources ? `<div class="reward-sources">${sources}</div>` : ""}</div></article>`;
    }).join("");
    const failed = state.rewards.filter(reward => reward.error);
    ui.retry.hidden = failed.length === 0;
    ui.copy.disabled = false;
  }

  function rememberSeenRewards(rewards) {
    const terms = rewards.map(reward => reward.term).filter(Boolean);
    const feelingIds = rewards.flatMap(reward => (reward.sources || []).map(source => source.id).filter(Boolean));
    state.seen.terms = [...new Set([...state.seen.terms, ...terms])].slice(-100);
    state.seen.feelingIds = [...new Set([...state.seen.feelingIds, ...feelingIds])].slice(-100);
    saveSessionState();
  }

  function retryFailedRewards() {
    const colors = state.rewards.filter(reward => reward.error).map(reward => reward.color);
    if (colors.length && !state.generating) generateRewards(colors, true);
  }

  function setGeneratingControls(value) {
    ui.copy.disabled = value;
    ui.retry.disabled = value;
    ui.next.disabled = value;
    ui.newTicket.disabled = value;
  }

  async function copyResult() {
    const text = formattedResult();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    const previous = ui.copy.textContent;
    ui.copy.textContent = "已复制";
    setTimeout(() => { ui.copy.textContent = previous; }, 1600);
  }

  function formattedResult() {
    const timestamp = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    const lines = [
      "Stone Memory · 刮刮乐结算",
      `记忆体：${state.library?.libraryName || state.library?.label || "当前记忆体"}`,
      `时间：${timestamp}`,
      `结果：${state.ticket.colors.length ? state.ticket.colors.map(color => COLOR_INFO[color].label).join("、") : "谢谢参与"}`,
    ];
    for (const reward of state.rewards) {
      lines.push("", `【${reward.title || COLOR_INFO[reward.color].short}】`);
      lines.push(reward.error ? `生成失败：${reward.error}` : reward.body);
      for (const source of reward.sources || []) {
        lines.push(`- ${source.sourceDate} · importance ${source.importance}：${source.content}`);
      }
    }
    return lines.join("\n");
  }

  function disableTicket(value) {
    ui.reveal.disabled = value;
    ui.newTicket.disabled = value;
    ui.canvas.style.pointerEvents = value ? "none" : "auto";
  }

  function setStatus(message, isError) {
    ui.status.className = `module-status${isError ? " error" : ""}`;
    ui.status.textContent = message;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  initialize();
})();
