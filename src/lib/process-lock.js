"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { processMatches } = require("./process-identity");
const { ensurePrivateDirectory, hardenPrivateFile, writePrivateFile } = require("../security/local-data-permissions");

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(sleeper, 0, 0, Math.max(1, milliseconds));
}

function readOwner(lockDir, { privatePaths = false } = {}) {
  try {
    const file = path.join(lockDir, "owner.json");
    if (privatePaths && fs.existsSync(lockDir)) {
      ensurePrivateDirectory(lockDir);
      hardenPrivateFile(file);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function inspectProcessLock(lockDir, marker, { privatePaths = false } = {}) {
  if (!fs.existsSync(lockDir)) return { exists: false, owner: null, active: false, ageMs: 0, signature: null };
  if (privatePaths) ensurePrivateDirectory(lockDir);
  let ageMs = 0;
  let signature = null;
  try {
    const stat = fs.statSync(lockDir);
    ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    signature = { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {}
  const owner = readOwner(lockDir, { privatePaths });
  const active = !!(owner?.pid && marker && processMatches(owner.pid, marker));
  return { exists: true, owner, active, ageMs, signature };
}

function removeIfUnchanged(lockDir, expectedSignature, { privatePaths = false } = {}) {
  if (!expectedSignature) return false;
  try {
    if (privatePaths) ensurePrivateDirectory(lockDir);
    const stat = fs.statSync(lockDir);
    if (stat.ino !== expectedSignature.ino || stat.mtimeMs !== expectedSignature.mtimeMs) return false;
    const tombstone = `${lockDir}.stale-${process.pid}-${crypto.randomUUID()}`;
    fs.renameSync(lockDir, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function writeOwner(lockDir, owner, { privatePaths = false } = {}) {
  const file = path.join(lockDir, "owner.json");
  if (privatePaths) return writePrivateFile(file, JSON.stringify(owner), { encoding: "utf8" });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Acquire a persistent process lock.
 *
 * A lock directory is created atomically. The short interval before owner.json
 * is written is treated as initialization, not as a stale lock; contenders
 * wait instead of deleting it. The returned lease is the only process allowed
 * to remove the lock.
 */
function acquireProcessLock(lockDir, {
  marker,
  staleMs = 30_000,
  waitMs = 2_000,
  pollMs = 25,
  privatePaths = false,
} = {}) {
  if (!lockDir) throw new Error("lockDir is required");
  const started = Date.now();
  const token = crypto.randomUUID();
  if (privatePaths) ensurePrivateDirectory(path.dirname(lockDir));
  else fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      if (privatePaths) ensurePrivateDirectory(lockDir);
      const owner = {
        pid: process.pid,
        token,
        marker: marker || null,
        createdAt: new Date().toISOString(),
      };
      try {
        writeOwner(lockDir, owner, { privatePaths });
      } catch (error) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        throw error;
      }
      let released = false;
      return {
        acquired: true,
        owner,
        release() {
          if (released) return false;
          released = true;
          const current = readOwner(lockDir, { privatePaths });
          if (current?.token !== token || Number(current?.pid) !== process.pid) return false;
          try { fs.rmSync(lockDir, { recursive: true, force: true }); return true; } catch { return false; }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = inspectProcessLock(lockDir, marker, { privatePaths });
      if (info.active) return { acquired: false, owner: info.owner, pending: false };
      if (info.ageMs >= staleMs) {
        removeIfUnchanged(lockDir, info.signature, { privatePaths });
        continue;
      }
      if (Date.now() - started >= waitMs) {
        return { acquired: false, owner: info.owner, pending: true };
      }
      sleepSync(pollMs);
    }
  }
}

module.exports = { acquireProcessLock, inspectProcessLock, removeIfUnchanged };
