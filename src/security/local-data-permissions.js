"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Only call these helpers for paths Stone Memory creates and owns.  In
// particular, never pass a Binding source or its parent directory here.
function assertNoSymlinkInPath(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Stone 私有路径不能经过符号链接：${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensurePrivateDirectory(directory) {
  assertNoSymlinkInPath(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Stone 私有目录不能是符号链接");
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

function assertPrivateFileTarget(file) {
  assertNoSymlinkInPath(path.dirname(file));
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Stone 私有文件不能是符号链接");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function hardenPrivateFile(file) {
  try {
    assertPrivateFileTarget(file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

function writePrivateFile(file, contents, options = {}) {
  const directory = ensurePrivateDirectory(path.dirname(file));
  assertPrivateFileTarget(file);
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
    assertPrivateFileTarget(file);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  hardenPrivateFile(file);
}

function appendPrivateFile(file, contents, options = {}) {
  const descriptor = openPrivateAppendFileDescriptor(file);
  try {
    fs.writeFileSync(descriptor, contents, options);
  } finally {
    fs.closeSync(descriptor);
  }
  hardenPrivateFile(file);
}

// A caller that hands an FD to child_process.spawn must retain it until the
// child has been created, then close its own copy. Do not replace this with a
// string path: that would reintroduce a path-following open between checks.
function openPrivateAppendFileDescriptor(file) {
  ensurePrivateDirectory(path.dirname(file));
  assertPrivateFileTarget(file);
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

function hardenDatabaseArtifacts(databasePath) {
  hardenPrivateFile(databasePath);
  hardenPrivateFile(`${databasePath}-wal`);
  hardenPrivateFile(`${databasePath}-shm`);
}

module.exports = { assertNoSymlinkInPath, assertPrivateFileTarget, ensurePrivateDirectory, hardenPrivateFile, writePrivateFile, appendPrivateFile, openPrivateAppendFileDescriptor, hardenDatabaseArtifacts };
