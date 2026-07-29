(() => {
  "use strict";

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const MODULE_THEME_BRIDGE_KEY = "stone-memory-developer-semantic-theme-v1";
  const CONTRACT_URL = "/theme-studio/contract.json?v=3";
  const ORIGINAL_THEME_NAME = "Stone Memory Original";
  const MODULE_ID = "theme-studio";
  const MODULE_ORDER = 20;
  const THEME_STYLE_VERSION = "6";
  const THEME_STYLE_FILES = [
    "tidal-tokens.css",
    "theme-coverage.css",
    "theme-workbench.css",
    "developer-theme.css",
    "developer-common.css",
    "developer-radius.css",
  ];
  const TOKEN_PROPERTIES = {
    colors: {
      canvas: "--stone-tide-canvas",
      canvasWarm: "--stone-tide-canvas-warm",
      ink: "--stone-tide-ink",
      inkSoft: "--stone-tide-ink-soft",
      inkFaint: "--stone-tide-ink-faint",
      accent: "--stone-tide-accent",
      accentStrong: "--stone-tide-accent-strong",
      accentSoft: "--stone-tide-accent-soft",
      surface: "--stone-tide-surface",
      surfaceSoft: "--stone-tide-surface-soft",
      line: "--stone-tide-line",
      lineSoft: "--stone-tide-line-soft",
      status: "--stone-tide-status",
      danger: "--stone-tide-danger",
      warning: "--stone-tide-warning",
      info: "--stone-tide-info",
      conflict: "--stone-tide-conflict",
      fusion: "--stone-tide-fusion",
    },
    radii: {
      extraSmall: "--stone-tide-radius-xs",
      small: "--stone-tide-radius-sm",
      medium: "--stone-tide-radius-md",
      large: "--stone-tide-radius-lg",
      pill: "--stone-tide-radius-pill",
    },
    shadows: {
      card: "--stone-tide-shadow-card",
      panel: "--stone-tide-shadow-panel",
      floating: "--stone-tide-shadow-floating",
      button: "--stone-tide-shadow-button",
    },
    spacing: {
      one: "--stone-tide-space-1",
      two: "--stone-tide-space-2",
      three: "--stone-tide-space-3",
      four: "--stone-tide-space-4",
      five: "--stone-tide-space-5",
      six: "--stone-tide-space-6",
    },
    motion: {
      fast: "--stone-tide-motion-fast",
      normal: "--stone-tide-motion-normal",
      easing: "--stone-tide-ease-soft",
    },
  };

  let contract = null;
  let currentTheme = null;
  let themeEnabled = false;

  const clone = value => JSON.parse(JSON.stringify(value));
  const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const cleanCssValue = value => {
    const text = String(value || "").trim();
    return text && text.length <= 180 && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(text) ? text : "";
  };

  function merge(base, override) {
    if (!isPlainObject(override)) return clone(base);
    const result = clone(base);
    for (const [key, value] of Object.entries(override)) {
      if (isPlainObject(value) && isPlainObject(result[key])) result[key] = merge(result[key], value);
      else result[key] = value;
    }
    return result;
  }

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

  function applyTokenValues(theme) {
    const properties = {};
    for (const [group, definitions] of Object.entries(TOKEN_PROPERTIES)) {
      for (const [name, property] of Object.entries(definitions)) {
        const value = cleanCssValue(theme?.tokens?.[group]?.[name]);
        if (!value) continue;
        document.documentElement.style.setProperty(property, value);
        properties[property] = value;
      }
    }
    return properties;
  }

  function publishDeveloperTheme(theme, properties) {
    try {
      sessionStorage.setItem(MODULE_THEME_BRIDGE_KEY, JSON.stringify({
        version: 1,
        name: String(theme?.name || "Custom").slice(0, 60),
        properties,
      }));
    } catch {}
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

  function applyTheme(theme, enabled = themeEnabled) {
    const properties = applyTokenValues(theme);
    publishDeveloperTheme(theme, properties);
    document.documentElement.dataset.stoneTheme = theme.name;
    document.body?.classList.toggle("tidal-visual", enabled);
    applyLogo(theme.assets?.logo);
  }

  function applySavedFirstFrame() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!isPlainObject(saved?.tokens)) return;
      const properties = applyTokenValues(saved);
      publishDeveloperTheme(saved, properties);
      themeEnabled = saved.name !== ORIGINAL_THEME_NAME;
      document.documentElement.dataset.stoneTheme = String(saved.name || "Custom").slice(0, 60);
      document.body?.classList.toggle("tidal-visual", themeEnabled);
    } catch {}
  }

  function validateToken(group, name, value) {
    const clean = cleanCssValue(value);
    if (!clean) throw new Error(`${group}.${name} 格式不合法`);
    if (group === "colors" && typeof CSS?.supports === "function" && !CSS.supports("color", clean)) {
      throw new Error(`${name} 不是合法颜色`);
    }
    if ((group === "radii" || group === "spacing") && !/^(\d+(?:\.\d+)?)(px|rem)$/.test(clean)) {
      throw new Error(`${name} 必须使用 px 或 rem`);
    }
    if (group === "shadows" && clean !== "none" && typeof CSS?.supports === "function" && !CSS.supports("box-shadow", clean)) {
      throw new Error(`${name} 不是合法阴影`);
    }
    if (group === "motion" && name !== "easing" && !/^(\d+(?:\.\d+)?)ms$/.test(clean)) {
      throw new Error(`${name} 必须使用 ms`);
    }
    return clean;
  }

  function normalizeLogoAsset(input) {
    if (input == null) return null;
    if (!isPlainObject(input)) throw new Error("主题 Logo 必须是对象");
    const type = String(input.type || "");
    const size = Number(input.size);
    const width = Number(input.width);
    const height = Number(input.height);
    const dataUrl = String(input.dataUrl || "");
    const builtinUrl = String(input.builtinUrl || "");
    if (!["image/png", "image/webp"].includes(type)) throw new Error("主题 Logo 只支持 PNG 或 WebP");
    if (!Number.isInteger(size) || size < 1 || size > 200 * 1024) throw new Error("主题 Logo 不能超过 200KB");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1600 || height < 160 || height > 1000) {
      throw new Error("主题 Logo 尺寸不合法");
    }
    if (builtinUrl && builtinUrl !== "/stone-memory-logo.png") throw new Error("主题 Logo 内置路径不合法");
    if (!builtinUrl && (!dataUrl.startsWith(`data:${type};base64,`) || dataUrl.length > 280000)) {
      throw new Error("主题 Logo 数据格式不合法");
    }
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
    if (!contract) throw new Error("主题契约尚未加载");
    if (!isPlainObject(input)) throw new Error("主题文件必须是 JSON 对象");
    const inputVersion = Number(input.version || 1);
    if (![1, 2, 3].includes(inputVersion)) throw new Error(`不支持 version: ${inputVersion} 的主题文件`);
    const normalized = merge(contract.defaults, input);
    normalized.$schema = contract.$schema;
    normalized.version = contract.version;
    normalized.name = String(normalized.name || contract.defaults.name).trim().slice(0, 60);
    delete normalized.description;
    normalized.assets = { logo: normalizeLogoAsset(normalized.assets?.logo) };
    normalized.tokens.typography = clone(contract.defaults.tokens.typography);

    for (const [group, definitions] of Object.entries(TOKEN_PROPERTIES)) {
      const defaults = contract.defaults.tokens[group];
      const source = normalized.tokens[group];
      normalized.tokens[group] = {};
      for (const name of Object.keys(definitions)) {
        normalized.tokens[group][name] = validateToken(group, name, source?.[name] ?? defaults[name]);
      }
    }
    return normalized;
  }

  function readSavedTheme() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : contract.defaults;
      const theme = normalizeTheme(parsed);
      themeEnabled = Boolean(raw) && theme.name !== ORIGINAL_THEME_NAME;
      if (raw && Number(parsed.version || 1) !== contract.version) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
      }
      return theme;
    } catch (error) {
      console.warn("Stone Memory theme could not be loaded:", error);
      themeEnabled = false;
      return normalizeTheme(contract.defaults);
    }
  }

  function handleStorage(event) {
    if (event.key !== STORAGE_KEY || !contract) return;
    try {
      currentTheme = normalizeTheme(event.newValue ? JSON.parse(event.newValue) : contract.defaults);
      themeEnabled = Boolean(event.newValue) && currentTheme.name !== ORIGINAL_THEME_NAME;
      applyTheme(currentTheme, themeEnabled);
    } catch (error) {
      console.warn("Stone Memory theme update could not be applied:", error);
      themeEnabled = false;
      currentTheme = normalizeTheme(contract.defaults);
      applyTheme(currentTheme, false);
    }
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
    card.innerHTML = `<div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">前端工具已接入</span><span class="developer-contributor">贡献人：@钦天监秋</span></div><p class="eyebrow">Visual system · Theme studio</p><h2>界面主题工作台</h2><p>调整界面的颜色、业务状态、圆角、阴影和品牌图标；旧版主题会自动迁移到最新契约。</p><div class="developer-experiment-features"><span>语义令牌</span><span>即时预览</span><span>v1/v2 兼容</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>主题方案</b></div><button class="developer-enter" id="open-theme-workbench" type="button"><span>Visual theme · v3</span><strong>打开工作台 →</strong></button></div>`;
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

  function mount(container) {
    if (!container || container.querySelector("[data-theme-workbench-link]")) return;
    const link = document.createElement("a");
    link.dataset.themeWorkbenchLink = "";
    link.className = "secondary";
    link.href = "/theme-studio/";
    link.textContent = "打开界面主题工作台";
    container.append(link);
  }

  async function initialize() {
    try {
      const response = await fetch(CONTRACT_URL);
      if (!response.ok) throw new Error(`主题契约加载失败 (${response.status})`);
      contract = await response.json();
      currentTheme = readSavedTheme();
      applyTheme(currentTheme, themeEnabled);
      window.addEventListener("storage", handleStorage);
    } catch (error) {
      document.body?.classList.remove("tidal-visual");
      console.warn("Stone Memory theme studio stayed detached:", error);
    }
  }

  loadThemeStyles();
  applySavedFirstFrame();

  const observer = new MutationObserver(mountWhenDeveloperVisible);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  mountWhenDeveloperVisible();

  window.StoneTheme = {
    get schema() { return contract?.$schema || "https://stone-memory.local/schemas/ui-theme-v3.json"; },
    defaults: () => contract ? clone(contract.defaults) : null,
    current: () => currentTheme ? clone(currentTheme) : null,
    apply: input => {
      currentTheme = normalizeTheme(input);
      themeEnabled = currentTheme.name !== ORIGINAL_THEME_NAME;
      applyTheme(currentTheme, themeEnabled);
      return clone(currentTheme);
    },
    mount,
  };

  initialize();
})();
