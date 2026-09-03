"use strict";

// Model identifiers are passed as argv (and by one legacy adapter as an
// unquoted token), so keep shell metacharacters out without assuming that
// providers use only bare alphanumerics. Names such as `model[1m]` are valid.
function normalizeModelName(value, { required = false, label = "model name" } = {}) {
  const model = String(value ?? "").trim();
  if (!model) {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (!/^[A-Za-z0-9._:/+\[\]-]{1,128}$/u.test(model)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return model;
}

module.exports = { normalizeModelName };
