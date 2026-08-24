(() => {
  "use strict";

  const moduleApi = window.StoneDeveloperModule;
  const threadId = moduleApi?.threadId || "";

  const TYPE_ORDER = ["beautiful", "nightmare", "erotic", "beautiful_erotic", "nightmare_erotic"];
  const TYPE_LABELS = {
    beautiful: "美梦",
    nightmare: "噩梦",
    erotic: "春梦",
    beautiful_erotic: "美梦染春梦",
    nightmare_erotic: "噩梦染春梦",
  };
  const DEFAULT_WEIGHTS = { beautiful: 64, nightmare: 9, erotic: 10, beautiful_erotic: 16, nightmare_erotic: 1 };
  const GUARDED = new Set(["nightmare", "nightmare_erotic"]);
  const MULTIPLIER_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  const PROMPT_ITEMS = [
    { key: "common-core", label: "公共织梦规则", desc: "决定所有梦境共同规则" },
    { key: "beautiful", label: "美梦", desc: "温暖、安全、圆满" },
    { key: "nightmare", label: "噩梦", desc: "危险、失去、恐惧的落点" },
    { key: "erotic", label: "春梦", desc: "自愿、平等的亲密与欲望" },
    { key: "beautiful_erotic", label: "美梦染春梦", desc: "在圆满里叠入亲密余韵" },
    { key: "nightmare_erotic", label: "噩梦染春梦", desc: "在危险里叠入亲密张力" },
  ];

  const root = document.querySelector("#dream-root");
  let prefs = null;
  let dreams = null;
  let pendingMultipliers = null;
  let pendingPin = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function formatPercent(value) {
    return `${(Number(value) * 100).toFixed(2)}%`;
  }
  function failClosed(message) {
    if (!threadId) throw new Error("缺少当前记忆体，请返回开发者模块重新进入");
    if (message) throw new Error(message);
  }

  async function api(path, options) {
    return moduleApi.api(path, options);
  }

  async function loadAll() {
    failClosed();
    const [dreamsData, prefsData] = await Promise.all([
      api(`/api/libraries/${encodeURIComponent(threadId)}/dreams`),
      api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/preferences`),
    ]);
    dreams = dreamsData;
    prefs = prefsData;
    pendingMultipliers = { ...prefs.multipliers };
    pendingPin = prefs.oneShot?.dreamType || null;
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "grimoire") return { view: "grimoire", key: parts[1] || null };
    if (parts[0] === "tuning") return { view: "tuning", key: parts[1] || null };
    if (parts[0] === "archive") return { view: "archive", date: parts[1] || null };
    return { view: "home" };
  }

  async function render() {
    const route = parseRoute();
    try {
      if (!prefs || !dreams) await loadAll();
      if (route.view === "grimoire" && route.key) return renderGrimoireEditor(route.key);
      if (route.view === "grimoire") return renderGrimoire();
      if (route.view === "tuning" && route.key) return renderTuningDetail(route.key);
      if (route.view === "tuning") return renderTuning();
      if (route.view === "archive" && route.date) return await renderArchiveDetail(route.date);
      if (route.view === "archive") return renderArchive();
      renderHome();
    } catch (error) {
      root.innerHTML = `<div class="dream-error">${escapeHtml(error.message)}</div>`;
    }
  }

  // ── 首页 ────────────────────────────────────────────────
  function renderHome() {
    const count = dreams.entries?.length ?? dreams.dreamDates?.length ?? 0;
    const missing = dreams.coverage?.missingDates?.length || 0;
    const latest = dreams.latest;
    const customCount = Object.values(prefs.promptOverrides || {}).filter(Boolean).length;
    const pinType = prefs.oneShot?.dreamType || null;
    const enabled = dreams.enabled === true;
    const latestMeta = latest
      ? `最近一场 ${dateLabel(latest.date)}《${latest.title || "未命名的梦"}》`
      : "还没有梦";

    root.innerHTML = `
      <section class="card status-card">
        <div class="section-title"><div><span class="label">当前状态</span></div></div>
        <div class="status-grid">
          <div class="stat"><strong>${escapeHtml(count)}</strong><span>已保存梦境</span></div>
          <div class="stat"><strong>${latest ? escapeHtml(dateLabel(latest.date)) : "—"}</strong><span>最近一场${latest ? " · " + escapeHtml(TYPE_LABELS[latest.dreamType] || latest.dreamType) : ""}</span></div>
          <div class="stat"><strong>${missing ? escapeHtml(missing) : "0"}</strong><span>漏织天数</span></div>
        </div>
        <div class="status-lines">
          <div class="status-line"><span>自动织梦</span><strong class="${enabled ? "on" : ""}">${enabled ? "已开启" : "已关闭"}</strong></div>
          <div class="status-line"><span>安梦守护</span><strong>${prefs.guard ? "已开启" : "未开启"}</strong></div>
          <div class="status-line"><span>下一场梦</span><strong>${pinType ? "已牵引至「" + escapeHtml(TYPE_LABELS[pinType] || pinType) + "」" : "正常随机"}</strong></div>
        </div>
        <label class="switch-row">
          <span><strong>自动织梦</strong><small>开启后，每天记忆挖掘完成时自动生成一场梦。</small></span>
          <input id="enabled" type="checkbox" ${enabled ? "checked" : ""}>
        </label>
        <div class="manual-dream">
          <div class="manual-dream-head"><strong>立即织梦</strong><small>为已经完成记忆挖掘的某一天手动生成一场梦</small></div>
          <div class="generate-row">
            <select id="date"></select>
            <button id="generate">立即织梦</button>
          </div>
          <p class="hint" id="generate-hint"></p>
        </div>
      </section>

      <section class="card entry-card" data-nav="grimoire" role="link" tabindex="0">
        <div class="entry-copy">
          <h2>织梦秘典</h2>
          <p>管理小机织梦时使用的规则与五类梦境秘典</p>
          <span class="entry-meta">${escapeHtml(PROMPT_ITEMS.length)} 份秘典 · ${customCount} 份已自定义</span>
        </div>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </section>

      <section class="card entry-card" data-nav="tuning" role="link" tabindex="0">
        <div class="entry-copy">
          <h2>织梦调律</h2>
          <p>决定下一场梦如何发生，也调整长期梦境倾向</p>
          <span class="entry-meta">梦向牵引 · 安梦守护 · 梦谱调律</span>
        </div>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </section>

      <section class="card entry-card" data-nav="archive" role="link" tabindex="0">
        <div class="entry-copy">
          <h2>梦境档案</h2>
          <p class="entry-sub">已经做过的梦</p>
          <p>收好小机曾经做过的每一场梦</p>
          <span class="entry-meta">${escapeHtml(count)} 场梦 · ${escapeHtml(latestMeta)}</span>
        </div>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </section>
    `;

    bindHome();
  }

  function bindHome() {
    const enabled = root.querySelector("#enabled");
    enabled.onchange = async () => {
      enabled.disabled = true;
      try {
        await api(`/api/libraries/${encodeURIComponent(threadId)}/settings`, {
          method: "PATCH",
          body: JSON.stringify({ automaticDream: enabled.checked }),
        });
        await loadAll();
        renderHome();
      } catch (error) {
        enabled.checked = !enabled.checked;
        setHint(error.message);
      } finally {
        enabled.disabled = false;
      }
    };

    root.querySelectorAll(".entry-card").forEach(card => {
      const go = () => { location.hash = `#/${card.dataset.nav}`; };
      card.onclick = go;
      card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
    });

    const date = root.querySelector("#date");
    const generate = root.querySelector("#generate");

    const eligible = (dreams.eligibleDates || []).slice().reverse();
    date.innerHTML = eligible.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    date.disabled = eligible.length === 0;
    generate.disabled = eligible.length === 0 || dreams.job?.status === "running";

    setGenerateHint();

    generate.onclick = async () => {
      generate.disabled = true;
      generate.textContent = "正在织梦……";
      try {
        await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/generate`, {
          method: "POST",
          body: JSON.stringify({ date: date.value }),
        });
        await loadAll();
        renderHome();
      } catch (error) {
        setHint(error.message);
        generate.disabled = false;
        generate.textContent = "立即织梦";
      }
    };
  }

  function setGenerateHint() {
    const hint = root.querySelector("#generate-hint");
    const pinType = prefs.oneShot?.dreamType || null;
    if (pinType) hint.textContent = `下一场将按「${TYPE_LABELS[pinType] || pinType}」织造，成功后自动解除牵引。`;
    else if (prefs.guard) hint.textContent = "本次随机织梦将避开噩梦。";
    else hint.textContent = "同一日期只保存一场梦；已经存在时不会覆盖。";
  }

  function setHint(message) {
    const hint = root.querySelector("#generate-hint");
    if (hint) hint.textContent = message;
  }

  function dateLabel(value) {
    const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? `${match[1]}-${match[2]}` : value;
  }

  // ── 梦境档案 ─────────────────────────────────────────────
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function dotDate(value) {
    const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? `${match[1]}.${match[2]}` : value;
  }

  function weekdayOf(value) {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? "" : WEEKDAYS[parsed.getDay()];
  }

  function monthLabel(key) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
    return match ? `${match[1]} 年 ${Number(match[2])} 月` : key;
  }

  function archiveMeta(date, dreamType) {
    return `${dotDate(date)} · ${TYPE_LABELS[dreamType] || dreamType}`;
  }

  function renderArchive() {
    const entries = [...(dreams.entries || [])].sort((a, b) => b.date.localeCompare(a.date));
    const groups = groupByMonth(entries);
    const range = entries.length
      ? (entries.at(-1).date.slice(0, 7) === entries[0].date.slice(0, 7)
        ? monthLabel(entries[0].date.slice(0, 7))
        : `${monthLabel(entries.at(-1).date.slice(0, 7))} — ${monthLabel(entries[0].date.slice(0, 7))}`)
      : "";

    root.innerHTML = `
      <div class="module-back"><a href="#/">← 返回自动织梦</a></div>
      <header class="archive-header">
        <h2>梦境档案</h2>
        <p class="lead">每一场被保存下来的梦，都留在这里。</p>
        <div class="archive-stats">${escapeHtml(entries.length)} 场梦${range ? `<span>${escapeHtml(range)}</span>` : ""}</div>
      </header>
      ${entries.length ? groups.map(group => archiveGroup(group)).join("") : `<section class="card archive-empty">还没有梦境。</section>`}
    `;

    root.querySelectorAll(".dream-entry").forEach(row => {
      const go = () => { location.hash = `#/archive/${row.dataset.date}`; };
      row.onclick = go;
      row.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
    });
  }

  function groupByMonth(entries) {
    const groups = [];
    const map = new Map();
    for (const dream of entries) {
      const key = dream.date.slice(0, 7);
      if (!map.has(key)) {
        const group = { key, dreams: [] };
        map.set(key, group);
        groups.push(group);
      }
      map.get(key).dreams.push(dream);
    }
    return groups;
  }

  function archiveGroup(group) {
    return `
      <section class="archive-month">
        <h3 class="archive-month-label">${escapeHtml(monthLabel(group.key))}</h3>
        <div class="archive-list">${group.dreams.map(dreamEntry).join("")}</div>
      </section>`;
  }

  function dreamEntry(dream) {
    const title = dream.title || "未命名的梦";
    return `
      <div class="dream-entry" data-date="${escapeHtml(dream.date)}" role="link" tabindex="0">
        <div class="dream-entry-date">
          <strong>${escapeHtml(dotDate(dream.date))}</strong>
          <span>${escapeHtml(weekdayOf(dream.date))}</span>
        </div>
        <div class="dream-entry-main">
          <span class="dream-entry-title">${escapeHtml(title)}</span>
          <span class="badge dream-type">${escapeHtml(TYPE_LABELS[dream.dreamType] || dream.dreamType)}</span>
        </div>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </div>`;
  }

  async function renderArchiveDetail(date) {
    const entries = [...(dreams.entries || [])].sort((a, b) => a.date.localeCompare(b.date));
    const index = entries.findIndex(dream => dream.date === date);
    if (index < 0) { location.hash = "#/archive"; return; }
    const meta = entries[index];
    const prev = index > 0 ? entries[index - 1] : null;
    const next = index < entries.length - 1 ? entries[index + 1] : null;

    let body = "";
    try {
      const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams?date=${encodeURIComponent(date)}`);
      body = data.latest?.body || "";
    } catch (error) {
      body = "";
    }

    root.innerHTML = `
      <div class="module-back"><a href="#/archive">← 返回梦境档案</a></div>
      <article class="card dream-article">
        <div class="dream-article-meta">${escapeHtml(archiveMeta(meta.date, meta.dreamType))}</div>
        <h1 class="dream-article-title">${escapeHtml(meta.title || "未命名的梦")}</h1>
        <div class="dream-article-body">${renderDreamMarkdown(body)}</div>
        ${(prev || next) ? `<nav class="dream-pager">
          ${prev ? `<a href="#/archive/${escapeHtml(prev.date)}">← ${escapeHtml(dotDate(prev.date))} ${escapeHtml(prev.title || "未命名的梦")}</a>` : `<span></span>`}
          ${next ? `<a href="#/archive/${escapeHtml(next.date)}">${escapeHtml(dotDate(next.date))} ${escapeHtml(next.title || "未命名的梦")} →</a>` : `<span></span>`}
        </nav>` : ""}
      </article>
    `;
  }

  function renderDreamMarkdown(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null;
    let paragraph = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
        paragraph = [];
      }
    };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const line of lines) {
      const heading = line.match(/^(#{1,6})[ \t]+(.+)$/);
      if (heading) {
        flushParagraph(); closeList();
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        continue;
      }
      const quote = line.match(/^>[ \t]?(.*)$/);
      if (quote) {
        flushParagraph(); closeList();
        out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      const item = line.match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$/);
      if (item) {
        const ordered = /^\d+[.)]/.test(line.trimStart());
        flushParagraph();
        const tag = ordered ? "ol" : "ul";
        if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
        out.push(`<li>${inline(item[1])}</li>`);
        continue;
      }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      closeList();
      paragraph.push(line);
    }
    flushParagraph(); closeList();
    return out.join("\n");
  }

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  // ── 织梦秘典 ─────────────────────────────────────────────
  function renderGrimoire() {
    root.innerHTML = `
      <div class="module-back"><a href="#/">← 返回自动织梦</a></div>
      <div class="grid-2">${PROMPT_ITEMS.map(item => grimoireCard(item)).join("")}</div>
    `;
    root.querySelectorAll(".grimoire-item").forEach(card => {
      const go = () => { location.hash = `#/grimoire/${card.dataset.key}`; };
      card.onclick = go;
      card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
    });
  }

  function grimoireCard(item) {
    const custom = prefs.promptOverrides?.[item.key] === true;
    return `
      <section class="card grimoire-item" data-key="${escapeHtml(item.key)}" role="link" tabindex="0">
        <div class="grimoire-item-head"><h3>${escapeHtml(item.label)}</h3><span class="badge ${custom ? "custom" : ""}">${custom ? "已自定义" : "使用默认"}</span></div>
        <p>${escapeHtml(item.desc)}</p>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </section>`;
  }

  function renderGrimoireEditor(key) {
    const item = PROMPT_ITEMS.find(row => row.key === key);
    if (!item) { location.hash = "#/grimoire"; return; }
    root.innerHTML = `
      <div class="module-back"><a href="#/grimoire">← 返回织梦秘典</a></div>
      <section class="card">
        <div class="section-title"><div><span class="label">织梦秘典</span><h2>${escapeHtml(item.label)}</h2></div><span class="badge" id="editor-status">读取中……</span></div>
        <p class="lead" id="editor-lead">${escapeHtml(item.desc)}</p>
        <div id="editor-error" class="validation-error" hidden></div>
        <textarea id="editor" spellcheck="false"></textarea>
        <div class="editor-actions">
          <button id="editor-reset" class="ghost">恢复默认</button>
          <button id="editor-save">保存修改</button>
        </div>
      </section>
    `;
    bindGrimoireEditor(item);
  }

  async function bindGrimoireEditor(item) {
    const editor = root.querySelector("#editor");
    const status = root.querySelector("#editor-status");
    const errorBox = root.querySelector("#editor-error");
    const lead = root.querySelector("#editor-lead");

    async function load() {
      const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/prompt?type=${encodeURIComponent(item.key)}`);
      editor.value = data.content || "";
      status.textContent = data.custom ? "已自定义" : "使用默认";
      status.className = "badge " + (data.custom ? "custom" : "");
      editor.placeholder = `在此编写「${item.label}」的 Markdown 内容……`;
    }

    root.querySelector("#editor-save").onclick = async () => {
      errorBox.hidden = true;
      const content = editor.value;
      if (!content.trim()) { showError("内容不能为空"); return; }
      const save = root.querySelector("#editor-save");
      save.disabled = true;
      save.textContent = "保存中……";
      try {
        const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/prompt`, {
          method: "PUT",
          body: JSON.stringify({ type: item.key, content }),
        });
        await loadAll();
        status.textContent = "已自定义";
        status.className = "badge custom";
        lead.textContent = `${item.desc}`;
        save.textContent = "保存修改";
      } catch (error) {
        showError(error.message);
        save.textContent = "保存修改";
      } finally {
        save.disabled = false;
      }
    };

    root.querySelector("#editor-reset").onclick = async () => {
      if (!confirm(`确定恢复「${item.label}」为 Stone Memory 内置默认？`)) return;
      errorBox.hidden = true;
      try {
        const data = await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/prompt?type=${encodeURIComponent(item.key)}`, {
          method: "DELETE",
        });
        await loadAll();
        editor.value = data.content || "";
        status.textContent = "使用默认";
        status.className = "badge";
      } catch (error) {
        showError(error.message);
      }
    };

    function showError(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }

    await load().catch(error => showError(error.message));
  }

  // ── 织梦调律 ─────────────────────────────────────────────
  function renderTuning() {
    root.innerHTML = `
      <div class="module-back"><a href="#/">← 返回自动织梦</a></div>
      ${tuningEntryCard("pin", "梦向牵引", "为下一场梦指定一次方向")}
      ${tuningEntryCard("guard", "安梦守护", "排除随机生成的噩梦与噩梦染春梦")}
      ${tuningEntryCard("spectrum", "梦谱调律", "用倍率重新调整五类梦境出现的倾向")}
    `;
    root.querySelectorAll("[data-tuning]").forEach(card => {
      const go = () => { location.hash = `#/tuning/${card.dataset.tuning}`; };
      card.onclick = go;
      card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } };
    });
  }

  function tuningEntryCard(key, title, desc) {
    return `
      <section class="card entry-card" data-tuning="${escapeHtml(key)}" role="link" tabindex="0">
        <div class="entry-copy">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(desc)}</p>
        </div>
        <div class="entry-arrow" aria-hidden="true">→</div>
      </section>`;
  }

  function renderTuningDetail(key) {
    if (key === "pin") return renderPinDetail();
    if (key === "guard") return renderGuardDetail();
    if (key === "spectrum") return renderSpectrumDetail();
    location.hash = "#/tuning";
  }

  function renderPinDetail() {
    const pinType = prefs.oneShot?.dreamType || null;
    root.innerHTML = `
      <div class="module-back"><a href="#/tuning">← 返回织梦调律</a></div>
      <section class="card">
        <div class="section-title"><div><h2>梦向牵引</h2><p class="lead">为下一场梦指定一次方向，成功织成并保存后自动解除。</p></div></div>
        <div id="pin-state">${pinStateHtml(pinType)}</div>
      </section>
    `;
    bindPinDetail();
  }

  function renderGuardDetail() {
    root.innerHTML = `
      <div class="module-back"><a href="#/tuning">← 返回织梦调律</a></div>
      <section class="card">
        <div class="section-title"><div><h2>安梦守护</h2><p class="lead">保护小机不随机坠入噩梦。</p></div></div>
        <label class="switch-row">
          <span><strong>安梦守护</strong><small>开启后随机梦谱不再出现噩梦与噩梦染春梦；不限制你主动指定噩梦。</small></span>
          <input id="guard" type="checkbox" ${prefs.guard ? "checked" : ""}>
        </label>
      </section>
    `;
    bindGuardDetail();
  }

  function renderSpectrumDetail() {
    const multipliers = pendingMultipliers || prefs.multipliers;
    const probabilities = computeProbabilities(multipliers, prefs.guard);
    root.innerHTML = `
      <div class="module-back"><a href="#/tuning">← 返回织梦调律</a></div>
      <section class="card">
        <div class="section-title"><div><h2>梦谱调律</h2><p class="lead">用倍率重新调整五类梦境出现的倾向，系统自动归一化为概率。</p></div></div>
        <div id="multiplier-list">
          ${TYPE_ORDER.map(type => multiplierRow(type, multipliers[type], probabilities[type])).join("")}
        </div>
        <div class="probability-total">预计概率合计：${formatPercent(TYPE_ORDER.reduce((sum, t) => sum + probabilities[t], 0))}</div>
        <div class="editor-actions">
          <button id="multiplier-reset" class="ghost">恢复原始梦谱</button>
          <button id="multiplier-save">保存调律</button>
        </div>
      </section>
    `;
    bindSpectrumDetail();
  }

  function pinStateHtml(pinType) {
    if (pinType) {
      return `<p>下一场已牵引至：<strong>${escapeHtml(TYPE_LABELS[pinType] || pinType)}</strong>，成功织成并保存后自动解除。</p>
        <div class="editor-actions"><button id="pin-change" class="ghost">更改梦向</button><button id="pin-cancel" class="ghost">取消牵引</button></div>`;
    }
    return `<p>下一场梦将继续按照当前梦谱随机生成。</p>
      <button id="pin-choose">为下一场选择梦向</button>`;
  }

  function multiplierRow(type, multiplier, probability) {
    const guarded = prefs.guard && GUARDED.has(type);
    const options = MULTIPLIER_STEPS.map(step => `<option value="${step}" ${Number(step) === Number(multiplier) ? "selected" : ""}>×${step}</option>`).join("");
    return `<div class="multiplier-row">
      <div class="multiplier-head"><strong>${escapeHtml(TYPE_LABELS[type])}</strong><span>倍率 <select data-type="${escapeHtml(type)}">${options}</select></span></div>
      <div class="multiplier-value">${guarded ? "已由安梦守护排除" : formatPercent(probability)}</div>
    </div>`;
  }

  function bindPinDetail() {
    const pinType = prefs.oneShot?.dreamType || null;
    if (pinType) {
      root.querySelector("#pin-change").onclick = () => showPinChooser();
      root.querySelector("#pin-cancel").onclick = async () => {
        await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/pin`, { method: "DELETE" });
        await loadAll();
        renderPinDetail();
      };
    } else {
      root.querySelector("#pin-choose").onclick = () => showPinChooser();
    }
  }

  function bindGuardDetail() {
    root.querySelector("#guard").onchange = async event => {
      const input = event.target;
      input.disabled = true;
      try {
        await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/guard`, {
          method: "PUT",
          body: JSON.stringify({ enabled: input.checked }),
        });
        await loadAll();
        renderGuardDetail();
      } catch (error) {
        input.checked = !input.checked;
        alert(error.message);
        input.disabled = false;
      }
    };
  }

  function bindSpectrumDetail() {
    root.querySelectorAll("#multiplier-list select").forEach(select => {
      select.onchange = () => {
        pendingMultipliers[select.dataset.type] = Number(select.value);
        refreshProbabilities();
      };
    });

    root.querySelector("#multiplier-reset").onclick = () => {
      pendingMultipliers = { beautiful: 1, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 };
      renderSpectrumDetail();
    };

    root.querySelector("#multiplier-save").onclick = async () => {
      const probabilities = computeProbabilities(pendingMultipliers, prefs.guard);
      if (TYPE_ORDER.reduce((sum, type) => sum + probabilities[type], 0) <= 0) {
        alert("至少保留一种可随机出现的梦境类型");
        return;
      }
      const save = root.querySelector("#multiplier-save");
      save.disabled = true;
      try {
        await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/multiplier`, {
          method: "PUT",
          body: JSON.stringify({ multipliers: pendingMultipliers }),
        });
        await loadAll();
        renderSpectrumDetail();
      } catch (error) {
        alert(error.message);
        save.disabled = false;
      }
    };
  }

  function showPinChooser() {
    root.querySelector("#pin-state").innerHTML = `
      <div class="pin-choices">${TYPE_ORDER.map(type => `<label class="pin-choice"><input type="radio" name="pin-type" value="${escapeHtml(type)}" ${pendingPin === type ? "checked" : ""}><span>${escapeHtml(TYPE_LABELS[type])}</span></label>`).join("")}</div>
      <p class="hint">${prefs.guard ? "本次为你主动指定的梦向，因此不受安梦守护限制。" : "成功织成并保存后自动解除牵引。"}</p>
      <div class="editor-actions"><button id="pin-confirm-cancel" class="ghost">取消</button><button id="pin-confirm">确认牵引</button></div>`;
    const chosen = root.querySelector('input[name="pin-type"]:checked');
    if (chosen) pendingPin = chosen.value;
    root.querySelectorAll('input[name="pin-type"]').forEach(input => {
      input.onchange = () => { pendingPin = input.value; };
    });
    root.querySelector("#pin-confirm-cancel").onclick = () => { pendingPin = prefs.oneShot?.dreamType || null; renderPinDetail(); };
    root.querySelector("#pin-confirm").onclick = async () => {
      if (!pendingPin) { alert("请选择一种梦向"); return; }
      await api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/pin`, {
        method: "PUT",
        body: JSON.stringify({ dreamType: pendingPin }),
      });
      await loadAll();
      renderPinDetail();
    };
  }

  function computeProbabilities(multipliers, guard) {
    const raw = {};
    for (const type of TYPE_ORDER) {
      raw[type] = (guard && GUARDED.has(type)) ? 0 : DEFAULT_WEIGHTS[type] * (multipliers[type] ?? 1);
    }
    const total = TYPE_ORDER.reduce((sum, type) => sum + raw[type], 0);
    if (total <= 0) return TYPE_ORDER.reduce((map, type) => ({ ...map, [type]: 0 }), {});
    return TYPE_ORDER.reduce((map, type) => ({ ...map, [type]: raw[type] / total }), {});
  }

  function refreshProbabilities() {
    const probabilities = computeProbabilities(pendingMultipliers, prefs.guard);
    root.querySelectorAll(".multiplier-row").forEach(row => {
      const type = row.querySelector("select").dataset.type;
      const value = row.querySelector(".multiplier-value");
      value.textContent = prefs.guard && GUARDED.has(type) ? "已由安梦守护排除" : formatPercent(probabilities[type]);
    });
    root.querySelector(".probability-total").textContent = `预计概率合计：${formatPercent(TYPE_ORDER.reduce((sum, t) => sum + probabilities[t], 0))}`;
  }

  window.addEventListener("hashchange", render);
  render();
})();
