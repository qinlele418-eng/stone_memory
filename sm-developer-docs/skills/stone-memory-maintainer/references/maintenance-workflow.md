# Stone Memory maintenance workflow

## Task routing

### Diagnose a failure

1. Record the exact error instead of paraphrasing it.
2. Identify runtime, command/tool, date/range, and whether the failure is read, plan, write, or display.
3. Inspect persisted state and logs without rewriting them.
4. Trace adapter → CLI → shared service → storage.
5. Compare historical implementation only to recover intended semantics; do not blindly revert unrelated changes.
6. Explain the cause before implementing unless the user asked to fix it.

### Implement a fix

1. Preserve user changes and unrelated dirty files.
2. Patch the shared layer when both runtimes/adapters share the cause.
3. Keep user-facing wording aligned with actual semantics.
4. Add a regression test that fails for the original bad case.
5. Verify focused behavior and compatibility surfaces.

### Review a PR or prototype

Separate product value from implementation quality:

```text
value worth preserving
private assumptions to remove
canonical services to reuse
runtime/platform gaps
test and migration requirements
recommended destination: core / developer module / proposal / private extension
```

Do not erase contributor attribution when rewriting integration code.

### Modify the Web UI

Before adding a write button, name its `stmem` command. Stop if none exists.

Check:

- desktop and mobile layout;
- currently selected memory body;
- loading, empty, error, and retry states;
- theme token coverage;
- page-position preservation after small mutations;
- pagination through the shared paging pattern;
- no raw secret or private-path exposure.

### Modify MCP

- For developer-module tools, follow [the module contract](../../../../developer-modules/DEVELOPMENT.md), section 17, and [module AGENTS.md](../../../../developer-modules/AGENTS.md).
- Register through the module's SDK v2 manifest `entry.mcp` and Provider. Do not add module-specific imports, definitions or routing branches to the root server or Core; do not create a separate MCP server/client configuration.
- Keep ordinary registration independent of the host's legacy-name compatibility table. For migrations, move the actual old tools, remove the old Core routes, and compare behavior; registering duplicate tools under new names is not a completed migration.
- Keep tool schema and implementation semantics aligned.
- Return actual protocol errors as errors.
- Route writes through CLI.
- Prevent read-only child MCPs from exposing or consuming write capabilities.
- Test initialize, tools/list, valid calls, and invalid calls.
- Exercise real MCP subprocess calls, independent global/memory gates, disabled or missing providers, and CLI write boundaries in an isolated HOME. Distinguish synthetic planner coverage from live model verification.
- Avoid stdout noise outside protocol frames.

### Modify watcher or automation

- Respect per-memory-body switches.
- Keep archive and memory-mining lanes distinct.
- Make state resumable and bounded; do not retry forever.
- Avoid duplicate concurrent writes.
- Do not interpret absence of new conversation as permission to mine or rebuild.

## Verification matrix

Choose the smallest sufficient set, then expand for risky changes:

| Change | Minimum verification |
|---|---|
| Pure text/docs | diff check, link/path check |
| Parser/planner | focused unit tests with edge cases |
| SQLite write/migration | temp database test, old/new schema path, transaction/rollback |
| Miner/compressor | prompt assembly, parser validation, empty/error behavior, atomic publish |
| Rebuild | dry-run parser, both runtimes when shared, identity/integrity checks |
| MCP | syntax check plus protocol subprocess test |
| Web UI | syntax check, integration tests, mobile/theme assumptions |
| Watcher/process | switch behavior, concurrency/state test, failure recovery |

Run `git diff --check` before commit. Run the full suite when a shared service, schema, CLI dispatcher, rebuild, miner, watcher, or public contract changes and the suite is practical.

## Git and external actions

- Do not commit merely because implementation is complete.
- “提交” authorizes a local commit, not necessarily a push.
- “推送” authorizes pushing the requested commit to the configured private remote.
- Inspect the remote before pushing; never assume a public/private destination.
- Do not merge PRs, invite collaborators, change permissions, publish packages, or deploy without explicit authorization.
- Keep ignored private documents ignored unless the user explicitly changes that policy.

## Handoff

Lead with the result. Mention:

- what changed;
- why it was wrong;
- what was verified;
- any restart/migration/user action required;
- commit and push status.

Avoid claiming that a frontend mock means the backend feature exists.
