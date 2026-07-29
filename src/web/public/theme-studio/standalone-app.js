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
  const MODULE_THEME_BRIDGE_KEY = "stone-memory-developer-semantic-theme-v1";
  const MAX_FILE_SIZE = 320 * 1024;
  const MAX_LOGO_FILE_SIZE = 200 * 1024;
  const LOGO_TYPES = new Set(["image/png", "image/webp"]);
  const CONTRACT_URL = "./contract.json?v=3";
  const state = { contract: null, theme: null, customThemes: [] };
  const COMMUNITY_THEMES = {
    garden: {
      name: "苔粉花园",
      description: "小绒太尉贡献的柔和苔粉花园主题。",
      contributor: "@小绒太尉",
      colors: {
        canvas: "#f5f0eb", ink: "#3d3d3d", inkSoft: "#78769c", inkFaint: "#8d8799",
        accent: "#db9ed3", accentStrong: "#a965a0", accentSoft: "rgba(237, 204, 224, 0.34)",
        surface: "#fdfaf6", surfaceSoft: "rgba(253, 250, 246, 0.72)",
        line: "rgba(219, 158, 211, 0.30)", lineSoft: "rgba(219, 158, 211, 0.18)",
        status: "#91b078", danger: "#a7564f", warning: "#9a6b43", info: "#6d76a8",
        conflict: "#a7564f", fusion: "#8a619f",
      },
      shadows: {
        card: "0 16px 42px rgba(153, 95, 143, 0.10)",
        panel: "0 20px 54px rgba(153, 95, 143, 0.14)",
        floating: "0 24px 64px rgba(112, 76, 105, 0.18)",
        button: "0 12px 28px rgba(181, 111, 169, 0.22)",
      },
    },
    purpleGray: {
      name: "紫灰仪表盘",
      description: "小绒太尉贡献的细腻紫灰仪表盘主题。",
      contributor: "@小绒太尉",
      colors: {
        canvas: "#f4f3f7", ink: "#1a1922", inkSoft: "#6d6a7c", inkFaint: "#8d8998",
        accent: "#6e4f9a", accentStrong: "#523c78", accentSoft: "rgba(110, 79, 154, 0.10)",
        surface: "rgba(255, 255, 255, 0.94)", surfaceSoft: "#f8f7fb",
        line: "rgba(26, 25, 34, 0.10)", lineSoft: "rgba(26, 25, 34, 0.06)",
        status: "#8265b3", danger: "#a7564f", warning: "#9a6b43", info: "#6574a8",
        conflict: "#a65d56", fusion: "#6e4f9a",
      },
      shadows: {
        card: "0 16px 42px rgba(82, 60, 120, 0.10)",
        panel: "0 20px 54px rgba(82, 60, 120, 0.14)",
        floating: "0 24px 64px rgba(54, 42, 76, 0.18)",
        button: "0 12px 28px rgba(82, 60, 120, 0.22)",
      },
    },
  };
  const COMMUNITY_LOGO = {
    name: "花体藤蔓 Stone Memory",
    type: "image/png",
    size: 143049,
    width: 1079,
    height: 507,
    dataUrl: "",
    builtinUrl: "/stone-memory-logo.png",
    contributor: "@小绒太尉",
  };

  const FIELD_GROUPS = [
    { key: "text", title: "文字", description: "正文、标题与辅助信息", paths: ["tokens.colors.ink", "tokens.colors.inkSoft", "tokens.colors.inkFaint"] },
    { key: "background", title: "背景", description: "页面、卡片与柔和表面", paths: ["tokens.colors.canvas", "tokens.colors.surface", "tokens.colors.surfaceSoft", "tokens.colors.accentSoft"] },
    { key: "interface", title: "界面色", description: "强调、主要操作与边框", paths: ["tokens.colors.accent", "tokens.colors.accentStrong", "tokens.colors.line", "tokens.colors.lineSoft"] },
    { key: "semantic", title: "状态色", description: "正常、危险、警告、信息、冲突与融合", paths: ["tokens.colors.status", "tokens.colors.danger", "tokens.colors.warning", "tokens.colors.info", "tokens.colors.conflict", "tokens.colors.fusion"] },
    { key: "radius", title: "圆角", description: "控件、卡片与大面板轮廓", paths: ["tokens.radii.small", "tokens.radii.medium", "tokens.radii.large"] },
    { key: "shadow", title: "阴影", description: "卡片与浮层的空间层级", paths: ["tokens.shadows.card", "tokens.shadows.panel"] },
  ];

  const colorLabels = {
    canvas: "页面背景", surface: "卡片背景", surfaceSoft: "柔和表面",
    ink: "主要文字", inkSoft: "次级文字", inkFaint: "弱化文字",
    accent: "强调色", accentStrong: "主要操作色", accentSoft: "浅色选中态",
    line: "边框", lineSoft: "弱边框", status: "正常状态", danger: "危险操作",
    warning: "警告提示", info: "信息提示", conflict: "冲突标记", fusion: "融合操作",
  };
  const colorCssNames = {
    canvas: "canvas", canvasWarm: "canvas-warm", ink: "ink", inkSoft: "ink-soft",
    inkFaint: "ink-faint", accent: "accent", accentStrong: "accent-strong",
    accentSoft: "accent-soft", surface: "surface", surfaceSoft: "surface-soft",
    line: "line", lineSoft: "line-soft", status: "status", danger: "danger",
    warning: "warning", info: "info", conflict: "conflict", fusion: "fusion",
  };
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
    if (kind === "duration" && !/^\d+(?:\.\d+)?ms$/.test(clean)) throw new Error(`${label}必须使用 ms`);
    if (kind === "easing" && !/^(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\(\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*\))$/.test(clean)) {
      throw new Error(`${label}不是支持的缓动曲线`);
    }
    return clean;
  }

  function tokenKind(group, name) {
    if (group === "colors") return "color";
    if (group === "radii" || group === "spacing") return "dimension";
    if (group === "shadows") return "shadow";
    if (group === "motion") return name === "easing" ? "easing" : "duration";
    return "text";
  }

  function normalizeLogoAsset(input) {
    if (input == null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("主题 Logo 必须是对象");
    const type = String(input.type || "");
    const size = Number(input.size);
    const width = Number(input.width);
    const height = Number(input.height);
    const dataUrl = String(input.dataUrl || "");
    const builtinUrl = String(input.builtinUrl || "");
    if (!LOGO_TYPES.has(type)) throw new Error("主题 Logo 只支持 PNG 或 WebP");
    if (!Number.isInteger(size) || size < 1 || size > MAX_LOGO_FILE_SIZE) throw new Error("主题 Logo 不能超过 200KB");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1600 || height < 160 || height > 1000) {
      throw new Error("主题 Logo 尺寸应为宽 320–1600px、高 160–1000px");
    }
    if (builtinUrl && builtinUrl !== "/stone-memory-logo.png") throw new Error("主题 Logo 内置路径不合法");
    if (!builtinUrl && (!dataUrl.startsWith(`data:${type};base64,`) || dataUrl.length > 280000)) throw new Error("主题 Logo 数据格式不合法");
    return {
      name: String(input.name || "theme-logo").slice(0, 120),
      type,
      size,
      width,
      height,
      dataUrl: builtinUrl ? "" : dataUrl,
      builtinUrl,
      contributor: String(input.contributor || "").slice(0, 60),
    };
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
    const properties = {};
    for (const [group, values] of Object.entries(state.theme.tokens)) {
      if (group === "typography") continue;
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== "string") continue;
        const suffix = tokenCssSuffix(group, name);
        if (!suffix) continue;
        const property = `${prefix}${suffix}`;
        document.documentElement.style.setProperty(property, value);
        properties[property] = value;
      }
    }
    try {
      sessionStorage.setItem(MODULE_THEME_BRIDGE_KEY, JSON.stringify({
        version: 1,
        name: String(state.theme.name || "Custom").slice(0, 60),
        properties,
      }));
    } catch {}
    applyLogo();
  }

  function applyLogo() {
    const logo = state.theme.assets?.logo;
    const source = logo?.builtinUrl || logo?.dataUrl;
    const preview = $("#theme-logo-preview");
    if (preview) {
      preview.classList.toggle("empty", !source);
      preview.innerHTML = source ? `<img src="${escapeHtml(source)}" alt="当前主题 Logo 预览">` : "<span>使用磐石原版石头小花</span>";
    }
  }

  function normalize(input) {
    const defaults = state.contract.defaults;
    const inputVersion = Number(input?.version || 1);
    if (![1, 2, 3].includes(inputVersion)) throw new Error(`不支持 version: ${inputVersion} 的主题文件`);
    const theme = merge(defaults, input);
    theme.$schema = state.contract.$schema;
    theme.version = state.contract.version;
    theme.name = String(theme.name || defaults.name).trim().slice(0, 60);
    delete theme.description;
    theme.assets = { logo: normalizeLogoAsset(theme.assets?.logo) };
    const safeTokens = {};
    for (const [group, defaultValues] of Object.entries(defaults.tokens)) {
      safeTokens[group] = {};
      for (const [name, fallback] of Object.entries(defaultValues)) {
        const value = group === "typography" ? fallback : theme.tokens?.[group]?.[name] ?? fallback;
        safeTokens[group][name] = validateValue(tokenKind(group, name), `${group}.${name}`, value);
      }
    }
    theme.tokens = safeTokens;
    return theme;
  }

  function imageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("无法读取图片尺寸"));
      image.src = dataUrl;
    });
  }

  function fileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("无法读取图片文件"));
      reader.readAsDataURL(file);
    });
  }

  async function chooseLogo(file) {
    if (!file) return;
    logoStatus("");
    try {
      if (!LOGO_TYPES.has(file.type)) throw new Error("请选择 PNG 或 WebP 图片");
      if (file.size > MAX_LOGO_FILE_SIZE) throw new Error("图片不能超过 200KB");
      const dataUrl = await fileDataUrl(file);
      const { width, height } = await imageDimensions(dataUrl);
      state.theme.assets = {
        logo: normalizeLogoAsset({ name: file.name, type: file.type, size: file.size, width, height, dataUrl }),
      };
      applyLogo();
      renderLogoMeta();
      logoStatus("");
      status("Logo 正在预览，保存主题后正式保留");
    } catch (error) {
      logoStatus(`Logo 上传失败：${error.message}`, true);
      status("");
    }
  }

  function renderLogoMeta() {
    const logo = state.theme.assets?.logo;
    const meta = $("#theme-logo-meta");
    const remove = $("#remove-theme-logo");
    if (meta) meta.textContent = logo ? `${logo.width}×${logo.height} · ${(logo.size / 1024).toFixed(1)}KB${logo.contributor ? ` · 贡献人：${logo.contributor}` : ""}` : "推荐透明背景；参考规格 1079×507、约 140KB";
    if (remove) {
      remove.hidden = false;
      remove.disabled = !logo;
    }
    applyLogo();
  }

  function chooseCommunityTheme(key) {
    const preset = COMMUNITY_THEMES[key];
    if (!preset) return;
    state.theme = normalize(merge(state.contract.defaults, {
      name: preset.name,
      description: preset.description,
      tokens: { colors: preset.colors, shadows: preset.shadows },
    }));
    applyTheme();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
    renderFields();
    status(`已切换到“${preset.name}” · 贡献人：${preset.contributor}`);
  }

  function chooseCommunityLogo() {
    state.theme.assets = { logo: normalizeLogoAsset(COMMUNITY_LOGO) };
    renderLogoMeta();
    logoStatus("");
    status("已选用花体藤蔓 Logo · 贡献人：@小绒太尉；保存主题后正式保留");
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

  function logoStatus(message, error = false) {
    const target = $("#theme-logo-status");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", error);
  }

  function renderField(definition) {
    const value = get(state.theme, definition.path);
    const displayValue = definition.kind === "color" ? colorToHex(value).toLowerCase() : value;
    const inputId = `theme-${definition.path.replaceAll(".", "-")}`;
    const colorPicker = definition.kind === "color" ? `<input class="theme-color-picker" type="color" data-color-path="${escapeHtml(definition.path)}" value="${displayValue}" aria-label="打开${escapeHtml(definition.label)}色盘" title="点击打开色盘">` : "";
    return `<div class="theme-field ${definition.kind === "color" ? "is-color" : ""}"><label for="${inputId}">${escapeHtml(definition.label)}</label><div class="theme-control">${colorPicker}<input id="${inputId}" class="theme-value-input" data-path="${escapeHtml(definition.path)}" value="${escapeHtml(displayValue)}" spellcheck="false" aria-label="${escapeHtml(definition.label)}代码"></div></div>`;
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
    target.innerHTML = builtIns.map(paletteCard).join("") + state.customThemes.map((item, index) => paletteCard({ id: item.name, label: item.theme.name, theme: item.theme, customIndex: index })).join("") + `<button class="theme-swatch theme-swatch-add" id="add-theme" type="button" title="添加自定义主题"><span class="theme-swatch-color theme-swatch-add-color"><i>+</i></span><span class="theme-swatch-name">添加主题</span></button><button class="theme-swatch theme-swatch-more" id="more-themes" type="button" title="浏览社区主题"><span class="theme-swatch-color theme-swatch-add-color"><i class="theme-more-dots" aria-hidden="true"><b></b><b></b><b></b></i></span><span class="theme-swatch-name">更多主题</span></button>`;
  }
  function renderFields() {
    const definitions = fieldDefinitions();
    $("#theme-fields").innerHTML = FIELD_GROUPS.map(group => {
      const groupFields = group.paths.map(path => definitions.find(definition => definition.path === path)).filter(Boolean);
      return `<section class="token-group token-group-${group.key}"><header class="token-group-head"><h3>${group.title}</h3><p>${group.description}</p></header><div class="token-group-fields">${groupFields.map(renderField).join("")}</div></section>`;
    }).join("");
    $("#theme-name").value = state.theme.name;
    const activePreset = activePresetName();
    document.querySelectorAll("[data-preset]").forEach(button => button.classList.toggle("active", button.dataset.preset === activePreset));
    renderThemePalette();
    renderLogoMeta();
  }

  function createUtilityGroup(title, description, className) {
    const section = document.createElement("section");
    section.className = `token-group token-group-utility ${className}`;
    section.setAttribute("aria-label", title);
    section.innerHTML = `<header class="token-group-head"><h3>${title}</h3><p>${description}</p></header><div class="theme-group-body"></div>`;
    return { section, body: section.querySelector(".theme-group-body") };
  }

  function promoteUtilityGroups() {
    const card = $(".theme-card");
    const topbar = $(".theme-topbar");
    const originalTokenStack = $("#theme-fields");
    if (!card || !topbar || !originalTokenStack) return;

    const themeGroup = createUtilityGroup("主题", "命名、保存、导入与切换主题", "token-group-theme");
    const logoGroup = createUtilityGroup("品牌图标", $("#theme-logo-meta")?.textContent || "上传、替换或恢复品牌图片", "token-group-logo");
    const logoMeta = logoGroup.section.querySelector(".token-group-head p");
    logoMeta.id = "theme-logo-meta";

    const paletteLabel = $(".theme-palette-row .theme-palette-label");
    if (paletteLabel) paletteLabel.textContent = "可用主题";
    $("#save-theme").textContent = "保存主题";
    $("#reset-theme").textContent = "恢复原版";
    $("#export-theme").textContent = "导出当前主题";
    $(".advanced-copy").innerHTML = `<p>导出的 JSON 使用 version 3 精简契约，只保留主题名称、品牌资源与当前令牌，不再输出旧版简介字段。</p><p>已有 version 1 和 version 2 主题仍可导入，会自动补齐缺少字段并迁移为 version 3；未知字段不会写入 CSS。</p><p>Logo 随主题 JSON 一同导出；支持 PNG/WebP，最大 200KB，宽 320–1600px、高 160–1000px。</p>`;
    $("#save-theme").after($("#reset-theme"));
    themeGroup.body.append($(".theme-name-row"), $(".theme-palette-row"), $("#community-theme-panel"), $("#theme-status"));
    logoGroup.body.append($(".theme-logo-controls"), $("#community-logo-panel"));

    const tokenFields = document.createElement("div");
    tokenFields.id = "theme-fields";
    tokenFields.className = "theme-token-groups";
    while (originalTokenStack.firstChild) tokenFields.append(originalTokenStack.firstChild);
    originalTokenStack.id = "theme-group-stack";
    originalTokenStack.append(themeGroup.section, logoGroup.section, tokenFields);

    const workbench = document.createElement("section");
    workbench.className = "theme-card theme-workbench-card";
    workbench.append(originalTokenStack, $(".theme-state-preview"), $(".advanced-json"));
    card.classList.add("theme-topbar");
    card.after(workbench);
    $(".theme-actions").remove();
    topbar.remove();
    renderLogoMeta();
  }

  function applyFieldValue(definition, value) {
    set(state.theme, definition.path, value);
    document.documentElement.style.setProperty(definition.css, value);
    const codeInput = document.querySelector(`[data-path="${definition.path}"]`);
    const colorInput = document.querySelector(`[data-color-path="${definition.path}"]`);
    const displayValue = definition.kind === "color" ? colorToHex(value).toLowerCase() : value;
    if (codeInput && codeInput.value !== displayValue) codeInput.value = displayValue;
    if (colorInput) colorInput.value = colorToHex(value).toLowerCase();
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
    state.theme = normalize(state.theme);
    const exportedTheme = {
      $schema: state.contract.$schema,
      version: state.contract.version,
      name: state.theme.name,
      assets: clone(state.theme.assets),
      tokens: clone(state.theme.tokens),
    };
    const blob = new Blob([`${JSON.stringify(exportedTheme, null, 2)}\n`], { type: "application/json" });
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
      if (file.size > MAX_FILE_SIZE) throw new Error("主题文件不能超过 320KB");
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
    const preset = {
      pearl: {
        name: "Pearl Tide",
        description: "来自 Tidal_Echo 默认 Light 外观的清透蓝灰主题。",
        colors: {
          canvas: "#f7fafc", canvasWarm: "#f7fafc", ink: "#253447", inkSoft: "#5e7080", inkFaint: "#8a99a8",
          accent: "#4c6378", accentStrong: "#2c4056", accentSoft: "#eef4fa",
          surface: "rgba(247, 250, 252, 0.92)", surfaceSoft: "rgba(244, 248, 250, 0.42)",
          line: "rgba(120, 142, 165, 0.24)", lineSoft: "rgba(151, 169, 181, 0.18)",
          status: "#5fbf8f", danger: "#cf8d92", warning: "#8a6542", info: "#5f7196",
          conflict: "#a65d56", fusion: "#765a96",
        },
      },
      harbor: {
        name: "Harbor",
        description: "来自 Tidal_Echo Harbor 外观的暖灰港湾主题。",
        colors: {
          canvas: "#f4f2ef", canvasWarm: "#f4f2ef", ink: "#36404b", inkSoft: "#5e6b78", inkFaint: "#9197a0",
          accent: "#4a5d6c", accentStrong: "#4a5d6c", accentSoft: "#efebe8",
          surface: "rgba(244, 242, 239, 0.92)", surfaceSoft: "rgba(234, 230, 228, 0.62)",
          line: "rgba(74, 93, 108, 0.20)", lineSoft: "rgba(151, 169, 181, 0.18)",
          status: "#6fa98c", danger: "#cf8d92", warning: "#8a6542", info: "#5f7196",
          conflict: "#a65d56", fusion: "#765a96",
        },
      },
    }[name];
    if (preset) {
      state.theme = normalize(merge(original, {
        name: preset.name,
        description: preset.description,
        tokens: {
          colors: preset.colors,
          radii: { extraSmall: "9px", small: "12px", medium: "18px", large: "20px", pill: "999px" },
          shadows: {
            card: "0 10px 28px rgba(70, 92, 108, 0.05)",
            panel: "0 18px 46px rgba(74, 93, 108, 0.10)",
            floating: "0 18px 50px rgba(30, 45, 62, 0.18)",
            button: "0 16px 32px rgba(41, 60, 78, 0.22)",
          },
          motion: { fast: "150ms", normal: "260ms", easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        },
      }));
    }
    applyTheme();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
    renderFields();
    status(`已切换到“${state.theme.name}”`);
  }

  function render() {
    $("#theme-studio-mount").innerHTML = `<section class="theme-card"><div class="theme-card-head"><p class="eyebrow">THEME STRUCTURE</p><h2>按视觉职责调整</h2><p class="theme-card-intro">每一排只处理一种视觉职责。颜色项可点左侧色块打开色盘，也可以直接输入 HEX、RGB 或 HSL。</p><div class="theme-card-meta"><small class="theme-credit">工作台贡献人：@钦天监秋</small><span class="theme-file-badge">TOKEN v${state.contract.version}</span></div></div><div class="theme-topbar"><div class="theme-name-row"><label class="theme-field theme-name-field"><span>主题名称</span><input id="theme-name" maxlength="60"></label><div class="theme-inline-actions"><button class="primary" id="save-theme" type="button">保存自定义主题</button><button class="secondary" id="export-theme" type="button">导出目前主题</button><label class="secondary theme-inline-upload" for="import-theme">导入主题 JSON</label><input id="import-theme" type="file" accept="application/json,.json" hidden></div></div><div class="theme-palette-row"><span class="theme-palette-label">主题</span><div id="theme-palette" class="theme-palette"></div></div><div id="community-theme-panel" class="community-assets" hidden><button type="button" data-community-theme="garden"><i style="--community-a:#f5f0eb;--community-b:#db9ed3;--community-c:#a965a0"></i><span><strong>苔粉花园</strong><small>贡献人：@小绒太尉</small></span></button><button type="button" data-community-theme="purpleGray"><i style="--community-a:#f4f3f7;--community-b:#6e4f9a;--community-c:#523c78"></i><span><strong>紫灰仪表盘</strong><small>贡献人：@小绒太尉</small></span></button></div><section class="theme-logo-row"><div><span class="theme-palette-label">品牌图标</span><p id="theme-logo-meta">推荐透明背景；参考规格 1079×507、约 140KB</p></div><div class="theme-logo-controls"><div id="theme-logo-preview" class="theme-logo-preview empty"><span>使用磐石原版石头小花</span></div><div class="theme-logo-buttons"><label class="secondary theme-inline-upload" for="import-theme-logo">选择图片</label><input id="import-theme-logo" type="file" accept="image/png,image/webp,.png,.webp" hidden><button class="secondary" id="more-theme-images" type="button">更多图片</button><button class="ghost" id="remove-theme-logo" type="button" hidden>恢复原图</button></div></div></section><div id="community-logo-panel" class="community-assets community-logo-assets" hidden><button type="button" id="use-community-logo"><img src="/stone-memory-logo.png" alt=""><span><strong>花体藤蔓 Stone Memory</strong><small>1079×507 · 139.7KB · 贡献人：@小绒太尉</small></span></button></div><div id="theme-fields" class="theme-groups"></div><section class="theme-state-preview" aria-label="主题状态预览"><div><span class="theme-palette-label">月历强度</span><div class="theme-calendar-preview"><i class="level-0" title="无活动"></i><i class="level-1" title="低活动"></i><i class="level-2" title="中活动"></i><i class="level-3" title="高活动"></i></div></div><div><span class="theme-palette-label">业务状态</span><div class="theme-status-preview"><i class="status">正常</i><i class="warning">警告</i><i class="info">信息</i><i class="conflict">冲突</i><i class="fusion">融合</i><i class="danger">危险</i></div></div></section><details class="advanced-json"><summary><span><strong>高级 JSON 与兼容性</strong><small>完整令牌、版本契约与跨版本适配</small></span><i>⌄</i></summary><div class="advanced-copy"><p>导出的 JSON 使用 version 2 契约，新增正常、警告、信息、冲突与融合等业务状态色。</p><p>已有 version 1 主题会自动补齐缺少字段并迁移为 version 2；未知字段不会写入 CSS。</p><p>Logo 随主题 JSON 一同导出；支持 PNG/WebP，最大 200KB，宽 320–1600px、高 160–1000px。</p></div></details><div class="theme-actions"><button class="ghost" id="reset-theme" type="button">恢复磐石原版</button><span id="theme-status" role="status" aria-live="polite"></span></div></section>`;
    $("#theme-logo-preview").insertAdjacentHTML("afterend", `<small id="theme-logo-status" class="theme-logo-status" role="status" aria-live="polite"></small>`);
    $(".theme-calendar-preview").insertAdjacentHTML("beforebegin", `<small class="theme-preview-hint">活动强度复用“界面色 → 强调色”，按 18% / 44% / 100% 逐级加深。</small>`);
    $(".theme-status-preview").insertAdjacentHTML("beforebegin", `<small class="theme-preview-hint">分别跟随“状态色”中的正常、警告、信息、冲突、融合与危险颜色。</small>`);
    renderFields();
    promoteUtilityGroups();
  }

  async function init() {
    try {
      state.contract = await fetch(CONTRACT_URL).then(response => { if (!response.ok) throw new Error(`主题契约加载失败 (${response.status})`); return response.json(); });
      state.customThemes = readCustomThemes();
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsedSaved = saved ? JSON.parse(saved) : state.contract.defaults;
      state.theme = normalize(parsedSaved);
      if (saved && Number(parsedSaved.version || 1) !== state.contract.version) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
      }
      if (state.customThemes.length) writeCustomThemes();
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
          status("已创建新的主题草稿，修改颜色后点击保存主题");
          return;
        }
        const moreThemesButton = event.target.closest("#more-themes");
        if (moreThemesButton) {
          const panel = $("#community-theme-panel");
          panel.hidden = !panel.hidden;
          return;
        }
        const communityThemeButton = event.target.closest("[data-community-theme]");
        if (communityThemeButton) {
          chooseCommunityTheme(communityThemeButton.dataset.communityTheme);
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
      $("#import-theme-logo").onchange = event => { chooseLogo(event.target.files?.[0]); event.target.value = ""; };
      $("#more-theme-images").onclick = () => {
        const panel = $("#community-logo-panel");
        panel.hidden = !panel.hidden;
      };
      $("#use-community-logo").onclick = chooseCommunityLogo;
      $("#remove-theme-logo").onclick = () => {
        state.theme.assets = { logo: null };
        renderLogoMeta();
        logoStatus("");
        status("已恢复原版石头小花，保存主题后正式保留");
      };

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
