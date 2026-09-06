"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { processMatches } = require("../lib/process-identity");
const { ensurePrivateDirectory, openPrivateAppendFileDescriptor } = require("../security/local-data-permissions");

function readManagedPid(pidFile, marker, adapters = {}) {
  const readFileSync = adapters.readFileSync || fs.readFileSync;
  const matches = adapters.processMatches || processMatches;
  let pid = null;
  try { pid = Number(readFileSync(pidFile, "utf8")); } catch {}
  const markers = Array.isArray(marker) ? marker : [marker];
  return Number.isInteger(pid) && pid > 0 && markers.some(item => matches(pid, item)) ? pid : null;
}

function stopManagedProcess({ pidFile, marker, waitMs = 5_000 }, adapters = {}) {
  const pid = readManagedPid(pidFile, marker, adapters);
  if (!pid) return { running: false, stopped: false, pid: null };
  const kill = adapters.kill || process.kill.bind(process);
  const matches = adapters.processMatches || processMatches;
  const wait = adapters.wait || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  kill(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  const markers = Array.isArray(marker) ? marker : [marker];
  const running = () => markers.some(item => matches(pid, item));
  while (Date.now() < deadline && running()) wait(50);
  if (running()) throw new Error(`${markers.join("/")} 在 ${waitMs}ms 内没有退出`);
  try { (adapters.rmSync || fs.rmSync)(pidFile, { force: true }); } catch {}
  return { running: false, stopped: true, pid };
}

function startManagedProcess({ script, pidFile, marker, args = [], env = process.env, logFile }, adapters = {}) {
  const existing = readManagedPid(pidFile, marker, adapters);
  if (existing) return { running: true, started: false, pid: existing };
  const privatePathOptions = adapters.privatePathOptions;
  ensurePrivateDirectory(path.dirname(pidFile), privatePathOptions);
  const output = logFile ? (adapters.openPrivateAppendFileDescriptor || openPrivateAppendFileDescriptor)(logFile, privatePathOptions) : "ignore";
  let child;
  try {
    child = (adapters.spawn || spawn)(process.execPath, [script, ...args], {
      detached: true, windowsHide: true, stdio: ["ignore", output, output], env,
    });
  } finally {
    if (typeof output === "number") fs.closeSync(output);
  }
  child.unref();
  return { running: true, started: true, pid: child.pid };
}

module.exports = { readManagedPid, stopManagedProcess, startManagedProcess };
