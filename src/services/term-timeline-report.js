"use strict";

function compactTermTimelineReport(data) {
  return {
    threadId: data.threadId,
    report: (data.report || []).map(row => ({
      term: row.term, normalizedTerm: row.normalizedTerm, categories: row.categories || [],
      categorySupport: row.categorySupport || {}, from: row.from, to: row.to,
      messageCount: row.messageCount, occurrenceCount: row.occurrenceCount, activeDays: row.activeDays,
      firstSeen: row.firstSeen, lastSeen: row.lastSeen, baseline: row.baseline,
      timeline: row.timeline || [], feelings: row.feelings || [],
    })),
    intersections: (data.intersections || []).map(row => ({
      terms: row.terms || [],
      sameDayCount: Array.isArray(row.sameDays) ? row.sameDays.length : Number(row.sameDayCount || 0),
      sameMessageCount: Number.isFinite(row.sameMessageCount)
        ? row.sameMessageCount : (Array.isArray(row.sameMessages) ? row.sameMessages.length : 0),
      sameFeelingCount: Array.isArray(row.sameFeelings) ? row.sameFeelings.length : Number(row.sameFeelingCount || 0),
    })),
    relation: {
      terms: (data.relation?.terms || []).map(row => ({
        term: row.term, normalizedTerm: row.normalizedTerm, state: row.state,
        shape: row.shape, confidence: row.confidence, reasons: row.reasons || [],
        signature: row.signature ? {
          term: row.signature.term, normalizedTerm: row.signature.normalizedTerm,
          sameFeelings: row.signature.sameFeelings, sameDays: row.signature.sameDays,
          strength: row.signature.strength,
        } : null,
      })),
      pairs: (data.relation?.pairs || []).map(row => ({
        terms: row.terms || [], normalizedTerms: row.normalizedTerms || [],
        state: row.state, shape: row.shape, evidence: row.evidence || {},
      })),
    },
    work: {
      groups: (data.work?.groups || []).map(row => ({
        id: row.id, state: row.state, shape: row.shape, firstSeen: row.firstSeen,
        lastSeen: row.lastSeen, members: (row.members || []).map(member => ({
          term: member.term, normalizedTerm: member.normalizedTerm,
        })),
      })),
    },
  };
}

module.exports = { compactTermTimelineReport };
