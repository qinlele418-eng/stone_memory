const { MemoryStore } = require("../storage/memory-store");
const { ingestMessages, previewIngestMessages } = require("./thread-ingest");

function previewRebuildArchiveCatchup({ fullArchive, currentMessages }) {
  const pendingFullRows = fullArchive.pendingNewFullBatch(currentMessages);
  const ingestPreview = previewIngestMessages(currentMessages);
  return { pendingFullRows, ingestPreview };
}

function applyRebuildArchiveCatchup({ fullArchive, memoryDir, threadId, currentMessages }) {
  const fullBacked = fullArchive.archiveNewFullBatch(currentMessages);
  const store = new MemoryStore({ memoryDir, threadId });
  try {
    const ingested = ingestMessages(currentMessages, { memoryStore: store });
    return { fullBacked, ingested };
  } finally {
    store.close();
  }
}

module.exports = { previewRebuildArchiveCatchup, applyRebuildArchiveCatchup };
