const TOOLS = [
  {
    name: "stmem_memory_rebuild",
    description: "Apply the latest successful rebuild preview using runtime-safe routing: Codex applies immediately and must restart at once; Claude Code queues for the next MCP load.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测当前 session" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_rebuild_preview",
    description: "生成只读线程重建预览，不排队、不改写线程。请使用统一结构：summary={mode,limit,minImportance}，context={mode,windowDays,toolPairs}，trim={excludedMessages,excludedTools}。这份完整请求会保留到确认阶段；随后调用 stmem_memory_rebuild，系统按 runtime 分流：Codex 立即 apply，Claude Code 写入 queue。trigger 由系统自动标记为 mcp，无需也不允许 Agent 填写。",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测当前 session" },
        summary: {
          type: "object",
          description: "摘要注入方式。default 注入全部非 hidden 历史摘要；limited 按数量和 importance 筛选，锚点仍受保护。",
          properties: {
            mode: { type: "string", enum: ["default", "limited"] },
            limit: { type: "integer", minimum: 0, description: "limited 模式最多保留多少条；0 表示不限数量" },
            minImportance: { type: "integer", minimum: 0, maximum: 5 },
          },
          required: ["mode"], additionalProperties: false,
        },
        context: {
          type: "object",
          description: "近期上下文方式。active_days 按活跃对话日保留；watermark 从最后一条摘要对应原文开始保留。",
          properties: {
            mode: { type: "string", enum: ["active_days", "watermark"] },
            windowDays: { type: "integer", minimum: 1, description: "活跃对话日数量；水位线无法定位时也作为安全回退" },
            toolPairs: { type: "integer", minimum: 0, description: "保留最近 N 组完整工具调用" },
          },
          required: ["mode"], additionalProperties: false,
        },
        trim: {
          type: "object",
          description: "本次永久裁剪范围；通常保持空数组，只有用户明确确认裁剪时才能填写。",
          properties: {
            excludedMessages: { type: "array", items: { type: "string" } },
            excludedTools: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_mine",
    description: "手动触发单日记忆挖掘（feelings + features 双通道）",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "日期 YYYY-MM-DD，默认昨天" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
        force: { type: "boolean", description: "整日重挖；成功后直接替换当天结果，失败保留旧结果" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_status",
    description: "查看 stmem 记忆系统当前状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stmem_dream_latest",
    description: "Read the latest available dream for one memory thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_dream_status",
    description: "Read dream coverage, including available and missing eligible dates.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_dream_get",
    description: "Read the dream for an exact date without falling back to another date.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
        date: { type: "string", description: "梦境日期 YYYY-MM-DD" },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_topic_manage",
    description: "高级/调试用低层工具：创建或更新主题笔记本。日常归类优先使用 stmem_notebook_delegate。create 需要 name；update 需要 topicId。",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        thread: { type: "string" },
        action: { type: "string", enum: ["create", "update"] },
        topicId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        coverPath: { type: "string", enum: ["", "preset:forest", "preset:mist", "preset:amber", "preset:berry", "preset:night"], description: "内置封面预设；留空或 preset:forest 为默认松林绿。" },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        archived: { type: "boolean" },
        isDefault: { type: "boolean", description: "是否设为当前记忆体唯一的默认写入主题；不会根据最近使用自动变化。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_write",
    description: "高级/调试用低层工具：创建或更新 Markdown 笔记。日常写作优先使用 stmem_notebook_delegate，由管家处理主题和 revision。直接更新必须提供 noteId 与当前 expectedRevision。",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        thread: { type: "string" },
        noteId: { type: "string" },
        topicId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_delegate",
    description: "主题小笔记的日常自然语言入口。主 Agent 只需提供 request；新建或改正文时附 content，可选 title/tags/visibility，查询/读取/移动时不需重传正文。临时规划子代理只有目录、搜索、精读三项只读工具，不持有写权限且不会收到正文；它返回计划后，由 Stone 受控执行器复核 threadId、目标、歧义、主题、路径和 revision，再通过正式 CLI 执行并返回透明收据。纸篓仅用于已有笔记的可逆软删除，不会物理删除。全新记忆体可以是 0 主题、0 笔记。",
    inputSchema: {
      type: "object",
      required: ["request"],
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
        request: { type: "string", description: "自然语言意图，例如：把这段旅行心得放到合适的主题；找蒲苇灯塔；给某篇笔记追加一段。" },
        content: { type: "string", description: "需要新建、追加或替换的正文；查询和读取时省略。正文不发送给规划子代理。" },
        title: { type: "string", description: "可选标题；未提供时由笔记管家建议。" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        updateMode: { type: "string", enum: ["append", "replace"], description: "更新笔记时必须明确追加或整体替换。" },
        allowCreateTopic: { type: "boolean", description: "只有明确允许且子代理置信度不低于 0.9 时才可新建主题。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_search",
    description: "关键词搜索记忆 feelings + 回溯原文 archive",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_deep_search",
    description: "深度记忆检索（子 agent 多级搜索 + 原文回溯）",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索内容（自然语言）" },
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_list",
    description: "List feelings from dates after the last audit cutoff. Shows feeling IDs and anchor type for marking.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_mark",
    description: "Mark feelings by seq number as original-text or key-event anchors. Input: { cutoffDate, numbers, type }",
    inputSchema: {
      type: "object",
      required: ["cutoffDate"],
      properties: {
        cutoffDate: { type: "string", description: "Audit cutoff date (YYYY-MM-DD)." },
        numbers: { type: "array", items: { type: "integer" }, description: "Seq numbers to mark, e.g. [1, 3, 5]." },
        type: { type: "string", enum: ["retain", "event"], description: "'retain' 保留对应原文；'event' 标记长期关键事件，供生命周期保护和巡检使用。默认 retain。" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_query",
    description: "Query feelings by date or keyword. Returns full content with anchor type. Input: { date?, keyword? }",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date YYYY-MM-DD, e.g. '2026-06-05'." },
        keyword: { type: "string", description: "Keyword to search in feeling content." },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_triggers_check",
    description: "检查当前待办事项（重建、挖掘阻塞），返回自然语言列表。适合在会话启动或睡前巡检时调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SEARCH_TOOLS = [
  {
    name: "memory_keyword_search",
    description: "Search feelings by keyword and return the narrative backbone with its event-window conversation. Use this first.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "Space-separated Chinese keywords." },
        maxResults: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_archive_context",
    description: "Search archive context across dates using keywords from the feeling result.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["feelingDate", "keywords"],
      properties: {
        feelingDate: { type: "string", description: "Core feeling date in YYYY-MM-DD." },
        keywords: { type: "string", description: "Space-separated keywords." },
        maxDays: { type: "integer", minimum: 1, maximum: 30 },
        skipBefore: { type: "string", description: "Only search dates after YYYY-MM-DD." },
        mode: { type: "string", enum: ["event", "pattern"] },
      },
      additionalProperties: false,
    },
  },
];

const NOTEBOOK_STEWARD_TOOLS = [
  {
    name: "notebook_catalog",
    description: "List the current memory body's notebook topics, default topic, counts, archive/seal state, and safe latest-note summaries. Always call this before planning placement.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notebook_search",
    description: "Search notebook title, tags, and body to locate an existing note. Use before read, update, move, restore, or trash; ambiguous matches require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topicId: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "notebook_read",
    description: "Read exactly one note by noteId to verify its title, topic, body, visibility, and current revision. This is read-only.",
    inputSchema: {
      type: "object",
      required: ["noteId"],
      properties: { noteId: { type: "string" } },
      additionalProperties: false,
    },
  },
];


module.exports = { TOOLS, SEARCH_TOOLS, NOTEBOOK_STEWARD_TOOLS };
