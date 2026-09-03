const crypto = require("crypto");

const RECALL_HEADERS = [
  /<memory_context>/i,
  /(?:^|\n)\s*(?:relevant|recalled|retrieved)\s+(?:past\s+)?memor(?:y|ies)\s*[:：]/i,
  /(?:^|\n)\s*(?:相关|召回|检索到的|过去的|历史)记忆(?:摘要|片段|内容)?\s*[:：]/,
  /(?:^|\n)\s*(?:memory|记忆)\s+context\s*[:：]/i,
];

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function compact(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function fingerprintText(value) {
  return compact(value)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[t\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi, "<time>")
    .replace(/\b\d{1,2}[月/-]\d{1,2}[日号]?(?:\s*\d{1,2}[:：]\d{2})?/g, "<time>")
    .replace(/\b\d{4,}\b/g, "<number>")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function blocks(text) {
  const value = compact(text);
  if (!value) return [];
  const paragraphs = value.split(/\n\s*\n+/).map(compact).filter(Boolean);
  const lines = value.split("\n").map(compact).filter(line => line.length >= 40);
  return [...new Set([...paragraphs, ...lines])];
}

function recallHeader(text) {
  for (const pattern of RECALL_HEADERS) {
    const match = String(text || "").match(pattern);
    if (match) return { header: match[0].trim(), index: match.index || 0 };
  }
  return null;
}

function candidateId(type, fingerprint) {
  return `${type}_${sha(fingerprint).slice(0, 16)}`;
}

function createConversationAnomalyDetector({ maxCandidates = 80 } = {}) {
  const exact = new Map(), fragments = new Map(), recalls = new Map();
  let scannedMessages = 0;
  function add(row) {
    if (!row?.text || !row?.timestamp) return;
    scannedMessages++;
    const text = compact(row.text);
    if (!text) return;
    const role = ["user","assistant"].includes(row.type || row.role) ? (row.type || row.role) : "unknown";
    const exactKey = sha(`${role}\u0000${text}`);
    const exactEntry = exact.get(exactKey) || { fingerprint: exactKey, role, text, count: 0, timestamps: [] };
    exactEntry.count++;
    if (exactEntry.timestamps.length < 5) exactEntry.timestamps.push(row.timestamp);
    exact.set(exactKey, exactEntry);

    const seenBlocks = new Set();
    for (const block of blocks(text)) {
      if (block.length < 40 || block.length > 30000) continue;
      const normalized = fingerprintText(block);
      if (normalized.length < 35 || seenBlocks.has(normalized)) continue;
      seenBlocks.add(normalized);
      const key = sha(`${role}\u0000${normalized}`);
      const entry = fragments.get(key) || { fingerprint: key, role, normalized, sample: block, count: 0, timestamps: [], parentFingerprints: new Set() };
      entry.count++;
      entry.parentFingerprints.add(exactKey);
      if (entry.timestamps.length < 5) entry.timestamps.push(row.timestamp);
      fragments.set(key, entry);
    }

    const recalled = recallHeader(text);
    if (recalled) {
      const normalizedHeader = fingerprintText(recalled.header);
      const key = sha(`${role}\u0000${normalizedHeader}`);
      const entry = recalls.get(key) || { fingerprint: key, role, header: recalled.header, count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < 3) entry.samples.push(text.slice(Math.max(0, recalled.index), recalled.index + 500));
      recalls.set(key, entry);
    }
  }
  function finish() {
    const exactDuplicates = [...exact.values()]
    .filter(item => item.count > 1 && item.text.length >= 12)
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, maxCandidates)
    .map(item => ({ id: candidateId("duplicate", item.fingerprint), type: "exact_duplicate", ...item, preview: item.text.slice(0, 500) }));

    const duplicateFingerprints = new Set(exactDuplicates.map(item => item.fingerprint));
    const injectionFragments = [...fragments.values()]
    .filter(item => item.count >= 3
      && !duplicateFingerprints.has(sha(`${item.role}\u0000${compact(item.sample)}`))
      && ![...item.parentFingerprints].every(parent => duplicateFingerprints.has(parent)))
    .sort((a, b) => b.count - a.count || b.sample.length - a.sample.length)
    .slice(0, maxCandidates)
    .map(({ parentFingerprints, ...item }) => ({ id: candidateId("injection", item.fingerprint), type: "injection_fragment", ...item, preview: item.sample.slice(0, 500) }));

    const recallBlocks = [...recalls.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxCandidates)
    .map(item => ({ id: candidateId("recall", item.fingerprint), type: "recall_block", ...item, preview: item.samples[0] || item.header }));

    return { scannedMessages, exactDuplicates, injectionFragments, recallBlocks };
  }
  return { add, finish };
}

function detectConversationAnomalies(rows, options) {
  const detector = createConversationAnomalyDetector(options);
  for (const row of rows || []) detector.add(row);
  return detector.finish();
}

function normalizeCleaningPolicy(input = {}) {
  const cleanList = (items, mapper) => Array.isArray(items) ? items.map(mapper).filter(Boolean).slice(0, 200) : [];
  return {
    exactDuplicates: cleanList(input.exactDuplicates, item => {
      const text = compact(item?.text);
      const role = ["user","assistant"].includes(item?.role) ? item.role : null;
      return text ? { id: String(item.id || candidateId("duplicate", sha(`${role||"any"}\u0000${text}`))).slice(0, 80), role, text, fingerprint: sha(`${role||"any"}\u0000${text}`), enabled: item.enabled !== false } : null;
    }),
    injectionFragments: cleanList(input.injectionFragments, item => {
      const normalized = compact(item?.normalized || fingerprintText(item?.sample));
      const role = ["user","assistant"].includes(item?.role) ? item.role : null;
      return normalized ? { id: String(item.id || candidateId("injection", sha(`${role||"any"}\u0000${normalized}`))).slice(0, 80), role, normalized, sample: compact(item.sample).slice(0, 30000), enabled: item.enabled !== false } : null;
    }),
    recallHeaders: cleanList(input.recallHeaders, item => {
      const header = compact(typeof item === "string" ? item : item?.header);
      const role = ["user","assistant"].includes(item?.role) ? item.role : null;
      return header ? { id: String(item?.id || candidateId("recall", sha(`${role||"any"}\u0000${fingerprintText(header)}`))).slice(0, 80), role, header: header.slice(0, 500), enabled: item?.enabled !== false } : null;
    }),
    customRuleHeaders: [...new Set((Array.isArray(input.customRuleHeaders) ? input.customRuleHeaders : [])
      .map(value => compact(value)).filter(Boolean).map(value => value.slice(0, 500)))].slice(0, 100),
  };
}

function stripFingerprintBlocks(text, rules, role) {
  let output = compact(text);
  const removed = [];
  if (!output) return { text: output, removed };
  for (const rule of rules) {
    if (!rule.enabled || (rule.role && rule.role !== role) || !rule.sample || !output.includes(rule.sample)) continue;
    removed.push({ category: "injection_fragment", ruleId: rule.id, text: rule.sample });
    output = compact(output.replace(rule.sample, ""));
  }
  const pieces = output.split(/(\n\s*\n+)/);
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = compact(pieces[index]);
    if (!piece) continue;
    const normalized = fingerprintText(piece);
    const rule = rules.find(item => item.enabled && (!item.role || item.role === role) && item.normalized === normalized);
    if (rule) {
      removed.push({ category: "injection_fragment", ruleId: rule.id, text: piece });
      pieces[index] = "";
      if (index + 1 < pieces.length) pieces[index + 1] = "";
      continue;
    }
    const lines = pieces[index].split("\n"), kept = [];
    for (const line of lines) {
      const lineRule = rules.find(item => item.enabled && (!item.role || item.role === role) && item.normalized === fingerprintText(line));
      if (lineRule) removed.push({ category: "injection_fragment", ruleId: lineRule.id, text: compact(line) });
      else kept.push(line);
    }
    pieces[index] = kept.join("\n");
  }
  output = compact(pieces.join(""));
  return { text: output, removed };
}

function applyConversationCleaning(text, policyInput, { duplicateSeen = false, role = null } = {}) {
  const policy = normalizeCleaningPolicy(policyInput);
  const rawOriginal = String(text || "");
  const original = compact(rawOriginal);
  if (!original) return { keep: false, text: "", removed: [], reason: "empty" };

  for (const header of policy.customRuleHeaders) {
    if (original.startsWith(header)) return { keep: false, text: "", removed: [{ category: "rule_header", ruleId: header, text: original }], reason: "rule_header" };
  }

  const duplicateRule = policy.exactDuplicates.find(item => item.enabled && (!item.role || item.role === role) && item.text === original);
  if (duplicateRule && duplicateSeen) {
    return { keep: false, text: "", removed: [{ category: "exact_duplicate", ruleId: duplicateRule.id, text: original }], reason: "exact_duplicate" };
  }

  let current = original;
  const removed = [];
  for (const rule of policy.recallHeaders) {
    if (!rule.enabled || (rule.role && rule.role !== role)) continue;
    const index = current.toLowerCase().indexOf(rule.header.toLowerCase());
    if (index < 0) continue;
    removed.push({ category: "recall_block", ruleId: rule.id, text: current.slice(index) });
    current = compact(current.slice(0, index));
  }

  const stripped = stripFingerprintBlocks(current, policy.injectionFragments, role);
  current = stripped.text;
  removed.push(...stripped.removed);
  return { keep: !!current, text: removed.length ? current : rawOriginal, removed, reason: current ? (removed.length ? "cleaned" : null) : (removed[0]?.category || "filtered") };
}

module.exports = {
  RECALL_HEADERS,
  fingerprintText,
  createConversationAnomalyDetector,
  detectConversationAnomalies,
  normalizeCleaningPolicy,
  applyConversationCleaning,
};
