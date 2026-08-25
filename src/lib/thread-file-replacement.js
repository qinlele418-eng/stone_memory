const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PERMISSION_BITS = 0o7777;

function permissionBits(stat) {
  return stat.mode & PERMISSION_BITS;
}

function isSafeRegularFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink();
}

function cleanupTemporaryFile(fsImpl, temporaryFile) {
  try { fsImpl.unlinkSync(temporaryFile); } catch {}
}

/**
 * Replaces an active thread JSONL without changing an existing POSIX file's
 * owner or permission bits. Metadata is prepared on the temporary file before
 * rename, so a metadata failure leaves the original file untouched.
 */
function replaceThreadFile(targetFile, contents, {
  beforeRename = null,
  fsImpl = fs,
  platform = process.platform,
  randomUUID = crypto.randomUUID,
} = {}) {
  let targetStat = null;
  try {
    targetStat = fsImpl.lstatSync(targetFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (targetStat && !isSafeRegularFile(targetStat)) {
    throw new Error(`Refusing to replace non-regular thread file: ${targetFile}`);
  }

  const directory = path.dirname(targetFile);
  const basename = path.basename(targetFile);
  const temporaryFile = path.join(directory, `.${basename}.stmem-${randomUUID()}.tmp`);
  let descriptor = null;
  let renamed = false;

  try {
    descriptor = fsImpl.openSync(temporaryFile, "wx", targetStat ? 0o600 : 0o666);
    fsImpl.writeFileSync(descriptor, contents, "utf8");

    if (targetStat && platform !== "win32") {
      const temporaryStat = fsImpl.fstatSync(descriptor);
      if (temporaryStat.uid !== targetStat.uid || temporaryStat.gid !== targetStat.gid) {
        fsImpl.fchownSync(descriptor, targetStat.uid, targetStat.gid);
      }
      if (permissionBits(fsImpl.fstatSync(descriptor)) !== permissionBits(targetStat)) {
        fsImpl.fchmodSync(descriptor, permissionBits(targetStat));
      }
    }

    fsImpl.closeSync(descriptor);
    descriptor = null;

    const verifiedTemporaryStat = fsImpl.lstatSync(temporaryFile);
    if (!isSafeRegularFile(verifiedTemporaryStat)) {
      throw new Error(`Refusing to rename non-regular temporary thread file: ${temporaryFile}`);
    }

    if (beforeRename) beforeRename();
    fsImpl.renameSync(temporaryFile, targetFile);
    renamed = true;
  } catch (error) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch {}
    }
    if (!renamed) cleanupTemporaryFile(fsImpl, temporaryFile);
    throw error;
  }
}

module.exports = { replaceThreadFile, permissionBits };
