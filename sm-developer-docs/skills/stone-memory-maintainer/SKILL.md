---
name: stone-memory-maintainer
description: Safely inspect, diagnose, modify, review, test, or extend the Stone Memory (SM) repository. Use for Stone Memory bugs, CLI/Web/MCP/watcher/rebuild/miner/search/compression work, PR or Issue review, developer modules, data migrations, release preparation, and contributor prototypes that must be generalized without exposing private memory data or creating parallel write paths.
---

# Stone Memory Maintainer

Maintain Stone Memory as one coherent product rather than a collection of local scripts. Preserve user control, data traceability, runtime compatibility, and the official CLI write boundary.

## Start every task

1. Locate the repository root.
2. Read every applicable `AGENTS.md` completely, including nested files for the target path.
3. Inspect `git status --short`; treat all existing changes as user-owned.
4. Classify the request:
   - **Explain/review/status:** inspect and report; do not mutate.
   - **Diagnose:** reproduce and identify the failing layer; do not implement unless requested.
   - **Change/build:** implement through the canonical architecture and verify.
   - **Commit/push/external action:** act only when explicitly requested.
5. Search with `rg`/`rg --files` before designing anything new.

Read [architecture-contract.md](references/architecture-contract.md) before changing a write path, data model, rebuild, miner, watcher, search, compression, MCP, or Web API.

## Trace the canonical path

Before editing, answer:

```text
What is the authoritative data source?
Which stmem CLI command owns the write?
Which shared service implements the behavior?
Which adapters call it?
Which runtimes and historical data are affected?
```

If no formal CLI write command exists, implement that boundary first. Do not hide missing architecture inside an HTTP route, MCP handler, frontend script, migration snippet, or user-specific automation.

For read-only views and planners, reuse readers/parsers directly when the repository permits it. Return to the CLI for every confirmed mutation.

## Work in evidence order

1. Reproduce with the smallest real or synthetic case.
2. Capture the actual error, command, runtime, input scope, and layer.
3. Compare the shared path and both Claude/Codex adapters when relevant.
4. Fix the narrowest shared cause.
5. Add a regression test for the observed failure.
6. Run focused tests, then broader tests proportional to risk.
7. Inspect the final diff for accidental data, paths, generated files, or unrelated edits.

Read [maintenance-workflow.md](references/maintenance-workflow.md) for task routing, test expectations, PR handling, and handoff rules.

## Preserve product semantics

- Keep `messages`, `feelings`, `features`, raw `full` archives, and active thread files distinct.
- Treat `daily`, `coarse`, and `hidden` as injection granularity, not deletion levels.
- Preserve full feeling content unless the user explicitly invokes a destructive deletion feature.
- Keep retain/original anchors separate from event/protection anchors.
- Never let a frequency curve, embedding similarity, importance score, or model output decide irreversible state alone.
- Keep dry-run, explicit confirmation, backup, validation, and atomic apply for risky operations.
- Share selection and safety rules across Claude and Codex even when their thread formats differ.
- Prefer recomputable evidence over new permanent state variables.
- Do not fix one private word, persona, date, path, or model with a hardcoded rule.

## Handle contributor prototypes

Treat a working prototype as evidence of product value, not proof that its implementation belongs in core.

Check:

- Does it work outside the contributor's machine?
- Does it reuse the canonical CLI and data sources?
- Are HOME, ports, providers, models, thread IDs, and paths configurable?
- Does it preserve both runtimes when the capability applies to both?
- Can it enter as a detachable developer module first?
- Does the UI use the shared module shell and theme contract?
- Are the contributor's original value and attribution preserved after integration?

When architecture support is missing, propose an Issue or design gap instead of simulating completion with a parallel server or private companion process.

## Protect private data

Read [privacy-and-contribution-boundaries.md](references/privacy-and-contribution-boundaries.md) before using real archives, preparing fixtures, writing docs, reviewing logs, or publishing a commit/PR.

Default to synthetic fixtures. Never expose conversation text, summaries, API keys, auth files, private thread identifiers, personal paths, collaborator lists, ignored planning documents, or unpublished product/patent material.

## Finish clearly

Report:

- the outcome and affected layer;
- the root cause for bug fixes;
- commands/tests run and their result;
- migrations, compatibility risks, or remaining gaps;
- whether changes were only local, committed, or pushed.

Do not claim success from a mock, dry-run, or frontend display when the formal backend path was not exercised.
