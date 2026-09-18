const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  MAX_ENABLED_BINDINGS,
  bindingCursorFile,
  validateEnabledBindingLimit,
} = require("../src/services/watcher-bindings");

test("watcher accepts at most five enabled live bindings", () => {
  const five = Array.from({ length: MAX_ENABLED_BINDINGS }, (_, index) => ({ id: `b-${index}`, enabled: true, mode: "parallel" }));
  assert.equal(validateEnabledBindingLimit(five), 5);
  assert.throws(() => validateEnabledBindingLimit([...five, { id: "b-5", enabled: true, mode: "parallel" }]), /最多同时监听 5 个/);
  assert.equal(validateEnabledBindingLimit([...five, { id: "disabled", enabled: false, mode: "parallel" }]), 5);
  assert.equal(validateEnabledBindingLimit([...five, { id: "import", enabled: true, mode: "import_only" }]), 5);
});

test("each formal binding receives an independent sync cursor", () => {
  const first = bindingCursorFile("memory-a", { id: "binding-one" });
  const second = bindingCursorFile("memory-a", { id: "binding-two" });
  assert.notEqual(first, second);
  assert.equal(path.basename(first), "binding-one.json");
  assert.match(first, /[\\/]\.sync-state[\\/]/u);
});
