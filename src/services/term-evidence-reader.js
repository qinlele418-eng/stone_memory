"use strict";

const fs = require("node:fs");
const { normalizeTerm } = require("./feature-phrase-extractor");
const { listDateFiles } = require("../lib/archive-paths");

function normalizedTerms(terms) {
  return [...new Set((terms || []).map(term => normalizeTerm(
    typeof term === "string" ? term : term.normalizedTerm || term.term
  )).filter(Boolean))];
}

function readMatchingUserMessages({ store, terms, from = null, to = null, archiveDir = null }) {
  const requested = normalizedTerms(terms);
  if (!requested.length) return [];
  const dates = store.listMessageDates();
  if (!dates.length && archiveDir) return readMatchingUserArchive({ archiveDir, terms: requested, from, to });
  const rows = [];
  for (const date of dates) {
    if ((from && date < from) || (to && date > to)) continue;
    for (const message of store.listMessages({ date })) {
      if (message.type !== "user") continue;
      const text = normalizeTerm(message.text);
      if (!requested.some(term => text.includes(term))) continue;
      rows.push({ date: message.sourceDate, timestamp: message.timestamp, text: message.text });
    }
  }
  return rows;
}

function readMatchingUserArchive({ archiveDir, terms, from = null, to = null }) {
  const requested = normalizedTerms(terms);
  const rows = [];
  for (const { date, file } of listDateFiles(archiveDir)) {
    if ((from && date < from) || (to && date > to)) continue;
    let lines;
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if ((message.type || message.role) !== "user" || !message.text) continue;
        const text = normalizeTerm(message.text);
        if (requested.some(term => text.includes(term))) {
          rows.push({ date, timestamp: message.timestamp || null, text: String(message.text) });
        }
      } catch {}
    }
  }
  return rows;
}

function readMatchingFeelings({ store, terms, from = null, to = null }) {
  const requested = normalizedTerms(terms);
  if (!requested.length) return [];
  const rows = [];
  for (const feeling of store.iterateFeelingEvidence({ from, to })) {
    const content = normalizeTerm(feeling.content);
    if (requested.some(term => content.includes(term))) rows.push(feeling);
  }
  return rows;
}

function countMessageCooccurrences({ store, terms, from = null, to = null }) {
  const requested = normalizedTerms(terms);
  const groups = [];
  for (let left = 0; left < requested.length; left++) {
    for (let right = left + 1; right < requested.length; right++) groups.push([requested[left], requested[right]]);
  }
  if (requested.length > 2) groups.push(requested);
  const counts = new Map(groups.map(group => [cooccurrenceKey(group), 0]));
  if (!groups.length) return counts;
  for (const date of store.listMessageDates()) {
    if ((from && date < from) || (to && date > to)) continue;
    for (const message of store.listMessages({ date })) {
      if (message.type !== "user") continue;
      const text = normalizeTerm(message.text);
      for (const group of groups) {
        if (group.every(term => text.includes(term))) {
          const key = cooccurrenceKey(group);
          counts.set(key, counts.get(key) + 1);
        }
      }
    }
  }
  return counts;
}

function cooccurrenceKey(terms) {
  return [...terms].map(normalizeTerm).sort().join("\u0000");
}

module.exports = {
  normalizedTerms, readMatchingUserMessages, readMatchingUserArchive, readMatchingFeelings,
  countMessageCooccurrences, cooccurrenceKey,
};
