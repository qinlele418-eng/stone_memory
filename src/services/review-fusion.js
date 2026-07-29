const crypto = require("crypto");
const { parseJsonObject } = require("../lib/json-parse");
const { feelingEventTime, normalizeNewImportance } = require("./memory-miner");

const FEATURE_CATEGORIES = new Set([
  "eat", "body", "sleep", "work", "relation",
  "habit", "location", "preference", "misc",
]);

function buildFusionPlan(sourceCandidate, parentCandidates = []) {
  if (sourceCandidate?.profile?.id !== "hybrid") {
    throw new Error("same-event fusion requires a hybrid review candidate");
  }
  const parents = new Map(parentCandidates.map(candidate => [candidate.id, candidate]));
  const rows = { feelings: [], features: [] };
  for (const kind of ["feelings", "features"]) {
    (sourceCandidate[kind] || []).forEach((row, index) => {
      const source = sourceCandidate.hybrid?.selectionProvenance?.[kind]?.[index] || {};
      const parent = parents.get(source.candidateId);
      rows[kind].push({
        id: `${kind}:${index}`,
        index,
        kind,
        content: String(row.content || ""),
        eventTime: kind === "feelings" ? feelingEventTime(row, sourceCandidate.date) || row.eventTime || null : null,
        category: row.category || null,
        importance: normalizeNewImportance(row.importance),
        candidateId: source.candidateId || null,
        profileId: source.profileId || parent?.profile?.id || null,
        modelLabel: parent?.profile?.label || parent?.profile?.model || source.profileId || "候选来源",
      });
    });
  }
  return {
    date: sourceCandidate.date,
    sourceCandidateId: sourceCandidate.id,
    rows,
    groups: {
      feelings: groupRows(rows.feelings, "feelings"),
      features: groupRows(rows.features, "features"),
    },
  };
}

function groupRows(rows, kind) {
  const parent = rows.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (left, right) => {
    const a = find(left), b = find(right);
    if (a !== b) parent[b] = a;
  };

  for (let left = 0; left < rows.length; left++) {
    for (let right = left + 1; right < rows.length; right++) {
      if (rows[left].candidateId && rows[left].candidateId === rows[right].candidateId) continue;
      if (shouldGroup(rows[left], rows[right], kind)) join(left, right);
    }
  }

  const components = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(row);
  });

  const groups = [];
  for (const component of components.values()) {
    const chunks = kind === "feelings" ? splitWideFeelingComponent(component) : [component];
    for (const chunk of chunks) {
      if (chunk.length < 2) continue;
      groups.push({
        id: `${kind}-group-${groups.length + 1}`,
        kind,
        members: chunk.sort(compareRows),
      });
    }
  }
  return groups;
}

function shouldGroup(left, right, kind) {
  const similarity = textSimilarity(left.content, right.content);
  if (kind === "features") {
    return left.category === right.category && similarity >= 0.35;
  }
  const leftTime = Date.parse(left.eventTime || "");
  const rightTime = Date.parse(right.eventTime || "");
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  const minutes = Math.abs(leftTime - rightTime) / 60000;
  if (minutes > 45) return false;
  if (minutes === 0) return similarity >= 0.08;
  if (minutes <= 5) return similarity >= 0.14;
  if (minutes <= 20) return similarity >= 0.3;
  return similarity >= 0.58;
}

function splitWideFeelingComponent(component) {
  const ordered = [...component].sort(compareRows);
  const chunks = [];
  for (const row of ordered) {
    const time = Date.parse(row.eventTime || "");
    const current = chunks.at(-1);
    const firstTime = Date.parse(current?.[0]?.eventTime || "");
    if (!current || !Number.isFinite(time) || !Number.isFinite(firstTime) || time - firstTime > 45 * 60000) {
      chunks.push([row]);
    } else {
      current.push(row);
    }
  }
  return chunks;
}

function buildFusionPrompt(plan, writerLabel) {
  const duplicateGroups = {
    feelings: plan.groups.feelings.map(promptGroup),
    features: plan.groups.features.map(promptGroup),
  };
  return `你正在为 Stone Memory 做一次“同事件融合”实验。输入只包含多个模型已经生成的记忆候选，不是原始聊天。

目标：对每个候选组判断是否确实描述同一事件或同一稳定特征。只有确定相同时才融合；不确定、存在冲突或只是时间相邻时，必须拒绝融合。

融合规则：
1. 优先以组内表达最完整、时间最精确且没有冲突的一份原稿为底稿；其他来源只能补入不冲突、确实已经写在来源中的具体事实。
2. 禁止新增人物、动作、数值、因果、心理或关系结论。禁止把两个不同事件写成一条。
3. feeling 必须保留 ${plan.date} 对应的中文日期，并采用组内最早来源的准确时间，精确到分。
4. 保留人名、专有词、数字、百分比、地点、任务名和核心动作，以免损伤关键词检索。
5. feature 仍是一句客观稳定事实，不带日期；类别由程序保留，不需要输出 category。
6. 如果来源互相冲突，merge=false。不要替模型猜测。
7. 每组必须返回一次，memberIds 必须与输入完全一致，不得遗漏或添加。
8. 只输出 JSON，不要 markdown，不要解释。

输出格式：
{
  "feelings": [
    {"groupId":"feelings-group-1","memberIds":["feelings:0","feelings:1"],"merge":true,"content":"融合后的完整摘要"},
    {"groupId":"feelings-group-2","memberIds":["feelings:2","feelings:3"],"merge":false}
  ],
  "features": [
    {"groupId":"features-group-1","memberIds":["features:0","features:1"],"merge":true,"content":"融合后的客观特征"}
  ]
}

执笔模型：${writerLabel || "已配置模型"}
候选组：
${JSON.stringify(duplicateGroups, null, 2)}`;
}

async function fuseReviewCandidate({
  reviews,
  sourceCandidateId,
  writerProfile,
  generate,
}) {
  const source = reviews.load(sourceCandidateId);
  if (source.status !== "review_pending") throw new Error("source hybrid candidate is no longer pending");
  if (source.profile?.id !== "hybrid") throw new Error("same-event fusion only accepts a hybrid candidate");
  reviews.assertCurrentFingerprint(source.date, source.archiveFingerprint);
  const parentCandidates = (source.hybrid?.parentCandidateIds || []).map(id => reviews.load(id));
  const plan = buildFusionPlan(source, parentCandidates);
  const groupCount = plan.groups.feelings.length + plan.groups.features.length;
  if (!groupCount) throw new Error("当前混合稿没有找到可安全尝试融合的同事件重复组");

  const prompt = buildFusionPrompt(plan, writerProfile?.label);
  const raw = await generate(prompt);
  const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw;
  if (!parsed) throw new Error("fusion model did not return a JSON object");
  const materialized = materializeFusion(plan, parsed);
  return reviews.createFusionCandidate({
    sourceCandidate: source,
    writerProfile,
    feelings: materialized.feelings,
    features: materialized.features,
    provenance: materialized.provenance,
    stats: materialized.stats,
    promptHash: sha256(prompt),
  });
}

function editFusionCandidate({ reviews, candidateId, edits }) {
  return reviews.updateFusionCandidate(candidateId, candidate => {
    const changed = [];
    for (const kind of ["feelings", "features"]) {
      const rows = Array.isArray(edits?.[kind]) ? edits[kind] : [];
      for (const edit of rows) {
        const index = Number(edit?.index);
        const row = candidate[kind]?.[index];
        const provenance = candidate.fusion?.provenance?.[kind]?.[index];
        if (!Number.isInteger(index) || !row || provenance?.merged !== true) {
          throw new Error(`only model-merged ${kind} rows may be edited`);
        }
        const content = String(edit?.content || "").trim();
        if (!content || content.length > 2000) {
          throw new Error(`edited ${kind} content must contain 1 to 2000 characters`);
        }
        if (content === row.content) continue;
        if (kind === "feelings") {
          const eventTime = feelingEventTime({ content }, candidate.date);
          if (!eventTime) throw new Error("edited feeling lost its recognizable event time");
          const sourceTimes = (provenance.sources || [])
            .map(source => Date.parse(source.eventTime || ""))
            .filter(Number.isFinite);
          const earliest = sourceTimes.length ? Math.min(...sourceTimes) : Date.parse(row.eventTime || "");
          if (!Number.isFinite(earliest) || Math.abs(Date.parse(eventTime) - earliest) > 10 * 60000) {
            throw new Error("edited feeling changed the event time beyond the safe window");
          }
          row.eventTime = eventTime;
        }
        changed.push({
          kind, index,
          previousContentSha256: sha256(row.content),
          contentSha256: sha256(content),
          updatedAt: new Date().toISOString(),
        });
        row.content = content;
      }
    }
    if (changed.length) {
      candidate.fusion.manualEdits = [...(candidate.fusion.manualEdits || []), ...changed];
      candidate.updatedAt = new Date().toISOString();
    }
    return candidate;
  });
}

function materializeFusion(plan, response) {
  const decisions = {
    feelings: validateDecisions(plan.groups.feelings, response?.feelings, "feelings"),
    features: validateDecisions(plan.groups.features, response?.features, "features"),
  };
  const groupedIds = new Set([
    ...plan.groups.feelings.flatMap(group => group.members.map(row => row.id)),
    ...plan.groups.features.flatMap(group => group.members.map(row => row.id)),
  ]);
  const output = { feelings: [], features: [] };
  const provenance = { feelings: [], features: [] };
  let mergedGroups = 0;
  let refusedGroups = 0;

  for (const kind of ["feelings", "features"]) {
    for (const row of plan.rows[kind]) {
      if (!groupedIds.has(row.id)) pushOriginal(output, provenance, row);
    }
    for (const group of plan.groups[kind]) {
      const decision = decisions[kind].get(group.id);
      if (!decision.merge) {
        refusedGroups++;
        for (const row of group.members) pushOriginal(output, provenance, row);
        continue;
      }
      const content = String(decision.content || "").trim();
      if (!content || content.length > 2000) throw new Error(`${group.id} fused content must contain 1 to 2000 characters`);
      const sources = group.members.map(sourceRef);
      if (kind === "feelings") {
        const eventTime = feelingEventTime({ content }, plan.date);
        if (!eventTime) throw new Error(`${group.id} fused feeling lost its recognizable event time`);
        const earliest = Math.min(...group.members.map(row => Date.parse(row.eventTime || "")).filter(Number.isFinite));
        if (!Number.isFinite(earliest) || Math.abs(Date.parse(eventTime) - earliest) > 10 * 60000) {
          throw new Error(`${group.id} fused feeling changed the event time beyond the safe window`);
        }
        output.feelings.push({
          content,
          eventTime,
          importance: Math.max(...group.members.map(row => row.importance)),
        });
        provenance.feelings.push({ merged: true, groupId: group.id, sources });
      } else {
        const category = group.members[0].category;
        if (!FEATURE_CATEGORIES.has(category)) throw new Error(`${group.id} has an unsupported feature category`);
        output.features.push({
          content,
          category,
          importance: Math.max(...group.members.map(row => row.importance)),
        });
        provenance.features.push({ merged: true, groupId: group.id, sources });
      }
      mergedGroups++;
    }
  }

  sortWithProvenance(output, provenance, "feelings", compareRows);
  dedupeWithProvenance(output, provenance, "feelings");
  dedupeWithProvenance(output, provenance, "features");
  return {
    feelings: output.feelings,
    features: output.features,
    provenance,
    stats: {
      originalFeelings: plan.rows.feelings.length,
      originalFeatures: plan.rows.features.length,
      fusedFeelings: output.feelings.length,
      fusedFeatures: output.features.length,
      suggestedGroups: plan.groups.feelings.length + plan.groups.features.length,
      mergedGroups,
      refusedGroups,
    },
  };
}

function validateDecisions(groups, rawDecisions, kind) {
  if (!Array.isArray(rawDecisions)) throw new Error(`fusion response ${kind} must be an array`);
  const expected = new Map(groups.map(group => [group.id, group]));
  const decisions = new Map();
  for (const decision of rawDecisions) {
    const group = expected.get(String(decision?.groupId || ""));
    if (!group || decisions.has(group.id)) throw new Error(`fusion response contains an unknown or duplicate ${kind} group`);
    const actualIds = [...new Set((decision.memberIds || []).map(String))].sort();
    const expectedIds = group.members.map(row => row.id).sort();
    if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
      throw new Error(`${group.id} memberIds do not match the reviewed source group`);
    }
    decisions.set(group.id, { merge: decision.merge === true, content: decision.content });
  }
  if (decisions.size !== groups.length) throw new Error(`fusion response omitted one or more ${kind} groups`);
  return decisions;
}

function pushOriginal(output, provenance, row) {
  const value = row.kind === "feelings"
    ? { content: row.content, eventTime: row.eventTime, importance: row.importance }
    : { content: row.content, category: row.category, importance: row.importance };
  output[row.kind].push(value);
  provenance[row.kind].push({ merged: false, groupId: null, sources: [sourceRef(row)] });
}

function sourceRef(row) {
  return {
    id: row.id,
    index: row.index,
    candidateId: row.candidateId,
    profileId: row.profileId,
    modelLabel: row.modelLabel,
    contentSha256: sha256(row.content),
    content: row.content,
    eventTime: row.eventTime,
    category: row.category,
    importance: row.importance,
  };
}

function sortWithProvenance(output, provenance, kind, comparator) {
  const pairs = output[kind].map((row, index) => ({ row, provenance: provenance[kind][index] }));
  pairs.sort((left, right) => comparator(left.row, right.row));
  output[kind] = pairs.map(pair => pair.row);
  provenance[kind] = pairs.map(pair => pair.provenance);
}

function dedupeWithProvenance(output, provenance, kind) {
  const keptRows = [];
  const keptProvenance = [];
  const byContent = new Map();
  output[kind].forEach((row, index) => {
    const existing = byContent.get(row.content);
    if (existing == null) {
      byContent.set(row.content, keptRows.length);
      keptRows.push(row);
      keptProvenance.push(provenance[kind][index]);
      return;
    }
    keptProvenance[existing].sources.push(...provenance[kind][index].sources);
  });
  output[kind] = keptRows;
  provenance[kind] = keptProvenance;
}

function promptGroup(group) {
  return {
    groupId: group.id,
    memberIds: group.members.map(row => row.id),
    sources: group.members.map(row => ({
      id: row.id,
      model: row.modelLabel,
      eventTime: row.eventTime,
      category: row.category,
      importance: row.importance,
      content: row.content,
    })),
  };
}

function compareRows(left, right) {
  const a = Date.parse(left.eventTime || "");
  const b = Date.parse(right.eventTime || "");
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return Number(left.index || 0) - Number(right.index || 0);
}

function textSimilarity(left, right) {
  const a = ngrams(left), b = ngrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

function ngrams(value) {
  const text = String(value || "")
    .replace(/^\d{1,2}月\d{1,2}日[^。]*。?/, "")
    .replace(/[\s，。、“”‘’！？：；,.!?;:'"()[\]{}]/g, "");
  const grams = new Set();
  if (text.length < 2) {
    if (text) grams.add(text);
    return grams;
  }
  for (let index = 0; index < text.length - 1; index++) grams.add(text.slice(index, index + 2));
  return grams;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

module.exports = {
  buildFusionPlan,
  buildFusionPrompt,
  editFusionCandidate,
  fuseReviewCandidate,
  groupRows,
  materializeFusion,
  textSimilarity,
};
