const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readImportSource } = require("./import-source");
const { ingestRecords, previewIngestRecords } = require("./thread-ingest");

const MODES = new Set(["primary", "parallel", "child", "import_only"]);
const PROVIDER = /^[a-z0-9][a-z0-9_-]*$/u;

function stableId(prefix, parts) {
  const digest = crypto.createHash("sha256").update(parts.map(value => String(value || "")).join("\0")).digest("hex").slice(0, 20);
  return `${prefix}_${digest}`;
}

function batchId() {
  return `bindimp_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function fileFingerprint(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function normalizedPath(value) {
  if (!value) return null;
  const file = path.resolve(String(value));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`绑定来源文件不存在：${file}`);
  return file;
}

function normalizeBindingInput(memoryId, input = {}) {
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!PROVIDER.test(provider)) throw new Error("provider 只能包含小写字母、数字、下划线和连字符");
  const externalThreadId = String(input.externalThreadId || "").trim() || null;
  const threadFile = normalizedPath(input.threadFile);
  if (!externalThreadId && !threadFile) throw new Error("externalThreadId 与 threadFile 至少提供一个");
  const mode = String(input.mode || "parallel").trim();
  if (!MODES.has(mode)) throw new Error(`不支持的 Binding 模式：${mode}`);
  const capabilities = input.capabilities && typeof input.capabilities === "object" ? input.capabilities : {};
  return {
    id: stableId("binding", [memoryId, provider, externalThreadId, threadFile]),
    memoryId,
    provider,
    externalThreadId,
    threadFile,
    mode,
    enabled: input.enabled !== false,
    capabilities,
  };
}

function bindingRow(row) {
  if (!row) return null;
  let capabilities = {};
  try { capabilities = JSON.parse(row.capabilities_json || "{}"); } catch {}
  return {
    id: row.id,
    memoryId: row.memory_id,
    provider: row.provider,
    externalThreadId: row.external_thread_id,
    threadFile: row.thread_file,
    mode: row.mode,
    enabled: row.enabled === 1,
    capabilities,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planBinding(store, input) {
  const binding = normalizeBindingInput(store.threadId, input);
  const existing = store.db.prepare("SELECT * FROM memory_bindings WHERE id=?").get(binding.id);
  return { action: existing ? "existing" : "create", binding: existing ? bindingRow(existing) : binding };
}

function addBinding(store, input) {
  const plan = planBinding(store, input);
  if (plan.action === "existing") return { changed: false, ...plan };
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO memory_bindings
    (id,memory_id,provider,external_thread_id,thread_file,mode,enabled,capabilities_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    plan.binding.id,
    store.threadId,
    plan.binding.provider,
    plan.binding.externalThreadId,
    plan.binding.threadFile,
    plan.binding.mode,
    plan.binding.enabled ? 1 : 0,
    JSON.stringify(plan.binding.capabilities || {}),
    now,
    now,
  );
  return { changed: true, action: "created", binding: getBinding(store, plan.binding.id) };
}

function listBindings(store) {
  return store.db.prepare("SELECT * FROM memory_bindings WHERE memory_id=? ORDER BY created_at,id")
    .all(store.threadId).map(bindingRow);
}

function getBinding(store, id) {
  const row = store.db.prepare("SELECT * FROM memory_bindings WHERE id=? AND memory_id=?").get(id, store.threadId);
  if (!row) throw new Error(`Binding 不存在：${id}`);
  return bindingRow(row);
}

function setBindingEnabled(store, id, enabled) {
  getBinding(store, id);
  store.db.prepare("UPDATE memory_bindings SET enabled=?,updated_at=? WHERE id=? AND memory_id=?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id, store.threadId);
  return getBinding(store, id);
}

function loadBindingSource(store, bindingId, options = {}) {
  const binding = getBinding(store, bindingId);
  const sourcePath = normalizedPath(options.source || binding.threadFile);
  if (!sourcePath) throw new Error("该 Binding 没有可导入的来源文件，请使用 --source 指定");
  const imported = readImportSource({
    filePath: sourcePath,
    table: options.table,
    timeField: options.timeField,
    roleField: options.roleField,
    contentField: options.contentField,
  });
  const cleanPreview = previewIngestRecords(imported.records, { format: imported.preview.format });
  return { binding, sourcePath, source: imported, cleanPreview, fingerprint: fileFingerprint(sourcePath) };
}

function previewBindingImport(store, bindingId, options = {}) {
  const loaded = loadBindingSource(store, bindingId, options);
  return {
    dryRun: true,
    binding: loaded.binding,
    sourcePath: loaded.sourcePath,
    sourceFingerprint: loaded.fingerprint,
    source: loaded.source.preview,
    ingest: loaded.cleanPreview,
  };
}

function applyBindingImport(store, bindingId, options = {}) {
  const loaded = loadBindingSource(store, bindingId, options);
  if (!loaded.binding.enabled) throw new Error("Binding 已停用，不能导入");
  const duplicateBatch = store.db.prepare(`SELECT id,status FROM binding_import_batches
    WHERE memory_id=? AND binding_id=? AND source_fingerprint=? AND status='applied' ORDER BY applied_at DESC LIMIT 1`)
    .get(store.threadId, bindingId, loaded.fingerprint);
  if (duplicateBatch) throw new Error(`同一来源版本已经导入：${duplicateBatch.id}`);
  const id = batchId();
  const appliedAt = new Date().toISOString();
  const transaction = store.db.transaction(() => {
    const result = ingestRecords(loaded.source.records, {
      memoryStore: store,
      format: loaded.source.preview.format,
      messageOptions: { bindingId, importBatchId: id },
    });
    store.db.prepare(`INSERT INTO binding_import_batches
      (id,memory_id,binding_id,status,source_path,source_fingerprint,discovered_count,inserted_count,duplicate_count,invalid_count,filtered_count,source_dates_json,metadata_json,applied_at)
      VALUES (?,?,?,'applied',?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      store.threadId,
      bindingId,
      loaded.sourcePath,
      loaded.fingerprint,
      loaded.cleanPreview.candidates,
      result.imported,
      result.duplicates,
      loaded.cleanPreview.invalid,
      loaded.cleanPreview.filtered,
      JSON.stringify(result.sourceDates),
      JSON.stringify({ format: result.format, filteredReasons: result.filteredReasons }),
      appliedAt,
    );
    return result;
  });
  const result = transaction();
  return {
    changed: result.imported > 0,
    batchId: id,
    bindingId,
    sourcePath: loaded.sourcePath,
    sourceFingerprint: loaded.fingerprint,
    discovered: loaded.cleanPreview.candidates,
    inserted: result.imported,
    duplicates: result.duplicates,
    invalid: loaded.cleanPreview.invalid,
    filtered: loaded.cleanPreview.filtered,
    sourceDates: result.sourceDates,
    appliedAt,
  };
}

function importBatch(store, id) {
  const row = store.db.prepare("SELECT * FROM binding_import_batches WHERE id=? AND memory_id=?").get(id, store.threadId);
  if (!row) throw new Error(`导入批次不存在：${id}`);
  return row;
}

function previewRevertImport(store, id) {
  const batch = importBatch(store, id);
  const messageCount = store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND import_batch_id=?")
    .get(store.threadId, id).count;
  let sourceDates = [];
  try { sourceDates = JSON.parse(batch.source_dates_json || "[]"); } catch {}
  const minedAfterImport = sourceDates.length
    ? store.db.prepare(`SELECT source_date,status,completed_at FROM mining_day_state
        WHERE thread_id=? AND source_date IN (${sourceDates.map(() => "?").join(",")})
          AND status IN ('completed','completed_empty') AND completed_at IS NOT NULL AND completed_at>=?
        ORDER BY source_date`).all(store.threadId, ...sourceDates, batch.applied_at)
    : [];
  return {
    dryRun: true,
    batchId: id,
    status: batch.status,
    bindingId: batch.binding_id,
    messageCount,
    sourceDates,
    minedAfterImport,
    reversible: batch.status === "applied" && minedAfterImport.length === 0,
  };
}

function revertBindingImport(store, id) {
  const preview = previewRevertImport(store, id);
  if (preview.status === "reverted") return { changed: false, ...preview, dryRun: false };
  if (preview.minedAfterImport.length) {
    const dates = preview.minedAfterImport.map(row => row.source_date).join("、");
    throw new Error(`导入后已有日期重新挖掘（${dates}），为避免留下无原文摘要，本期拒绝自动撤销`);
  }
  const revertedAt = new Date().toISOString();
  const removed = store.db.transaction(() => {
    const result = store.db.prepare("DELETE FROM messages WHERE thread_id=? AND import_batch_id=?").run(store.threadId, id);
    store.db.prepare("UPDATE binding_import_batches SET status='reverted',reverted_at=? WHERE id=? AND memory_id=?")
      .run(revertedAt, id, store.threadId);
    return result.changes;
  })();
  return { changed: removed > 0, batchId: id, removed, revertedAt };
}

function listImportBatches(store, bindingId = null) {
  const rows = bindingId
    ? store.db.prepare("SELECT * FROM binding_import_batches WHERE memory_id=? AND binding_id=? ORDER BY applied_at DESC").all(store.threadId, bindingId)
    : store.db.prepare("SELECT * FROM binding_import_batches WHERE memory_id=? ORDER BY applied_at DESC").all(store.threadId);
  return rows.map(row => ({
    id: row.id,
    bindingId: row.binding_id,
    status: row.status,
    sourcePath: row.source_path,
    discovered: row.discovered_count,
    inserted: row.inserted_count,
    duplicates: row.duplicate_count,
    invalid: row.invalid_count,
    filtered: row.filtered_count,
    appliedAt: row.applied_at,
    revertedAt: row.reverted_at,
  }));
}

module.exports = {
  normalizeBindingInput,
  planBinding,
  addBinding,
  listBindings,
  getBinding,
  setBindingEnabled,
  previewBindingImport,
  applyBindingImport,
  previewRevertImport,
  revertBindingImport,
  listImportBatches,
};
