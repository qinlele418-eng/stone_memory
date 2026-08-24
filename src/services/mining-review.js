const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MemoryStore } = require("../storage/memory-store");
const {
  normalizeNewImportance,
  normalizeFeelingImportance,
  sortFeelingsChronologically,
  feelingEventTime,
} = require("./memory-miner");
const { archiveFingerprint } = require("./mining-state");
const { isInjectedMemoryBlock } = require("../lib/system-injection");

const REVIEW_RULES = Object.freeze({
  "source-aware": "识别同一天可能存在多个窗口或并行入口；不得仅凭时间相邻就拼接无关上下文。",
  "platform-neutral": "证据表明属于同一段持续关系时，以人物、事件和感受为主，减少不必要的平台与技术名词，但不得改变事实。",
  "personal-emotion": "私人记忆优先记录具体互动、感受和双方回应，避免写成人物画像、周报或咨询报告。",
  "conflict-context": "冷淡、冲突、吃醋或抱怨必须保留当日上下文；单次局部体验不得自动升级为长期稳定 feature。",
  "intimate-facts": "成年人自愿的亲密内容按原文事实提取，不因表达直白而跳过；不得续写、补全或虚构。",
  "count-limit": "证据充分时生成 8 到 20 条 feelings；证据不足允许少于 8 条，禁止凑数，且不得超过 20 条。",
  "strict-importance": "feelings 按 1 到 5 表达记忆分量；features 只允许 2、3、5，并且宁缺毋滥，只保留有跨日价值且有原文证据的稳定索引。",
});

function buildReviewOverlay({ ruleIds = [], additionalInstruction = "" } = {}) {
  const ids = [...new Set((ruleIds || []).map(String))];
  const unknown = ids.filter(id => !REVIEW_RULES[id]);
  if (unknown.length) throw new Error(`unknown review rule: ${unknown.join(", ")}`);
  const extra = String(additionalInstruction || "").trim();
  if (extra.length > 4000) throw new Error("additionalInstruction is too long");
  const lines = ids.map((id, index) => `${index + 1}. ${REVIEW_RULES[id]}`);
  if (extra) lines.push(`附加说明：${extra}`);
  return { ruleIds: ids, text: lines.length ? `本次候选审阅附加规则：\n${lines.join("\n")}` : "" };
}

function normalizeCandidateResults({ date, feelings = [], features = [], enforceCountLimit = false }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date must be YYYY-MM-DD");
  if (!Array.isArray(feelings) || !Array.isArray(features)) throw new Error("feelings and features must be arrays");

  const [, month, day] = date.split("-").map(Number);
  const expectedDatePrefix = `${month}月${day}日`;
  const seenFeelings = new Set();
  const normalizedFeelings = sortFeelingsChronologically(feelings).flatMap(item => {
    const content = String(item?.content || "").trim()
      .replace(/^\d{1,2}月\d{1,2}日/, expectedDatePrefix);
    if (!content || seenFeelings.has(content)) return [];
    seenFeelings.add(content);
    return [{
      content,
      eventTime: item.eventTime || feelingEventTime({ content }, date),
      importance: normalizeFeelingImportance(item.importance),
    }];
  });
  if (enforceCountLimit && normalizedFeelings.length > 20) {
    throw new Error("count-limit allows at most 20 feelings");
  }

  const seenFeatures = new Set();
  const normalizedFeatures = features.flatMap(item => {
    const content = String(item?.content || "").trim();
    if (!content || seenFeatures.has(content)) return [];
    seenFeatures.add(content);
    return [{
      content,
      category: String(item?.category || "misc").trim() || "misc",
      importance: normalizeNewImportance(item.importance),
    }];
  });
  return { feelings: normalizedFeelings, features: normalizedFeatures };
}

function nearDuplicateHints(candidates, threshold = 0.48) {
  const rows = [];
  for (const candidate of candidates || []) {
    for (const kind of ["feelings", "features"]) {
      (candidate[kind] || []).forEach((item, index) => rows.push({
        candidateId: candidate.id,
        kind,
        index,
        content: String(item.content || ""),
        eventTime: item.eventTime || null,
      }));
    }
  }
  const hints = [];
  for (let left = 0; left < rows.length; left++) {
    for (let right = left + 1; right < rows.length; right++) {
      const a = rows[left], b = rows[right];
      if (a.kind !== b.kind || a.content === b.content) continue;
      const score = ngramSimilarity(a.content, b.content);
      const sameEventTime = !!a.eventTime && a.eventTime === b.eventTime;
      if (score >= threshold || (sameEventTime && score >= 0.08)) {
        hints.push({ left: ref(a), right: ref(b), score: Number(score.toFixed(3)), sameEventTime });
      }
    }
  }
  return hints.sort((a, b) => b.score - a.score);
}

class MiningReviewStore {
  constructor({ memoryDir, threadId, candidateDirectoryName = "review-candidates" }) {
    if (!memoryDir || !threadId) throw new Error("memoryDir and threadId are required");
    if (!/^[a-z0-9-]+$/.test(candidateDirectoryName)) throw new Error("invalid candidate directory name");
    this.memoryDir = memoryDir;
    this.threadId = threadId;
    this.candidateDir = path.join(memoryDir, candidateDirectoryName);
    this.backupDir = path.join(memoryDir, "backups");
  }

  createCandidate(input) {
    const ruleIds = [...new Set((input.ruleIds || []).map(String))];
    const normalized = normalizeCandidateResults({
      date: input.date,
      feelings: input.feelings,
      features: input.features,
      enforceCountLimit: ruleIds.includes("count-limit"),
    });
    if (!input.archiveFingerprint) throw new Error("archiveFingerprint is required");
    const candidate = {
      version: 1,
      id: candidateId(),
      threadId: this.threadId,
      date: input.date,
      profile: sanitizeProfile(input.profile),
      ruleIds,
      promptHash: input.promptHash || null,
      archiveFingerprint: String(input.archiveFingerprint),
      messageCount: Number(input.messageCount) || 0,
      chunkCount: Number(input.chunkCount) || 0,
      chunkKb: Number(input.chunkKb) || null,
      chunkReport: sanitizeChunkReport(input.chunkReport),
      batch: sanitizeBatchProvenance(input.batch),
      priorCounts: {
        feelings: Number(input.priorCounts?.feelings) || 0,
        features: Number(input.priorCounts?.features) || 0,
      },
      feelings: normalized.feelings,
      features: normalized.features,
      createdAt: new Date().toISOString(),
      status: "review_pending",
      appliedAt: null,
      discardedAt: null,
      backup: null,
    };
    this._write(candidate);
    return candidate;
  }

  list({ date = null } = {}) {
    if (!fs.existsSync(this.candidateDir)) return [];
    return fs.readdirSync(this.candidateDir)
      .filter(name => /^candidate-[0-9a-f-]+\.json$/.test(name))
      .flatMap(name => {
        try {
          const candidate = JSON.parse(fs.readFileSync(path.join(this.candidateDir, name), "utf8"));
          if (candidate.threadId !== this.threadId || (date && candidate.date !== date)) return [];
          return [candidate];
        } catch {
          return [];
        }
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  load(id) {
    const candidate = JSON.parse(fs.readFileSync(this._path(id), "utf8"));
    validateCandidate(candidate, { id, threadId: this.threadId });
    return candidate;
  }

  assertCurrentFingerprint(date, expected) {
    this._assertCurrentFingerprint(date, expected);
  }

  mix({ date, selection, enforceCountLimit = false }) {
    const refs = [
      ...(Array.isArray(selection?.feelings) ? selection.feelings : []),
      ...(Array.isArray(selection?.features) ? selection.features : []),
    ];
    const parentIds = [...new Set(refs.map(item => String(item?.candidateId || "")))];
    if (!parentIds.length) throw new Error("at least one candidate item must be selected");
    const parents = parentIds.map(id => this.load(id));
    for (const parent of parents) {
      if (parent.status !== "review_pending") throw new Error("selection contains a processed candidate");
      if (parent.date !== date) throw new Error("only candidates from the same date may be mixed");
      if (parent.profile?.id === "hybrid") throw new Error("hybrid candidates cannot be nested");
    }
    if (new Set(parents.map(item => item.archiveFingerprint)).size !== 1) {
      throw new Error("candidate archive fingerprints differ");
    }
    this._assertCurrentFingerprint(date, parents[0].archiveFingerprint);

    const picked = { feelings: [], features: [] };
    const provenance = { feelings: [], features: [] };
    const exactDuplicatesDropped = { feelings: 0, features: 0 };
    for (const kind of ["feelings", "features"]) {
      const requested = Array.isArray(selection?.[kind]) ? selection[kind] : [];
      if (requested.length > 200) throw new Error("selection exceeds 200 items");
      const seenRefs = new Set();
      const seenContent = new Set();
      for (const reference of requested) {
        const parent = parents.find(item => item.id === String(reference?.candidateId || ""));
        const index = Number(reference?.index);
        const refKey = `${parent?.id || ""}:${index}`;
        if (seenRefs.has(refKey)) continue;
        seenRefs.add(refKey);
        if (!parent || !Number.isInteger(index) || index < 0 || index >= parent[kind].length) {
          throw new Error("selection contains an invalid candidate reference");
        }
        const original = parent[kind][index];
        const row = { ...original };
        let edited = false;
        if (kind === "feelings" && Object.prototype.hasOwnProperty.call(reference, "content")) {
          const content = String(reference.content || "").trim();
          if (!content || content.length > 2000) throw new Error("edited feeling must contain 1 to 2000 characters");
          const eventTime = feelingEventTime({ content }, date);
          if (!eventTime) throw new Error("edited feeling must retain a recognizable event time");
          edited = content !== original.content;
          row.content = content;
          row.eventTime = eventTime;
        }
        if (seenContent.has(row.content)) {
          exactDuplicatesDropped[kind]++;
          continue;
        }
        seenContent.add(row.content);
        picked[kind].push(row);
        provenance[kind].push({
          candidateId: parent.id,
          profileId: parent.profile?.id || null,
          originalIndex: index,
          edited,
          originalContentSha256: edited ? sha256(original.content) : null,
        });
      }
    }
    if (!picked.feelings.length && !picked.features.length) throw new Error("selection is empty");
    const ordered = picked.feelings
      .map((row, index) => ({ row, provenance: provenance.feelings[index] }))
      .sort((a, b) => compareEventTime(a.row, b.row));
    picked.feelings = ordered.map(item => item.row);
    provenance.feelings = ordered.map(item => item.provenance);
    if (enforceCountLimit && picked.feelings.length > 20) {
      throw new Error("count-limit allows at most 20 feelings");
    }

    const candidate = {
      version: 1,
      id: candidateId(),
      threadId: this.threadId,
      date,
      profile: { id: "hybrid", label: "Hybrid review selection", channel: "review" },
      ruleIds: [],
      promptHash: null,
      archiveFingerprint: parents[0].archiveFingerprint,
      messageCount: parents[0].messageCount,
      chunkCount: null,
      priorCounts: parents[0].priorCounts,
      feelings: picked.feelings,
      features: picked.features,
      hybrid: {
        parentCandidateIds: parentIds,
        selectionProvenance: provenance,
        exactDuplicatesDropped,
        nearDuplicateHints: nearDuplicateHints(parents),
        enforceCountLimit: !!enforceCountLimit,
      },
      createdAt: new Date().toISOString(),
      status: "review_pending",
      appliedAt: null,
      discardedAt: null,
      backup: null,
    };
    this._write(candidate);
    return candidate;
  }

  createFusionCandidate({
    sourceCandidate,
    writerProfile,
    feelings,
    features,
    provenance,
    stats,
    promptHash,
  }) {
    if (!sourceCandidate || sourceCandidate.threadId !== this.threadId) {
      throw new Error("fusion source candidate is invalid");
    }
    if (sourceCandidate.profile?.id !== "hybrid" || sourceCandidate.status !== "review_pending") {
      throw new Error("fusion source must be a pending hybrid candidate");
    }
    const normalized = normalizeCandidateResults({
      date: sourceCandidate.date,
      feelings,
      features,
      enforceCountLimit: sourceCandidate.hybrid?.enforceCountLimit === true,
    });
    if (normalized.feelings.length !== feelings.length || normalized.features.length !== features.length) {
      throw new Error("fusion output changed during normalization; review provenance would be unsafe");
    }
    const candidate = {
      version: 1,
      id: candidateId(),
      threadId: this.threadId,
      date: sourceCandidate.date,
      profile: {
        id: "fusion",
        label: `同事件融合 · ${String(writerProfile?.label || writerProfile?.model || "已配置模型")}`,
        channel: "review",
      },
      ruleIds: [],
      promptHash: promptHash || null,
      archiveFingerprint: sourceCandidate.archiveFingerprint,
      messageCount: sourceCandidate.messageCount,
      chunkCount: null,
      priorCounts: sourceCandidate.priorCounts,
      feelings: normalized.feelings,
      features: normalized.features,
      fusion: {
        sourceCandidateId: sourceCandidate.id,
        writerProfile: sanitizeProfile(writerProfile),
        provenance,
        stats,
        safeguards: {
          sourceCandidatePreserved: true,
          rawMessagesUntouched: true,
          exactMemberCoverageRequired: true,
          feelingTimeToleranceMinutes: 10,
        },
      },
      createdAt: new Date().toISOString(),
      status: "review_pending",
      appliedAt: null,
      discardedAt: null,
      backup: null,
    };
    this._write(candidate);
    return candidate;
  }

  updateFusionCandidate(id, mutate) {
    const candidate = this.load(id);
    if (candidate.status !== "review_pending" || candidate.profile?.id !== "fusion") {
      throw new Error("only a pending fusion candidate may be updated");
    }
    this._assertCurrentFingerprint(candidate.date, candidate.archiveFingerprint);
    const updated = mutate(candidate);
    if (!updated || updated !== candidate) {
      throw new Error("fusion candidate update must mutate and return the loaded candidate");
    }
    validateCandidate(candidate, { id, threadId: this.threadId });
    this._write(candidate);
    return candidate;
  }

  async apply(id) {
    const release = this._acquireApplyLock(id);
    try {
      // The lock must be held before loading status. Two CLI processes may otherwise
      // both observe review_pending and publish different candidates for one day.
      const candidate = this.load(id);
      if (candidate.status !== "review_pending") throw reviewError("REVIEW_ALREADY_PROCESSED", "candidate has already been processed");
      this._assertCurrentFingerprint(candidate.date, candidate.archiveFingerprint);
      fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
      const store = new MemoryStore({ memoryDir: this.memoryDir, threadId: this.threadId });
      try {
        const conflicts = this._manualStateConflicts(store, candidate.date);
        if (conflicts.total) {
          throw reviewError(
            "REVIEW_MANUAL_STATE_CONFLICT",
            `${candidate.date} 存在 ${conflicts.total} 条锚点或人工编辑摘要，已拒绝覆盖。请先处理这些保护状态，再重新发布候选。`,
            conflicts,
          );
        }
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
        const backupFile = `${stamp}-before-review-${candidate.date}-${candidate.id.slice(-8)}.db`;
        const backupPath = path.join(this.backupDir, backupFile);
        await store.db.backup(backupPath);
        const postBackupFingerprint = archiveFingerprint(reviewMessages(store, candidate.date));
        if (postBackupFingerprint !== candidate.archiveFingerprint) {
          throw reviewError("REVIEW_MESSAGES_CHANGED", "messages changed while the review backup was being created");
        }
        const now = new Date().toISOString();
        const job = store.createJob({
          sourceDate: candidate.date,
          mode: "remine",
          triggerType: "cli",
          publishStrategy: "replace",
          instruction: JSON.stringify({
            reviewCandidateId: candidate.id,
            profileId: candidate.profile?.id || null,
            parentCandidateIds: candidate.hybrid?.parentCandidateIds || null,
            promptHash: candidate.promptHash,
          }),
        });
        store.updateJob(job.id, { status: "running", startedAt: now });
        try {
          const messages = reviewMessages(store, candidate.date);
          const normalized = normalizeCandidateResults({
            date: candidate.date,
            feelings: candidate.feelings,
            features: candidate.features,
            enforceCountLimit: candidate.ruleIds?.includes("count-limit") ||
              candidate.hybrid?.enforceCountLimit === true,
          });
          const result = store.replaceDay(candidate.date, {
            feelings: normalized.feelings,
            features: normalized.features,
            source: "remine",
            miningJobId: job.id,
            dayState: {
              status: normalized.feelings.length || normalized.features.length ? "completed" : "completed_empty",
              messageCount: messages.length,
              feelingCount: normalized.feelings.length,
              featureCount: normalized.features.length,
              attempt: 1,
              archiveFingerprint: candidate.archiveFingerprint,
              completedAt: now,
              updatedAt: now,
            },
          });
          store.updateJob(job.id, {
            status: "completed",
            feelingCount: normalized.feelings.length,
            featureCount: normalized.features.length,
            finishedAt: now,
            publishedAt: now,
          });
          candidate.status = "applied";
          candidate.appliedAt = now;
          candidate.backup = { filename: backupFile, sha256: sha256(fs.readFileSync(backupPath)) };
          candidate.miningJobId = job.id;
          this._write(candidate);
          this._discardSiblings(candidate);
          return {
            ok: true,
            candidateId: candidate.id,
            date: candidate.date,
            feelingCount: result.feelings.length,
            featureCount: result.features.length,
            miningJobId: job.id,
            backup: candidate.backup,
          };
        } catch (error) {
          store.updateJob(job.id, {
            status: "failed",
            errorCode: error.code || "REVIEW_APPLY_FAILED",
            errorMessage: error.message,
            finishedAt: new Date().toISOString(),
          });
          throw error;
        }
      } finally {
        store.close();
      }
    } finally {
      release();
    }
  }

  _manualStateConflicts(store, date) {
    const feelings = store.listFeelings({ date });
    const ids = new Set(feelings.map(row => row.id));
    const retainConfig = readJson(path.join(this.memoryDir, "retain-config.json"), { retain: {}, eventAnchors: {} });
    const retainAnchors = Object.keys(retainConfig.retain || {}).filter(id => ids.has(id));
    const eventAnchors = Object.keys(retainConfig.eventAnchors || {}).filter(id => ids.has(id));
    const editedFeelings = feelings.filter(row =>
      row.source === "manual" ||
      row.summary_mode !== "daily" ||
      !!row.coarse_summary ||
      !!row.coarse_terms
    ).map(row => row.id);
    return {
      total: new Set([...retainAnchors, ...eventAnchors, ...editedFeelings]).size,
      retainAnchors,
      eventAnchors,
      editedFeelings,
    };
  }

  _acquireApplyLock(candidateIdValue) {
    fs.mkdirSync(this.candidateDir, { recursive: true, mode: 0o700 });
    const candidate = this.load(candidateIdValue);
    const lockPath = path.join(this.candidateDir, `.apply-${candidate.date}.lock`);
    let handle;
    try {
      handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({
        pid: process.pid,
        candidateId: candidateIdValue,
        createdAt: new Date().toISOString(),
      }));
    } catch (error) {
      if (error.code === "EEXIST") {
        throw reviewError("REVIEW_APPLY_LOCKED", `${candidate.date} 已有另一份候选正在发布，请等待完成后刷新。`);
      }
      throw error;
    }
    return () => {
      try { fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    };
  }

  discard(id) {
    const candidate = this.load(id);
    if (candidate.status !== "review_pending") throw new Error("candidate has already been processed");
    candidate.status = "discarded";
    candidate.discardedAt = new Date().toISOString();
    this._write(candidate);
    return { ok: true, candidateId: id };
  }

  _assertCurrentFingerprint(date, expected) {
    const store = new MemoryStore({ memoryDir: this.memoryDir, threadId: this.threadId });
    try {
      const current = archiveFingerprint(reviewMessages(store, date));
      if (current !== expected) throw reviewError("REVIEW_MESSAGES_CHANGED", "messages changed after candidate generation");
      return current;
    } finally {
      store.close();
    }
  }

  _discardSiblings(applied) {
    for (const candidate of this.list({ date: applied.date })) {
      if (candidate.id === applied.id || candidate.status !== "review_pending") continue;
      candidate.status = "discarded";
      candidate.discardedAt = new Date().toISOString();
      candidate.discardReason = `superseded_by:${applied.id}`;
      this._write(candidate);
    }
  }

  _path(id) {
    if (!/^candidate-[0-9a-f-]+$/.test(String(id || ""))) throw new Error("invalid candidate id");
    return path.join(this.candidateDir, `${id}.json`);
  }

  _write(candidate) {
    fs.mkdirSync(this.candidateDir, { recursive: true, mode: 0o700 });
    const file = this._path(candidate.id);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(candidate, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function sanitizeProfile(profile) {
  return {
    id: String(profile?.id || "configured-default"),
    label: String(profile?.label || profile?.id || "Configured default"),
    channel: String(profile?.channel || "configured"),
    runtime: profile?.runtime ? String(profile.runtime) : null,
    provider: profile?.provider ? String(profile.provider) : null,
    model: profile?.model ? String(profile.model) : null,
    reasoning: profile?.reasoning ? String(profile.reasoning) : null,
  };
}

function sanitizeChunkReport(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 100).map((row, index) => ({
    index: Number(row.index) || index + 1,
    total: Number(row.total) || 0,
    channel: ["api", "subagent"].includes(row.channel) ? row.channel : null,
    runtime: ["codex", "claude"].includes(row.runtime) ? row.runtime : null,
    provider: row.provider ? String(row.provider).slice(0, 128) : null,
    model: row.model ? String(row.model).slice(0, 128) : null,
    startTime: row.startTime || null,
    endTime: row.endTime || null,
    timeLabel: row.timeLabel ? String(row.timeLabel).slice(0, 128) : null,
    messageCount: Math.max(0, Number(row.messageCount) || 0),
    inputBytes: Math.max(0, Number(row.inputBytes) || 0),
    outputCount: Math.max(0, Number(row.outputCount) || 0),
    empty: row.empty === true,
    recoveryStatus: ["format_repaired", "subagent_takeover"].includes(row.recoveryStatus)
      ? row.recoveryStatus
      : null,
    recoveryMessage: row.recoveryMessage ? String(row.recoveryMessage).slice(0, 500) : null,
    featureRecoveryStatus: ["format_repaired", "subagent_takeover"].includes(row.featureRecoveryStatus)
      ? row.featureRecoveryStatus
      : null,
    featureRecoveryMessage: row.featureRecoveryMessage
      ? String(row.featureRecoveryMessage).slice(0, 500)
      : null,
  }));
}

function reviewMessages(store, date) {
  return store.listMessages({ date }).filter(row => !isInjectedMemoryBlock(row.text));
}

function sanitizeBatchProvenance(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "");
  const taskId = String(input.taskId || "");
  if (!/^batch-[0-9a-f-]+$/.test(id) || !/^task-[A-Za-z0-9-]+$/.test(taskId)) return null;
  return {
    id,
    taskId,
    groupDates: [...new Set((input.groupDates || [])
      .map(String)
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort(),
  };
}

function validateCandidate(candidate, { id, threadId }) {
  if (!candidate || candidate.version !== 1) throw reviewError("REVIEW_CANDIDATE_INVALID", "unsupported or invalid candidate");
  if (candidate.id !== id) throw reviewError("REVIEW_CANDIDATE_INVALID", "candidate id does not match its filename");
  if (candidate.threadId !== threadId) throw reviewError("REVIEW_CANDIDATE_INVALID", "candidate belongs to another thread");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(candidate.date || ""))) {
    throw reviewError("REVIEW_CANDIDATE_INVALID", "candidate date is invalid");
  }
  if (!["review_pending", "applied", "discarded"].includes(candidate.status)) {
    throw reviewError("REVIEW_CANDIDATE_INVALID", "candidate status is invalid");
  }
  if (!candidate.archiveFingerprint || !Array.isArray(candidate.feelings) || !Array.isArray(candidate.features)) {
    throw reviewError("REVIEW_CANDIDATE_INVALID", "candidate payload is incomplete");
  }
  normalizeCandidateResults({
    date: candidate.date,
    feelings: candidate.feelings,
    features: candidate.features,
    enforceCountLimit: candidate.ruleIds?.includes("count-limit") ||
      candidate.hybrid?.enforceCountLimit === true,
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function reviewError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function candidateId() {
  return `candidate-${crypto.randomUUID()}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareEventTime(left, right) {
  const a = Date.parse(left.eventTime || "");
  const b = Date.parse(right.eventTime || "");
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return 0;
}

function ref(row) {
  return { candidateId: row.candidateId, kind: row.kind, index: row.index };
}

function ngramSimilarity(left, right) {
  const a = ngrams(left), b = ngrams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function ngrams(value) {
  const text = String(value || "")
    .replace(/^\d{1,2}月\d{1,2}日[^。]*。?/, "")
    .replace(/[\s，。、“”‘’！？：；,.!?;:'"()[\]{}]/g, "");
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index++) grams.add(text.slice(index, index + 2));
  return grams;
}

module.exports = {
  MiningReviewStore,
  REVIEW_RULES,
  buildReviewOverlay,
  normalizeCandidateResults,
  nearDuplicateHints,
};
