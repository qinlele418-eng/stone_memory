// A frame's Content-Length counts UTF-8 bytes, including across pipe chunks.
function startTransport(handle, { input = process.stdin, output = process.stdout } = {}) {
  let data = Buffer.alloc(0);
  const keepAlive = setInterval(() => {}, 60_000);
  input.once("end", () => clearInterval(keepAlive));
  input.on("data", chunk => {
    data = Buffer.concat([data, Buffer.from(chunk)]);
    while (data.length) {
      const header = data.toString("ascii").match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
      let body, mode;
      if (header) {
        const end = header[0].length + Number(header[1]);
        if (data.length < end) break;
        body = data.subarray(header[0].length, end).toString("utf8");
        data = data.subarray(end);
        mode = "content-length";
      } else {
        if (data.toString("ascii").startsWith("Content-Length:") || "Content-Length:".startsWith(data.toString("ascii"))) break;
        const end = data.indexOf(10);
        if (end < 0) break;
        body = data.subarray(0, end).toString("utf8").trim();
        data = data.subarray(end + 1);
        mode = "jsonl";
      }
      if (!body) continue;
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      const respond = (id, result) => {
        const text = JSON.stringify({ jsonrpc: "2.0", id, result });
        output.write(mode === "jsonl" ? `${text}\n` : `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
      };
      Promise.resolve(handle(message, respond)).catch(() => {});
    }
  });
  input.resume();
  return () => clearInterval(keepAlive);
}
module.exports = { startTransport };
