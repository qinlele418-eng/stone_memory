// Migrated public Notebook tools; definitions and dispatch are owned by this module.
const tools = [
  {
    "name": "status",
    "description": "高级/调试用低层工具：查看当前记忆体的主题目录与安全概览。日常自然语言操作优先使用 stmem_notebook_delegate。封存笔记不返回正文摘要。",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "query",
    "description": "高级/调试用低层工具：组合搜索主题笔记。日常查询优先使用 stmem_notebook_delegate。包含封存笔记，因为封存不是 Agent 读取权限。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        },
        "topicId": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "maxItems": 20,
          "description": "需要全部命中的精确标签，可与 query/topicId 组合。"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "read",
    "description": "高级/调试用低层工具：按 noteId 读取完整 Markdown。日常读取优先使用 stmem_notebook_delegate；返回 revision 供安全修改。",
    "inputSchema": {
      "type": "object",
      "required": [
        "noteId"
      ],
      "properties": {
        "noteId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  }
];
module.exports = {
  tools: () => structuredClone(tools),
  async call(context, name, args) {
    let result;
    if (name === "status") result = context.core.notebook.catalog();
    else if (name === "query") result = context.core.notebook.search({
      query: args.query || "", topicId: args.topicId || null, tags: args.tags || [], limit: args.limit,
    });
    else if (name === "read") result = context.core.notebook.read(args.noteId) || { found: false, threadId: context.memoryId, noteId: args.noteId };
    else throw new Error("unknown notebook tool");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  },
};
