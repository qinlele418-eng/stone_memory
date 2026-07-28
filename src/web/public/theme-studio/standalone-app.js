(() => {
  "use strict";

  const smartBackLink = document.querySelector("[data-smart-back]");
  smartBackLink?.addEventListener("click", event => {
    try {
      const previousUrl = new URL(document.referrer);
      if (previousUrl.origin !== window.location.origin || previousUrl.href === window.location.href) return;
      event.preventDefault();
      window.history.back();
    } catch {}
  });

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const CUSTOM_THEMES_KEY = "stone-memory-ui-themes-v1";
  const MAX_FILE_SIZE = 32 * 1024;
  const CONTRACT_URL = "./contract.json";
  const state = { contract: null, theme: null, customThemes: [] };

  const FIELD_GROUPS = [
    { key: "text", order: "01", title: "文字", description: "正文、标题与辅助信息", paths: ["tokens.colors.ink", "tokens.colors.inkSoft"] },
    { key: "background", order: "02", title: "背景", description: "页面、卡片与浅色选中态", paths: ["tokens.colors.canvas", "tokens.colors.surface", "tokens.colors.accentSoft"] },
    { key: "interface", order: "03", title: "界面色", description: "强调、按钮、边框与危险操作", paths: ["tokens.colors.accent", "tokens.colors.accentStrong", "tokens.colors.line", "tokens.colors.danger"] },
    { key: "radius", order: "04", title: "圆角", description: "控件、卡片与大面板轮廓", paths: ["tokens.radii.small", "tokens.radii.medium", "tokens.radii.large"] },
    { key: "shadow", order: "05", title: "阴影", description: "卡片与浮层的空间层级", paths: ["tokens.shadows.card", "tokens.shadows.panel"] },
  ];

  const colorLabels = { canvas: "页面背景", surface: "卡片背景", ink: "主要文字", inkSoft: "次级文字", accent: "强调色", accentStrong: "主要按钮", accentSoft: "浅色选中态", line: "边框", danger: "危险操作" };
  const colorCssNames = { canvas: "canvas", canvasWarm: "canvas-warm", ink: "ink", inkSoft: "ink-soft", inkFaint: "ink-faint", accent: "accent", accentStrong: "accent-strong", accentSoft: "accent-soft", surface: "surface", surfaceSoft: "surface-soft", line: "line", lineSoft: "line-soft", status: "status", danger: "danger" };
  const radiusLabels = { small: "小控件", medium: "普通卡片", large: "大面板" };
  const radiusCssNames = { extraSmall: "xs", small: "sm", medium: "md", large: "lg", pill: "pill" };
  const shadowLabels = { card: "卡片阴影", panel: "面板阴影" };
  const spacingCssNames = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6" };

  const $ = selector => document.querySelector(selector);
  const clone = value => JSON.parse(JSON.stringify(value));
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);

  function set(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((current, key) => current[key] ??= {}, object);
    target[last] = value;
  }

  function merge(base, override) {
    if (!override || typeof override !== "object" || Array.isArray(override)) return clone(base);
    const result = clone(base);
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") result[key] = merge(result[key], value);
      else result[key] = value;
    }
    return result;
  }

  function cssSupports(property, value) {
    return typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports(property, value);
  }

  function validateValue(kind, label, value) {
    const clean = String(value ?? "").trim();
    if (!clean || clean.length > 180) throw new Error(`${label}格式不合法`);
    if (/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(clean)) throw new Error(`${label}包含不允许的内容`);
    if (kind === "color" && !cssSupports("color", clean)) throw new Error(`${label}不是合法颜色`);
    if (kind === "dimension" && !/^\d+(?:\.\d+)?(px|rem)$/.test(clean)) throw new Error(`${label}必须使用 px 或 rem`);
    if (kind === "shadow" && clean !== "none" && !cssSupports("box-shadow", clean)) throw new Error(`${label}不是合法阴影`);
    return clean;
  }

  function fieldDefinitions() {
    const editable = state.contract.editable;
    const definitions = [];
    const prefix = state.contract.coreTokenPrefix || "--stone-tide-";
    for (const name of editable.colors) definitions.push({ name, path: `tokens.colors.${name}`, css: `${prefix}${colorCssNames[name] || name}`, kind: "color", label: colorLabels[name] || name });
    for (const name of editable.radii) definitions.push({ name, path: `tokens.radii.${name}`, css: `${prefix}radius-${radiusCssNames[name] || name}`, kind: "dimension", label: radiusLabels[name] || name });
    for (const name of editable.shadows) definitions.push({ name, path: `tokens.shadows.${name}`, css: `${prefix}shadow-${name}`, kind: "shadow", label: shadowLabels[name] || name });
    return definitions;
  }

  function colorToHex(value) {
    const clean = String(value || "").trim();
    const fullHex = clean.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
    if (fullHex) return `#${fullHex[1]}`;
    const shortHex = clean.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (shortHex) return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`;
    const rgb = clean.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
    if (rgb) return `#${rgb.slice(1, 4).map(channel => Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, "0")).join("")}`;
    return "#397052";
  }

  function tokenCssSuffix(group, name) {
    if (group === "colors") return colorCssNames[name] || name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    if (group === "radii") return `radius-${radiusCssNames[name] || name}`;
    if (group === "shadows") return `shadow-${name}`;
    if (group === "spacing") return `space-${spacingCssNames[name] || name}`;
    if (group === "typography") return `font-${name}`;
    if (group === "motion") return name === "easing" ? "ease-soft" : `motion-${name}`;
    return null;
  }

  function applyTheme() {
    const prefix = state.contract.coreTokenPrefix || "--stone-tide-";
    for (const [group, values] of Object.entries(state.theme.tokens)) {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== "string") continue;
        const suffix = tokenCssSuffix(group, name);
        if (suffix) document.documentElement.style.setProperty(`${prefix}${suffix}`, value);
      }
    }
  }

  function normalize(input) {
    const defaults = state.contract.defaults;
    const theme = merge(defaults, input);
    theme.$schema = state.contract.$schema;
    theme.version = state.contract.version;
    theme.name = String(theme.name || defaults.name).trim().slice(0, 60);
    theme.description = String(theme.description || "").trim().slice(0, 240);
    for (const definition of fieldDefinitions()) set(theme, definition.path, validateValue(definition.kind, definition.label, get(theme, definition.path)));
    return theme;
  }

  function readCustomThemes() {
    try {
      const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.map(item => ({ name: String(item?.name || item?.theme?.name || "未命名主题"), theme: normalize(item?.theme || item) })).filter(item => item.theme?.name) : [];
    } catch {
      return [];
    }
  }

  function writeCustomThemes() {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(state.customThemes));
  }

  function status(message, error = false) {
    const target = $("#theme-status");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", error);
  }

  function renderField(definition) {
    const value = get(state.theme, definition.path);
    const inputId = `theme-${definition.path.replaceAll(".", "-")}`;
    const colorPicker = definition.kind === "color" ? `<input class="theme-color-picker" type="color" data-color-path="${escapeHtml(definition.path)}" value="${colorToHex(value)}" aria-label="打开${escapeHtml(definition.label)}色盘" title="点击打开色盘">` : "";
    return `<div class="theme-field ${definition.kind === "color" ? "is-color" : ""}"><label for="${inputId}">${escapeHtml(definition.label)}</label><div class="theme-control">${colorPicker}<input id="${inputId}" class="theme-value-input" data-path="${escapeHtml(definition.path)}" value="${escapeHtml(value)}" spellcheck="false" aria-label="${escapeHtml(definition.label)}代码"></div></div>`;
  }

  function activePresetName() {
    if (state.theme.name === state.contract.defaults.name) return "original";
    if (state.theme.name === "Pearl Tide") return "pearl";
    if (state.theme.name === "Harbor") return "harbor";
    return "";
  }

  function paletteCard({ id, label, theme, customIndex = null }) {
    const colors = theme.tokens.colors;
    const active = customIndex === null ? activePresetName() === id : activePresetName() === "" && state.theme.name === theme.name;
    const swatch = `<span class="theme-swatch-color" style="--swatch-canvas:${escapeHtml(colors.canvas)};--swatch-accent:${escapeHtml(colors.accent)};--swatch-ink:${escapeHtml(colors.ink)}"><i></i><b></b></span>`;
    if (customIndex === null) return `<button class="theme-swatch ${active ? "active" : ""}" type="button" data-preset="${escapeHtml(id)}" title="使用 ${escapeHtml(label)}">${swatch}<span class="theme-swatch-name">${escapeHtml(label)}</span></button>`;
    return `<span class="theme-swatch-item"><button class="theme-swatch ${active ? "active" : ""}" type="button" data-custom-theme-index="${customIndex}" title="载入 ${escapeHtml(label)}">${swatch}<span class="theme-swatch-name">${escapeHtml(label)}</span></button><button class="theme-swatch-delete" type="button" data-delete-custom-theme-index="${customIndex}" aria-label="删除 ${escapeHtml(label)}">×</button></span>`;
  }

  function renderThemePalette() {
    const target = $("#theme-palette");
    if (!target) return;
    const builtIns = [
      { id: "original", label: "磐石原版", theme: state.contract.defaults },
      { id: "pearl", label: "Pearl Tide", theme: merge(state.contract.defaults, { tokens: { colors: { canvas: "#f7fafc", ink: "#253447", accent: "#4c6378" } } }) },
      { id: "harbor", label: "Harbor", theme: merge(state.contract.defaults, { tokens: { colors: { canvas: "#f4f2ef", ink: "#36404b", accent: "#4a5d6c" } } }) }
    ];
    target.innerHTML = builtIns.map(paletteCard).join("") + state.customThemes.map((item, index) => paletteCard({ id: item.name, label: item.theme.name, theme: item.theme, customIndex: index })).join("") + `<button class="theme-swatch theme-swatch-add" id="add-theme" type="button" title="添加自定义主题"><span class="theme-swatch-color theme-swatch-add-color"><i>+</i></span><span class="theme-swatch-name">添加主题</span></button>`;
  }
  function renderFields() {
    const definitions = fieldDefinitions();
    $("#theme-fields").innerHTML = FIELD_GROUPS.map(group => {
      const groupFields = group.paths.map(path => definitions.find(definition => definition.path === path)).filter(Boolean);
      return `<section class="token-group token-group-${group.key}"><header class="token-group-head"><span>${group.order}</span><div><h3>${group.title}</h3><p>${group.description}</p></div></header><div class="token-group-fields" style="--field-count:${groupFields.length}">${groupFields.map(renderField).join("")}</div></section>`;
    }).join("");
    $("#theme-name").value = state.theme.name;
    const activePreset = activePresetName();
    document.querySelectorAll("[data-preset]").forEach(button => button.classList.toggle("active", button.dataset.preset === activePreset));
    renderThemePalette();
  }

  function applyFieldValue(definition, value) {
    set(state.theme, definition.path, value);
    document.documentElement.style.setProperty(definition.css, value);
    const codeInput = document.querySelector(`[data-path="${definition.path}"]`);
    const colorInput = document.querySelector(`[data-color-path="${definition.path}"]`);
    if (codeInput && codeInput.value !== value) codeInput.value = value;
    if (colorInput) colorInput.value = colorToHex(value);
  }

  function save() {
    state.theme = normalize(state.theme);
    const entry = { name: state.theme.name, theme: clone(state.theme) };
    const existingIndex = state.customThemes.findIndex(item => item.name === entry.name);
    if (existingIndex >= 0) state.customThemes.splice(existingIndex, 1, entry);
    else state.customThemes.push(entry);
    writeCustomThemes();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
    renderFields();
    status(`“${state.theme.name}”已保存，已加入主题列表`);
  }

  function exportTheme() {
    const blob = new Blob([`${JSON.stringify(state.theme, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const name = state.theme.name.toLowerCase().replace(/[^\w\u3400-\u9fff-]+/gu, "-").replace(/^-+|-+$/g, "") || "stone-theme";
    link.href = url;
    link.download = `${name}.stone-theme.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    status("主题 JSON 已下载，不包含业务数据");
  }

  async function importTheme(file) {
    if (!file) return;
    try {
      if (!/\.json$/i.test(file.name)) throw new Error("请选择 .json 主题文件");
      if (file.size > MAX_FILE_SIZE) throw new Error("主题文件不能超过 32 KB");
      state.theme = normalize(JSON.parse(await file.text()));
      applyTheme();
      renderFields();
      save();
      status(`已导入并保存“${state.theme.name}”`);
    } catch (error) {
      status(`导入失败：${error.message}`, true);
    }
  }
  function choosePreset(name) {
    const original = state.contract.defaults;
    if (name === "original") state.theme = normalize(original);
    if (name === "pearl") state.theme = normalize(merge(original, { name: "Pearl Tide", description: "来自 Tidal_Echo 默认 Light 外观的清透蓝灰主题。", tokens: { colors: { canvas: "#f7fafc", canvasWarm: "#f7fafc", ink: "#253447", inkSoft: "#5e7080", inkFaint: "#8a99a8", accent: "#4c6378", accentStrong: "#2c4056", accentSoft: "#eef4fa", surface: "rgba(247, 250, 252, 0.92)", surfaceSoft: "rgba(244, 248, 250, 0.42)", line: "rgba(120, 142, 165, 0.24)", lineSoft: "rgba(151, 169, 181, 0.18)", status: "#5fbf8f", danger: "#cf8d92" }, radii: { extraSmall: "9px", small: "12px", medium: "18px", large: "20px", pill: "999px" }, shadows: { card: "0 10px 28px rgba(70, 92, 108, 0.05)", panel: "0 18px 46px rgba(74, 93, 108, 0.10)", floating: "0 18px 50px rgba(30, 45, 62, 0.18)", button: "0 16px 32px rgba(41, 60, 78, 0.22)" }, typography: { display: "\"Cormorant Garamond\", Georgia, serif", body: "\"Noto Serif SC\", \"Songti SC\", \"STSong\", \"SimSun\", serif" }, motion: { fast: "150ms", normal: "260ms", easing: "cubic-bezier(0.22, 1, 0.36, 1)" } } }));
    if (name === "harbor") state.theme = normalize(merge(original, { name: "Harbor", description: "来自 Tidal_Echo Harbor 外观的暖灰港湾主题。", tokens: { colors: { canvas: "#f4f2ef", canvasWarm: "#f4f2ef", ink: "#36404b", inkSoft: "#5e6b78", inkFaint: "#9197a0", accent: "#4a5d6c", accentStrong: "#4a5d6c", accentSoft: "#efebe8", surface: "rgba(244, 242, 239, 0.92)", surfaceSoft: "rgba(234, 230, 228, 0.62)", line: "rgba(74, 93, 108, 0.20)", lineSoft: "rgba(151, 169, 181, 0.18)", status: "#6fa98c", danger: "#cf8d92" }, radii: { extraSmall: "9px", small: "12px", medium: "18px", large: "20px", pill: "999px" }, shadows: { card: "0 10px 28px rgba(70, 92, 108, 0.05)", panel: "0 18px 46px rgba(74, 93, 108, 0.10)", floating: "0 18px 50px rgba(30, 45, 62, 0.18)", button: "0 16px 32px rgba(41, 60, 78, 0.22)" }, typography: { display: "\"Cormorant Garamond\", Georgia, serif", body: "\"Noto Serif SC\", \"Songti SC\", \"STSong\", \"SimSun\", serif" }, motion: { fast: "150ms", normal: "260ms", easing: "cubic-bezier(0.22, 1, 0.36, 1)" } } }));
    applyTheme();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
    renderFields();
    status(`已切换到“${state.theme.name}”`);
  }

  function render() {
    $("#theme-studio-mount").innerHTML = `<section class="theme-card"><div class="theme-card-head"><div><p class="eyebrow">THEME STRUCTURE</p><h2>按视觉职责调整</h2><p>每一排只处理一种视觉职责。颜色项可点左侧色块打开色盘，也可以直接输入 HEX、RGB 或 HSL。</p></div><span class="theme-file-badge">TOKEN v${state.contract.version}</span></div><div class="theme-topbar"><div class="theme-name-row"><label class="theme-field theme-name-field"><span>主题名称</span><input id="theme-name" maxlength="60"></label><div class="theme-inline-actions"><button class="primary" id="save-theme" type="button">保存自定义主题</button><button class="secondary" id="export-theme" type="button">导出目前主题</button><label class="secondary theme-inline-upload" for="import-theme">上传 JSON</label><input id="import-theme" type="file" accept="application/json,.json" hidden></div></div><div class="theme-palette-row"><span class="theme-palette-label">主题</span><div id="theme-palette" class="theme-palette"></div></div><div id="theme-fields" class="theme-groups"></div><details class="advanced-json"><summary><span><strong>高级 JSON 与兼容性</strong><small>完整令牌、版本契约与跨版本适配</small></span><i>⌄</i></summary><div class="advanced-copy"><p>导出的 JSON 使用稳定的 version 1 契约。磐石记忆后续调整页面时，只要继续使用 <code>--stone-tide-*</code> 语义变量，主题文件无需跟着页面选择器修改。</p><p>缺少的新字段会回退到当前契约默认值，未知字段不会写入 CSS。</p></div></details><div class="theme-actions"><button class="ghost" id="reset-theme" type="button">恢复磐石原版</button><span id="theme-status" role="status" aria-live="polite"></span></div></section>`;
    renderFields();
  }

  async function init() {
    try {
      state.contract = await fetch(CONTRACT_URL).then(response => { if (!response.ok) throw new Error(`主题契约加载失败 (${response.status})`); return response.json(); });
      state.customThemes = readCustomThemes();
      const saved = localStorage.getItem(STORAGE_KEY);
      state.theme = normalize(saved ? JSON.parse(saved) : state.contract.defaults);
      applyTheme();
      render();

      document.addEventListener("input", event => {
        const input = event.target;
        if (input.id === "theme-name") { state.theme.name = input.value; return; }
        const definition = fieldDefinitions().find(item => item.path === (input.dataset.colorPath || input.dataset.path));
        if (!definition) return;
        try {
          const value = validateValue(definition.kind, definition.label, input.value);
          applyFieldValue(definition, value);
          input.removeAttribute("aria-invalid");
          status("正在预览，尚未保存");
        } catch (error) {
          input.setAttribute("aria-invalid", "true");
          status(error.message, true);
        }
      });

      document.addEventListener("click", event => {
        const presetButton = event.target.closest("[data-preset]");
        if (presetButton) {
          choosePreset(presetButton.dataset.preset);
          return;
        }
        const addButton = event.target.closest("#add-theme");
        if (addButton) {
          const nextName = `自定义主题 ${state.customThemes.length + 1}`;
          state.theme = normalize(merge(state.theme, { name: nextName }));
          applyTheme();
          renderFields();
          $("#theme-name")?.focus();
          status("已创建新的主题草稿，修改颜色后点击保存自定义主题");
          return;
        }
        const deleteButton = event.target.closest("[data-delete-custom-theme-index]");
        if (deleteButton) {
          const index = Number(deleteButton.dataset.deleteCustomThemeIndex);
          if (!state.customThemes[index]) return;
          state.customThemes.splice(index, 1);
          writeCustomThemes();
          renderThemePalette();
          status("已删除自定义主题");
          return;
        }
        const button = event.target.closest("[data-custom-theme-index]");
        if (!button) return;
        const entry = state.customThemes[Number(button.dataset.customThemeIndex)];
        if (!entry) return;
        state.theme = normalize(entry.theme);
        applyTheme();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
        renderFields();
        status(`已切换到“${state.theme.name}”`);
      });
      $("#save-theme").onclick = save;
      $("#export-theme").onclick = exportTheme;
      $("#reset-theme").onclick = () => { state.theme = normalize(state.contract.defaults); applyTheme(); renderFields(); localStorage.removeItem(STORAGE_KEY); status("已恢复磐石记忆原版主题"); };
      $("#import-theme").onchange = event => { importTheme(event.target.files?.[0]); event.target.value = ""; };

    } catch (error) {
      $("#theme-studio-mount").innerHTML = `<section class="theme-card error-card">主题契约加载失败：${escapeHtml(error.message)}</section>`;
    }
  }

  window.addEventListener("storage", event => {
    if (!state.contract) return;
    if (event.key === CUSTOM_THEMES_KEY) {
      state.customThemes = readCustomThemes();
      renderThemePalette();
      return;
    }
    if (event.key !== STORAGE_KEY) return;
    try {
      state.theme = normalize(event.newValue ? JSON.parse(event.newValue) : state.contract.defaults);
      applyTheme();
      if ($("#theme-fields")) renderFields();
      status(event.newValue ? "已从其他标签同步主题" : "已从其他标签恢复磐石原版");
    } catch (error) {
      status(`同步主题失败：${error.message}`, true);
    }
  });

  init();
})();