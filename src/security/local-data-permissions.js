"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Only call these helpers for paths Stone Memory creates and owns.  In
// particular, never pass a Binding source or its parent directory here.
// The caller's home directory is a trust boundary, not Stone-owned data. On
// macOS it may legitimately be reached through /var -> /private/var. Check
// every component *below* that boundary, including .stone_memory itself.
function assertNoSymlinkInPath(target, { trustedRoot = os.homedir() } = {}) {
  const root = path.resolve(trustedRoot);
  let current = path.resolve(target);
  const relative = path.relative(root, current);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Stone 私有路径必须位于受信任根目录之下");
  }
  while (current !== root) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Stone 私有路径不能经过符号链接：${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}

function ensurePrivateDirectory(directory, security = {}) {
  assertNoSymlinkInPath(directory, security);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Stone 私有目录不能是符号链接");
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

function assertPrivateFileTarget(file, security = {}) {
  assertNoSymlinkInPath(file, security);
}

function hardenPrivateFile(file, security = {}) {
  try {
    assertPrivateFileTarget(file, security);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

function writePrivateFile(file, contents, options = {}, security = {}) {
  const directory = ensurePrivateDirectory(path.dirname(file), security);
  assertPrivateFileTarget(file, security);
  const temp = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  let writeError = null;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(descriptor, contents, options);
    try { fs.fchmodSync(descriptor, 0o600); } catch {}
  } catch (error) {
    writeError = error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (writeError) {
    try { fs.unlinkSync(temp); } catch {}
    throw writeError;
  }
  try {
    // rename replaces a raced destination symlink rather than following it.
    assertPrivateFileTarget(file, security);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  hardenPrivateFile(file, security);
}

function appendPrivateFile(file, contents, options = {}, security = {}) {
  const descriptor = openPrivateAppendFileDescriptor(file, security);
  try {
    fs.writeFileSync(descriptor, contents, options);
  } finally {
    fs.closeSync(descriptor);
  }
  hardenPrivateFile(file, security);
}

// A caller that hands an FD to child_process.spawn must retain it until the
// child has been created, then close its own copy. Do not replace this with a
// string path: that would reintroduce a path-following open between checks.
function openPrivateAppendFileDescriptor(file, security = {}) {
  ensurePrivateDirectory(path.dirname(file), security);
  assertPrivateFileTarget(file, security);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow, 0o600);
    try { fs.fchmodSync(descriptor, 0o600); } catch {}
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    throw error;
  }
}

function hardenDatabaseArtifacts(databasePath, security = {}) {
  hardenPrivateFile(databasePath, security);
  hardenPrivateFile(`${databasePath}-wal`, security);
  hardenPrivateFile(`${databasePath}-shm`, security);
}

module.exports = { assertNoSymlinkInPath, assertPrivateFileTarget, ensurePrivateDirectory, hardenPrivateFile, writePrivateFile, appendPrivateFile, openPrivateAppendFileDescriptor, hardenDatabaseArtifacts };
