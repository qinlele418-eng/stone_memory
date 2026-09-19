const tools = [
  {
    "name": "latest",
    "description": "Read the latest available dream for one memory thread.",
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
    "name": "status",
    "description": "Read dream coverage, including available and missing eligible dates.",
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
    "name": "get",
    "description": "Read the dream for an exact date without falling back to another date.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "date": {
          "type": "string",
          "description": "梦境日期 YYYY-MM-DD"
        }
      },
      "required": [
        "date"
      ],
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
  call(context, name, args) {
    let result;
    if (name === "latest") result = context.core.dream.latest() || { threadId: context.memoryId, date: null, dreamType: null, title: "", body: "", found: false, message: "暂无梦境" };
    else if (name === "status") result = context.core.dream.status();
    else if (name === "get") result = context.core.dream.get(args.date) || { threadId: context.memoryId, date: args.date, dreamType: null, title: "", body: "", found: false, message: "指定日期没有梦境" };
    else throw new Error("unknown dream tool");
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
  },
};
