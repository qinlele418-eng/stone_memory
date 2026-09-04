(() => {
  "use strict";

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const MODULE_THEME_BRIDGE_KEY = "stone-memory-developer-semantic-theme-v1";
  const BRAND_LOGO_STORAGE_KEY = "stone-memory-brand-logo-v1";
  const PROPERTY_GROUPS = {
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

  const clean = value => {
    const text = String(value || "").trim();
    return text && text.length <= 180 && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(text) ? text : "";
  };

  try {
    const theme = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (theme?.tokens && typeof theme.tokens === "object") {
      const properties = {};
      for (const [group, names] of Object.entries(PROPERTY_GROUPS)) {
        for (const [name, property] of Object.entries(names)) {
          const value = clean(theme.tokens?.[group]?.[name]);
          if (!value) continue;
          document.documentElement.style.setProperty(property, value);
          properties[property] = value;
        }
      }
      document.documentElement.dataset.stoneTheme = String(theme.name || "Custom").slice(0, 60);
      sessionStorage.setItem(MODULE_THEME_BRIDGE_KEY, JSON.stringify({ version: 1, name: String(theme.name || "Custom").slice(0, 60), properties }));
      const logo = theme.assets?.logo;
      const source = typeof logo?.dataUrl === "string" && /^data:image\/(?:png|webp);base64,/i.test(logo.dataUrl) ? logo.dataUrl : logo?.builtinUrl === "/stone-memory-logo.png" ? logo.builtinUrl : "";
      if (source) localStorage.setItem(BRAND_LOGO_STORAGE_KEY, source); else localStorage.removeItem(BRAND_LOGO_STORAGE_KEY);
    }
  } catch {}
  document.documentElement.classList.add("stone-theme-first-frame-ready");
})();
