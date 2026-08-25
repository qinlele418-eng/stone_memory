"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("./database");

const VISIBILITIES = new Set(["visible", "sealed"]);
const COVER_PRESETS = new Set(["", "preset:forest", "preset:mist", "preset:amber", "preset:berry", "preset:night"]);
const NOTEBOOK_IMAGE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"], [".avif", "image/avif"],
]);
const MAX_NOTEBOOK_ASSET_BYTES = 20 * 1024 * 1024;

class NotebookStore {
  constructor({ threadId, root, memoryDir = root } = {}) {
    this.threadId = requiredSegment(threadId, "threadId");
    if (!root) throw new Error("notebook root is required");
    this.root = path.resolve(root);
    this.db = openDatabase(memoryDir || this.root);
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO threads(id,created_at,updated_at) VALUES (?,?,?)")
      .run(this.threadId, now, now);
  }

  close() { this.db.close(); }

  status() {
    const topics = this.db.prepare(`SELECT t.id,t.name,t.slug,t.description,t.cover_path AS coverPath,
      t.visibility,t.is_archived AS isArchived,t.is_default AS isDefault,t.created_at AS createdAt,t.updated_at AS updatedAt,
      COUNT(e.id) AS entryCount,MAX(e.updated_at) AS latestEntryAt
      FROM notebook_topics t LEFT JOIN notebook_entries e ON e.topic_id=t.id AND e.thread_id=t.thread_id
      WHERE t.thread_id=? GROUP BY t.id ORDER BY t.is_archived,t.updated_at DESC,t.name`).all(this.threadId)
      .map(normalizeTopicRow);
    const latestEntries = new Map(this.db.prepare(`SELECT id,topic_id,title,visibility,body_text,updated_at FROM (
      SELECT e.*,ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY updated_at DESC,id DESC) AS row_number
      FROM notebook_entries e WHERE thread_id=?) WHERE row_number=1`).all(this.threadId).map(row => [row.topic_id, row]));
    for (const topic of topics) topic.latestEntry = normalizeLatestEntry(latestEntries.get(topic.id));
    return {
      threadId: this.threadId,
      topicCount: topics.length,
      entryCount: topics.reduce((sum, topic) => sum + topic.entryCount, 0),
      defaultTopicId: topics.find(topic => topic.isDefault)?.id || null,
      topics,
    };
  }

  createTopic({ name, description = "", visibility = "visible", coverPath = "", isDefault = false }) {
    const normalizedName = requiredText(name, "topic name");
    const normalizedVisibility = assertVisibility(visibility);
    const id = `topic_${crypto.randomUUID()}`;
    const slugBase = slugify(normalizedName) || "notebook";
    const slug = `${slugBase}--${id.slice(-6)}`;
    const now = new Date().toISOString();
    const previousDefault = isDefault ? this.getDefaultTopic() : null;
    const topicDirectory = path.join(this.root, "topics", slug);
    fs.mkdirSync(path.join(topicDirectory, "entries"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(topicDirectory, "assets"), { recursive: true, mode: 0o700 });
    this.db.transaction(() => {
      if (isDefault) this.db.prepare("UPDATE notebook_topics SET is_default=0 WHERE thread_id=?").run(this.threadId);
      this.db.prepare(`INSERT INTO notebook_topics
        (id,thread_id,name,slug,description,cover_path,visibility,is_archived,is_default,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,0,?,?,?)`).run(
        id, this.threadId, normalizedName, slug, singleLine(description), normalizeCoverPath(coverPath), normalizedVisibility,
        isDefault ? 1 : 0, now, now,
      );
    })();
    if (previousDefault && previousDefault.id !== id) this.writeTopicMetadata(this.getTopic(previousDefault.id));
    this.writeTopicMetadata(this.getTopic(id));
    return this.getTopic(id);
  }

  updateTopic({ topicId, name, description, visibility, archived, coverPath, isDefault }) {
    const current = this.getTopic(topicId);
    if (!current) throw new Error(`notebook topic not found: ${topicId}`);
    const next = {
      name: name === undefined ? current.name : requiredText(name, "topic name"),
      description: description === undefined ? current.description : singleLine(description),
      coverPath: coverPath === undefined ? current.coverPath : normalizeCoverPath(coverPath),
      visibility: visibility === undefined ? current.visibility : assertVisibility(visibility),
      archived: archived === undefined ? current.isArchived : Boolean(archived),
      isDefault: isDefault === undefined ? current.isDefault : Boolean(isDefault),
      updatedAt: new Date().toISOString(),
    };
    const previousDefault = next.isDefault ? this.getDefaultTopic() : null;
    if (next.archived && next.isDefault) throw new Error("default notebook topic cannot be archived; clear the default or choose another topic first");
    this.db.transaction(() => {
      if (next.isDefault) this.db.prepare("UPDATE notebook_topics SET is_default=0 WHERE thread_id=?").run(this.threadId);
      this.db.prepare(`UPDATE notebook_topics SET name=?,description=?,cover_path=?,visibility=?,is_archived=?,is_default=?,updated_at=?
        WHERE id=? AND thread_id=?`).run(
        next.name, next.description, next.coverPath || null, next.visibility, next.archived ? 1 : 0,
        next.isDefault ? 1 : 0, next.updatedAt, current.id, this.threadId,
      );
    })();
    if (previousDefault && previousDefault.id !== current.id) this.writeTopicMetadata(this.getTopic(previousDefault.id));
    this.writeTopicMetadata(this.getTopic(current.id));
    return this.getTopic(current.id);
  }

  getTopic(topicId) {
    const row = this.db.prepare(`SELECT id,name,slug,description,cover_path AS coverPath,
      visibility,is_archived AS isArchived,is_default AS isDefault,created_at AS createdAt,updated_at AS updatedAt
      FROM notebook_topics WHERE id=? AND thread_id=?`).get(requiredSegment(topicId, "topicId"), this.threadId);
    return row ? normalizeTopicRow(row) : null;
  }

  writeEntry({ noteId, topicId, title, body, tags = [], visibility = "visible", expectedRevision }) {
    const normalizedBody = requiredText(body, "note body");
    const normalizedTitle = requiredText(title, "note title");
    const normalizedVisibility = assertVisibility(visibility);
    const normalizedTags = normalizeTags(tags);
    const current = noteId ? this.getEntryRecord(noteId) : null;
    if (noteId && !current) throw new Error(`notebook entry not found: ${noteId}`);
    const topic = topicId ? this.getTopic(topicId) : current ? this.getTopic(current.topicId) : this.getDefaultTopic();
    if (!topicId && !current && !topic) throw new Error("topicId is required when no default notebook topic is configured");
    if (!topic) throw new Error(`notebook topic not found: ${topicId}`);
    if (topic.isArchived) throw new Error(`notebook topic is archived: ${topicId}`);
    const now = new Date().toISOString();

    if (noteId) {
      if (!Number.isInteger(expectedRevision)) throw new Error("expectedRevision is required when updating a note");
      if (expectedRevision !== current.revision) {
        const error = new Error(`notebook revision conflict: expected ${expectedRevision}, current ${current.revision}`);
        error.code = "NOTEBOOK_REVISION_CONFLICT";
        throw error;
      }
      const nextRevision = current.revision + 1;
      const targetTopic = topic;
      const targetRelativePath = current.topicId === targetTopic.id
        ? current.relativePath
        : this.newEntryRelativePath(targetTopic, normalizedTitle, current.id);
      this.backupRevision(current);
      this.atomicWrite(targetRelativePath, renderEntryMarkdown({
        id: current.id, topicId: targetTopic.id, title: normalizedTitle, tags: normalizedTags,
        visibility: normalizedVisibility, createdAt: current.createdAt, updatedAt: now,
        revision: nextRevision, body: normalizedBody,
      }));
      if (targetRelativePath !== current.relativePath) this.safeRemove(current.relativePath);
      const changed = this.db.prepare(`UPDATE notebook_entries SET topic_id=?,title=?,relative_path=?,visibility=?,
        tags_json=?,body_text=?,revision=?,updated_at=? WHERE id=? AND thread_id=? AND revision=?`).run(
        targetTopic.id, normalizedTitle, targetRelativePath, normalizedVisibility,
        JSON.stringify(normalizedTags), normalizedBody, nextRevision, now,
        current.id, this.threadId, current.revision,
      );
      if (!changed.changes) throw new Error("notebook entry changed during update");
      return this.readEntry(current.id);
    }

    const id = `note_${crypto.randomUUID()}`;
    const relativePath = this.newEntryRelativePath(topic, normalizedTitle, id);
    this.atomicWrite(relativePath, renderEntryMarkdown({
      id, topicId: topic.id, title: normalizedTitle, tags: normalizedTags,
      visibility: normalizedVisibility, createdAt: now, updatedAt: now, revision: 1,
      body: normalizedBody,
    }));
    this.db.prepare(`INSERT INTO notebook_entries
      (id,thread_id,topic_id,title,relative_path,visibility,tags_json,body_text,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(
      id, this.threadId, topic.id, normalizedTitle, relativePath, normalizedVisibility,
      JSON.stringify(normalizedTags), normalizedBody, now, now,
    );
    return this.readEntry(id);
  }

  getDefaultTopic() {
    const row = this.db.prepare(`SELECT id,name,slug,description,cover_path AS coverPath,
      visibility,is_archived AS isArchived,is_default AS isDefault,created_at AS createdAt,updated_at AS updatedAt
      FROM notebook_topics WHERE thread_id=? AND is_default=1`).get(this.threadId);
    return row ? normalizeTopicRow(row) : null;
  }

  query({ query = "", topicId = null, tags = [], limit = 20 } = {}) {
    const normalizedQuery = String(query || "").trim();
    const needle = normalizedQuery.toLocaleLowerCase();
    const normalizedTags = normalizeTags(tags).map(tag => tag.toLocaleLowerCase());
    if (!needle && !normalizedTags.length) throw new Error("query or at least one exact tag is required");
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const rows = topicId
      ? this.db.prepare(`SELECT e.*,t.name AS topic_name FROM notebook_entries e
        JOIN notebook_topics t ON t.id=e.topic_id WHERE e.thread_id=? AND e.topic_id=?
        ORDER BY e.updated_at DESC`).all(this.threadId, requiredSegment(topicId, "topicId"))
      : this.db.prepare(`SELECT e.*,t.name AS topic_name FROM notebook_entries e
        JOIN notebook_topics t ON t.id=e.topic_id WHERE e.thread_id=? ORDER BY e.updated_at DESC`).all(this.threadId);
    const matches = [];
    for (const row of rows) {
      const tags = parseTags(row.tags_json);
      const loweredTags = tags.map(tag => tag.toLocaleLowerCase());
      if (normalizedTags.some(tag => !loweredTags.includes(tag))) continue;
      const haystack = `${row.title}\n${tags.join(" ")}\n${row.body_text}`.toLocaleLowerCase();
      const index = needle ? haystack.indexOf(needle) : 0;
      if (needle && index < 0) continue;
      matches.push({
        id: row.id,
        topicId: row.topic_id,
        topicName: row.topic_name,
        title: row.title,
        relativePath: row.relative_path,
        visibility: row.visibility,
        tags,
        revision: row.revision,
        updatedAt: row.updated_at,
        snippet: snippetAround(row.body_text, normalizedQuery),
      });
      if (matches.length >= boundedLimit) break;
    }
    return { threadId: this.threadId, query: normalizedQuery, topicId, tags: normalizeTags(tags), matchCount: matches.length, matches };
  }

  readEntry(noteId) {
    const row = this.getEntryRecord(noteId);
    if (!row) return null;
    return {
      found: true,
      threadId: this.threadId,
      id: row.id,
      topicId: row.topicId,
      topicName: row.topicName,
      title: row.title,
      relativePath: row.relativePath,
      visibility: row.visibility,
      tags: row.tags,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      body: row.body,
      markdown: fs.readFileSync(this.resolveRelative(row.relativePath), "utf8"),
    };
  }

  listEntries({ topicId, includeBody = false } = {}) {
    const rows = this.db.prepare(`SELECT e.*,t.name AS topic_name FROM notebook_entries e
      JOIN notebook_topics t ON t.id=e.topic_id WHERE e.thread_id=? AND e.topic_id=?
      ORDER BY e.updated_at DESC`).all(this.threadId, requiredSegment(topicId, "topicId"));
    return rows.map(row => ({
      id: row.id, topicId: row.topic_id, topicName: row.topic_name, title: row.title,
      relativePath: row.relative_path, visibility: row.visibility, tags: parseTags(row.tags_json),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(includeBody ? { body: row.body_text } : {}),
    }));
  }

  readAsset(topicId, filename) {
    const topic = this.getTopic(topicId);
    if (!topic) throw new Error(`notebook topic not found: ${topicId}`);
    const safeName = requiredSegment(filename, "asset filename");
    const extension = path.extname(safeName).toLowerCase();
    const contentType = NOTEBOOK_IMAGE_TYPES.get(extension);
    if (!contentType) throw new Error("notebook asset must be png, jpg, jpeg, webp, gif, or avif");
    const relativePath = path.posix.join("topics", topic.slug, "assets", safeName);
    const absolutePath = this.resolveRelative(relativePath);
    if (!fs.existsSync(absolutePath)) return null;
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_NOTEBOOK_ASSET_BYTES) throw new Error("notebook asset exceeds 20 MB display limit");
    return { absolutePath, relativePath, contentType, size: stat.size, modifiedAt: stat.mtime };
  }

  getEntryRecord(noteId) {
    const row = this.db.prepare(`SELECT e.*,t.name AS topic_name FROM notebook_entries e
      JOIN notebook_topics t ON t.id=e.topic_id WHERE e.id=? AND e.thread_id=?`)
      .get(requiredSegment(noteId, "noteId"), this.threadId);
    if (!row) return null;
    return {
      id: row.id, topicId: row.topic_id, topicName: row.topic_name, title: row.title,
      relativePath: row.relative_path, visibility: row.visibility, tags: parseTags(row.tags_json),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, body: row.body_text,
    };
  }

  newEntryRelativePath(topic, title, noteId) {
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${date}-${slugify(title).slice(0, 50) || "note"}-${noteId.slice(-6)}.md`;
    return path.posix.join("topics", topic.slug, "entries", filename);
  }

  writeTopicMetadata(topic) {
    const relativePath = path.posix.join("topics", topic.slug, "topic.json");
    this.atomicWrite(relativePath, `${JSON.stringify({
      schemaVersion: "stone.notebook.topic.v1",
      id: topic.id,
      name: topic.name,
      description: topic.description,
      coverPath: topic.coverPath,
      visibility: topic.visibility,
      archived: topic.isArchived,
      isDefault: topic.isDefault,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
    }, null, 2)}\n`);
  }

  backupRevision(entry) {
    const relative = path.posix.join("history", entry.id, `revision-${entry.revision}.md`);
    const source = this.resolveRelative(entry.relativePath);
    if (!fs.existsSync(source)) return;
    const target = this.resolveRelative(relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }

  atomicWrite(relativePath, content) {
    const target = this.resolveRelative(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch {} }
  }

  safeRemove(relativePath) {
    const target = this.resolveRelative(relativePath);
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  resolveRelative(relativePath) {
    const target = path.resolve(this.root, String(relativePath || ""));
    const prefix = `${this.root}${path.sep}`;
    if (target !== this.root && !target.startsWith(prefix)) throw new Error("notebook path escaped root");
    return target;
  }
}

function renderEntryMarkdown({ id, topicId, title, tags, visibility, createdAt, updatedAt, revision, body }) {
  return [
    "---",
    `id: ${jsonScalar(id)}`,
    `topicId: ${jsonScalar(topicId)}`,
    `title: ${jsonScalar(title)}`,
    `tags: ${JSON.stringify(tags)}`,
    `visibility: ${visibility}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    `revision: ${revision}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function normalizeTopicRow(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || "",
    coverPath: row.coverPath || null,
    visibility: row.visibility,
    isArchived: Boolean(row.isArchived),
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    entryCount: Number(row.entryCount || 0),
    latestEntryAt: row.latestEntryAt || null,
  };
}

function normalizeLatestEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    updatedAt: row.updated_at,
    summary: row.visibility === "sealed" ? null : summarize(row.body_text),
  };
}

function summarize(value, limit = 96) {
  const text = singleLine(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredSegment(value, name) {
  const text = requiredText(value, name);
  if (text === "." || text === ".." || /[\\/\0]/.test(text)) throw new Error(`invalid ${name}`);
  return text;
}

function assertVisibility(value) {
  const visibility = String(value || "visible");
  if (!VISIBILITIES.has(visibility)) throw new Error("visibility must be visible or sealed");
  return visibility;
}

function normalizeCoverPath(value) {
  const coverPath = singleLine(value);
  if (!COVER_PRESETS.has(coverPath)) throw new Error("coverPath must be an available notebook cover preset");
  return coverPath;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw new Error("tags must be an array");
  return [...new Set(tags.map(singleLine).filter(Boolean))].slice(0, 20);
}

function parseTags(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function singleLine(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function slugify(value) { return singleLine(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""); }
function jsonScalar(value) { return JSON.stringify(String(value)); }

function snippetAround(body, query) {
  const text = String(body || "").replace(/\s+/g, " ");
  const index = text.toLocaleLowerCase().indexOf(String(query || "").toLocaleLowerCase());
  if (index < 0) return text.slice(0, 180);
  const start = Math.max(0, index - 70);
  return `${start ? "…" : ""}${text.slice(start, index + String(query).length + 110)}${index + String(query).length + 110 < text.length ? "…" : ""}`;
}

module.exports = { NotebookStore, renderEntryMarkdown, VISIBILITIES, COVER_PRESETS };
