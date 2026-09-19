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
tools.push(...[
  {
    "name": "topic_manage",
    "description": "高级/调试用低层工具：创建或更新主题笔记本。日常归类优先使用 stmem_notebook_delegate。create 需要 name；update 需要 topicId。",
    "inputSchema": {
      "type": "object",
      "required": [
        "action"
      ],
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "create",
            "update"
          ]
        },
        "topicId": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "coverPath": {
          "type": "string",
          "enum": [
            "",
            "preset:forest",
            "preset:mist",
            "preset:amber",
            "preset:berry",
            "preset:night"
          ],
          "description": "内置封面预设；留空或 preset:forest 为默认松林绿。"
        },
        "visibility": {
          "type": "string",
          "enum": [
            "visible",
            "sealed"
          ]
        },
        "archived": {
          "type": "boolean"
        },
        "isDefault": {
          "type": "boolean",
          "description": "是否设为当前记忆体唯一的默认写入主题；不会根据最近使用自动变化。"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "write",
    "description": "高级/调试用低层工具：创建或更新 Markdown 笔记。日常写作优先使用 stmem_notebook_delegate，由管家处理主题和 revision。直接更新必须提供 noteId 与当前 expectedRevision。",
    "inputSchema": {
      "type": "object",
      "required": [
        "title",
        "body"
      ],
      "properties": {
        "noteId": {
          "type": "string"
        },
        "topicId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "maxItems": 20
        },
        "visibility": {
          "type": "string",
          "enum": [
            "visible",
            "sealed"
          ]
        },
        "expectedRevision": {
          "type": "integer",
          "minimum": 1
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "delegate",
    "description": "主题小笔记的日常自然语言入口。主 Agent 只需提供 request；新建或改正文时附 content，可选 title/tags/visibility，查询/读取/移动时不需重传正文。临时规划子代理只有目录、搜索、精读三项只读工具，不持有写权限且不会收到正文；它返回计划后，由 Stone 受控执行器复核 threadId、目标、歧义、主题、路径和 revision，再通过正式 CLI 执行并返回透明收据。纸篓仅用于已有笔记的可逆软删除，不会物理删除。全新记忆体可以是 0 主题、0 笔记。",
    "inputSchema": {
      "type": "object",
      "required": [
        "request"
      ],
      "properties": {
        "request": {
          "type": "string",
          "description": "自然语言意图，例如：把这段旅行心得放到合适的主题；找蒲苇灯塔；给某篇笔记追加一段。"
        },
        "content": {
          "type": "string",
          "description": "需要新建、追加或替换的正文；查询和读取时省略。正文不发送给规划子代理。"
        },
        "title": {
          "type": "string",
          "description": "可选标题；未提供时由笔记管家建议。"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "maxItems": 20
        },
        "visibility": {
          "type": "string",
          "enum": [
            "visible",
            "sealed"
          ]
        },
        "updateMode": {
          "type": "string",
          "enum": [
            "append",
            "replace"
          ],
          "description": "更新笔记时必须明确追加或整体替换。"
        },
        "allowCreateTopic": {
          "type": "boolean",
          "description": "只有明确允许且子代理置信度不低于 0.9 时才可新建主题。"
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  }
]);
module.exports = {
  tools: () => structuredClone(tools),
  async call(context, name, args) {
    let result;
    if (name === "status") result = context.core.notebook.catalog();
    else if (name === "query") result = context.core.notebook.search({
      query: args.query || "", topicId: args.topicId || null, tags: args.tags || [], limit: args.limit,
    });
    else if (name === "read") result = context.core.notebook.read(args.noteId) || { found: false, threadId: context.memoryId, noteId: args.noteId };
    else if (["topic_manage", "write", "delegate"].includes(name)) result = await context.runCommand(name, args);
    else throw new Error("unknown notebook tool");
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  },
};
