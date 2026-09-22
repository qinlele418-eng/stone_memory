(() => {
  "use strict";

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const MODULE_THEME_BRIDGE_KEY = "stone-memory-developer-semantic-theme-v1";
  const BRAND_LOGO_STORAGE_KEY = "stone-memory-brand-logo-v1";
  const CONTRACT_URL = "/theme-studio/contract.json?v=6";
  const ORIGINAL_THEME_NAME = "Stone Memory Original";
  const MODULE_ID = "theme-studio";
  const MODULE_ORDER = 20;
  const THEME_STYLE_VERSION = "17";
  const THEME_STYLE_FILES = [
    "theme-tokens.css",
    "theme-coverage.css",
    "theme-workbench.css",
    "developer-theme.css",
    "developer-common.css",
    "developer-radius.css",
  ];
  const TOKEN_PROPERTIES = {
    colors: {
      canvas: "--stone-theme-canvas",
      canvasWarm: "--stone-theme-canvas-warm",
      ink: "--stone-theme-ink",
      inkSoft: "--stone-theme-ink-soft",
      inkFaint: "--stone-theme-ink-faint",
      accent: "--stone-theme-accent",
      accentStrong: "--stone-theme-accent-strong",
      accentSoft: "--stone-theme-accent-soft",
      calendarBloom: "--stone-theme-calendar-bloom",
      surface: "--stone-theme-surface",
      surfaceSoft: "--stone-theme-surface-soft",
      line: "--stone-theme-line",
      lineSoft: "--stone-theme-line-soft",
      status: "--stone-theme-status",
      danger: "--stone-theme-danger",
      warning: "--stone-theme-warning",
      info: "--stone-theme-info",
      conflict: "--stone-theme-conflict",
      fusion: "--stone-theme-fusion",
    },
    radii: {
      extraSmall: "--stone-theme-radius-xs",
      small: "--stone-theme-radius-sm",
      medium: "--stone-theme-radius-md",
      large: "--stone-theme-radius-lg",
      pill: "--stone-theme-radius-pill",
    },
    shadows: {
      card: "--stone-theme-shadow-card",
      panel: "--stone-theme-shadow-panel",
      floating: "--stone-theme-shadow-floating",
      button: "--stone-theme-shadow-button",
    },
    spacing: {
      one: "--stone-theme-space-1",
      two: "--stone-theme-space-2",
      three: "--stone-theme-space-3",
      four: "--stone-theme-space-4",
      five: "--stone-theme-space-5",
      six: "--stone-theme-space-6",
    },
    motion: {
      fast: "--stone-theme-motion-fast",
      normal: "--stone-theme-motion-normal",
      easing: "--stone-theme-ease-soft",
    },
  };

  let contract = null;
  let currentTheme = null;
  let themeEnabled = false;

  // Reset the two retired built-in schemes without keeping their former
  // names or visual values in the current source tree.
  const RETIRED_THEME_FINGERPRINTS = new Set(["362qx4", "scef1"]);

  const clone = value => JSON.parse(JSON.stringify(value));
  const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const cleanCssValue = value => {
    const text = String(value || "").trim();
    return text && text.length <= 180 && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(text) ? text : "";
  };

  function themeFingerprint(theme) {
    const colors = theme?.tokens?.colors || {};
    const signature = [colors.canvas, colors.ink, colors.accent, colors.accentStrong, colors.accentSoft]
      .map(value => String(value || "").trim().toLowerCase())
      .join("|");
    let hash = 2166136261;
    for (const character of signature) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isRetiredBuiltinTheme(theme) {
    return RETIRED_THEME_FINGERPRINTS.has(themeFingerprint(theme));
  }

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

  function applyBrowserChrome(theme) {
    const color = cleanCssValue(theme?.tokens?.colors?.canvas);
    if (!color) return;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  }

  function applyLogo(logo) {
    const root = document.documentElement;
    const source = logo?.builtinUrl || logo?.dataUrl;
    if (!source) {
      root.style.removeProperty("--stone-theme-logo");
      document.body?.classList.remove("stone-custom-logo");
      try { localStorage.removeItem(BRAND_LOGO_STORAGE_KEY); } catch {}
      return;
    }
    root.style.setProperty("--stone-theme-logo", `url("${source}")`);
    document.body?.classList.add("stone-custom-logo");
    try { localStorage.setItem(BRAND_LOGO_STORAGE_KEY, source); } catch {}
  }

  function applyTheme(theme, enabled = themeEnabled) {
    const properties = applyTokenValues(theme);
    publishDeveloperTheme(theme, properties);
    document.documentElement.dataset.stoneTheme = theme.name;
    // 这是整套原版与自定义主题共用的语义样式入口，不是“自定义主题已开启”的标志。
    // 切回原版只恢复默认 token；移除该类会让页面退回未适配的旧裸样式。
    document.body?.classList.add("stone-theme-enabled");
    applyBrowserChrome(theme);
    applyLogo(theme.assets?.logo);
  }

  function applySavedFirstFrame() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!isPlainObject(saved?.tokens)) return;
      if (isRetiredBuiltinTheme(saved)) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const firstFrameTheme = clone(saved);
      if (!isPlainObject(firstFrameTheme.tokens.colors)) firstFrameTheme.tokens.colors = {};
      if (!cleanCssValue(firstFrameTheme.tokens.colors.calendarBloom)) {
        firstFrameTheme.tokens.colors.calendarBloom = firstFrameTheme.tokens.colors.accent;
      }
      const properties = applyTokenValues(firstFrameTheme);
      publishDeveloperTheme(firstFrameTheme, properties);
      themeEnabled = saved.name !== ORIGINAL_THEME_NAME;
      document.documentElement.dataset.stoneTheme = String(saved.name || "Custom").slice(0, 60);
      document.body?.classList.add("stone-theme-enabled");
      applyBrowserChrome(firstFrameTheme);
      applyLogo(saved.assets?.logo);
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
    if (builtinUrl && builtinUrl !== "/stone-memory-logo.png" && !/^\/brand-icons\/[a-z0-9-]+\.png$/.test(builtinUrl)) {
      throw new Error("主题 Logo 内置路径不合法");
    }
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
    if (isRetiredBuiltinTheme(input)) throw new Error("该历史内置主题已停止支持，请选择新的磐石主题");
    const inputVersion = Number(input.version || 1);
    if (![1, 2, 3].includes(inputVersion)) throw new Error(`不支持 version: ${inputVersion} 的主题文件`);
    const hasCalendarBloom = typeof input.tokens?.colors?.calendarBloom === "string";
    const merged = merge(contract.defaults, input);
    if (!hasCalendarBloom && String(merged.name || "") !== ORIGINAL_THEME_NAME) {
      merged.tokens.colors.calendarBloom = merged.tokens.colors.accent;
    }
    const normalized = {
      $schema: contract.$schema,
      version: contract.version,
      name: String(merged.name || contract.defaults.name).trim().slice(0, 60),
      assets: { logo: normalizeLogoAsset(merged.assets?.logo) },
      tokens: {
        typography: clone(contract.defaults.tokens.typography),
      },
    };

    for (const [group, definitions] of Object.entries(TOKEN_PROPERTIES)) {
      const defaults = contract.defaults.tokens[group];
      const source = merged.tokens[group];
      normalized.tokens[group] = {};
      for (const name of Object.keys(definitions)) {
        normalized.tokens[group][name] = validateToken(group, name, source?.[name] ?? defaults[name]);
      }
    }
    return normalized;
  }

  function readSavedTheme() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let parsed = raw ? JSON.parse(raw) : contract.defaults;
      if (isRetiredBuiltinTheme(parsed)) {
        localStorage.removeItem(STORAGE_KEY);
        raw = null;
        parsed = contract.defaults;
      }
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
      const incoming = event.newValue ? JSON.parse(event.newValue) : contract.defaults;
      if (isRetiredBuiltinTheme(incoming)) {
        localStorage.removeItem(STORAGE_KEY);
        currentTheme = normalizeTheme(contract.defaults);
        themeEnabled = false;
        applyTheme(currentTheme, false);
        return;
      }
      currentTheme = normalizeTheme(incoming);
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
    card.className = "me-menu-row theme-entry-row";
    card.id = "open-theme-workbench";
    card.tabIndex = 0;
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<span class="me-menu-icon" aria-hidden="true">◐</span><span class="me-menu-copy"><strong>自定义主题</strong></span><span aria-hidden="true">›</span>`;
    host.append(card);
    sortDeveloperModules(host);
    card.onclick = event => {
      const destination = new URL("/theme-studio/", window.location.origin);
      window.location.href = destination;
    };
    card.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); card.click(); }
    };
  }

  let mountScheduled = false;
  function mountWhenDeveloperVisible() {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(() => {
      mountScheduled = false;
      mountDeveloperEntry(document.querySelector("#theme-entry-host"));
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
      document.body?.classList.add("stone-theme-enabled");
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
