function startTransport(handle, { input = process.stdin, output = process.stdout } = {}) {
  function respond(id, result) {
    const body = JSON.stringify({ jsonrpc: "2.0", id, result });
    const byteLength = Buffer.byteLength(body, "utf8");

    if (rpcMode === "jsonl") {
      output.write(`${body}\n`);
      return;
    }

    output.write(`Content-Length: ${byteLength}\r\n\r\n${body}`);
  }

  let rpcMode = "content-length";
  let data = "";
  // Some launchers create the stdio pipe before they write the first MCP frame.
  // Keep the server alive during that short gap instead of exiting with code 0.
  const stdioKeepAlive = setInterval(() => {}, 60_000);
  input.setEncoding("utf8");
  input.resume();
  input.once("end", () => clearInterval(stdioKeepAlive));
  input.on("data", (chunk) => {
    data += chunk;
    while (true) {
      // 优先解析 Content-Length 头（标准 MCP stdio 协议）
      const clMatch = data.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
      if (clMatch) {
        rpcMode = "content-length";

        const len = parseInt(clMatch[1], 10);
        const hdrEnd = clMatch[0].length;
        if (data.length < hdrEnd + len) break;
        try { handle(JSON.parse(data.slice(hdrEnd, hdrEnd + len)), respond); } catch {}
        data = data.slice(hdrEnd + len);
        continue;
      }
      // fallback: newline-delimited JSON
      const nlIdx = data.indexOf("\n");
      if (nlIdx >= 0) {
        const line = data.slice(0, nlIdx).trim();
        data = data.slice(nlIdx + 1);
        if (line) {
          rpcMode = "jsonl";
          try { handle(JSON.parse(line), respond); } catch {}
        }
        continue;
      }
      break;
    }
  });

  return () => clearInterval(stdioKeepAlive);
}
module.exports = { startTransport };
