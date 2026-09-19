const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { startTransport } = require("../src/mcp/protocol");
const { createHandler } = require("../src/mcp/server");
const { Registry } = require("../src/mcp/registry");
test("transport handles split UTF-8 bytes, both frame modes and async replies", async t => {
  const input = new PassThrough(), output = new PassThrough();
  let bytes = Buffer.alloc(0);
  output.on("data", chunk => bytes = Buffer.concat([bytes, chunk]));
  t.after(startTransport(async (message, respond) => {
    if (message.id === 1) await new Promise(resolve => setTimeout(resolve, 10));
    respond(message.id, { value: message.value });
  }, { input, output }));
  const message = JSON.stringify({ id: 1, value: "中文🙂" });
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  for (const byte of frame) input.write(Buffer.from([byte]));
  input.end(JSON.stringify({ id: 2, value: "JSONL" }) + "\n");
  await new Promise(resolve => setTimeout(resolve, 30));
  const newline = bytes.indexOf(10);
  assert.equal(JSON.parse(bytes.subarray(0, newline).toString()).id, 2);
  const framed = bytes.subarray(newline + 1);
  const end = framed.indexOf("\r\n\r\n") + 4;
  const length = Number(framed.subarray(0, end).toString().match(/\d+/)[0]);
  assert.equal(framed.length - end, length);
  assert.equal(JSON.parse(framed.subarray(end).toString()).result.value, "中文🙂");
});
test("MCP cancellation aborts module context and permits subsequent requests", async () => {
  const registry = new Registry();
  let started;
  const ready = new Promise(resolve => started = resolve);
  let signal;
  registry.registerModule({ id: "cancel", version: "1", scope: "global", entry: {}, permissions: ["mcp:tools"] }, {
    tools: () => [{ name: "wait", description: "wait", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }],
    call(context) { signal = context.signal; started(); return new Promise(() => {}); },
  }, { state: { globalEnabled: true }, memoryIds: [] });
  const handle = createHandler(registry), responses = [];
  const pending = handle({ id: 1, method: "tools/call", params: { name: "stmem_cancel_wait" } }, (id, result) => responses.push({ id, result }));
  await ready;
  await handle({ method: "notifications/cancelled", params: { requestId: 1 } }, () => assert.fail("notification response"));
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(responses[0].result.content[0].text, "MCP_CANCELLED");
  await handle({ id: 2, method: "initialize" }, (id, result) => assert.equal(result.serverInfo.name, "stmem-mcp"));
});
