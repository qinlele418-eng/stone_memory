(() => {
  "use strict";
  const api = window.StoneDeveloperModule;
  const readerTools = window.StoneNotebookReader;
  const threadId = api?.threadId || "";
  const base = `/api/libraries/${encodeURIComponent(threadId)}/notebooks`;
  const $ = selector => document.querySelector(selector);
  const bookshelf = $("#bookshelf");
  const shelfStage = $(".shelf-stage");
  const libraryHeading = $(".library-heading");
  const toolbar = $(".toolbar");
  const workspace = $("#workspace");
  const reader = $("#reader");
  const paper = $("#paper");
  const entries = $("#entries");
  const notice = $("#notice");
  const topicDialog = $("#topic-dialog");
  const noteDialog = $("#note-dialog");
  let state = {
    topics: [], currentTopic: null, currentNote: null, currentEntries: [],
    readingBlocks: [], readingPages: [], readingPage: 0, visibleEntries: [], currentNoteIndex: -1,
  };
  const paperStyleSelect = $("#paper-style");
  const readingModeSelect = $("#reading-mode");
  const PAPER_STYLES = new Set(["blank", "lined", "grid"]);
  const PAPER_STYLE_KEY = "stone:notebook:paper-style:v1";
  const READING_MODES = new Set(["paged", "continuous"]);
  const READING_MODE_KEY = "stone:notebook:reading-mode:v1";

  const pageShell = document.querySelector("stone-module-page");
  if (pageShell?.shadowRoot) {
    const shellStyle = document.createElement("style");
    shellStyle.textContent = `main{width:min(1160px,calc(100% - 32px))!important;padding-top:18px!important}header{padding:10px 6px 22px!important}.eyebrow{margin-top:18px!important}h1{font-size:clamp(38px,5vw,50px)!important}.description{margin-top:11px!important}.meta{margin-top:8px!important}@media(max-width:680px){main{width:min(100% - 20px,1160px)!important}.eyebrow{margin-top:14px!important}h1{font-size:34px!important}}`;
    pageShell.shadowRoot.append(shellStyle);
  }

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatDate = value => value ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)) : "还没有内容";
  const formatCatalogDate = value => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)).replace("/", ".") : "--.--";
  const formatLongDate = value => value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(value)) : "日期未记载";
  function message(text, kind = "") { notice.textContent = text; notice.dataset.kind = kind; }
  function formError(form, text = "") {
    const target = form.querySelector(".form-error");
    target.textContent = text;
    target.hidden = !text;
  }
  function resetImageAttachment() {
    $("#note-image").value = "";
    $("#note-image-alt").value = "";
    const status = $("#image-upload-status");
    status.textContent = "";
    status.dataset.kind = "";
    $("#upload-note-image").disabled = false;
  }

  function insertAtCursor(textarea, value) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const suffix = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
    const insertion = `${prefix}${value}${suffix}`;
    textarea.setRangeText(insertion, start, end, "end");
    textarea.focus();
  }
  const coverClass = topic => String(topic.coverPath || "preset:forest").replace("preset:", "cover-");

  function applyPaperStyle(value, persist = true) {
    const style = PAPER_STYLES.has(value) ? value : "blank";
    paper.dataset.paperStyle = style;
    paperStyleSelect.value = style;
    if (persist) {
      try { localStorage.setItem(PAPER_STYLE_KEY, style); } catch {}
    }
  }
  try { applyPaperStyle(localStorage.getItem(PAPER_STYLE_KEY) || "blank", false); } catch { applyPaperStyle("blank", false); }
  paperStyleSelect.addEventListener("change", event => applyPaperStyle(event.currentTarget.value));

  function applyReadingMode(value, persist = true) {
    const mode = READING_MODES.has(value) ? value : "paged";
    paper.dataset.readingMode = mode;
    readingModeSelect.value = mode;
    if (persist) {
      try { localStorage.setItem(READING_MODE_KEY, mode); } catch {}
    }
    if (state.currentNote) {
      state.readingPage = 0;
      buildReadingPages();
      renderReadingPage();
    }
  }
  try { applyReadingMode(localStorage.getItem(READING_MODE_KEY) || "paged", false); } catch { applyReadingMode("paged", false); }
  readingModeSelect.addEventListener("change", event => applyReadingMode(event.currentTarget.value));

  async function loadStatus() {
    if (!threadId) throw new Error("缺少当前记忆体，请返回插件工坊重新进入");
    const data = await api.api(base);
    state.topics = data.topics || [];
    $("#topic-count").textContent = `/ ${data.topicCount}`;
    renderBookshelf();
    renderSearchTopics();
    message(`${data.topicCount} 本主题笔记 · ${data.entryCount} 篇 Markdown`);
  }

  function renderSearchTopics() {
    const select = $("#search-topic"), selected = select.value;
    select.innerHTML = `<option value="">全部主题</option>${state.topics.map(topic => `<option value="${escapeHtml(topic.id)}">${escapeHtml(topic.name)}${topic.isDefault ? "（默认）" : ""}</option>`).join("")}`;
    if (state.topics.some(topic => topic.id === selected)) select.value = selected;
  }

  function renderBookshelf() {
    bookshelf.classList.remove("search-mode");
    if (!state.topics.length) {
      bookshelf.innerHTML = `<div class="empty"><strong>书架还是空的</strong><p>先创建一本主题笔记，旅行、论坛、游戏或随笔都可以。</p></div>`;
      return;
    }
    bookshelf.innerHTML = state.topics.map((topic, index) => {
      const sealed = topic.visibility === "sealed";
      const unavailable = sealed || topic.isArchived;
      const status = [sealed ? "封存中" : "主题笔记", topic.isDefault ? "默认写入" : "", topic.isArchived ? "已归档" : ""].filter(Boolean).join(" · ");
      const latest = topic.latestEntry ? `<aside class="latest-note"><strong>${escapeHtml(topic.latestEntry.title)}</strong><span>${topic.latestEntry.visibility === "sealed" ? "最近一篇已封存" : escapeHtml(topic.latestEntry.summary || "暂无摘要")}</span></aside>` : "";
      const volume = String(index + 1).padStart(2, "0");
      return `<article class="book ${sealed ? "sealed" : ""} ${topic.isArchived ? "archived" : ""} ${coverClass(topic)}" style="--book-index:${index % 6}">
        <div class="notebook-cover">
          <span class="book-spine" aria-hidden="true"></span>
          <span class="cover-flower" aria-hidden="true"></span>
          <p>${escapeHtml(status)}</p>
          <h2>${escapeHtml(topic.name)}</h2>
          <span class="cover-description">${escapeHtml(topic.description || "随手收藏")}</span>
          <b class="volume-number">${volume}</b>
          ${sealed ? `<span class="seal">由小机封存中</span>` : ""}
          ${unavailable ? "" : `<button type="button" class="open-book" data-topic="${escapeHtml(topic.id)}" aria-label="翻开主题：${escapeHtml(topic.name)}"><span>翻开笔记</span></button>`}
        </div>
        <div class="book-copy"><footer><strong>${topic.entryCount} 篇笔记</strong><span>${formatDate(topic.latestEntryAt)}</span></footer>${latest}</div>
        <div class="book-actions"><button type="button" class="quiet-manage" data-manage-topic="${escapeHtml(topic.id)}" aria-label="管理主题：${escapeHtml(topic.name)}">管理主题</button></div>
      </article>`;
    }).join("");
    bookshelf.querySelectorAll("[data-topic]").forEach(button => button.onclick = () => openTopic(button.dataset.topic));
    bookshelf.querySelectorAll("[data-manage-topic]").forEach(button => button.onclick = () => openTopicForm(button.dataset.manageTopic));
  }

  async function openTopic(topicId) {
    const topic = state.topics.find(item => item.id === topicId);
    if (!topic || topic.visibility === "sealed") return;
    state.currentTopic = topic;
    const rows = await api.api(`${base}/topics/${encodeURIComponent(topicId)}/entries`);
    state.currentEntries = rows;
    $("#topic-kicker").textContent = `${rows.length} 篇 Markdown`;
    $("#topic-title").textContent = topic.name;
    $("#topic-description").textContent = topic.description || "这本笔记还没有说明。";
    workspace.dataset.stamp = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date()).toUpperCase();
    $("#new-note").hidden = false;
    renderDirectory(rows, { emptyTitle: "还没有写下第一页", emptyDescription: "可以由你写，也可以让小机通过 MCP 保存。", allowUnseal: true });
    shelfStage.hidden = true;
    libraryHeading.hidden = true;
    toolbar.hidden = true;
    notice.hidden = true;
    reader.hidden = true;
    workspace.hidden = false;
    $("#new-note").focus();
  }

  function renderDirectory(rows, { includeTopic = false, allowUnseal = false, emptyTitle = "没有找到", emptyDescription = "换一个关键词试试看。" } = {}) {
    entries.innerHTML = rows.length ? rows.map((note, index) => {
      const tags = (note.tags || []).map(tag => `#${escapeHtml(tag)}`).join("  ");
      const topic = includeTopic && note.topicName ? escapeHtml(note.topicName) : "";
      const meta = [topic, tags || (!includeTopic ? "随笔" : "")].filter(Boolean).join(" · ");
      return note.visibility === "sealed"
        ? `<article class="entry sealed-entry"><time>${formatCatalogDate(note.updatedAt)}</time><div class="entry-copy"><h3>${escapeHtml(note.title)}</h3><span>${topic ? `${topic} · ` : ""}此篇由小机封存中</span></div><span class="dot-leader" aria-hidden="true"></span><b>${String(index + 1).padStart(2, "0")}</b>${allowUnseal ? `<button type="button" data-unseal-note="${escapeHtml(note.id)}">解除封存</button>` : ""}</article>`
        : `<button class="entry" type="button" data-note="${escapeHtml(note.id)}"><time>${formatCatalogDate(note.updatedAt)}</time><div class="entry-copy"><h3>${escapeHtml(note.title)}</h3><span>${meta || "主题笔记"}</span></div><span class="dot-leader" aria-hidden="true"></span><b>${String(index + 1).padStart(2, "0")}</b></button>`;
    }).join("") : `<div class="empty"><strong>${escapeHtml(emptyTitle)}</strong><p>${escapeHtml(emptyDescription)}</p></div>`;
    entries.querySelectorAll("[data-note]").forEach(button => button.onclick = () => readNote(button.dataset.note));
    entries.querySelectorAll("[data-unseal-note]").forEach(button => button.onclick = () => unsealNote(button.dataset.unsealNote));
  }

  async function readNote(noteId) {
    const note = await api.api(`${base}/entries/${encodeURIComponent(noteId)}`);
    if (note.visibility === "sealed") return;
    state.currentNote = note;
    const visibleEntries = state.currentEntries.filter(item => item.visibility !== "sealed");
    const currentIndex = visibleEntries.findIndex(item => item.id === note.id);
    state.visibleEntries = visibleEntries;
    state.currentNoteIndex = currentIndex;
    state.readingPage = 0;
    const date = new Date(note.updatedAt || note.createdAt || Date.now());
    const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date).toUpperCase();
    const day = String(date.getDate()).padStart(2, "0");
    paper.innerHTML = `<span class="paper-ribbon" aria-hidden="true"></span><div class="book-page book-page-title"><header><div class="date-badge"><small>${month}</small><strong>${day}</strong></div><p>${formatLongDate(date)}<span class="leaf-divider" aria-hidden="true"></span>${escapeHtml(note.topicName)} · 第 ${note.revision} 版</p><h2>${escapeHtml(note.title)}</h2><div>${(note.tags || []).map(tag => `<span>#${escapeHtml(tag)}</span>`).join("")}</div></header></div><div class="book-page book-page-body"><div id="reading-content" aria-live="polite"></div><nav id="body-pagination" class="body-pagination" aria-label="当前笔记正文分页"><button id="previous-page" type="button">← 上一页</button><span id="page-status"></span><button id="next-page" type="button">下一页 →</button></nav></div><footer><span>${String(Math.max(0, currentIndex) + 1).padStart(2, "0")}</span><i>/</i><span>${String(visibleEntries.length).padStart(2, "0")}</span></footer>`;
    buildReadingPages();
    renderReadingPage();
    const previous = $("#previous-note"), next = $("#next-note");
    previous.disabled = currentIndex <= 0;
    next.disabled = currentIndex < 0 || currentIndex >= visibleEntries.length - 1;
    previous.dataset.note = currentIndex > 0 ? visibleEntries[currentIndex - 1].id : "";
    next.dataset.note = currentIndex >= 0 && currentIndex < visibleEntries.length - 1 ? visibleEntries[currentIndex + 1].id : "";
    workspace.hidden = true;
    reader.hidden = false;
    $("#reader-back").focus();
  }

  function readingBudget() {
    return window.matchMedia("(max-width: 800px)").matches ? 320 : 420;
  }

  function buildReadingPages() {
    const note = state.currentNote;
    if (!note || !readerTools) return;
    state.readingBlocks = readerTools.renderMarkdownBlocks(note.body, {
      resolveImageUrl: source => readerTools.resolveImageUrl(source, { base, topicId: note.topicId }),
    });
    state.readingPages = readerTools.paginateBlocks(state.readingBlocks, readingBudget());
    state.readingPage = Math.min(state.readingPage, Math.max(0, state.readingPages.length - 1));
  }

  function renderReadingPage() {
    const content = $("#reading-content"), controls = $("#body-pagination");
    if (!content || !controls) return;
    const continuous = readingModeSelect.value === "continuous";
    const blocks = continuous ? state.readingBlocks : (state.readingPages[state.readingPage] || []);
    content.innerHTML = `<div class="markdown">${blocks.map(block => block.html).join("")}</div>`;
    controls.hidden = continuous || state.readingPages.length <= 1;
    if (!controls.hidden) {
      const previous = $("#previous-page"), next = $("#next-page");
      previous.disabled = state.readingPage <= 0;
      next.disabled = state.readingPage >= state.readingPages.length - 1;
      $("#page-status").textContent = `正文 ${state.readingPage + 1} / ${state.readingPages.length}`;
      previous.onclick = () => changeReadingPage(-1);
      next.onclick = () => changeReadingPage(1);
    }
  }

  function changeReadingPage(offset) {
    const next = Math.max(0, Math.min(state.readingPages.length - 1, state.readingPage + offset));
    if (next === state.readingPage) return;
    state.readingPage = next;
    renderReadingPage();
    paper.scrollIntoView({ block: "start", behavior: "auto" });
  }

  function openTopicForm(topicId = "") {
    const form = $("#topic-form"), topic = state.topics.find(item => item.id === topicId) || null;
    form.reset(); formError(form);
    form.elements.topicId.value = topic?.id || "";
    form.elements.name.value = topic?.name || "";
    form.elements.description.value = topic?.description || "";
    form.elements.coverPath.value = topic?.coverPath === "preset:forest" ? "" : topic?.coverPath || "";
    form.elements.isDefault.checked = Boolean(topic?.isDefault);
    form.elements.sealed.checked = topic?.visibility === "sealed";
    form.elements.archived.checked = Boolean(topic?.isArchived);
    form.querySelector("h2").textContent = topic ? "管理主题笔记" : "新建一本主题笔记";
    form.elements.save.textContent = topic ? "保存主题设置" : "创建";
    form.querySelector(".edit-only").hidden = !topic;
    topicDialog.showModal();
    form.elements.name.focus();
  }
  $("#new-topic").onclick = () => openTopicForm();
  $("#new-note").onclick = () => {
    const form = $("#note-form");
    form.reset(); formError(form); resetImageAttachment();
    form.querySelector("h2").textContent = "写一页";
    form.elements.save.textContent = "保存 Markdown";
    form.elements.topicId.value = state.currentTopic.id;
    form.elements.noteId.value = "";
    form.elements.expectedRevision.value = "";
    noteDialog.showModal();
  };
  $("#edit-note").onclick = () => {
    const note = state.currentNote;
    if (!note || note.visibility === "sealed") return;
    const form = $("#note-form");
    form.reset(); formError(form); resetImageAttachment();
    form.querySelector("h2").textContent = "编辑这一页";
    form.elements.save.textContent = "保存修改";
    form.elements.topicId.value = note.topicId;
    form.elements.noteId.value = note.id;
    form.elements.expectedRevision.value = String(note.revision);
    form.elements.title.value = note.title;
    form.elements.tags.value = note.tags.join("，");
    form.elements.body.value = note.body;
    form.elements.sealed.checked = false;
    noteDialog.showModal();
  };
  $("#upload-note-image").addEventListener("click", async event => {
    const button = event.currentTarget;
    const form = $("#note-form");
    const file = $("#note-image").files[0];
    const status = $("#image-upload-status");
    status.dataset.kind = "";
    if (!file) {
      status.textContent = "请先选择一张图片。";
      status.dataset.kind = "error";
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      status.textContent = "这张图片超过 20 MB，请压缩后再试。";
      status.dataset.kind = "error";
      return;
    }
    const topicId = form.elements.topicId.value;
    if (!topicId) {
      status.textContent = "还没有确定图片所属主题，请重新打开这一页。";
      status.dataset.kind = "error";
      return;
    }
    button.disabled = true;
    status.textContent = "正在把图片放入当前主题……";
    try {
      const response = await fetch(`${base}/assets/${encodeURIComponent(topicId)}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-alt-text": encodeURIComponent($("#note-image-alt").value.trim() || "笔记图片"),
        },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "图片上传失败");
      insertAtCursor(form.elements.body, result.markdown);
      $("#note-image").value = "";
      status.textContent = result.deduplicated ? "这张图片已在主题中，已插入正文。" : "图片已放入当前主题，并插入正文；保存笔记后显示。";
    } catch (error) {
      status.textContent = error.message;
      status.dataset.kind = "error";
    } finally {
      button.disabled = false;
    }
  });
  document.querySelectorAll("[data-close-dialog]").forEach(button => {
    button.addEventListener("click", () => { const dialog = button.closest("dialog"); if (dialog) { formError(dialog.querySelector("form")); dialog.close(); } });
  });
  function showLibrary() {
    workspace.hidden = true; reader.hidden = true; shelfStage.hidden = false; libraryHeading.hidden = false; toolbar.hidden = false; notice.hidden = false; state.currentTopic = null; state.currentNote = null;
    $("#new-topic").focus();
  }
  $("#back").onclick = showLibrary;
  $("#reader-back").onclick = () => { reader.hidden = true; workspace.hidden = false; };
  $("#reader-index").onclick = () => { reader.hidden = true; workspace.hidden = false; };
  $("#previous-note").onclick = event => event.currentTarget.dataset.note && readNote(event.currentTarget.dataset.note);
  $("#next-note").onclick = event => event.currentTarget.dataset.note && readNote(event.currentTarget.dataset.note);
  let previousReadingBudget = readingBudget();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nextBudget = readingBudget();
      if (!state.currentNote || nextBudget === previousReadingBudget) return;
      previousReadingBudget = nextBudget;
      state.readingPage = 0;
      buildReadingPages();
      renderReadingPage();
    }, 120);
  });

  $("#topic-form").addEventListener("submit", async event => {
    event.preventDefault();
    const target = event.currentTarget, form = new FormData(target), topicId = String(form.get("topicId") || "");
    formError(target);
    try {
      await api.api(topicId ? `${base}/topics/${encodeURIComponent(topicId)}` : `${base}/topics`, { method: topicId ? "PATCH" : "POST", body: JSON.stringify({ name: form.get("name"), description: form.get("description"), coverPath: form.get("coverPath"), isDefault: Boolean(form.get("isDefault")), visibility: form.get("sealed") ? "sealed" : "visible", ...(topicId ? { archived: Boolean(form.get("archived")) } : {}) }) });
      topicDialog.close(); await loadStatus(); message(topicId ? "主题设置已保存" : "主题已创建");
    } catch (error) { formError(target, error.message); }
  });

  $("#note-form").addEventListener("submit", async event => {
    event.preventDefault();
    const target = event.currentTarget, form = new FormData(target), topicId = form.get("topicId"), noteId = String(form.get("noteId") || "");
    formError(target);
    try {
      const payload = { topicId, title: form.get("title"), body: form.get("body"), tags: String(form.get("tags") || "").split(/[，,]/).map(value => value.trim()).filter(Boolean), visibility: form.get("sealed") ? "sealed" : "visible" };
      if (noteId) payload.expectedRevision = Number(form.get("expectedRevision"));
      const saved = await api.api(noteId ? `${base}/entries/${encodeURIComponent(noteId)}` : `${base}/entries`, { method: noteId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      noteDialog.close(); await loadStatus(); await openTopic(topicId);
      if (saved.visibility === "visible") await readNote(saved.id);
    } catch (error) { formError(target, error.message); }
  });

  async function unsealNote(noteId) {
    try {
      const saved = await api.api(`${base}/entries/${encodeURIComponent(noteId)}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: "visible" }) });
      await loadStatus(); await openTopic(saved.topicId); message(`《${saved.title}》已解除封存`);
    } catch (error) { message(error.message, "error"); }
  }

  $("#search-form").addEventListener("submit", async event => {
    event.preventDefault();
    const query = $("#search").value.trim(), topicId = $("#search-topic").value, tags = $("#search-tags").value.trim();
    if (!query && !tags) return loadStatus();
    try {
      const params = new URLSearchParams({ q: query, tags });
      if (topicId) params.set("topicId", topicId);
      const data = await api.api(`${base}/search?${params}`);
      state.currentTopic = null;
      state.currentEntries = data.matches || [];
      const description = [query && `“${query}”`, tags && `标签 ${tags}`, topicId && "当前主题"].filter(Boolean).join(" · ");
      $("#topic-kicker").textContent = `${data.matchCount} 条匹配 · 跨主题目录`;
      $("#topic-title").textContent = "检索目录";
      $("#topic-description").textContent = `${description || "全部主题"} · 找到 ${data.matchCount} 篇`;
      workspace.dataset.stamp = `SEARCH · ${data.matchCount}`;
      $("#new-note").hidden = true;
      renderDirectory(state.currentEntries, { includeTopic: true });
      shelfStage.hidden = true; libraryHeading.hidden = true; toolbar.hidden = true; notice.hidden = true; reader.hidden = true; workspace.hidden = false;
      $("#back").focus();
    } catch (error) { message(error.message, "error"); }
  });

  loadStatus().catch(error => message(error.message, "error"));
})();
