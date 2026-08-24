const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { replaceThreadFile, permissionBits } = require("../src/lib/thread-file-replacement");

function stat({ mode = 0o100600, uid = 1000, gid = 1000, file = true, link = false } = {}) {
  return { mode, uid, gid, isFile: () => file, isSymbolicLink: () => link };
}

function metadataFs({ target = stat({ mode: 0o100640, uid: 2000, gid: 3000 }), temporary = stat({ mode: 0o100600, uid: 1000, gid: 1000 }), fail = null } = {}) {
  const calls = [];
  const targetFile = path.join("threads", "thread.jsonl");
  const temporaryFile = path.join("threads", ".thread.jsonl.stmem-test.tmp");
  const failIfRequested = operation => {
    if (fail === operation) throw new Error(`${operation} failed`);
  };
  return {
    calls, targetFile, temporaryFile,
    lstatSync(file) {
      calls.push(["lstat", file]);
      if (file === targetFile) {
        if (target) return target;
        const error = new Error("target missing");
        error.code = "ENOENT";
        throw error;
      }
      if (file === temporaryFile) return temporary;
      throw new Error(`unexpected lstat ${file}`);
    },
    openSync(file, flag, mode) { calls.push(["open", file, flag, mode]); return 7; },
    writeFileSync(fd, contents, encoding) { calls.push(["write", fd, contents, encoding]); },
    fstatSync(fd) { calls.push(["fstat", fd]); return temporary; },
    fchownSync(fd, uid, gid) { calls.push(["fchown", fd, uid, gid]); failIfRequested("fchown"); },
    fchmodSync(fd, mode) { calls.push(["fchmod", fd, mode]); failIfRequested("fchmod"); },
    closeSync(fd) { calls.push(["close", fd]); },
    renameSync(from, to) { calls.push(["rename", from, to]); failIfRequested("rename"); },
    unlinkSync(file) { calls.push(["unlink", file]); if (fail === "unlink") throw new Error("unlink failed"); },
  };
}

function runWith(fsImpl, options = {}) {
  replaceThreadFile(fsImpl.targetFile, "new jsonl\n", {
    fsImpl,
    platform: "linux",
    randomUUID: () => "test",
    ...options,
  });
}

test("preserves changed POSIX metadata before renaming", () => {
  const fsImpl = metadataFs();
  runWith(fsImpl);
  assert.deepEqual(fsImpl.calls.map(call => call[0]), [
    "lstat", "open", "write", "fstat", "fchown", "fstat", "fchmod", "close", "lstat", "rename",
  ]);
  assert.deepEqual(fsImpl.calls.find(call => call[0] === "fchown"), ["fchown", 7, 2000, 3000]);
  assert.deepEqual(fsImpl.calls.find(call => call[0] === "fchmod"), ["fchmod", 7, 0o640]);
});

test("skips unnecessary metadata changes and skips chown on Windows", () => {
  const matching = metadataFs({ temporary: stat({ mode: 0o100640, uid: 2000, gid: 3000 }) });
  runWith(matching);
  assert.equal(matching.calls.some(call => call[0] === "fchown"), false);
  assert.equal(matching.calls.some(call => call[0] === "fchmod"), false);

  const windows = metadataFs();
  runWith(windows, { platform: "win32" });
  assert.equal(windows.calls.some(call => call[0] === "fchown"), false);
  assert.equal(windows.calls.some(call => call[0] === "fchmod"), false);
});

for (const operation of ["fchown", "fchmod"]) {
  test(`${operation} failure never renames the original thread`, () => {
    const fsImpl = metadataFs({ fail: operation });
    assert.throws(() => runWith(fsImpl), new RegExp(`${operation} failed`));
    assert.equal(fsImpl.calls.some(call => call[0] === "rename"), false);
    assert.equal(fsImpl.calls.some(call => call[0] === "unlink"), true);
  });
}

test("rename failure is preserved when temporary cleanup also fails", () => {
  const fsImpl = metadataFs({ fail: "rename" });
  fsImpl.unlinkSync = file => { fsImpl.calls.push(["unlink", file]); throw new Error("cleanup failed"); };
  assert.throws(() => runWith(fsImpl), /rename failed/);
  assert.equal(fsImpl.calls.some(call => call[0] === "rename"), true);
  assert.equal(fsImpl.calls.some(call => call[0] === "unlink"), true);
});

test("refuses a symbolic-link target before creating a temporary file", () => {
  const fsImpl = metadataFs({ target: stat({ link: true }) });
  assert.throws(() => runWith(fsImpl), /non-regular thread file/);
  assert.equal(fsImpl.calls.some(call => call[0] === "open"), false);
});

test("refuses a symbolic-link temporary file and leaves the target unrenamed", () => {
  const fsImpl = metadataFs({ temporary: stat({ link: true }) });
  assert.throws(() => runWith(fsImpl), /non-regular temporary thread file/);
  assert.equal(fsImpl.calls.some(call => call[0] === "rename"), false);
  assert.equal(fsImpl.calls.some(call => call[0] === "unlink"), true);
});

test("keeps normal creation behavior when the target does not exist", () => {
  const fsImpl = metadataFs({ target: null });
  runWith(fsImpl);
  assert.deepEqual(fsImpl.calls.find(call => call[0] === "open"), ["open", fsImpl.temporaryFile, "wx", 0o666]);
  assert.equal(fsImpl.calls.some(call => call[0] === "fchown"), false);
  assert.equal(fsImpl.calls.some(call => call[0] === "fchmod"), false);
  assert.equal(fsImpl.calls.some(call => call[0] === "rename"), true);
});

test("runs the pre-rename callback only after metadata preparation", () => {
  const fsImpl = metadataFs();
  runWith(fsImpl, { beforeRename: () => fsImpl.calls.push(["backup"]) });
  const calls = fsImpl.calls.map(call => call[0]);
  assert.ok(calls.indexOf("fchmod") < calls.indexOf("backup"));
  assert.ok(calls.indexOf("backup") < calls.indexOf("rename"));
});

test("uses only permission bits when restoring mode", () => {
  assert.equal(permissionBits({ mode: 0o100675 }), 0o675);
});
