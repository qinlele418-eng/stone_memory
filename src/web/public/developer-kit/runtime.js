(() => {
  "use strict";

  const STORAGE_KEY = "stone-memory-ui-theme-v1";
  const CSS_TOKENS = {
    colors: {
      canvas: "--stone-tide-canvas", ink: "--stone-tide-ink",
      inkSoft: "--stone-tide-ink-soft", inkFaint: "--stone-tide-ink-faint",
      accent: "--stone-tide-accent", accentStrong: "--stone-tide-accent-strong",
      accentSoft: "--stone-tide-accent-soft", surface: "--stone-tide-surface",
      surfaceSoft: "--stone-tide-surface-soft", line: "--stone-tide-line",
      lineSoft: "--stone-tide-line-soft", status: "--stone-tide-status",
      danger: "--stone-tide-danger",
    },
    radii: {
      extraSmall: "--stone-tide-radius-xs", small: "--stone-tide-radius-sm",
      medium: "--stone-tide-radius-md", large: "--stone-tide-radius-lg",
      pill: "--stone-tide-radius-pill",
    },
    shadows: {
      card: "--stone-tide-shadow-card", panel: "--stone-tide-shadow-panel",
      floating: "--stone-tide-shadow-floating", button: "--stone-tide-shadow-button",
    },
    motion: {
      fast: "--stone-tide-motion-fast", normal: "--stone-tide-motion-normal",
      easing: "--stone-tide-ease-soft",
    },
  };

  const cleanCssValue = value => {
    const text = String(value || "").trim();
    return text && text.length <= 180 && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(text) ? text : "";
  };

  function applyFirstFrameTheme() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.tokens) return;
      for (const [group, definitions] of Object.entries(CSS_TOKENS)) {
        for (const [name, property] of Object.entries(definitions)) {
          const value = cleanCssValue(saved.tokens[group]?.[name]);
          if (value) document.documentElement.style.setProperty(property, value);
        }
      }
      document.documentElement.dataset.stoneTheme = String(saved.name || "Custom").slice(0, 60);
      document.documentElement.classList.add("stone-module-themed");
    } catch {}
  }

  applyFirstFrameTheme();

  const params = new URLSearchParams(location.search);
  const THREAD_KEY = "stone-memory-developer-thread";
  const requestedThreadId = params.get("threadId") || "";
  if (requestedThreadId) {
    try { sessionStorage.setItem(THREAD_KEY, requestedThreadId); } catch {}
  }
  let rememberedThreadId = "";
  try { rememberedThreadId = sessionStorage.getItem(THREAD_KEY) || ""; } catch {}
  const threadId = requestedThreadId || rememberedThreadId;

  function returnToDeveloperMode() {
    const url = new URL("/", location.origin);
    if (threadId) {
      url.searchParams.set("threadId", threadId);
      url.searchParams.set("view", "developer");
    }
    location.href = url;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  async function currentLibrary() {
    if (!threadId) return null;
    const data = await api(`/review-lab/api/libraries?threadId=${encodeURIComponent(threadId)}`);
    return data.libraries?.find(row => row.threadId === threadId) || data.libraries?.[0] || null;
  }

  class StoneModulePage extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: "open" });
      const eyebrow = this.getAttribute("eyebrow") || "STONE MEMORY · DEVELOPER MODULE";
      const title = this.getAttribute("title") || "开发者模块";
      const description = this.getAttribute("description") || "";
      root.innerHTML = `<style>
        :host { display:block; min-height:100dvh; color:var(--stone-tide-ink,#18372b); }
        * { box-sizing:border-box; }
        main { width:min(1120px,calc(100% - 32px)); margin:0 auto; padding:26px 0 80px; }
        header { padding:18px 6px 28px; }
        a { display:inline-flex; align-items:center; min-height:36px; padding:0 13px; color:var(--stone-tide-accent-strong,#295540); text-decoration:none; border:1px solid var(--stone-tide-line,#dce6d7); border-radius:999px; background:color-mix(in srgb,var(--stone-tide-surface,#fffef9) 82%,transparent); box-shadow:0 10px 28px color-mix(in srgb,var(--stone-tide-accent,#397052) 8%,transparent); font:750 12px var(--stone-tide-font-body,Inter,system-ui,sans-serif); cursor:pointer; }
        a:hover { border-color:var(--stone-tide-accent,#397052); transform:translateY(-1px); }
        .eyebrow { margin:28px 0 7px; color:var(--stone-tide-accent,#397052); font:800 12px var(--stone-tide-font-body,Inter,system-ui,sans-serif); letter-spacing:.18em; }
        h1 { margin:0; font:600 clamp(38px,6vw,58px) var(--stone-tide-font-display,Georgia,"Noto Serif SC",serif); }
        .description { max-width:750px; margin:18px 0 0; color:var(--stone-tide-ink-soft,#69756d); font:400 14px/1.75 var(--stone-tide-font-body,Inter,system-ui,sans-serif); }
        .meta { margin-top:12px; }
        @media(max-width:680px) {
          main { width:min(100% - 20px,1120px); padding-top:14px; }
          header { padding:12px 2px 22px; }
          .eyebrow { margin-top:22px; font-size:10px; }
          h1 { font-size:34px; }
          .description { margin-top:13px; font-size:13px; line-height:1.65; }
        }
      </style><main><header><a href="/">← 返回开发者模块</a><p class="eyebrow"></p><h1></h1><p class="description"></p><div class="meta"><slot name="meta"></slot></div></header><slot></slot></main>`;
      root.querySelector(".eyebrow").textContent = eyebrow;
      root.querySelector("h1").textContent = title;
      const descriptionNode = root.querySelector(".description");
      descriptionNode.textContent = description;
      descriptionNode.hidden = !description;
      root.querySelector("a").addEventListener("click", event => {
        event.preventDefault();
        returnToDeveloperMode();
      });
    }
  }

  if (!customElements.get("stone-module-page")) {
    customElements.define("stone-module-page", StoneModulePage);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("stone-developer-module");
    document.querySelectorAll("[data-stone-back]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        returnToDeveloperMode();
      });
    });
    currentLibrary().then(library => {
      document.querySelectorAll("[data-stone-library]").forEach(node => {
        node.textContent = library?.libraryName || library?.label || "未绑定记忆体";
      });
    }).catch(() => {});
  });

  window.StoneDeveloperModule = Object.freeze({
    threadId,
    api,
    currentLibrary,
    returnToDeveloperMode,
  });
})();
