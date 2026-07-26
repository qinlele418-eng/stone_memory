#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MemoryStore } = require("../src/storage/memory-store");
const { getThreadDir } = require("../src/config");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function stableId(prefix, ...parts) {
  return `${prefix}_legacy_${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function diaryEntries(diaryDir) {
  const rows = [];
  const dates = new Set();
  for (const file of fs.readdirSync(diaryDir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()) {
    const sourceDate = file.slice(0, 10);
    dates.add(sourceDate);
    const text = fs.readFileSync(path.join(diaryDir, file), "utf8").trim();
    const sections = text.split(/(?=^##\s+)/gm).filter(section => section.startsWith("## "));
    for (const section of sections) {
      const [headingLine, ...bodyLines] = section.split("\n");
      const heading = headingLine.replace(/^##\s+/, "").trim();
      const body = bodyLines.join("\n").trim();
      if (!body) continue;
      const time = heading.match(/^(\d{2}:\d{2})\b/)?.[1] || null;
      const content = `[迁移日记] ${sourceDate} ${heading}：${body.replace(/\s+/g, " ")}`;
      rows.push({
        id: stableId("mem", "diary", sourceDate, heading, body),
        sourceDate,
        eventTime: time,
        content,
        importance: /关系|承诺|健康|吃药|就医|难受|害怕|记住|重要/.test(content) ? 4 : 3,
      });
    }
  }
  return { rows, dates };
}

function timelineEntries(file, diaryDates) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = [];
  for (const [sourceDate, day] of Object.entries(data.facts || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (diaryDates.has(sourceDate)) continue;
    for (const event of day.events || []) {
      const title = String(event.title || "事件").trim();
      const note = String(event.note || "").trim();
      if (!note) continue;
      const startAt = event.startAt ? new Date(event.startAt) : null;
      const eventTime = startAt && Number.isFinite(startAt.getTime())
        ? new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone || "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(startAt)
        : null;
      const content = `[迁移时间线] ${sourceDate} ${title}：${note.replace(/\s+/g, " ")}`;
      rows.push({
        id: stableId("mem", "timeline", event.id || "", sourceDate, title, note),
        sourceDate,
        eventTime,
        content,
        importance: /health|medication|work|meeting|关系|健康|吃药|就医/.test(`${event.categoryId || ""} ${content}`) ? 4 : 3,
      });
    }
  }
  return rows;
}

function featureEntries(memoryDir) {
  const categories = {
    "facts.md": "facts",
    "open_loops.md": "open_loops",
    "patterns.md": "patterns",
    "preferences.md": "preferences",
    "projects.md": "projects",
    "recovery.md": "recovery",
  };
  const rows = [];
  for (const [file, category] of Object.entries(categories)) {
    const text = fs.readFileSync(path.join(memoryDir, file), "utf8");
    for (const match of text.matchAll(/^-\s+(.+?)(?=^\s*-\s+|^#|\s*$)/gms)) {
      const body = match[1].replace(/\n\s+/g, " ").trim();
      if (!body) continue;
      const date = body.match(/\b(2026-\d{2}-\d{2})\b/)?.[1] || null;
      rows.push({
        id: stableId("feature", file, body),
        sourceDate: date,
        category,
        content: `[Cyberboss迁移/${category}] ${body}`,
        importance: /明确|重要|必须|不要|偏好|长期|核心|主锚点/.test(body) ? 4 : 3,
      });
    }
  }
  return rows;
}

function main() {
  const threadId = arg("thread");
  const root = path.resolve(arg("source-root", ""));
  const apply = process.argv.includes("--apply");
  if (!threadId || !root) throw new Error("usage: --thread <id> --source-root <extracted .cyberboss dir> [--apply]");

  const diary = diaryEntries(path.join(root, "diary"));
  const feelings = [
    ...diary.rows,
    ...timelineEntries(path.join(root, "timeline", "timeline-facts.json"), diary.dates),
  ];
  const features = featureEntries(path.join(root, "memory"));
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try {
    const existingFeelingIds = new Set(store.listFeelings().map(row => row.id));
    const existingFeatureIds = new Set(store.listFeatures().map(row => row.id));
    const newFeelings = feelings.filter(row => !existingFeelingIds.has(row.id));
    const newFeatures = features.filter(row => !existingFeatureIds.has(row.id));
    const report = {
      mode: apply ? "apply" : "dry-run",
      diaryFiles: diary.dates.size,
      diaryFeelings: diary.rows.length,
      timelineFallbackFeelings: feelings.length - diary.rows.length,
      featureItems: features.length,
      newFeelings: newFeelings.length,
      newFeatures: newFeatures.length,
    };
    if (!apply) return console.log(JSON.stringify(report, null, 2));

    const now = new Date().toISOString();
    const insertFeeling = store.db.prepare(`INSERT OR IGNORE INTO feelings
      (id,thread_id,source_date,event_time,order_key,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (@id,@threadId,@sourceDate,@eventTime,@orderKey,@content,@importance,'import','cyberboss-migration-20260710',NULL,@createdAt,@updatedAt)`);
    const insertFeature = store.db.prepare(`INSERT OR IGNORE INTO features
      (id,thread_id,source_date,category,content,importance,source,source_thread,mining_job_id,created_at,updated_at)
      VALUES (@id,@threadId,@sourceDate,@category,@content,@importance,'import','cyberboss-migration-20260710',NULL,@createdAt,@updatedAt)`);
    store.db.transaction(() => {
      newFeelings.forEach((row, index) => insertFeeling.run({
        ...row,
        threadId,
        orderKey: `${row.eventTime || row.sourceDate}:legacy:${String(index).padStart(6, "0")}`,
        createdAt: now,
        updatedAt: now,
      }));
      newFeatures.forEach(row => insertFeature.run({ ...row, threadId, createdAt: now, updatedAt: now }));
    })();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

main();
