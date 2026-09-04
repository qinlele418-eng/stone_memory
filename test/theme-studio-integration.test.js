const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("main page enables the semantic theme bridge", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "web", "public", "index.html"),
    "utf8",
  );
  assert.match(html, /<body[^>]*\bclass="[^"]*\bstone-theme-enabled\b[^"]*"/);
});

test("PWA icon sync reads the saved custom theme logo before CSS bootstrap", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /localStorage\.getItem\(BRAND_LOGO_STORAGE_KEY\)/);
  assert.match(app, /stone-memory-brand-logo-v1/);
  assert.match(app, /data:image\\\/\(\?:png\|webp\)/);
});

test("theme studio persists the active logo for add-to-desktop", () => {
  const studio = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "theme-studio", "standalone-app.js"), "utf8");
  assert.match(studio, /function persistActiveTheme\(\)/);
  assert.match(studio, /localStorage\.setItem\(BRAND_LOGO_STORAGE_KEY, source\)/);
  assert.match(studio, /localStorage\.removeItem\(BRAND_LOGO_STORAGE_KEY\)/);
});

test("add-to-desktop updates browser shortcut icon from the active logo", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /link\[rel="icon"\].*link\[rel="shortcut icon"\].*link\[rel="apple-touch-icon"\]/);
  assert.match(app, /link\.href=desktopIcon/);
  assert.match(app, /reader\.readAsDataURL\(blob\)/);
});

test("mobile workspace navigation keeps two-character labels centered", () => {
  const styles = fs.readFileSync(
    path.join(__dirname, "..", "src", "web", "public", "styles.css"),
    "utf8",
  );
  const mobileNav = styles.match(/@media \(max-width: 760px\) \{[\s\S]*?\.stats-grid/)?.[0] || "";
  assert.match(mobileNav, /\.side-nav\s*\{[^}]*align-items:\s*stretch/);
  assert.match(mobileNav, /\.side-nav button\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(mobileNav, /height:\s*100%/);
  assert.match(mobileNav, /padding:\s*6px 4px/);
  assert.match(mobileNav, /white-space:\s*normal/);
  assert.match(mobileNav, /overflow-wrap:\s*normal/);
  assert.match(mobileNav, /\.side-nav button span\s*\{[^}]*white-space:\s*nowrap/);
});

test("mobile mining remains contained while input zoom overrides stay removed", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const mainStyles = fs.readFileSync(path.join(publicDir, "styles.css"), "utf8");
  const themeStyles = fs.readFileSync(path.join(publicDir, "theme-studio", "standalone.css"), "utf8");
  const kitStyles = fs.readFileSync(path.join(publicDir, "developer-kit", "styles.css"), "utf8");

  assert.match(mainStyles, /button,\s*input,\s*select,\s*textarea\s*\{[\s\S]*?color:\s*var\(--pine-950\);[\s\S]*?font:\s*inherit;/);
  assert.doesNotMatch(mainStyles, /var\(--ink\)/);
  assert.match(mainStyles, /\.workspace-grid\s*>\s*\*,\s*#workspace-main\s*\{\s*min-width:\s*0/);
  assert.doesNotMatch(mainStyles, /\.timeline-chart-scroll\s*\{[^}]*max-width:\s*100%|\.timeline-chart-scroll\s*\{[^}]*min-width:\s*0/);
  assert.doesNotMatch(mainStyles, /#timeline-results\s*\{?\s*min-width:\s*0/);
  assert.match(mainStyles, /\.memory-toolbar\s*>\s*label\.secondary\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/);
  assert.match(mainStyles, /\.memory-entry-grid button\s*\{[^}]*color:\s*var\(--pine-950\)/);

  for (const styles of [mainStyles, themeStyles, kitStyles]) {
    assert.doesNotMatch(styles, /input:not\(\[type="checkbox"\]\)[\s\S]*?textarea\s*\{\s*font-size:\s*16px\s*!important/);
  }

  const compactActions = themeStyles.match(/@media \(max-width: 620px\)[\s\S]*?@media|@media \(max-width: 620px\)[\s\S]*$/)?.[0] || "";
  assert.match(compactActions, /\.theme-inline-actions button,[\s\S]*?min-height:\s*44px/);
  assert.match(compactActions, /\.theme-inline-actions button,[\s\S]*?font-size:\s*10px/);
  assert.match(compactActions, /\.theme-inline-actions button,[\s\S]*?white-space:\s*normal/);
});

test("theme studio remains a single removable frontend integration", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  const entry = /\s*(?:<script[^>]*data-stone-theme-entry[^>]*><\/script>|<link[^>]*data-stone-theme-entry[^>]*>)/g;
  const matches = html.match(entry) || [];
  const detachedHtml = html.replace(entry, "");

  assert.equal(matches.length, 8);
  assert.doesNotMatch(detachedHtml, /theme-studio/);
  assert.doesNotMatch(app, /theme-studio|stone-memory-ui-theme/);
  assert.doesNotMatch(server, /theme-studio|stone-memory-ui-theme/);

  const externalReferences = [];
  const externalThemePersistence = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (absolute === path.join(publicDir, "theme-studio")) continue;
        visit(absolute);
        continue;
      }
      if (!/\.(?:html|js|css)$/.test(entry.name)) continue;
      const source = fs.readFileSync(absolute, "utf8");
      if (/\/theme-studio\//.test(source)) {
        externalReferences.push(path.relative(publicDir, absolute).replaceAll("\\", "/"));
      }
      if (/stone-memory-ui-theme-v1/.test(source)) {
        externalThemePersistence.push(path.relative(publicDir, absolute).replaceAll("\\", "/"));
      }
    }
  };
  visit(publicDir);
  assert.deepEqual(externalReferences, ["developer-kit/runtime.js", "index.html"]);
  assert.deepEqual(externalThemePersistence, []);
});

test("theme studio uses only the Stone Memory visual vocabulary and original presets", () => {
  const repoDir = path.join(__dirname, "..");
  const publicDir = path.join(repoDir, "src", "web", "public");
  const themeDir = path.join(publicDir, "theme-studio");
  const sourceFiles = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:css|html|js|json|md)$/.test(entry.name)) sourceFiles.push(absolute);
    }
  };
  visit(publicDir);
  visit(path.join(repoDir, "sm-developer-docs"));
  const rootAgents = path.join(repoDir, "AGENTS.md");
  if (fs.existsSync(rootAgents)) sourceFiles.push(rootAgents);
  const source = sourceFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
  const retiredIdentifiers = [
    ["Tidal", "Echo"].join("_"),
    ["Pearl", "Tide"].join(" "),
    ["Har", "bor"].join(""),
    ["stone", "tide"].join("-"),
    ["tidal", "visual"].join("-"),
    ["tidal", "tokens"].join("-"),
  ];
  for (const identifier of retiredIdentifiers) assert.equal(source.toLowerCase().includes(identifier.toLowerCase()), false, identifier);

  assert.equal(fs.existsSync(path.join(themeDir, "theme-tokens.css")), true);
  assert.equal(fs.existsSync(path.join(themeDir, ["tidal", "tokens.css"].join("-"))), false);
  const contract = JSON.parse(fs.readFileSync(path.join(themeDir, "contract.json"), "utf8"));
  const standalone = fs.readFileSync(path.join(themeDir, "standalone-app.js"), "utf8");
  assert.equal(contract.coreTokenPrefix, "--stone-theme-");
  assert.match(standalone, /pineInk:[\s\S]*?name:\s*"松烟青"/);
  assert.doesNotMatch(standalone, /clayPaper|陶土纸/);
  assert.match(standalone, /RETIRED_THEME_FINGERPRINTS/);
  assert.match(standalone, /isRetiredBuiltinTheme\(input\)/);

  const retiredVisualValues = [
    ["#f7", "fafc"].join(""),
    ["#253", "447"].join(""),
    ["#4c", "6378"].join(""),
    ["#f4", "f2ef"].join(""),
    ["#364", "04b"].join(""),
    ["#4a", "5d6c"].join(""),
  ];
  for (const value of retiredVisualValues) assert.equal(source.toLowerCase().includes(value), false, value);
});

test("semantic theme covers mining calendar states and preserves the developer lab visual layer", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public", "theme-studio");
  const developerRuntime = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "developer-kit", "runtime.js"), "utf8");
  const contract = JSON.parse(fs.readFileSync(path.join(publicDir, "contract.json"), "utf8"));
  const legacyV1 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "theme-studio-v1.json"), "utf8"));
  const legacyV2 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "theme-studio-v2.json"), "utf8"));
  const coverage = fs.readFileSync(path.join(publicDir, "theme-coverage.css"), "utf8");
  const developer = fs.readFileSync(path.join(publicDir, "developer-common.css"), "utf8");
  const workbench = fs.readFileSync(path.join(publicDir, "theme-workbench.css"), "utf8");
  const tokens = fs.readFileSync(path.join(publicDir, "theme-tokens.css"), "utf8");
  const bootstrap = fs.readFileSync(path.join(publicDir, "bootstrap.js"), "utf8");
  const standalone = fs.readFileSync(path.join(publicDir, "standalone-app.js"), "utf8");
  const standaloneCss = fs.readFileSync(path.join(publicDir, "standalone.css"), "utf8");

  for (const state of ["mining-none", "mining-pending", "mining-light", "mining-deep", "mining-failed", "mining-running"]) {
    assert.match(coverage, new RegExp(`calendar-day\\.${state}`));
  }
  for (const level of ["level-0", "level-1", "level-2", "level-3"]) {
    assert.ok(coverage.includes(`conversation-legend .${level}`));
  }
  assert.match(coverage, /calendar-day\.level-3[\s\S]*stone-theme-accent/);
  const activityLevels = coverage.match(/body\.stone-theme-enabled \.calendar-day\.level-1,[\s\S]*?body\.stone-theme-enabled \.calendar-day\.mining-none/)?.[0] || "";
  assert.match(activityLevels, /stone-theme-accent/);
  assert.doesNotMatch(activityLevels, /stone-theme-status/);
  const miningBloomStates = coverage.match(/body\.stone-theme-enabled \.calendar-day\.mining-light,[\s\S]*?body\.stone-theme-enabled \.calendar-day\.mining-failed/)?.[0] || "";
  assert.match(miningBloomStates, /stone-theme-calendar-bloom/);
  assert.doesNotMatch(miningBloomStates, /stone-theme-status/);
  assert.match(workbench, /body\.stone-theme-enabled \.maintenance-card i\s*\{[\s\S]*?color:\s*var\(--stone-theme-accent-strong\);[\s\S]*?background:\s*var\(--stone-theme-accent-soft\)/);
  assert.match(workbench, /body\.stone-theme-enabled \.maintenance-card:hover i\s*\{[\s\S]*?color:\s*var\(--stone-theme-canvas\);[\s\S]*?background:\s*var\(--stone-theme-accent\)/);
  assert.match(tokens, /body\.stone-theme-enabled \.memory-entry-grid button,[\s\S]*?box-shadow:\s*var\(--stone-theme-shadow-card\)/);
  assert.match(tokens, /body\.stone-theme-enabled \.memory-entry-grid strong\s*\{[\s\S]*?font-family:\s*var\(--stone-theme-font-display\)/);
  assert.match(workbench, /body\.stone-theme-enabled \.memory-entry-grid button\s*\{[\s\S]*?border-radius:\s*var\(--stone-theme-radius-lg\)/);
  assert.match(workbench, /body\.stone-theme-enabled \.memory-entry-grid button:not\(:disabled\):hover\s*\{[\s\S]*?box-shadow:\s*var\(--stone-theme-shadow-panel\)/);
  const calendarSurface = coverage.match(/body\.stone-theme-enabled \.activity-calendar,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || "";
  const newCardSurface = coverage.match(/body\.stone-theme-enabled \.new-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(calendarSurface, /stone-theme-accent-soft/);
  assert.match(newCardSurface, /stone-theme-accent-soft/);
  assert.match(developer, /developer-experiment-card[\s\S]*linear-gradient/);
  const developerCards = developer.match(/body\.stone-theme-enabled \.developer-experiment-card,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || "";
  const developerEnter = developer.match(/body\.stone-theme-enabled \.developer-enter\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(developerCards, /stone-theme-surface/);
  assert.match(developerCards, /stone-theme-accent-soft/);
  assert.doesNotMatch(developerCards, /stone-theme-ink\)\s*90%/);
  assert.match(developerEnter, /stone-theme-accent/);
  assert.match(developerEnter, /stone-theme-shadow-button/);
  assert.doesNotMatch(developer, /developer-experiment-card::before\s*\{\s*display:\s*none/);
  assert.doesNotMatch(developer, /developer-experiment-glow\s*\{\s*display:\s*none/);
  assert.match(coverage, /new-card span[\s\S]*stone-theme-accent-soft/);
  const topbarRule = workbench.match(/body\.stone-theme-enabled \.topbar\s*\{([\s\S]*?)\}/)?.[1] || "";
  const sidebarRule = workbench.match(/body\.stone-theme-enabled \.sidebar\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(topbarRule, /\b(?:margin|padding)\s*:/);
  assert.doesNotMatch(sidebarRule, /\b(?:margin|padding)\s*:/);
  assert.match(topbarRule, /background:\s*transparent/);
  assert.match(sidebarRule, /background:\s*transparent/);
  assert.match(tokens, /--stone-theme-font-display:\s*Georgia,\s*"Noto Serif SC",\s*serif/);
  assert.match(tokens, /--stone-theme-font-body:\s*Inter,\s*"Noto Sans SC",\s*"Microsoft YaHei",\s*system-ui,\s*sans-serif/);
  assert.doesNotMatch(bootstrap, /path:\s*"tokens\.typography\./);
  assert.match(standalone, /if\s*\(group === "typography"\)\s*continue/);
  assert.doesNotMatch(standalone, /Cormorant Garamond|Songti SC|STSong|SimSun/);
  assert.match(standalone, /garden:[\s\S]*shadows:\s*\{[\s\S]*rgba\(153,\s*95,\s*143/);
  assert.match(standalone, /sakuraNight:[\s\S]*name:\s*"樱夜黑粉"[\s\S]*contributor:\s*"@钦天监秋"/);
  assert.match(standalone, /data-community-theme="sakuraNight"[\s\S]*贡献人：@钦天监秋/);
  assert.match(standalone, /tokens:\s*\{\s*colors:\s*preset\.colors,\s*shadows:\s*preset\.shadows\s*\}/);
  assert.match(bootstrap, /theme-studio\/\$\{file\}\?v=\$\{THEME_STYLE_VERSION\}/);

  assert.match(tokens, /--stone-theme-page-background:/);
  assert.match(tokens, /--stone-theme-custom-page-background:/);
  assert.match(tokens, /--stone-theme-page-glow-strong:/);
  assert.match(tokens, /:root\[data-stone-theme\]:not\(\[data-stone-theme="Stone Memory Original"\]\)/);
  assert.match(tokens, /body\.stone-theme-enabled\s*\{[\s\S]*?background:\s*var\(--stone-theme-page-background\)/);
  assert.doesNotMatch(workbench, /body\.stone-theme-enabled::before/);
  assert.doesNotMatch(tokens, /rgba\(196,\s*211,\s*223/);
  assert.match(tokens, /--moss-500:\s*var\(--stone-theme-accent\)/);
  assert.match(tokens, /--moss-300:\s*color-mix\([^;]*--stone-theme-accent/);
  assert.match(tokens, /--moss-200:\s*color-mix\([^;]*--stone-theme-accent-soft/);
  assert.match(tokens, /--earth:\s*var\(--stone-theme-ink-faint\)/);

  assert.equal(contract.version, 3);
  assert.equal(contract.$schema, "https://stone-memory.local/schemas/ui-theme-v3.json");
  assert.equal("description" in contract.defaults, false);
  assert.equal(legacyV1.version, 1);
  assert.equal(legacyV2.version, 2);
  assert.equal(legacyV1.tokens.colors.accent, "#123456");
  assert.equal(legacyV2.tokens.colors.accent, "#654321");
  for (const token of ["status", "danger", "warning", "info", "conflict", "fusion"]) {
    assert.ok(contract.editable.colors.includes(token), `${token} should be editable`);
    assert.equal(typeof contract.defaults.tokens.colors[token], "string");
    assert.match(developerRuntime, new RegExp(`"--stone-theme-${token}"`));
  }
  assert.ok(contract.editable.colors.includes("calendarBloom"), "calendarBloom should be editable");
  assert.equal(contract.defaults.tokens.colors.calendarBloom, "#d98794");
  assert.match(bootstrap, /calendarBloom:\s*"--stone-theme-calendar-bloom"/);
  assert.match(developerRuntime, /"--stone-theme-calendar-bloom"/);
  assert.match(standalone, /tokens\.colors\.calendarBloom/);
  assert.match(standalone, /calendarBloom:\s*"记忆花色"/);
  assert.match(standalone, /calendarBloom:\s*"calendar-bloom"/);
  assert.match(bootstrap, /sessionStorage\.setItem\(MODULE_THEME_BRIDGE_KEY/);
  assert.match(standalone, /sessionStorage\.setItem\(MODULE_THEME_BRIDGE_KEY/);
  assert.match(developerRuntime, /sessionStorage\.getItem\(MODULE_THEME_BRIDGE_KEY\)/);
  assert.doesNotMatch(developerRuntime, /localStorage|stone-memory-ui-theme-v1/);
  assert.match(standalone, /\!\[1,\s*2,\s*3\]\.includes\(inputVersion\)/);
  assert.match(bootstrap, /\!\[1,\s*2,\s*3\]\.includes\(inputVersion\)/);
  assert.match(standalone, /已有 version 1 和 version 2 主题仍可导入/);
  assert.match(bootstrap, /applyLogo\(saved\.assets\?\.logo\)/);
  assert.match(bootstrap, /const normalized = \{\s*\$schema: contract\.\$schema,/);
  assert.match(standalone, /const theme = \{\s*\$schema: state\.contract\.\$schema,/);
  assert.match(standalone, /const exportedTheme = \{[\s\S]*?\$schema:[\s\S]*?version:[\s\S]*?name:[\s\S]*?assets:[\s\S]*?tokens:/);
  assert.doesNotMatch(standalone, /JSON\.stringify\(state\.theme,\s*null,\s*2\)/);
  assert.match(standalone, /theme-calendar-preview/);
  for (const state of ["mining-none", "mining-pending", "mining-light", "mining-deep"]) {
    assert.match(standalone, new RegExp(`class="${state}`));
  }
  assert.match(standalone, /浅、深花色跟随“界面色 → 记忆花色”/);
  assert.match(standalone, /选中外圈继续跟随强调色/);
  assert.doesNotMatch(standalone, /活动强度复用“界面色 → 强调色”|18% \/ 44% \/ 100%/);
  assert.match(standaloneCss, /\.theme-calendar-preview \.mining-light\s*\{[\s\S]*?stone-theme-calendar-bloom/);
  assert.match(standaloneCss, /\.theme-calendar-preview \.mining-deep\s*\{[\s\S]*?background:\s*var\(--stone-theme-calendar-bloom\)/);
  assert.match(standaloneCss, /\.theme-calendar-preview \.selected\s*\{[\s\S]*?outline:\s*2px solid var\(--stone-theme-accent\)/);
  assert.match(standalone, /hasCalendarBloom[\s\S]*merged\.tokens\.colors\.calendarBloom\s*=\s*merged\.tokens\.colors\.accent/);
  assert.match(bootstrap, /hasCalendarBloom[\s\S]*merged\.tokens\.colors\.calendarBloom\s*=\s*merged\.tokens\.colors\.accent/);
  assert.match(standalone, /分别跟随“状态色”中的正常、警告、信息、冲突、融合与危险颜色/);
  assert.match(standaloneCss, /\.theme-preview-hint\s*\{[\s\S]*?font-size:\s*9px/);
  assert.match(standalone, /tokens\.colors\.status/);
  assert.match(standalone, /tokens\.colors\.fusion/);
  const tokenFields = standaloneCss.match(/\.token-group-fields\s*\{([\s\S]*?)\}/)?.[1] || "";
  const compactLayout = standaloneCss.match(/@media \(max-width: 620px\)\s*\{([\s\S]*)\}\s*$/)?.[1] || "";
  const extremeNarrowLayout = standaloneCss.match(/@media \(max-width: 340px\)\s*\{([\s\S]*?)\}\s*$/)?.[1] || "";
  assert.match(tokenFields, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/);
  assert.doesNotMatch(tokenFields, /grid-auto-flow|overflow-x/);
  assert.match(compactLayout, /\.token-group-fields,[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(compactLayout, /\.theme-color-picker[\s\S]*width:\s*26px/);
  assert.match(compactLayout, /\.theme-color-picker[\s\S]*height:\s*26px/);
  assert.match(compactLayout, /\.token-group \.theme-value-input\s*\{\s*font-size:\s*11px\s*!important/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field\s*\{[\s\S]*?grid-template-columns:\s*60px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*32px/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field > label\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?white-space:\s*nowrap/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field input\s*\{[\s\S]*?height:\s*30px;[\s\S]*?padding-inline:\s*3px/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-color-picker\s*\{[\s\S]*?width:\s*18px\s*!important;[\s\S]*?height:\s*18px\s*!important/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-value-input\s*\{\s*font-size:\s*12px\s*!important/);
  assert.match(compactLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field\.is-color \.theme-value-input\s*\{[\s\S]*?font-size:\s*10px\s*!important;[\s\S]*?letter-spacing:\s*-0\.6px/);
  assert.match(extremeNarrowLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field\s*\{[\s\S]*?grid-template-columns:\s*60px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*32px/);
  assert.match(extremeNarrowLayout, /\.token-group:not\(\.token-group-shadow\) \.theme-field\.is-color \.theme-value-input\s*\{[\s\S]*?font-size:\s*9px\s*!important;[\s\S]*?letter-spacing:\s*-0\.5px/);
  assert.doesNotMatch(compactLayout, /\.theme-value-input[\s\S]*transform:\s*scale\(\.8\)/);
  assert.match(standalone, /theme-card-meta[\s\S]*theme-credit[\s\S]*theme-file-badge/);
  assert.match(standalone, /createUtilityGroup\("主题",\s*"命名、保存、导入与切换主题"/);
  assert.match(standalone, /createUtilityGroup\("品牌图标"/);
  assert.match(standalone, /originalTokenStack\.append\(themeGroup\.section,\s*logoGroup\.section,\s*tokenFields\)/);
  assert.match(standalone, /topbar\.remove\(\)/);
  assert.doesNotMatch(standalone.match(/const FIELD_GROUPS = \[[\s\S]*?\];/)?.[0] || "", /\border\s*:/);
  assert.match(standalone, /\$\("#save-theme"\)\.after\(\$\("#reset-theme"\)\)/);
  assert.match(standalone, /workbench\.className\s*=\s*"theme-card theme-workbench-card"/);
  assert.match(standalone, /supportCard\.className\s*=\s*"theme-support-card"/);
  assert.match(standalone, /supportCard\.append\(\$\("\.theme-state-preview"\),\s*\$\("\.advanced-json"\)\)/);
  assert.match(standalone, /card\.classList\.add\("theme-topbar"\)/);
  const cardMeta = standaloneCss.match(/\.theme-card-meta\s*\{([\s\S]*?)\}/)?.[1] || "";
  const compactActions = standaloneCss.match(/\.theme-inline-actions button,[\s\S]*?\.theme-inline-upload\s*\{([\s\S]*?)\}/)?.[1] || "";
  const inlineActions = standaloneCss.match(/\.theme-inline-actions\s*\{([\s\S]*?)\}/)?.[1] || "";
  const logoActions = standaloneCss.match(/\.theme-logo-buttons > button,[\s\S]*?\.theme-logo-buttons > label\s*\{([\s\S]*?)\}/)?.[1] || "";
  const logoControls = standaloneCss.match(/\.theme-logo-controls\s*\{([\s\S]*?)\}/)?.[1] || "";
  const logoPreview = standaloneCss.match(/\.theme-logo-preview\s*\{([\s\S]*?)\}/)?.[1] || "";
  const colorPicker = standaloneCss.match(/\.theme-color-picker\s*\{([\s\S]*?)\}/)?.[1] || "";
  const tokenGroup = standaloneCss.match(/\.token-group\s*\{([\s\S]*?)\}/)?.[1] || "";
  const communityAssets = standaloneCss.match(/\.community-assets\s*\{([\s\S]*?)\}/)?.[1] || "";
  const statePreview = standaloneCss.match(/\.theme-state-preview\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(cardMeta, /justify-content:\s*space-between/);
  assert.match(compactActions, /min-height:\s*26px/);
  assert.match(inlineActions, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(inlineActions, /flex-wrap/);
  assert.match(compactLayout, /\.theme-inline-actions\s*\{[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(standalone, /\$\("#save-theme"\)\.textContent = "保存主题"/);
  assert.match(standalone, /\$\("#reset-theme"\)\.textContent = "恢复原版"/);
  assert.match(standalone, /\$\("#export-theme"\)\.textContent = "导出当前主题"/);
  assert.match(standalone, /theme-swatch-more[\s\S]*?theme-swatch-color theme-swatch-add-color[\s\S]*?theme-more-dots[\s\S]*?<b><\/b><b><\/b><b><\/b>/);
  assert.match(standaloneCss, /\.theme-more-dots\s*\{[\s\S]*?inline-flex/);
  assert.match(standaloneCss, /\.theme-more-dots b\s*\{[\s\S]*?position:\s*static;[\s\S]*?flex:\s*0 0 5px;[\s\S]*?opacity:\s*1;/);
  assert.match(logoActions, /min-height:\s*26px/);
  assert.match(standaloneCss, /\.theme-logo-buttons\s*\{[\s\S]*?align-content:\s*end;[\s\S]*?gap:\s*6px/);
  assert.match(logoControls, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*84px/);
  assert.match(logoControls, /justify-self:\s*start/);
  assert.match(logoControls, /justify-content:\s*start/);
  assert.match(logoControls, /width:\s*min\(100%,\s*294px\)/);
  assert.match(logoControls, /"preview buttons"[\s\S]*"status \."/);
  assert.match(logoPreview, /aspect-ratio:\s*1/);
  assert.match(logoPreview, /max-width:\s*200px/);
  assert.doesNotMatch(compactLayout, /\.theme-logo-preview\s*\{[^}]*max-width:\s*none/);
  assert.match(standaloneCss, /\.theme-logo-preview img\s*\{[\s\S]*?object-fit:\s*contain/);
  assert.match(standaloneCss, /\.theme-logo-status\.error\s*\{[^}]*stone-theme-danger/);
  assert.match(standalone, /logoStatus\(`Logo 上传失败：\$\{error\.message\}`,\s*true\)/);
  assert.match(standalone, /remove\.hidden\s*=\s*false;[\s\S]*remove\.disabled\s*=\s*!logo/);
  assert.match(standaloneCss, /\.secondary,\s*\.ghost,\s*\.theme-upload\s*\{/);
  assert.match(standaloneCss, /\.advanced-json summary\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent/);
  assert.match(standalone, /function parseShadowValue\(value\)/);
  assert.match(standalone, /function composeShadowValue\(editor\)/);
  assert.match(standalone, /<details class="token-group token-group-shadow theme-shadow-group">/);
  assert.match(standalone, /partInput\("x",\s*"横向偏移"/);
  assert.match(standalone, /partInput\("opacity",\s*"透明度 %"/);
  assert.match(standalone, /complex old value|复杂旧值/);
  assert.match(standalone, /theme-field theme-shadow-part[\s\S]*?theme-control[\s\S]*?class="theme-value-input"/);
  assert.match(standalone, /theme-field theme-shadow-part is-color[\s\S]*?theme-color-picker[\s\S]*?class="theme-value-input"/);
  assert.match(standalone, /theme-shadow-raw[\s\S]*?class="theme-field"[\s\S]*?class="theme-control"[\s\S]*?class="theme-value-input"/);
  assert.match(standaloneCss, /\.theme-shadow-group > summary\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(standaloneCss, /\.token-group-shadow\.theme-shadow-group \.token-group-fields\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(standaloneCss, /\.theme-shadow-group\[open\] > \.token-group-fields\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?box-shadow:\s*var\(--stone-theme-shadow-floating\)/);
  assert.match(standaloneCss, /\.theme-shadow-group\[open\] > \.token-group-fields\s*\{[\s\S]*?border-radius:\s*var\(--stone-theme-radius-lg\)/);
  assert.match(standaloneCss, /\.theme-shadow-field\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-top:\s*1px solid var\(--stone-theme-line-soft\);[\s\S]*?border-radius:\s*0/);
  assert.match(compactLayout, /\.theme-shadow-parts\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(compactLayout, /\.theme-shadow-group\[open\] > \.token-group-fields\s*\{[\s\S]*?border-radius:\s*19px/);
  assert.match(compactLayout, /\.token-group-shadow \.theme-shadow-part\s*\{[\s\S]*?grid-template-columns:\s*50px minmax\(0,\s*1fr\);[\s\S]*?min-height:\s*32px/);
  assert.match(compactLayout, /\.token-group-shadow \.theme-shadow-part > label\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?white-space:\s*nowrap/);
  assert.match(compactLayout, /\.token-group-shadow \.theme-shadow-part \.theme-color-picker\s*\{[\s\S]*?width:\s*18px\s*!important;[\s\S]*?height:\s*18px\s*!important/);
  assert.doesNotMatch(standaloneCss, /\.theme-shadow-parts input/);
  assert.match(standaloneCss, /\.theme-token-groups\s*\{\s*display:\s*contents;\s*\}/);
  assert.match(standaloneCss, /\.theme-groups\s*\{[\s\S]*?align-items:\s*start;[\s\S]*?align-content:\s*start/);
  assert.match(tokenFields, /align-items:\s*start/);
  assert.match(tokenFields, /align-content:\s*start/);
  assert.match(standaloneCss, /\.theme-groups > \.token-group:first-child\s*\{\s*border-top:\s*0;\s*\}/);
  assert.match(standaloneCss, /@media \(min-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(standaloneCss, /@media \(min-width:\s*900px\)[\s\S]*?\.theme-workbench-card\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/);
  assert.match(standaloneCss, /\.theme-groups::before,\s*\.theme-groups::after\s*\{[\s\S]*?inset-block:\s*0;[\s\S]*?width:\s*calc\(\(100%\s*-\s*22px\)\s*\/\s*2\)/);
  assert.match(standaloneCss, /\.theme-groups::before\s*\{\s*left:\s*0;\s*\}[\s\S]*?\.theme-groups::after\s*\{\s*right:\s*0;\s*\}/);
  assert.match(standaloneCss, /\.token-group-logo,\s*\.theme-token-groups > \.token-group:nth-child\(even\)\s*\{[\s\S]*?border-left:\s*0/);
  assert.match(standaloneCss, /\.theme-support-card\s*\{\s*display:\s*contents;\s*\}/);
  assert.match(standaloneCss, /@media \(min-width:\s*900px\)[\s\S]*?\.theme-support-card\s*\{[\s\S]*?border:\s*1px solid var\(--stone-theme-line-soft\);[\s\S]*?background:\s*var\(--stone-theme-surface\);[\s\S]*?box-shadow:\s*var\(--stone-theme-shadow-card\)/);
  assert.match(standaloneCss, /\.token-group-head\s*\{[\s\S]*?justify-content:\s*space-between/);
  assert.doesNotMatch(standaloneCss, /\.token-group-head > span/);
  assert.match(standalone, /const displayValue = definition\.kind === "color" \? colorToHex\(value\)\.toLowerCase\(\) : value/);
  assert.match(colorPicker, /width:\s*32px/);
  assert.match(colorPicker, /height:\s*32px/);
  assert.match(colorPicker, /aspect-ratio:\s*1/);
  assert.match(standaloneCss, /\.theme-swatch-color\s*\{[\s\S]*?width:\s*48px;[\s\S]*?height:\s*36px;/);
  assert.doesNotMatch(tokenGroup, /\bbackground\s*:|border-radius\s*:/);
  assert.doesNotMatch(communityAssets, /\bbackground\s*:|border-radius\s*:/);
  assert.doesNotMatch(statePreview, /\bbackground\s*:|border-radius\s*:/);
  assert.match(standaloneCss, /\.theme-card-intro\s*\{[\s\S]*?font-size:\s*11px/);
  assert.match(bootstrap, /fetch\(CONTRACT_URL\)/);
  assert.doesNotMatch(bootstrap, /const DEFAULT_THEME\s*=/);
  assert.match(bootstrap, /Number\(parsed\.version \|\| 1\) !== contract\.version/);
});
