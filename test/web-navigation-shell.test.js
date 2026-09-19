const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const publicDir = path.join(__dirname, "..", "src", "web", "public");

test("responsive navigation shell delegates to the stable frontend", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const adapter = fs.readFileSync(path.join(publicDir, "developer-kit", "navigation-shell.js"), "utf8");
  const styles = fs.readFileSync(path.join(publicDir, "developer-kit", "navigation-shell.css"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");

  for (const action of ["home", "memory", "workshop", "me"]) {
    assert.match(html, new RegExp(`data-shell-action="${action}"`));
  }
  assert.ok(html.indexOf("/app.js?v=40") < html.indexOf("/developer-kit/navigation-shell.js?v=3"));
  assert.match(html, /\/developer-kit\/navigation-shell\.css\?v=5/);
  assert.match(adapter, /MutationObserver/);
  assert.match(adapter, /data-view="\$\{view\}"/);
  assert.match(adapter, /openWorkshop/);
  assert.match(adapter, /StoneLegacyNavigation\?\.openAbout/);
  assert.match(adapter, /StoneLegacyNavigation\?\.openHome/);
  assert.match(adapter, /StoneLegacyNavigation\.openMemory/);
  assert.match(adapter, /state === "global-about"/);
  assert.match(adapter, /state === "global-workshop"/);
  assert.match(app, /function renderMyContent/);
  assert.match(app, /关注项目/);
  assert.match(app, /召唤赞赏码/);
  assert.match(app, /class="workspace-nav"/);
  for (const tab of ["概况", "记忆", "上下文状态", "接入", "设置"]) {
    assert.match(app, new RegExp(`<span>${tab}</span>`));
  }
  for (const content of ["已生长了", "原始对话", "原始线程总体积", "当前对话线程信息", "当前窗口上下文", "当前窗口注入", "自动化设置"]) {
    assert.match(app, new RegExp(content));
  }
  assert.match(app, /contextUsageHint\(usage,data\.automaticFullMining\)/);
  assert.match(app, /context-usage-track/);
  assert.match(app, /data\.contextUsage/);
  assert.match(app, /重建目标窗口/);
  assert.match(app, /name="rebuild-binding"/);
  assert.match(app, /bindingId:rebuildState\.bindingMemoryId===library\.threadId\?rebuildState\.bindingId:null/);
  assert.match(app, /automationSwitch\("automaticFullMining"/);
  assert.match(app, /automationSwitch\("automaticMemoryMaintenance"/);
  assert.match(app, /automationSwitch\("automaticCompression"/);
  const managementTabs = app.match(/function managementNav\(active="overview"\)[\s\S]*?let settingsRenderVersion/)?.[0] || "";
  assert.match(managementTabs, /return ""/);
  assert.doesNotMatch(managementTabs, /管理二级导航|data-management-view|管理概览|摘要记忆|对话档案|上下文与线程|数据维护/);
  const managementOverview = app.match(/function renderManagement\(library\)[\s\S]*?async function renderAutomation/)?.[0] || "";
  assert.doesNotMatch(managementOverview, /查看记忆、原文和当前上下文/);
  for (const content of ["记忆档案", "人设 / 规则", "摘要", "全量对话", "时间轴", "记忆维护", "数据导入", "管理挖掘素材", "记忆挖掘台", "记忆压缩（测试功能）"]) {
    assert.match(managementOverview, new RegExp(content));
  }
  for (const count of ["counts.rules", "counts.feelings", "counts.messages"]) assert.match(managementOverview, new RegExp(count.replace(".", "\\.")));
  assert.doesNotMatch(managementOverview, /counts\.features|条特征/);
  assert.match(managementOverview, /支持直接导入线程文件或符合格式的对话文件/);
  assert.match(managementOverview, /决定哪些对话、工具链成为挖掘摘要的素材，同时避免反复注入的内容污染摘要库/);
  assert.match(managementOverview, /手动生成多日摘要并审核/);
  assert.match(managementOverview, /renderMemorySection\(library,"rules"\)/);
  assert.match(managementOverview, /renderMemorySection\(library,"feelings"\)/);
  assert.match(managementOverview, /renderConversations\(library\)/);
  assert.match(managementOverview, /renderTimeline\(library\)/);
  assert.match(managementOverview, /renderConversationImport\(library\)/);
  assert.match(managementOverview, /renderToolPolicy\(library\)/);
  assert.match(managementOverview, /renderMining\(library\)/);
  assert.match(managementOverview, /renderCompression\(library\)/);
  assert.match(app, /function renderAccess\(library\)/);
  assert.match(app, /最多同时监听 5 个窗口/);
  assert.match(app, /data-binding-toggle/);
  assert.match(app, /data-binding-delete/);
  assert.match(app, /data-binding-primary/);
  assert.match(app, /settingsRenderVersion/);
  assert.doesNotMatch(app, /querySelector\("\.side-title"\)/);
  assert.match(app, /function showBindingGuide\(library\)/);
  assert.match(app, /请用bind mcp将该窗口和\$\{memoryName\}记忆体绑定/);
  assert.match(app, /copy-binding-command/);
  assert.match(app, /#check-thread, #overview-repair/);
  assert.match(app, /showIntegrity\(library, true\)/);
  assert.doesNotMatch(app, /data-view="developer"/);
  const workspaceTemplate = app.match(/function workspace\(data\)[\s\S]*?function renderAboutContent/)?.[0] || "";
  assert.doesNotMatch(workspaceTemplate, /data-view="about"|renderAbout\(/);
  assert.match(app, /function renderGlobalAbout\(\)/);
  assert.match(app, /class="global-about"/);
  assert.match(app, /StoneLegacyNavigation = Object\.freeze/);
  assert.doesNotMatch(adapter, /\bfetch\s*\(|XMLHttpRequest|StoneDeveloperModule\.api/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /inset:\s*auto 0 0/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(styles, /display:\s*contents/);
  assert.match(styles, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.stone-global-links\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*4/);
  assert.match(styles, /\.stone-global-bottom\s*\{[\s\S]*?grid-column:\s*4/);
  assert.match(styles, /\.stone-global-links\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?border-top:\s*0/);
  assert.match(styles, /\.stone-global-bottom\s*\{[\s\S]*?margin-top:\s*0/);
  assert.match(styles, /min-height:\s*0;[\s\S]*?height:\s*100%/);
  assert.match(styles, /background:\s*var\(--stone-theme-surface\)/);
  assert.match(styles, /button\.active::before[\s\S]*?background:\s*var\(--stone-theme-accent\)/);
});
