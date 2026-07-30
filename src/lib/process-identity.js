"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

function processCommand(pid, adapters = {}) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return "";
  const platform = adapters.platform || process.platform;
  const kill = adapters.kill || process.kill.bind(process);
  const readFileSync = adapters.readFileSync || fs.readFileSync;
  const run = adapters.execFileSync || execFileSync;
  try { kill(number, 0); } catch { return ""; }
  if (platform === "linux") {
    try { return readFileSync(`/proc/${number}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
    catch { return ""; }
  }
  if (platform === "win32") {
    try {
      return run("powershell.exe", [
        "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${number}").CommandLine`,
      ], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
    } catch { return ""; }
  }
  try {
    return run("ps", ["-p", String(number), "-o", "command="], {
      encoding: "utf8", timeout: 3000,
    }).trim();
  } catch { return ""; }
}

function processMatches(pid, marker, adapters) {
  const command = processCommand(pid, adapters);
  return !!command && command.includes(String(marker));
}

module.exports = { processCommand, processMatches };
