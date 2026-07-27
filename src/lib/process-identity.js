"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");

function processCommand(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return "";
  try { process.kill(number, 0); } catch { return ""; }
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${number}/cmdline`, "utf8").replace(/\0/g, " ").trim(); }
    catch { return ""; }
  }
  if (process.platform === "win32") {
    try {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${number}").CommandLine`,
      ], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
    } catch { return ""; }
  }
  try {
    return execFileSync("ps", ["-p", String(number), "-o", "command="], {
      encoding: "utf8", timeout: 3000,
    }).trim();
  } catch { return ""; }
}

function processMatches(pid, marker) {
  const command = processCommand(pid);
  return !!command && command.includes(String(marker));
}

module.exports = { processCommand, processMatches };
