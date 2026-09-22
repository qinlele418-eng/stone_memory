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
  const DESKTOP_ICON_STORAGE_KEY = "stone-memory-desktop-icon-v1";
  const DEFAULT_DESKTOP_ICON = "/app-logo.jpg";
  const MAX_FILE_SIZE = 320 * 1024;
  const MAX_LOGO_FILE_SIZE = 200 * 1024;
  const LOGO_TYPES = new Set(["image/png", "image/webp"]);
  const CONTRACT_URL = "./contract.json?v=6";
  const state = { contract: null, theme: null, customThemes: [] };
  const RETIRED_THEME_FINGERPRINTS = new Set(["362qx4", "scef1"]);
  const BUILTIN_PRESETS = {
    pineInk: {
      name: "松烟青",
      colors: {
        canvas: "#edf1f4", canvasWarm: "#f7f5ef", ink: "#18252b", inkSoft: "#53636a", inkFaint: "#7f8b90",
        accent: "#2f6874", accentStrong: "#174752", accentSoft: "#d8e9ea", calendarBloom: "#ba6673",
        surface: "rgba(250, 250, 247, 0.96)", surfaceSoft: "#e4ebec",
        line: "#c5d2d3", lineSoft: "rgba(117, 139, 142, 0.22)",
        status: "#477b61", danger: "#ad4f45", warning: "#9a6a30", info: "#486f9b",
        conflict: "#985852", fusion: "#745991",
      },
      radii: { extraSmall: "7px", small: "11px", medium: "17px", large: "26px", pill: "9999px" },
      shadows: {
        card: "0 7px 22px rgba(24, 55, 62, 0.08)",
        panel: "0 18px 52px rgba(19, 52, 59, 0.12)",
        floating: "0 28px 82px rgba(13, 36, 41, 0.18)",
        button: "0 9px 20px rgba(47, 104, 116, 0.24)",
      },
      motion: { fast: "135ms", normal: "225ms", easing: "cubic-bezier(0.16, 0.84, 0.32, 1)" },
    },
  };
  const COMMUNITY_THEMES = {
    garden: {
      name: "苔粉花园",
      description: "小绒太尉贡献的柔和苔粉花园主题。",
      contributor: "@小绒太尉",
      colors: {
        canvas: "#f5f0eb", ink: "#3d3d3d", inkSoft: "#78769c", inkFaint: "#8d8799",
        accent: "#db9ed3", accentStrong: "#a965a0", accentSoft: "rgba(237, 204, 224, 0.34)", calendarBloom: "#d98794",
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
        accent: "#6e4f9a", accentStrong: "#523c78", accentSoft: "rgba(110, 79, 154, 0.10)", calendarBloom: "#8265b3",
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
    sakuraNight: {
      name: "樱夜黑粉",
      description: "钦天监秋贡献的黑粉深色主题。",
      contributor: "@钦天监秋",
      colors: {
        canvas: "#16131F", canvasWarm: "#1D1823", ink: "#F0D9E4", inkSoft: "#C1A0AC", inkFaint: "#806C79",
        accent: "#F0D9E4", accentStrong: "#C1A0AC", accentSoft: "rgba(240, 217, 228, 0.14)", calendarBloom: "#D48DA6",
        surface: "rgba(29, 24, 35, 0.94)", surfaceSoft: "#2B2432",
        line: "#4A3F4B", lineSoft: "rgba(128, 108, 121, 0.38)",
        status: "#C1A0AC", danger: "#D48DA6", warning: "#D7A86E", info: "#9DA9D8",
        conflict: "#D48DA6", fusion: "#C59BD8",
      },
      shadows: {
        card: "0 18px 50px rgba(0, 0, 0, 0.34)",
        panel: "0 18px 50px rgba(0, 0, 0, 0.34)",
        floating: "0 24px 70px rgba(0, 0, 0, 0.44)",
        button: "0 10px 24px rgba(240, 217, 228, 0.12)",
      },
    },
    roseManor: {
      name: "玫瑰庄园",
      description: "柔和玫瑰粉与暖白表面的庄园主题。",
      contributor: "Stone Memory 素材库",
      colors: {
        canvas: "#fbf5f1", canvasWarm: "#fffef9", ink: "#574b49", inkSoft: "#887678", inkFaint: "#aa9698",
        accent: "#dca1af", accentStrong: "#c68191", accentSoft: "#f7e5e8", calendarBloom: "#dca1af",
        surface: "#fffdfb", surfaceSoft: "#f8efec", line: "#e7d1c2", lineSoft: "#f1e4dc",
        status: "#8fa58e", danger: "#b66767", warning: "#b58a63", info: "#8490a8", conflict: "#c0787b", fusion: "#a08094",
      },
      radii: { extraSmall: "9px", small: "16px", medium: "26px", large: "36px", pill: "999px" },
      shadows: {
        card: "0 10px 30px 0 rgba(200, 174, 176, 0.06)", panel: "0 16px 44px 0 rgba(185, 154, 158, 0.08)",
        floating: "0 20px 56px rgba(185, 154, 158, 0.10)", button: "0 10px 24px rgba(198, 143, 155, 0.12)",
      },
      spacing: { one: "6px", two: "10px", three: "14px", four: "18px", five: "24px", six: "32px" },
      motion: { fast: "180ms", normal: "200ms", easing: "ease" },
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
  const COMMUNITY_LOGOS = {
    original: COMMUNITY_LOGO,
    sweet1: { name: "甜酷石头 1", type: "image/png", size: 162786, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/sweet-stone-1.png", contributor: "Stone Memory 素材库" },
    sweet2: { name: "甜酷石头 2", type: "image/png", size: 170700, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/sweet-stone-2.png", contributor: "Stone Memory 素材库" },
    stone1: { name: "花园石头 1", type: "image/png", size: 191799, width: 900, height: 900, dataUrl: "", builtinUrl: "/brand-icons/stone-1.png", contributor: "Stone Memory 素材库" },
    stone2: { name: "花园石头 2", type: "image/png", size: 197543, width: 900, height: 900, dataUrl: "", builtinUrl: "/brand-icons/stone-2.png", contributor: "Stone Memory 素材库" },
    stone3: { name: "花园石头 3", type: "image/png", size: 193473, width: 900, height: 900, dataUrl: "", builtinUrl: "/brand-icons/stone-3.png", contributor: "Stone Memory 素材库" },
    stone4: { name: "花园石头 4", type: "image/png", size: 186958, width: 900, height: 900, dataUrl: "", builtinUrl: "/brand-icons/stone-4.png", contributor: "Stone Memory 素材库" },
    stone5: { name: "花园石头 5", type: "image/png", size: 167135, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/stone-5.png", contributor: "Stone Memory 素材库" },
    stone6: { name: "花园石头 6", type: "image/png", size: 200309, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/stone-6.png", contributor: "Stone Memory 素材库" },
    stone7: { name: "花园石头 7", type: "image/png", size: 185058, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/stone-7.png", contributor: "Stone Memory 素材库" },
    stone8: { name: "花园石头 8", type: "image/png", size: 175683, width: 450, height: 450, dataUrl: "", builtinUrl: "/brand-icons/stone-8.png", contributor: "Stone Memory 素材库" },
  };

  const FIELD_GROUPS = [
    { key: "text", title: "文字", description: "正文、标题与辅助信息", paths: ["tokens.colors.ink", "tokens.colors.inkSoft", "tokens.colors.inkFaint"] },
    { key: "background", title: "背景", description: "页面、卡片与柔和表面", paths: ["tokens.colors.canvas", "tokens.colors.surface", "tokens.colors.surfaceSoft", "tokens.colors.accentSoft"] },
    { key: "interface", title: "界面色", description: "强调、记忆花色、主要操作与边框", paths: ["tokens.colors.accent", "tokens.colors.accentStrong", "tokens.colors.calendarBloom", "tokens.colors.line", "tokens.colors.lineSoft"] },
    { key: "semantic", title: "状态色", description: "正常、危险、警告、信息、冲突与融合", paths: ["tokens.colors.status", "tokens.colors.danger", "tokens.colors.warning", "tokens.colors.info", "tokens.colors.conflict", "tokens.colors.fusion"] },
    { key: "radius", title: "圆角", description: "控件、卡片与大面板轮廓", paths: ["tokens.radii.small", "tokens.radii.medium", "tokens.radii.large"] },
    { key: "shadow", title: "阴影", description: "卡片与浮层的空间层级", paths: ["tokens.shadows.card", "tokens.shadows.panel"] },
  ];

  const colorLabels = {
    canvas: "页面背景", surface: "卡片背景", surfaceSoft: "柔和表面",
    ink: "主要文字", inkSoft: "次级文字", inkFaint: "弱化文字",
    accent: "强调色", accentStrong: "主要操作色", accentSoft: "浅色选中态", calendarBloom: "记忆花色",
    line: "边框", lineSoft: "弱边框", status: "正常状态", danger: "危险操作",
    warning: "警告提示", info: "信息提示", conflict: "冲突标记", fusion: "融合操作",
  };
  const colorCssNames = {
    canvas: "canvas", canvasWarm: "canvas-warm", ink: "ink", inkSoft: "ink-soft",
    inkFaint: "ink-faint", accent: "accent", accentStrong: "accent-strong",
    accentSoft: "accent-soft", calendarBloom: "calendar-bloom", surface: "surface", surfaceSoft: "surface-soft",
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

  function buildBuiltinTheme(id) {
    const preset = BUILTIN_PRESETS[id];
    if (!preset) return null;
    return normalize(merge(state.contract.defaults, {
      name: preset.name,
      tokens: {
        colors: preset.colors,
        radii: preset.radii,
        shadows: preset.shadows,
        motion: preset.motion,
      },
    }));
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
    if (builtinUrl && builtinUrl !== "/stone-memory-logo.png" && !/^\/brand-icons\/[a-z0-9-]+\.png$/.test(builtinUrl)) throw new Error("主题 Logo 内置路径不合法");
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
    const prefix = state.contract.coreTokenPrefix || "--stone-theme-";
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

  function parseShadowColor(value) {
    const clean = String(value || "").trim();
    const hex = clean.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
      let digits = hex[1];
      if (digits.length <= 4) digits = digits.split("").map(digit => `${digit}${digit}`).join("");
      const hasAlpha = digits.length === 8;
      return {
        color: `#${digits.slice(0, 6).toLowerCase()}`,
        opacity: hasAlpha ? Math.round((parseInt(digits.slice(6), 16) / 255) * 100) : 100,
      };
    }
    const rgb = clean.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*\.?\d+)\s*)?\)$/i);
    if (!rgb) return null;
    return {
      color: `#${rgb.slice(1, 4).map(channel => Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, "0")).join("")}`,
      opacity: Math.round(Math.max(0, Math.min(1, rgb[4] === undefined ? 1 : Number(rgb[4]))) * 100),
    };
  }

  function parseShadowValue(value) {
    const clean = String(value || "").trim();
    if (!clean || clean === "none") return null;
    const colorMatch = clean.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*$/i);
    if (!colorMatch) return null;
    const color = parseShadowColor(colorMatch[1]);
    const lengths = clean.slice(0, colorMatch.index).trim().split(/\s+/);
    if (!color || lengths.length < 3 || lengths.length > 4) return null;
    if (!lengths.every(length => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(length) && (/px$/i.test(length) || Number(length) === 0))) return null;
    const numbers = lengths.map(Number.parseFloat);
    if (numbers[2] < 0) return null;
    return {
      x: numbers[0],
      y: numbers[1],
      blur: numbers[2],
      spread: numbers[3] || 0,
      color: color.color,
      opacity: color.opacity,
    };
  }

  function formatShadowNumber(value) {
    const rounded = Math.round(Number(value) * 100) / 100;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  }

  function formatShadowLength(value) {
    const number = Number(value);
    return number === 0 ? "0" : `${formatShadowNumber(number)}px`;
  }

  function shadowColorToRgba(hex, opacity) {
    const clean = String(hex || "").replace("#", "");
    const channels = [0, 2, 4].map(index => parseInt(clean.slice(index, index + 2), 16));
    return `rgba(${channels.join(", ")}, ${formatShadowNumber(Number(opacity) / 100)})`;
  }

  function composeShadowValue(editor) {
    const values = {};
    editor.querySelectorAll("[data-shadow-part]").forEach(input => { values[input.dataset.shadowPart] = input.value; });
    const requiredNumbers = ["x", "y", "blur", "spread", "opacity"];
    if (requiredNumbers.some(key => values[key] === "" || !Number.isFinite(Number(values[key])))) throw new Error("阴影参数必须填写有效数字");
    if (Number(values.blur) < 0) throw new Error("阴影模糊不能小于 0");
    if (Number(values.opacity) < 0 || Number(values.opacity) > 100) throw new Error("阴影透明度必须在 0–100 之间");
    if (!/^#[0-9a-f]{6}$/i.test(values.color || "")) throw new Error("阴影颜色必须使用六位 HEX");
    return `${formatShadowLength(values.x)} ${formatShadowLength(values.y)} ${formatShadowLength(values.blur)} ${formatShadowLength(values.spread)} ${shadowColorToRgba(values.color, values.opacity)}`;
  }

  function shadowValueSummary(parts) {
    return `横向 ${formatShadowNumber(parts.x)} · 纵向 ${formatShadowNumber(parts.y)} · 模糊 ${formatShadowNumber(parts.blur)} · 透明 ${formatShadowNumber(parts.opacity)}%`;
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
    const prefix = state.contract.coreTokenPrefix || "--stone-theme-";
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
    document.documentElement.dataset.stoneTheme = String(state.theme.name || "Custom").slice(0, 60);
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

  function persistActiveTheme() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.theme));
  }

  function clearActiveTheme() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function desktopIconSource() {
    return localStorage.getItem(DESKTOP_ICON_STORAGE_KEY) || DEFAULT_DESKTOP_ICON;
  }

  function renderDesktopIcon() {
    const preview = $("#desktop-icon-preview");
    if (preview) preview.innerHTML = `<img src="${escapeHtml(desktopIconSource())}" alt="当前桌面图标预览">`;
  }

  function normalize(input) {
    const defaults = state.contract.defaults;
    if (isRetiredBuiltinTheme(input)) throw new Error("该历史内置主题已停止支持，请选择新的磐石主题");
    const inputVersion = Number(input?.version || 1);
    if (![1, 2, 3].includes(inputVersion)) throw new Error(`不支持 version: ${inputVersion} 的主题文件`);
    const hasCalendarBloom = typeof input?.tokens?.colors?.calendarBloom === "string";
    const merged = merge(defaults, input);
    if (!hasCalendarBloom && String(merged.name || "") !== defaults.name) {
      merged.tokens.colors.calendarBloom = merged.tokens.colors.accent;
    }
    const theme = {
      $schema: state.contract.$schema,
      version: state.contract.version,
      name: String(merged.name || defaults.name).trim().slice(0, 60),
      assets: { logo: normalizeLogoAsset(merged.assets?.logo) },
      tokens: {},
    };
    const safeTokens = {};
    for (const [group, defaultValues] of Object.entries(defaults.tokens)) {
      safeTokens[group] = {};
      for (const [name, fallback] of Object.entries(defaultValues)) {
        const value = group === "typography" ? fallback : merged.tokens?.[group]?.[name] ?? fallback;
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
      tokens: { colors: preset.colors, radii: preset.radii, shadows: preset.shadows, spacing: preset.spacing, motion: preset.motion },
    }));
    applyTheme();
    persistActiveTheme();
    renderFields();
    status(`已切换到“${preset.name}” · 贡献人：${preset.contributor}`);
  }

  function chooseCommunityLogo(key = "original") {
    const logo = COMMUNITY_LOGOS[key];
    if (!logo) return;
    state.theme.assets = { logo: normalizeLogoAsset(logo) };
    renderLogoMeta();
    logoStatus("");
    status(`已选用${logo.name} · 贡献人：${logo.contributor}；保存主题后正式保留`);
  }

  function readCustomThemes() {
    try {
      const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      const themes = [];
      for (const item of list) {
        const source = item?.theme || item;
        if (isRetiredBuiltinTheme(source)) continue;
        try {
          const theme = normalize(source);
          if (theme.name) themes.push({ name: String(item?.name || theme.name || "未命名主题"), theme });
        } catch {}
      }
      return themes;
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

  function renderShadowField(definition) {
    const value = get(state.theme, definition.path);
    const parts = parseShadowValue(value);
    const inputId = `theme-${definition.path.replaceAll(".", "-")}`;
    if (!parts) {
      return `<div class="theme-shadow-field theme-shadow-raw"><header><strong>${escapeHtml(definition.label)}</strong><small>复杂旧值，保留原始 CSS 编辑</small></header><div class="theme-field"><label for="${inputId}">原始 CSS</label><div class="theme-control"><input id="${inputId}" class="theme-value-input" data-path="${escapeHtml(definition.path)}" value="${escapeHtml(value)}" spellcheck="false" aria-label="${escapeHtml(definition.label)}原始 CSS"></div></div></div>`;
    }
    const partInput = (part, label) => {
      const partId = `${inputId}-${part}`;
      return `<div class="theme-field theme-shadow-part"><label for="${partId}">${label}</label><div class="theme-control"><input id="${partId}" class="theme-value-input" inputmode="decimal" data-shadow-part="${part}" value="${escapeHtml(formatShadowNumber(parts[part]))}" aria-label="${escapeHtml(definition.label)}${label}"></div></div>`;
    };
    const colorId = `${inputId}-color`;
    const colorField = `<div class="theme-field theme-shadow-part is-color"><label for="${colorId}">颜色</label><div class="theme-control"><input class="theme-color-picker" type="color" data-shadow-color-part="color" value="${escapeHtml(parts.color)}" aria-label="打开${escapeHtml(definition.label)}色盘" title="点击打开色盘"><input id="${colorId}" class="theme-value-input" data-shadow-part="color" value="${escapeHtml(parts.color)}" spellcheck="false" aria-label="${escapeHtml(definition.label)}颜色代码"></div></div>`;
    return `<div class="theme-shadow-field" data-shadow-path="${escapeHtml(definition.path)}"><header><strong>${escapeHtml(definition.label)}</strong><small data-shadow-summary>${escapeHtml(shadowValueSummary(parts))}</small></header><div class="theme-shadow-parts">${partInput("x", "横向偏移")}${partInput("y", "纵向偏移")}${partInput("blur", "模糊")}${partInput("spread", "扩散")}${colorField}${partInput("opacity", "透明度 %")}</div></div>`;
  }

  function renderShadowGroup(group, definitions) {
    return `<details class="token-group token-group-shadow theme-shadow-group"><summary><span><strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(group.description)}；展开后分别调整位置、模糊、扩散、颜色和透明度</small></span><i aria-hidden="true">⌄</i></summary><div class="token-group-fields">${definitions.map(renderShadowField).join("")}</div></details>`;
  }

  function activePresetName() {
    if (state.theme.name === state.contract.defaults.name) return "original";
    for (const [id, preset] of Object.entries(BUILTIN_PRESETS)) {
      if (state.theme.name === preset.name) return id;
    }
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
      ...Object.entries(BUILTIN_PRESETS).map(([id, preset]) => ({ id, label: preset.name, theme: buildBuiltinTheme(id) })),
    ];
    target.innerHTML = builtIns.map(paletteCard).join("") + state.customThemes.map((item, index) => paletteCard({ id: item.name, label: item.theme.name, theme: item.theme, customIndex: index })).join("") + `<button class="theme-swatch theme-swatch-add" id="add-theme" type="button" title="添加自定义主题"><span class="theme-swatch-color theme-swatch-add-color"><i>+</i></span><span class="theme-swatch-name">添加主题</span></button><button class="theme-swatch theme-swatch-more" id="more-themes" type="button" title="浏览社区主题"><span class="theme-swatch-color theme-swatch-add-color"><i class="theme-more-dots" aria-hidden="true"><b></b><b></b><b></b></i></span><span class="theme-swatch-name">更多主题</span></button>`;
  }
  function renderFields() {
    const definitions = fieldDefinitions();
    $("#theme-fields").innerHTML = FIELD_GROUPS.map(group => {
      const groupFields = group.paths.map(path => definitions.find(definition => definition.path === path)).filter(Boolean);
      if (group.key === "shadow") return renderShadowGroup(group, groupFields);
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
    const desktopIconGroup = createUtilityGroup("桌面图标", "独立设置添加到桌面时使用的图标，不跟随品牌 Logo", "token-group-desktop-icon");
    desktopIconGroup.body.innerHTML = `<div class="theme-logo-controls"><div id="desktop-icon-preview" class="theme-logo-preview"></div><div class="theme-logo-buttons"><button class="secondary" id="use-brand-desktop-icon" type="button">使用品牌图</button><button class="ghost" id="reset-desktop-icon" type="button">恢复石头小花</button></div><small class="theme-logo-status">桌面图标跟随品牌图或恢复为原版石头小花。</small></div>`;
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
    originalTokenStack.append(themeGroup.section, logoGroup.section, desktopIconGroup.section, tokenFields);

    const workbench = document.createElement("section");
    workbench.className = "theme-card theme-workbench-card";
    const supportCard = document.createElement("section");
    supportCard.className = "theme-support-card";
    supportCard.setAttribute("aria-label", "主题预览与兼容性");
    supportCard.append($(".theme-state-preview"), $(".advanced-json"));
    workbench.append(originalTokenStack, supportCard);
    card.classList.add("theme-topbar");
    card.after(workbench);
    $(".theme-actions").remove();
    topbar.remove();
    renderLogoMeta();
    renderDesktopIcon();
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
    persistActiveTheme();
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
    state.theme = name === "original" ? normalize(state.contract.defaults) : buildBuiltinTheme(name);
    if (!state.theme) return;
    applyTheme();
    persistActiveTheme();
    renderFields();
    status(`已切换到“${state.theme.name}”`);
  }

  function communityLogoButtons() {
    return Object.entries(COMMUNITY_LOGOS).map(([key, logo]) => `<button type="button" data-community-logo="${escapeHtml(key)}"><img src="${escapeHtml(logo.builtinUrl)}" alt=""><span><strong>${escapeHtml(logo.name)}</strong><small>${logo.width}×${logo.height} · ${(logo.size / 1024).toFixed(1)}KB · 贡献人：${escapeHtml(logo.contributor)}</small></span></button>`).join("");
  }

  function render() {
      $("#theme-studio-mount").innerHTML = `<section class="theme-card"><div class="theme-card-head"><p class="eyebrow">THEME STRUCTURE</p><h2>按视觉职责调整</h2><p class="theme-card-intro">每一排只处理一种视觉职责。颜色项可点左侧色块打开色盘，也可以直接输入 HEX、RGB 或 HSL。</p><div class="theme-card-meta"><small class="theme-credit">工作台贡献人：@钦天监秋</small><span class="theme-file-badge">TOKEN v${state.contract.version}</span></div></div><div class="theme-topbar"><div class="theme-name-row"><label class="theme-field theme-name-field"><span>主题名称</span><input id="theme-name" maxlength="60"></label><div class="theme-inline-actions"><button class="primary" id="save-theme" type="button">保存自定义主题</button><button class="secondary" id="export-theme" type="button">导出目前主题</button><label class="secondary theme-inline-upload" for="import-theme">导入主题 JSON</label><input id="import-theme" type="file" accept="application/json,.json" hidden></div></div><div class="theme-palette-row"><span class="theme-palette-label">主题</span><div id="theme-palette" class="theme-palette"></div></div><div id="community-theme-panel" class="community-assets" hidden><button type="button" data-community-theme="garden"><i style="--community-a:#f5f0eb;--community-b:#db9ed3;--community-c:#a965a0"></i><span><strong>苔粉花园</strong><small>贡献人：@小绒太尉</small></span></button><button type="button" data-community-theme="purpleGray"><i style="--community-a:#f4f3f7;--community-b:#6e4f9a;--community-c:#523c78"></i><span><strong>紫灰仪表盘</strong><small>贡献人：@小绒太尉</small></span></button><button type="button" data-community-theme="sakuraNight"><i style="--community-a:#16131F;--community-b:#F0D9E4;--community-c:#C1A0AC"></i><span><strong>樱夜黑粉</strong><small>贡献人：@钦天监秋</small></span></button><button type="button" data-community-theme="roseManor"><i style="--community-a:#fbf5f1;--community-b:#dca1af;--community-c:#c68191"></i><span><strong>玫瑰庄园</strong><small>Stone Memory 素材库</small></span></button></div><section class="theme-logo-row"><div><span class="theme-palette-label">品牌图标</span><p id="theme-logo-meta">推荐透明背景；参考规格 1079×507、约 140KB</p></div><div class="theme-logo-controls"><div id="theme-logo-preview" class="theme-logo-preview empty"><span>使用磐石原版石头小花</span></div><div class="theme-logo-buttons"><label class="secondary theme-inline-upload" for="import-theme-logo">选择图片</label><input id="import-theme-logo" type="file" accept="image/png,image/webp,.png,.webp" hidden><button class="secondary" id="more-theme-images" type="button">更多图片</button><button class="ghost" id="remove-theme-logo" type="button" hidden>恢复原图</button></div></div></section><div id="community-logo-panel" class="community-assets community-logo-assets" hidden>${communityLogoButtons()}</div><div id="theme-fields" class="theme-groups"></div><section class="theme-state-preview" aria-label="主题状态预览"><div><span class="theme-palette-label">月历强度</span><div class="theme-calendar-preview"><i class="level-0" title="无活动"></i><i class="level-1" title="低活动"></i><i class="level-2" title="中活动"></i><i class="level-3" title="高活动"></i></div></div><div><span class="theme-palette-label">业务状态</span><div class="theme-status-preview"><i class="status">正常</i><i class="warning">警告</i><i class="info">信息</i><i class="conflict">冲突</i><i class="fusion">融合</i><i class="danger">危险</i></div></div></section><details class="advanced-json"><summary><span><strong>高级 JSON 与兼容性</strong><small>完整令牌、版本契约与跨版本适配</small></span><i>⌄</i></summary><div class="advanced-copy"><p>导出的 JSON 使用 version 3 契约，包含完整的业务状态色与品牌图标。</p><p>已有 version 1 和 version 2 主题仍可导入，并会自动补齐缺少字段后迁移到 version 3；未知字段不会写入 CSS。</p><p>Logo 随主题 JSON 一同导出；支持 PNG/WebP，最大 200KB，宽 320–1600px、高 160–1000px。</p></div></details><div class="theme-actions"><button class="ghost" id="reset-theme" type="button">恢复磐石记忆原版</button><span id="theme-status" role="status" aria-live="polite"></span></div></section>`;
    const calendarPreview = $(".theme-calendar-preview");
    calendarPreview.parentElement.querySelector(".theme-palette-label").textContent = "记忆月历";
    calendarPreview.innerHTML = `<span><i class="mining-none"></i><small>无对话</small></span><span><i class="mining-pending selected"></i><small>未挖掘</small></span><span><i class="mining-light"></i><small>&lt;10 摘要</small></span><span><i class="mining-deep"></i><small>≥10 摘要</small></span>`;
    const advancedParagraphs = $(".advanced-copy").querySelectorAll("p");
    advancedParagraphs[0].textContent = "导出的 JSON 使用 version 3 契约，包含完整的界面、月历与业务状态令牌。";
    $("#theme-logo-preview").insertAdjacentHTML("afterend", `<small id="theme-logo-status" class="theme-logo-status" role="status" aria-live="polite"></small>`);
    $(".theme-calendar-preview").insertAdjacentHTML("beforebegin", `<small class="theme-preview-hint">浅、深花色跟随“界面色 → 记忆花色”；灰色表示尚未挖掘，选中外圈继续跟随强调色。</small>`);
    $(".theme-status-preview").insertAdjacentHTML("beforebegin", `<small class="theme-preview-hint">分别跟随“状态色”中的正常、警告、信息、冲突、融合与危险颜色。</small>`);
    renderFields();
    promoteUtilityGroups();
  }

  async function init() {
    try {
      state.contract = await fetch(CONTRACT_URL).then(response => { if (!response.ok) throw new Error(`主题契约加载失败 (${response.status})`); return response.json(); });
      state.customThemes = readCustomThemes();
      let saved = localStorage.getItem(STORAGE_KEY);
      let parsedSaved = saved ? JSON.parse(saved) : state.contract.defaults;
      if (isRetiredBuiltinTheme(parsedSaved)) {
        clearActiveTheme();
        saved = null;
        parsedSaved = state.contract.defaults;
      }
      state.theme = normalize(parsedSaved);
      if (saved && Number(parsedSaved.version || 1) !== state.contract.version) {
        persistActiveTheme();
      }
      writeCustomThemes();
      applyTheme();
      render();

      document.addEventListener("input", event => {
        const input = event.target;
        if (input.id === "theme-name") { state.theme.name = input.value; return; }
        const shadowEditor = input.closest?.("[data-shadow-path]");
        const shadowPart = input.dataset.shadowPart || input.dataset.shadowColorPart;
        if (shadowEditor && shadowPart) {
          const definition = fieldDefinitions().find(item => item.path === shadowEditor.dataset.shadowPath);
          if (!definition) return;
          try {
            if (input.dataset.shadowColorPart) {
              const colorCode = shadowEditor.querySelector('[data-shadow-part="color"]');
              if (colorCode) colorCode.value = input.value.toLowerCase();
            } else if (input.dataset.shadowPart === "color" && /^#[0-9a-f]{6}$/i.test(input.value)) {
              const colorPicker = shadowEditor.querySelector("[data-shadow-color-part]");
              if (colorPicker) colorPicker.value = input.value.toLowerCase();
            }
            const value = validateValue("shadow", definition.label, composeShadowValue(shadowEditor));
            applyFieldValue(definition, value);
            shadowEditor.querySelectorAll("[data-shadow-part], [data-shadow-color-part]").forEach(control => control.removeAttribute("aria-invalid"));
            const summary = shadowEditor.querySelector("[data-shadow-summary]");
            const parsed = parseShadowValue(value);
            if (summary && parsed) summary.textContent = shadowValueSummary(parsed);
            status("正在预览，尚未保存");
          } catch (error) {
            input.setAttribute("aria-invalid", "true");
            status(error.message, true);
          }
          return;
        }
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
        persistActiveTheme();
        renderFields();
        status(`已切换到“${state.theme.name}”`);
      });
      $("#save-theme").onclick = save;
      $("#export-theme").onclick = exportTheme;
      $("#reset-theme").onclick = () => { state.theme = normalize(state.contract.defaults); applyTheme(); renderFields(); clearActiveTheme(); status("已恢复磐石记忆原版主题"); };
      $("#import-theme").onchange = event => { importTheme(event.target.files?.[0]); event.target.value = ""; };
      $("#import-theme-logo").onchange = event => { chooseLogo(event.target.files?.[0]); event.target.value = ""; };
      $("#use-brand-desktop-icon").onclick = () => {
        const logo = state.theme.assets?.logo;
        const source = logo?.builtinUrl || logo?.dataUrl || "";
        if (!source) { status("当前主题没有品牌图片，请先选择或上传品牌图", true); return; }
        localStorage.setItem(DESKTOP_ICON_STORAGE_KEY, source);
        renderDesktopIcon();
        status("已将当前品牌图保存为桌面图标");
      };
      $("#reset-desktop-icon").onclick = () => {
        localStorage.removeItem(DESKTOP_ICON_STORAGE_KEY);
        renderDesktopIcon();
        status("桌面图标已恢复为原版石头小花");
      };
      $("#more-theme-images").onclick = () => {
        const panel = $("#community-logo-panel");
        panel.hidden = !panel.hidden;
      };
      document.querySelectorAll("[data-community-logo]").forEach(button => {
        button.onclick = () => chooseCommunityLogo(button.dataset.communityLogo);
      });
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
      const incoming = event.newValue ? JSON.parse(event.newValue) : state.contract.defaults;
      if (isRetiredBuiltinTheme(incoming)) {
        clearActiveTheme();
        state.theme = normalize(state.contract.defaults);
      } else {
        state.theme = normalize(incoming);
      }
      applyTheme();
      if ($("#theme-fields")) renderFields();
      status(event.newValue ? "已从其他标签同步主题" : "已从其他标签恢复磐石原版");
    } catch (error) {
      status(`同步主题失败：${error.message}`, true);
    }
  });

  init();
})();
