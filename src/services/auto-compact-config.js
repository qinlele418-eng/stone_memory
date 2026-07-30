function resolveAutoCompactConfig(threadConfig = {}) {
  // automaticCompression is a new consent switch. Deliberately do not inherit
  // legacy autoCompact.enabled=true after an upgrade.
  if (threadConfig.automaticCompression !== true) return { enabled: false };
  const raw = threadConfig.autoCompact || {};

  const maxChars = positiveInteger(raw.maxChars ?? 80000);
  const stopChars = positiveInteger(raw.stopChars ?? 60000);
  if (maxChars == null) return { enabled: false, error: "autoCompact.maxChars 必须是正整数" };
  if (stopChars == null) return { enabled: false, error: "autoCompact.stopChars 必须是正整数" };
  if (stopChars > maxChars) return { enabled: false, error: "autoCompact.stopChars 不能高于 maxChars" };
  return { enabled: true, maxChars, stopChars };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

module.exports = { resolveAutoCompactConfig };
