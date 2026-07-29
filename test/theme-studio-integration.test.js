const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("main page enables the semantic theme bridge", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "web", "public", "index.html"),
    "utf8",
  );
  assert.match(html, /<body[^>]*\bclass="[^"]*\btidal-visual\b[^"]*"/);
});

test("mobile workspace navigation top-aligns wrapped labels", () => {
  const styles = fs.readFileSync(
    path.join(__dirname, "..", "src", "web", "public", "styles.css"),
    "utf8",
  );
  const mobileNav = styles.match(/@media \(max-width: 760px\) \{[\s\S]*?\.stats-grid/)?.[0] || "";
  assert.match(mobileNav, /\.side-nav\s*\{[^}]*align-items:\s*stretch/);
  assert.match(mobileNav, /\.side-nav button\s*\{[\s\S]*?align-items:\s*flex-start/);
  assert.match(mobileNav, /height:\s*100%/);
  assert.match(mobileNav, /padding:\s*6px 4px 0/);
});

test("mobile pages contain wide workspace content and prevent input zoom", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const mainStyles = fs.readFileSync(path.join(publicDir, "styles.css"), "utf8");
  const themeStyles = fs.readFileSync(path.join(publicDir, "theme-studio", "standalone.css"), "utf8");
  const kitStyles = fs.readFileSync(path.join(publicDir, "developer-kit", "styles.css"), "utf8");
  const reviewStyles = fs.readFileSync(path.join(publicDir, "review-lab", "styles.css"), "utf8");

  assert.match(mainStyles, /\.workspace-grid\s*>\s*\*,\s*#workspace-main\s*\{\s*min-width:\s*0/);
  assert.match(mainStyles, /\.timeline-chart-scroll\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0/);

  for (const styles of [mainStyles, themeStyles, kitStyles, reviewStyles]) {
    assert.match(styles, /textarea\s*\{\s*font-size:\s*16px\s*!important/);
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
  const entry = /<script src="\/theme-studio\/bootstrap\.js" defer><\/script>/g;
  const matches = html.match(entry) || [];
  const detachedHtml = html.replace(entry, "");

  assert.equal(matches.length, 1);
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
  assert.deepEqual(externalReferences, ["index.html"]);
  assert.deepEqual(externalThemePersistence, []);
});

test("semantic theme covers mining calendar states and preserves the developer lab visual layer", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public", "theme-studio");
  const reviewDir = path.join(__dirname, "..", "src", "web", "public", "review-lab");
  const developerRuntime = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "developer-kit", "runtime.js"), "utf8");
  const contract = JSON.parse(fs.readFileSync(path.join(publicDir, "contract.json"), "utf8"));
  const legacyV1 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "theme-studio-v1.json"), "utf8"));
  const legacyV2 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "theme-studio-v2.json"), "utf8"));
  const coverage = fs.readFileSync(path.join(publicDir, "theme-coverage.css"), "utf8");
  const developer = fs.readFileSync(path.join(publicDir, "developer-common.css"), "utf8");
  const workbench = fs.readFileSync(path.join(publicDir, "theme-workbench.css"), "utf8");
  const tokens = fs.readFileSync(path.join(publicDir, "tidal-tokens.css"), "utf8");
  const bootstrap = fs.readFileSync(path.join(publicDir, "bootstrap.js"), "utf8");
  const standalone = fs.readFileSync(path.join(publicDir, "standalone-app.js"), "utf8");
  const standaloneCss = fs.readFileSync(path.join(publicDir, "standalone.css"), "utf8");
  const reviewTheme = fs.readFileSync(path.join(reviewDir, "theme.css"), "utf8");

  for (const state of ["mining-none", "mining-pending", "mining-light", "mining-deep", "mining-failed", "mining-running"]) {
    assert.match(coverage, new RegExp(`calendar-day\\.${state}`));
  }
  for (const level of ["level-0", "level-1", "level-2", "level-3"]) {
    assert.ok(coverage.includes(`conversation-legend .${level}`));
  }
  assert.match(coverage, /calendar-day\.level-3[\s\S]*stone-tide-accent/);
  const activityLevels = coverage.match(/body\.tidal-visual \.calendar-day\.level-1,[\s\S]*?body\.tidal-visual \.calendar-day\.mining-none/)?.[0] || "";
  assert.match(activityLevels, /stone-tide-accent/);
  assert.doesNotMatch(activityLevels, /stone-tide-status/);
  assert.match(coverage, /calendar-day\.mining-deep[\s\S]*stone-tide-status/);
  const calendarSurface = coverage.match(/body\.tidal-visual \.activity-calendar,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || "";
  const newCardSurface = coverage.match(/body\.tidal-visual \.new-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(calendarSurface, /stone-tide-accent-soft/);
  assert.match(newCardSurface, /stone-tide-accent-soft/);
  assert.match(developer, /developer-experiment-card[\s\S]*linear-gradient/);
  const developerCards = developer.match(/body\.tidal-visual \.developer-experiment-card,[\s\S]*?\{([\s\S]*?)\}/)?.[1] || "";
  const developerEnter = developer.match(/body\.tidal-visual \.developer-enter\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(developerCards, /stone-tide-surface/);
  assert.match(developerCards, /stone-tide-accent-soft/);
  assert.doesNotMatch(developerCards, /stone-tide-ink\)\s*90%/);
  assert.match(developerEnter, /stone-tide-accent/);
  assert.match(developerEnter, /stone-tide-shadow-button/);
  assert.doesNotMatch(developer, /developer-experiment-card::before\s*\{\s*display:\s*none/);
  assert.doesNotMatch(developer, /developer-experiment-glow\s*\{\s*display:\s*none/);
  assert.match(coverage, /new-card span[\s\S]*stone-tide-accent-soft/);
  const topbarRule = workbench.match(/body\.tidal-visual \.topbar\s*\{([\s\S]*?)\}/)?.[1] || "";
  const sidebarRule = workbench.match(/body\.tidal-visual \.sidebar\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(topbarRule, /\b(?:margin|padding)\s*:/);
  assert.doesNotMatch(sidebarRule, /\b(?:margin|padding)\s*:/);
  assert.match(topbarRule, /background:\s*transparent/);
  assert.match(sidebarRule, /background:\s*transparent/);
  assert.match(tokens, /--stone-tide-font-display:\s*Georgia,\s*"Noto Serif SC",\s*serif/);
  assert.match(tokens, /--stone-tide-font-body:\s*Inter,\s*"Noto Sans SC",\s*"Microsoft YaHei",\s*system-ui,\s*sans-serif/);
  assert.doesNotMatch(bootstrap, /path:\s*"tokens\.typography\./);
  assert.match(standalone, /if\s*\(group === "typography"\)\s*continue/);
  assert.doesNotMatch(standalone, /Cormorant Garamond|Songti SC|STSong|SimSun/);
  assert.match(standalone, /garden:[\s\S]*shadows:\s*\{[\s\S]*rgba\(153,\s*95,\s*143/);
  assert.match(standalone, /tokens:\s*\{\s*colors:\s*preset\.colors,\s*shadows:\s*preset\.shadows\s*\}/);
  assert.match(bootstrap, /theme-studio\/\$\{file\}\?v=\$\{THEME_STYLE_VERSION\}/);

  const pageGlow = workbench.match(/body\.tidal-visual::before\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(pageGlow, /stone-tide-surface/);
  assert.match(pageGlow, /stone-tide-accent-soft/);
  assert.match(pageGlow, /stone-tide-canvas/);
  assert.doesNotMatch(pageGlow, /rgba\(196,\s*211,\s*223/);
  assert.match(tokens, /--moss-500:\s*var\(--stone-tide-accent\)/);
  assert.match(tokens, /--moss-300:\s*color-mix\([^;]*--stone-tide-accent/);
  assert.match(tokens, /--moss-200:\s*color-mix\([^;]*--stone-tide-accent-soft/);
  assert.match(tokens, /--earth:\s*var\(--stone-tide-ink-faint\)/);
  assert.match(reviewTheme, /\.model-builder,[\s\S]*stone-tide-surface-soft/);
  assert.match(reviewTheme, /--pine:\s*var\(--stone-tide-accent/);
  assert.match(reviewTheme, /\.model:has\(input:checked\),[\s\S]*var\(--pine\)/);

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
    assert.match(developerRuntime, new RegExp(`"--stone-tide-${token}"`));
  }
  assert.match(bootstrap, /sessionStorage\.setItem\(MODULE_THEME_BRIDGE_KEY/);
  assert.match(standalone, /sessionStorage\.setItem\(MODULE_THEME_BRIDGE_KEY/);
  assert.match(developerRuntime, /sessionStorage\.getItem\(MODULE_THEME_BRIDGE_KEY\)/);
  assert.doesNotMatch(developerRuntime, /localStorage|stone-memory-ui-theme-v1/);
  assert.match(standalone, /\!\[1,\s*2,\s*3\]\.includes\(inputVersion\)/);
  assert.match(bootstrap, /\!\[1,\s*2,\s*3\]\.includes\(inputVersion\)/);
  assert.match(standalone, /已有 version 1 和 version 2 主题仍可导入/);
  assert.match(standalone, /delete theme\.description/);
  assert.match(bootstrap, /delete normalized\.description/);
  assert.match(standalone, /const exportedTheme = \{[\s\S]*?\$schema:[\s\S]*?version:[\s\S]*?name:[\s\S]*?assets:[\s\S]*?tokens:/);
  assert.doesNotMatch(standalone, /JSON\.stringify\(state\.theme,\s*null,\s*2\)/);
  assert.match(standalone, /theme-calendar-preview/);
  assert.match(standalone, /活动强度复用“界面色 → 强调色”/);
  assert.match(standalone, /18% \/ 44% \/ 100%/);
  assert.doesNotMatch(standalone, /挖掘轻\/深度/);
  assert.match(standalone, /分别跟随“状态色”中的正常、警告、信息、冲突、融合与危险颜色/);
  assert.match(standaloneCss, /\.theme-preview-hint\s*\{[\s\S]*?font-size:\s*9px/);
  assert.match(standalone, /tokens\.colors\.status/);
  assert.match(standalone, /tokens\.colors\.fusion/);
  const tokenFields = standaloneCss.match(/\.token-group-fields\s*\{([\s\S]*?)\}/)?.[1] || "";
  const compactLayout = standaloneCss.match(/@media \(max-width: 620px\)\s*\{([\s\S]*)\}\s*$/)?.[1] || "";
  assert.match(tokenFields, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/);
  assert.doesNotMatch(tokenFields, /grid-auto-flow|overflow-x/);
  assert.match(compactLayout, /\.token-group-fields,[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(compactLayout, /\.theme-color-picker[\s\S]*width:\s*26px/);
  assert.match(compactLayout, /\.theme-color-picker[\s\S]*height:\s*26px/);
  assert.match(compactLayout, /\.token-group \.theme-field \.theme-value-input[\s\S]*font-size:\s*16px\s*!important/);
  assert.match(compactLayout, /\.token-group \.theme-field \.theme-value-input[\s\S]*transform:\s*scale\(\.8\)/);
  assert.match(compactLayout, /\.theme-field\.is-color \.theme-value-input[\s\S]*flex-basis:\s*calc\(125% - 38\.75px\)/);
  assert.match(standalone, /theme-card-meta[\s\S]*theme-credit[\s\S]*theme-file-badge/);
  assert.match(standalone, /createUtilityGroup\("主题",\s*"命名、保存、导入与切换主题"/);
  assert.match(standalone, /createUtilityGroup\("品牌图标"/);
  assert.match(standalone, /originalTokenStack\.append\(themeGroup\.section,\s*logoGroup\.section,\s*tokenFields\)/);
  assert.match(standalone, /topbar\.remove\(\)/);
  assert.doesNotMatch(standalone.match(/const FIELD_GROUPS = \[[\s\S]*?\];/)?.[0] || "", /\border\s*:/);
  assert.match(standalone, /\$\("#save-theme"\)\.after\(\$\("#reset-theme"\)\)/);
  assert.match(standalone, /workbench\.className\s*=\s*"theme-card theme-workbench-card"/);
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
  assert.match(logoActions, /min-height:\s*26px/);
  assert.match(standaloneCss, /\.theme-logo-buttons\s*\{[\s\S]*?align-content:\s*end;[\s\S]*?gap:\s*6px/);
  assert.match(logoControls, /grid-template-columns:\s*minmax\(120px,\s*180px\)\s*84px/);
  assert.match(logoControls, /"preview buttons"[\s\S]*"status \."/);
  assert.match(logoPreview, /aspect-ratio:\s*1/);
  assert.match(standaloneCss, /\.theme-logo-preview img\s*\{[\s\S]*?object-fit:\s*contain/);
  assert.match(standaloneCss, /\.theme-logo-status\.error\s*\{[^}]*stone-tide-danger/);
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
  assert.match(compactLayout, /\.theme-shadow-parts\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(standaloneCss, /\.theme-shadow-parts input/);
  assert.match(standaloneCss, /\.theme-token-groups\s*\{\s*display:\s*contents;\s*\}/);
  assert.match(standaloneCss, /\.theme-groups\s*\{[\s\S]*?align-items:\s*start;[\s\S]*?align-content:\s*start/);
  assert.match(tokenFields, /align-items:\s*start/);
  assert.match(tokenFields, /align-content:\s*start/);
  assert.match(standaloneCss, /\.theme-groups > \.token-group:first-child\s*\{\s*border-top:\s*0;\s*\}/);
  assert.match(standaloneCss, /@media \(min-width:\s*900px\)[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(standaloneCss, /\.token-group-head\s*\{[\s\S]*?justify-content:\s*space-between/);
  assert.doesNotMatch(standaloneCss, /\.token-group-head > span/);
  assert.match(standalone, /const displayValue = definition\.kind === "color" \? colorToHex\(value\)\.toLowerCase\(\) : value/);
  assert.match(colorPicker, /width:\s*32px/);
  assert.match(colorPicker, /height:\s*32px/);
  assert.match(colorPicker, /aspect-ratio:\s*1/);
  assert.match(standaloneCss, /\.theme-swatch-color\s*\{[\s\S]*?width:\s*52px;[\s\S]*?height:\s*52px;[\s\S]*?aspect-ratio:\s*1/);
  assert.doesNotMatch(tokenGroup, /\bbackground\s*:|border-radius\s*:/);
  assert.doesNotMatch(communityAssets, /\bbackground\s*:|border-radius\s*:/);
  assert.doesNotMatch(statePreview, /\bbackground\s*:|border-radius\s*:/);
  assert.match(standaloneCss, /\.theme-card-intro\s*\{[\s\S]*?font-size:\s*11px/);
  assert.match(bootstrap, /fetch\(CONTRACT_URL\)/);
  assert.doesNotMatch(bootstrap, /const DEFAULT_THEME\s*=/);
  assert.match(bootstrap, /Number\(parsed\.version \|\| 1\) !== contract\.version/);
  assert.match(reviewTheme, /--warning:\s*var\(--stone-tide-warning/);
  assert.match(reviewTheme, /--conflict:\s*var\(--stone-tide-conflict/);
  assert.match(reviewTheme, /--fusion:\s*var\(--stone-tide-fusion/);
  assert.match(reviewTheme, /\.mix-actions \.fusion-button[\s\S]*var\(--fusion\)/);
  assert.match(reviewTheme, /\.item-flag\.conflict,[\s\S]*var\(--conflict\)/);
  assert.doesNotMatch(reviewTheme, /\.mix-actions \.fusion-button\s*\{[^}]*#765a96/);
  assert.doesNotMatch(reviewTheme, /\.status\.has-error\s*\{[^}]*#fff0ea/);
});
