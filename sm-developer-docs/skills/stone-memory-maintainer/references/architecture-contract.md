# Stone Memory architecture contract

Read this reference before changing formal behavior.

## Canonical write boundary

`stmem` is the only public write interface:

```text
Terminal ───────────────→ stmem CLI → formal write service
Web → local HTTP adapter → stmem CLI → formal write service
MCP ────────────────────→ stmem CLI → formal write service
Automation ─────────────→ stmem CLI → formal write service
```

Rules:

- Add or validate the CLI operation before attaching Web, MCP, desktop, or automation.
- Keep HTTP adapters limited to local parameter handling, secure temporary files, CLI invocation, and response formatting.
- Do not duplicate initialization, import, mining, compression, rebuild, repair, or database writes in adapters.
- Keep secrets out of argv, logs, fixtures, Issues, and commits.
- Allow direct readers/planners for read-only output; route confirmed writes back through CLI.

Typical ownership:

```text
create/update memory body → stmem init
import conversations      → stmem import
sync conversations        → stmem sync
mine memories             → stmem mine
compress summaries        → stmem compact / stmem compress
hide dormant summaries    → stmem hidden
rebuild/repair thread     → stmem rebuild
database maintenance      → stmem db
system diagnosis          → stmem doctor
```

## Data responsibilities

```text
SQLite messages  → cleaned user/assistant conversation used by archive UI and miner
SQLite feelings  → event narrative, time, importance, injection state, anchors
SQLite features  → derived high-value concept index and category
raw full archive → lossless rebuild/recovery source, including supported tool records
active JSONL     → context currently consumed by the agent
```

Do not:

- feed rebuild `<memory_context>` or injected rules back into `messages`;
- let plain-text filtering control raw `full` backup;
- store thinking, system metadata, or tool records as ordinary dialogue;
- merge all layers into a universal memory row;
- let features replace feeling semantics or original evidence.

## Memory states and anchors

- `daily`: inject full summary content.
- `coarse`: inject shorter coarse content while retaining original content.
- `hidden`: exclude from rebuild injection while retaining searchable content.
- retain/original anchor: inject a confirmed original-message range.
- event anchor: protect the feeling from automatic decay/compression decisions.

Anchors have explicit user authority. Do not merge the two anchor types or silently override them with lifecycle scores.

## Rebuild

- Keep Claude and Codex format adapters separate but share selection, anchors, windows, and safety policy.
- Preview before apply.
- Back up active input before replacement.
- Validate output structure and identity before atomic replacement.
- Keep watermark mode optional; it replaces the active-day cutoff, not tool retention.
- Check the other runtime whenever fixing a shared rebuild class.
- MCP preview and queued apply must remain separate: the apply queue reuses the exact latest successful preview parameters.

## Mining

- Mine only cleaned conversation messages.
- Keep API and Subagent task definitions equivalent.
- Split large input only at complete messages and preferably real conversation gaps.
- Do not publish partial-day results when a block fails.
- Preserve date and event time; sort new memories stably by event time.
- Generate features from the successfully generated feelings for that run.
- Distinguish a valid empty result from an upstream/format failure.

## Compression and retrieval

- Keep original feeling content.
- Protect manual anchors.
- Use category, time evidence, shared signatures, importance, lifecycle stage, and original context together.
- Do not let word frequency, curve shape, uniqueness, or embeddings become a single veto.
- Keep Deep Search capable of both event retrieval and recurring-pattern retrieval.
- Treat summaries as narrative backbones and archives as evidence, not interchangeable stores.

## Frontend and developer modules

- The Web UI adapts existing CLI/read services; it does not invent writes.
- Load experimental modules through detachable bootstraps and the shared module shell.
- Pass the actual selected `threadId`; never default silently to the first memory body.
- Reuse theme tokens and mobile layout contracts.
- Keep experimental UI and backend paths removable until validated by real users.
