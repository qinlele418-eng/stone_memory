(() => {
  "use strict";

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const SCHEMA_ID = "https://stone-memory.local/schemas/ui-theme-v1.json";
  const MAX_FILE_SIZE = 320 * 1024;
  const MAX_LOGO_FILE_SIZE = 200 * 1024;
  const LOGO_TYPES = new Set(["image/png", "image/webp"]);
  const ORIGINAL_THEME_NAME = "Stone Memory Original";
  const MODULE_ID = "theme-studio";
  const MODULE_ORDER = 20;
  const THEME_STYLE_VERSION = "5";
  const THEME_STYLE_FILES = [
    "tidal-tokens.css",
    "theme-coverage.css",
    "theme-workbench.css",
    "developer-theme.css",
    "developer-common.css",
    "developer-radius.css",
  ];

  function loadThemeStyles() {
    for (const file of THEME_STYLE_FILES) {
      if (document.querySelector(`link[data-stone-theme-style="${file}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `/theme-studio/${file}?v=${THEME_STYLE_VERSION}`;
      link.dataset.stoneThemeStyle = file;
      document.head.append(link);
    }
  }

  loadThemeStyles();

  const FIELD_DEFS = [
    { path: "tokens.colors.canvas", css: "--stone-tide-canvas", kind: "color", label: "页面背景" },
    { path: "tokens.colors.ink", css: "--stone-tide-ink", kind: "color", label: "主要文字" },
    { path: "tokens.colors.inkSoft", css: "--stone-tide-ink-soft", kind: "color", label: "次级文字" },
    { path: "tokens.colors.inkFaint", css: "--stone-tide-ink-faint", kind: "color", label: "弱化文字" },
    { path: "tokens.colors.accent", css: "--stone-tide-accent", kind: "color", label: "强调色" },
    { path: "tokens.colors.accentStrong", css: "--stone-tide-accent-strong", kind: "color", label: "主要按钮" },
    { path: "tokens.colors.accentSoft", css: "--stone-tide-accent-soft", kind: "color", label: "浅色选中态" },
    { path: "tokens.colors.surface", css: "--stone-tide-surface", kind: "color", label: "卡片表面" },
    { path: "tokens.colors.surfaceSoft", css: "--stone-tide-surface-soft", kind: "color", label: "柔和表面" },
    { path: "tokens.colors.line", css: "--stone-tide-line", kind: "color", label: "边框" },
    { path: "tokens.colors.lineSoft", css: "--stone-tide-line-soft", kind: "color", label: "弱边框" },
    { path: "tokens.colors.status", css: "--stone-tide-status", kind: "color", label: "正常状态" },
    { path: "tokens.colors.danger", css: "--stone-tide-danger", kind: "color", label: "危险操作" },

    { path: "tokens.radii.extraSmall", css: "--stone-tide-radius-xs", kind: "dimension", label: "小控件" },
    { path: "tokens.radii.small", css: "--stone-tide-radius-sm", kind: "dimension", label: "输入框" },
    { path: "tokens.radii.medium", css: "--stone-tide-radius-md", kind: "dimension", label: "普通卡片" },
    { path: "tokens.radii.large", css: "--stone-tide-radius-lg", kind: "dimension", label: "大面板" },
    { path: "tokens.radii.pill", css: "--stone-tide-radius-pill", kind: "dimension", label: "胶囊按钮" },

    { path: "tokens.shadows.card", css: "--stone-tide-shadow-card", kind: "shadow", label: "卡片阴影" },
    { path: "tokens.shadows.panel", css: "--stone-tide-shadow-panel", kind: "shadow", label: "面板阴影" },
    { path: "tokens.shadows.floating", css: "--stone-tide-shadow-floating", kind: "shadow", label: "浮层阴影" },
    { path: "tokens.shadows.button", css: "--stone-tide-shadow-button", kind: "shadow", label: "按钮阴影" },

    { path: "tokens.spacing.one", css: "--stone-tide-space-1", kind: "dimension", label: "间距 1" },
    { path: "tokens.spacing.two", css: "--stone-tide-space-2", kind: "dimension", label: "间距 2" },
    { path: "tokens.spacing.three", css: "--stone-tide-space-3", kind: "dimension", label: "间距 3" },
    { path: "tokens.spacing.four", css: "--stone-tide-space-4", kind: "dimension", label: "间距 4" },
    { path: "tokens.spacing.five", css: "--stone-tide-space-5", kind: "dimension", label: "间距 5" },
    { path: "tokens.spacing.six", css: "--stone-tide-space-6", kind: "dimension", label: "间距 6" },

    { path: "tokens.motion.fast", css: "--stone-tide-motion-fast", kind: "duration", label: "快速动效" },
    { path: "tokens.motion.normal", css: "--stone-tide-motion-normal", kind: "duration", label: "普通动效" },
    { path: "tokens.motion.easing", css: "--stone-tide-ease-soft", kind: "easing", label: "缓动曲线" },
  ];

  const GROUPS = [
    { key: "colors", title: "配色", hint: "支持 HEX、RGB、RGBA、HSL 和 HSLA。", open: true },
    { key: "radii", title: "圆角", hint: "建议使用 px 或 rem。" },
    { key: "shadows", title: "阴影", hint: "使用合法的 CSS box-shadow 值。" },
    { key: "spacing", title: "间距", hint: "用于统一控制页面节奏。" },
    { key: "motion", title: "动效", hint: "时长使用 ms，缓动支持 cubic-bezier。" },
  ];

  const DEFAULT_THEME = {
    $schema: SCHEMA_ID,
    version: 1,
    name: "Stone Memory Original",
    description: "磐石记忆原版绿色主题。",
    assets: { logo: null },
    tokens: {
      colors: {
        canvas: "#f5f8f1",
        ink: "#18372b",
        inkSoft: "#69756d",
        inkFaint: "#796d5d",
        accent: "#397052",
        accentStrong: "#295540",
        accentSoft: "#eaf2e5",
        surface: "rgba(255, 254, 249, 0.94)",
        surfaceSoft: "#f2f3ef",
        line: "#dce6d7",
        lineSoft: "rgba(220, 230, 215, 0.90)",
        status: "#7ea36f",
        danger: "#a3463e",
      },
      radii: {
        extraSmall: "9px",
        small: "12px",
        medium: "18px",
        large: "28px",
        pill: "999px",
      },
      shadows: {
        card: "0 18px 50px rgba(41, 85, 64, 0.10)",
        panel: "0 18px 50px rgba(41, 85, 64, 0.10)",
        floating: "0 24px 70px rgba(41, 85, 64, 0.16)",
        button: "0 10px 24px rgba(57, 112, 82, 0.24)",
      },
      spacing: {
        one: "6px",
        two: "10px",
        three: "14px",
        four: "18px",
        five: "24px",
        six: "32px",
      },
      typography: {
        display: "Georgia, \"Noto Serif SC\", serif",
        body: "Inter, \"Noto Sans SC\", \"Microsoft YaHei\", system-ui, sans-serif",
      },
      motion: {
        fast: "180ms",
        normal: "200ms",
        easing: "ease",
      },
    },
  };

  const clone = value => JSON.parse(JSON.stringify(value));
  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");

  function getPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
  }

  function setPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((current, key) => current[key] ??= {}, object);
    target[last] = value;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cssSupports(property, value) {
    return typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports(property, value);
  }

  function validateValue(definition, value) {
    if (typeof value !== "string") throw new Error(`${definition.label}必须是字符串`);
    const clean = value.trim();
    if (!clean || clean.length > 180) throw new Error(`${definition.label}长度不合法`);
    if (/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(clean)) throw new Error(`${definition.label}包含不允许的内容`);

    if (definition.kind === "color" && !cssSupports("color", clean)) {
      throw new Error(`${definition.label}不是合法颜色`);
    }
    if (definition.kind === "dimension") {
      const match = clean.match(/^(\d+(?:\.\d+)?)(px|rem)$/);
      if (!match || Number(match[1]) > 999) throw new Error(`${definition.label}必须是 0–999px/rem`);
    }
    if (definition.kind === "shadow" && clean !== "none" && !cssSupports("box-shadow", clean)) {
      throw new Error(`${definition.label}不是合法阴影`);
    }
    if (definition.kind === "font" && !/^[\w\u3400-\u9fff\s"',.-]+$/u.test(clean)) {
      throw new Error(`${definition.label}包含不允许的字体字符`);
    }
    if (definition.kind === "duration") {
      const match = clean.match(/^(\d+(?:\.\d+)?)ms$/);
      if (!match || Number(match[1]) > 2000) throw new Error(`${definition.label}必须是 0–2000ms`);
    }
    if (definition.kind === "easing" && !/^(ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier\(\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*,\s*-?\d*\.?\d+\s*\))$/.test(clean)) {
      throw new Error(`${definition.label}不是支持的缓动曲线`);
    }
    return clean;
  }

  function assertAllowedKeys(object, allowed, label) {
    if (!isPlainObject(object)) throw new Error(`${label}必须是对象`);
    const unknown = Object.keys(object).filter(key => !allowed.has(key));
    if (unknown.length) throw new Error(`${label}包含未知字段：${unknown.join(", ")}`);
  }

  function normalizeLogoAsset(input) {
    if (input == null) return null;
    if (!isPlainObject(input)) throw new Error("主题 Logo 必须是对象");
    assertAllowedKeys(input, new Set(["name", "type", "size", "width", "height", "dataUrl", "builtinUrl", "contributor"]), "主题 Logo");
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

  function normalizeTheme(input) {
    if (!isPlainObject(input)) throw new Error("主题文件必须是 JSON 对象");
    assertAllowedKeys(input, new Set(["$schema", "version", "name", "description", "assets", "tokens"]), "主题根节点");
    if (input.version !== 1) throw new Error("只支持 version: 1 的主题文件");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 60) {
      throw new Error("主题名称应为 1–60 个字符");
    }

    for (const group of GROUPS) {
      const definitions = FIELD_DEFS.filter(definition => definition.path.split(".")[1] === group.key);
      const tokenGroup = input.tokens[group.key];
      if (!isPlainObject(tokenGroup)) continue;
    }

    const normalized = clone(DEFAULT_THEME);
    normalized.name = input.name.trim();
    normalized.description = typeof input.description === "string" ? input.description.trim().slice(0, 240) : "";
    normalized.assets.logo = normalizeLogoAsset(input.assets?.logo);
    for (const definition of FIELD_DEFS) {
      const value = getPath(input, definition.path);
      if (value === undefined) continue;
      setPath(normalized, definition.path, validateValue(definition, value));
    }
    return normalized;
  }

  let themeEnabled = false;

  function applyTheme(theme, enabled = themeEnabled) {
    for (const definition of FIELD_DEFS) {
      document.documentElement.style.setProperty(definition.css, getPath(theme, definition.path));
    }
    document.documentElement.dataset.stoneTheme = theme.name;
    document.body?.classList.toggle("tidal-visual", enabled);
    applyLogo(theme.assets?.logo);
  }

  function applyLogo(logo) {
    const root = document.documentElement;
    const source = logo?.builtinUrl || logo?.dataUrl;
    if (!source) {
      root.style.removeProperty("--stone-theme-logo");
      document.body?.classList.remove("stone-custom-logo");
      return;
    }
    root.style.setProperty("--stone-theme-logo", `url("${source}")`);
    document.body?.classList.add("stone-custom-logo");
  }

  function isOriginalTheme(theme) {
    return theme?.name === ORIGINAL_THEME_NAME;
  }

  function readSavedTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const theme = raw ? normalizeTheme(JSON.parse(raw)) : clone(DEFAULT_THEME);
      themeEnabled = Boolean(raw) && !isOriginalTheme(theme);
      return theme;
    } catch (error) {
      console.warn("Stone Memory theme could not be loaded:", error);
      themeEnabled = false;
      return clone(DEFAULT_THEME);
    }
  }

  let currentTheme = readSavedTheme();
  applyTheme(currentTheme);

  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY) return;
    if (!event.newValue) {
      themeEnabled = false;
      currentTheme = clone(DEFAULT_THEME);
      applyTheme(currentTheme, false);
      return;
    }
    try {
      currentTheme = normalizeTheme(JSON.parse(event.newValue));
      themeEnabled = !isOriginalTheme(currentTheme);
      applyTheme(currentTheme, themeEnabled);
    } catch (error) {
      console.warn("Stone Memory theme update could not be applied:", error);
      themeEnabled = false;
      currentTheme = clone(DEFAULT_THEME);
      applyTheme(currentTheme, false);
    }
  });

  function groupMarkup(group) {
    const definitions = FIELD_DEFS.filter(definition => definition.path.split(".")[1] === group.key);
    return `<details class="theme-token-group" ${group.open ? "open" : ""}>
      <summary><span><strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(group.hint)}</small></span><i aria-hidden="true">⌄</i></summary>
      <div class="theme-token-grid">
        ${definitions.map(definition => {
          const value = getPath(currentTheme, definition.path);
          const swatch = definition.kind === "color" ? `<span class="theme-swatch" data-theme-swatch="${escapeHtml(definition.path)}" aria-hidden="true"></span>` : "";
          return `<label class="theme-token-field">
            <span>${escapeHtml(definition.label)}</span>
            <span class="theme-token-control">${swatch}<input data-theme-path="${escapeHtml(definition.path)}" value="${escapeHtml(value)}" spellcheck="false"></span>
          </label>`;
        }).join("")}
      </div>
    </details>`;
  }

  function renderEditor(section) {
    section.querySelector("#theme-name").value = currentTheme.name;
    section.querySelector("#theme-description").value = currentTheme.description || "";
    section.querySelector("#theme-token-groups").innerHTML = GROUPS.map(groupMarkup).join("");
    for (const swatch of section.querySelectorAll("[data-theme-swatch]")) {
      swatch.style.background = getPath(currentTheme, swatch.dataset.themeSwatch);
    }
  }

  function setStatus(section, message, error = false) {
    const status = section.querySelector("#theme-status");
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function saveTheme(section) {
    try {
      currentTheme = normalizeTheme(currentTheme);
      themeEnabled = !isOriginalTheme(currentTheme);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentTheme));
      applyTheme(currentTheme);
      renderEditor(section);
      setStatus(section, `“${currentTheme.name}”已保存到本机`);
    } catch (error) {
      setStatus(section, error.message, true);
    }
  }

  function exportTheme(section) {
    try {
      const theme = normalizeTheme(currentTheme);
      const blob = new Blob([`${JSON.stringify(theme, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeName = theme.name.toLowerCase().replace(/[^\w\u3400-\u9fff-]+/gu, "-").replace(/^-+|-+$/g, "") || "stone-theme";
      link.href = url;
      link.download = `${safeName}.stone-theme.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(section, "主题 JSON 已下载，不包含业务数据");
    } catch (error) {
      setStatus(section, error.message, true);
    }
  }

  async function importTheme(section, file) {
    if (!file) return;
    try {
      if (!/\.json$/i.test(file.name)) throw new Error("请选择 .json 主题文件");
      if (file.size > MAX_FILE_SIZE) throw new Error("主题文件不能超过 320KB");
      const parsed = JSON.parse(await file.text());
      currentTheme = normalizeTheme(parsed);
      themeEnabled = !isOriginalTheme(currentTheme);
      applyTheme(currentTheme);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentTheme));
      renderEditor(section);
      setStatus(section, `已导入并启用“${currentTheme.name}”`);
    } catch (error) {
      setStatus(section, `导入失败：${error.message}`, true);
    }
  }

  function resetTheme(section) {
    currentTheme = clone(DEFAULT_THEME);
    themeEnabled = false;
    localStorage.removeItem(STORAGE_KEY);
    applyTheme(currentTheme);
    renderEditor(section);
    setStatus(section, "已恢复磐石记忆原版主题");
  }

  function mount(container) {
    if (!container || container.querySelector("[data-theme-workbench]")) return;
    const section = document.createElement("section");
    section.className = "section-card theme-workbench";
    section.dataset.themeWorkbench = "";
    section.innerHTML = `<div class="theme-workbench-head">
      <div>
        <p class="eyebrow">Visual theme</p>
        <h2>界面主题工作台</h2>
        <p>下载当前主题、编辑 JSON 后重新上传，或者直接在这里调整视觉令牌。主题只保存在当前浏览器。</p>
      </div>
      <span class="theme-file-badge">JSON · v1</span>
    </div>
    <div class="theme-meta-grid">
      <label class="theme-token-field"><span>主题名称</span><input id="theme-name" maxlength="60"></label>
      <label class="theme-token-field"><span>说明</span><input id="theme-description" maxlength="240"></label>
    </div>
    <div id="theme-token-groups"></div>
    <div class="theme-workbench-actions">
      <button class="primary" type="button" id="save-theme">保存当前主题</button>
      <button class="secondary" type="button" id="export-theme">下载 JSON</button>
      <label class="secondary theme-upload" for="import-theme">导入主题 JSON</label>
      <input id="import-theme" type="file" accept="application/json,.json" hidden>
      <button class="ghost" type="button" id="reset-theme">恢复默认</button>
      <span id="theme-status" role="status" aria-live="polite"></span>
    </div>`;

    const firstCard = container.querySelector(".section-card");
    if (firstCard) firstCard.before(section);
    else container.append(section);
    renderEditor(section);

    section.addEventListener("input", event => {
      const input = event.target;
      if (input.id === "theme-name") {
        currentTheme.name = input.value;
        setStatus(section, "正在预览，尚未保存");
        return;
      }
      if (input.id === "theme-description") {
        currentTheme.description = input.value;
        return;
      }
      const definition = FIELD_DEFS.find(item => item.path === input.dataset.themePath);
      if (!definition) return;
      try {
        const value = validateValue(definition, input.value);
        setPath(currentTheme, definition.path, value);
        document.documentElement.style.setProperty(definition.css, value);
        input.removeAttribute("aria-invalid");
        const swatch = section.querySelector(`[data-theme-swatch="${definition.path}"]`);
        if (swatch) swatch.style.background = value;
        setStatus(section, "正在预览，尚未保存");
      } catch (error) {
        input.setAttribute("aria-invalid", "true");
        setStatus(section, error.message, true);
      }
    });

    section.querySelector("#save-theme").onclick = () => saveTheme(section);
    section.querySelector("#export-theme").onclick = () => exportTheme(section);
    section.querySelector("#reset-theme").onclick = () => resetTheme(section);
    section.querySelector("#import-theme").onchange = event => {
      importTheme(section, event.target.files?.[0]);
      event.target.value = "";
    };
  }

  function sortDeveloperModules(host) {
    [...host.querySelectorAll("[data-developer-module]")]
      .sort((left, right) => Number(left.dataset.moduleOrder) - Number(right.dataset.moduleOrder))
      .forEach(card => host.append(card));
  }

  function mountDeveloperEntry(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card developer-theme-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">前端工具已接入</span><span class="developer-contributor">贡献人：@钦天监秋</span></div><p class="eyebrow">Visual system · Theme studio</p><h2>界面主题工作台</h2><p>提取并调整界面的颜色、圆角、阴影和品牌图标；主题可以下载成 JSON，再交给其他人继续修改。</p><div class="developer-experiment-features"><span>颜色令牌</span><span>即时预览</span><span>社区素材</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>主题方案</b></div><button class="developer-enter" id="open-theme-workbench" type="button"><span>Visual theme · v1</span><strong>打开工作台 →</strong></button></div>`;
    host.append(card);
    sortDeveloperModules(host);
    card.querySelector("#open-theme-workbench").onclick = () => {
      const threadId = document.querySelector(".workspace")?.dataset.threadId;
      if (threadId) {
        const returnUrl = new URL(window.location.href);
        returnUrl.searchParams.set("threadId", threadId);
        returnUrl.searchParams.set("view", "developer");
        window.history.replaceState(null, "", returnUrl);
      }
      const destination = new URL("/theme-studio/", window.location.origin);
      if (threadId) destination.searchParams.set("threadId", threadId);
      window.location.href = destination;
    };
  }

  let mountScheduled = false;
  function mountWhenDeveloperVisible() {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(() => {
      mountScheduled = false;
      mountDeveloperEntry(document.querySelector("#developer-module-host"));
    });
  }

  const observer = new MutationObserver(mountWhenDeveloperVisible);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  mountWhenDeveloperVisible();

  window.StoneTheme = {
    schema: SCHEMA_ID,
    defaults: () => clone(DEFAULT_THEME),
    current: () => clone(currentTheme),
    apply: input => {
      currentTheme = normalizeTheme(input);
      applyTheme(currentTheme);
      return clone(currentTheme);
    },
    mount,
  };
})();
