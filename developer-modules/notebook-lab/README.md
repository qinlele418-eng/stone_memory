# Sentence-book presentation for the existing notebook system

This contribution adds `kind: "sentence-book"` to the existing themed notebook. It is a notebook presentation, not a second storage service or a separate memory database.

A book is a notebook topic; each card is a notebook entry whose body contains the quotation. Optional metadata carries `speaker`, `collector`, `note`, `note_author`, `conversation_title`, `source_id`, `originalCreatedAt`, and recoverable `sentenceRemoved` state. Existing standard notebooks keep their reading layout.

## Operations

- Continuous card layout with 12 cards per page, search, full-card detail, editing, recoverable removal and restoration.
- JSON import with preview and original-source deduplication.
- Per-book cover/header/footer images with crop preview; paper, text and accent colors; editable cover title.
- New sentence drafts and uncertain-write receipts are scoped to memory and topic in browser storage. Confirmed content is stored through the original notebook API/CLI, never only in browser storage.

## Shared data and MCP

Writes reuse `stmem notebook` via existing HTTP or module MCP command adapters and NotebookService/NotebookStore. MCP names are unchanged. `topic_manage` accepts the book kind and presentation; `write` accepts structured metadata. Use `query`/`read` for discovery and revision-aware edits. To remove or restore, read first, preserve the entry and metadata, and write `sentenceRemoved: true` or `false` with the current revision. The natural-language delegate remains for ordinary notes and is not the structured sentence-book editor.

The existing notebook tables gain additive defaulted columns (`kind`, `presentation_json`, `metadata_json`), preserving ordinary rows and IDs. This touches shared storage only because the already-integrated notebook implementation lives there; no parallel database, provider registration, watcher, port or new permission is added.

## Assets and compatibility

See frontend `assets/SOURCE.md` and `FONT-LICENSE.md`. Only required web fonts and ornaments are distributed. Uploaded covers, memory files, test-library databases and local operational notes are excluded.

Code rollback uses the previous release. Keep the additive columns and current data; do not restore old database snapshots over newer user writes. Older code cannot display sentence-specific metadata but can still read notebook bodies.

## Validation

Targeted notebook CLI, Web, storage, pagination/Markdown, import and MCP integration tests accompany this change. Browser checks include desktop/mobile viewport layouts, pagination with 25 synthetic entries, long text, search, add/edit/cancel, import preview/deduplication, and removal/restore. Browser viewport validation is not physical-device acceptance.
