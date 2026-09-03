const { normalizeTerm } = require("./feature-phrase-extractor");
const { countOccurrences } = require("./term-timeline");

function updateTermEvidenceCache({ store, terms }) {
  const normalizedTerms = [...new Set((terms || []).map(term =>
    normalizeTerm(typeof term === "string" ? term : term.normalizedTerm || term.term)
  ).filter(Boolean))];
  const dates = store.listMessageDates();
  const latestCached = store.latestTermEvidenceDates(normalizedTerms);
  const rows = [];
  const scanned = [];

  const pendingByTerm = new Map(normalizedTerms.map(term => {
    const lastDate = latestCached.get(term) || null;
    return [term, dates.filter(date => !lastDate || date > lastDate)];
  }));
  const pendingSets = new Map([...pendingByTerm].map(([term, pending]) => [term, new Set(pending)]));

  for (const date of dates) {
    const termsForDate = normalizedTerms.filter(term => pendingSets.get(term).has(date));
    if (!termsForDate.length) continue;
    const counts = new Map(termsForDate.map(term => [term, { userMessageCount: 0, occurrenceCount: 0 }]));
    for (const message of store.listMessages({ date })) {
      if (message.type !== "user") continue;
      const text = normalizeTerm(message.text);
      for (const term of termsForDate) {
        const count = countOccurrences(text, term);
        if (!count) continue;
        const result = counts.get(term);
        result.userMessageCount++;
        result.occurrenceCount += count;
      }
    }
    for (const term of termsForDate) rows.push({ normalizedTerm: term, sourceDate: date, ...counts.get(term) });
  }
  for (const [term, pendingDates] of pendingByTerm) {
    if (pendingDates.length) scanned.push({ normalizedTerm: term, from: pendingDates[0], to: pendingDates.at(-1), dates: pendingDates.length });
  }

  store.upsertTermDailyStats(rows);
  return { terms: normalizedTerms.length, rows: rows.length, scanned };
}

module.exports = { updateTermEvidenceCache };
