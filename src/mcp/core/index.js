const { SEARCH_ONLY, NOTEBOOK_STEWARD_MODE, MAX_DEEP_SEARCH_TOOL_CALLS, MAX_NOTEBOOK_STEWARD_TOOL_CALLS } = require("./shared");
const { TOOLS, SEARCH_TOOLS, NOTEBOOK_STEWARD_TOOLS } = require("./definitions");
const { toolTriggersCheck, toolStatus } = require("./memory");
const { toolNotebookTopicManage, toolNotebookWrite, toolNotebookDelegate, toolInternalNotebookCatalog, toolInternalNotebookSearch, toolInternalNotebookRead } = require("./notebook");
const { toolRebuildPreview, toolRebuild } = require("./rebuild");
const { toolMine } = require("./mining");
const { toolDreamLatest, toolDreamStatus, toolDreamGet } = require("./dream");
const { toolMemorySearch, toolDeepSearch, toolInternalKeywordSearch, toolInternalArchiveContext } = require("./search");
const { toolAuditList, toolAuditMark, toolAuditQuery } = require("./audit");
let deepSearchToolCalls = 0;
let notebookStewardToolCalls = 0;
function call(name, args = {}) {
  let text;
  let isError = false;
  try {
    if (NOTEBOOK_STEWARD_MODE) {
      notebookStewardToolCalls++;
      if (notebookStewardToolCalls > MAX_NOTEBOOK_STEWARD_TOOL_CALLS) {
        text = "已达到本次笔记管家的 6 次工具调用上限，请根据现有信息返回操作计划。";
      } else if (name === "notebook_catalog") text = toolInternalNotebookCatalog();
      else if (name === "notebook_search") text = toolInternalNotebookSearch(args);
      else if (name === "notebook_read") text = toolInternalNotebookRead(args);
      else throw new Error(`笔记管家模式不提供工具: ${name}`);
    } else if (SEARCH_ONLY) {
      deepSearchToolCalls++;
      if (deepSearchToolCalls > MAX_DEEP_SEARCH_TOOL_CALLS) {
        text = "已达到本次 Deep Search 的 5 次工具调用上限，请根据现有证据组织最终回答。";
      } else if (name === "memory_keyword_search") text = toolInternalKeywordSearch(args);
      else if (name === "memory_archive_context") text = toolInternalArchiveContext(args);
      else throw new Error(`搜索模式不提供工具: ${name}`);
    } else if (name === "stmem_memory_rebuild") text = toolRebuild(args);
    else if (name === "stmem_memory_rebuild_preview") text = toolRebuildPreview(args);
    else if (name === "stmem_memory_mine") text = toolMine(args);
    else if (name === "stmem_memory_status") text = toolStatus();
    else if (name === "stmem_dream_latest") text = toolDreamLatest(args);
    else if (name === "stmem_dream_status") text = toolDreamStatus(args);
    else if (name === "stmem_dream_get") text = toolDreamGet(args);
    else if (name === "stmem_notebook_topic_manage") text = toolNotebookTopicManage(args);
    else if (name === "stmem_notebook_write") text = toolNotebookWrite(args);
    else if (name === "stmem_notebook_delegate") text = toolNotebookDelegate(args);
    else if (name === "stmem_memory_search") text = toolMemorySearch(args);
    else if (name === "stmem_memory_deep_search") text = toolDeepSearch(args);
    else if (name === "stmem_memory_audit_list") text = toolAuditList(args);
    else if (name === "stmem_memory_audit_mark") text = toolAuditMark(args);
    else if (name === "stmem_memory_audit_query") text = toolAuditQuery(args);
    else if (name === "stmem_memory_triggers_check") text = toolTriggersCheck(args);
    else throw new Error(`未知工具: ${name}`);
  } catch (err) {
    text = `工具执行错误: ${err.message}`;
    isError = true;
  }

  return { content: [{ type: "text", text }], isError };
}
module.exports = { tools: NOTEBOOK_STEWARD_MODE ? NOTEBOOK_STEWARD_TOOLS : SEARCH_ONLY ? SEARCH_TOOLS : TOOLS, call };
