# Dream Lab

Dream Lab is the memory-scoped Automatic Dream module. It provides the Dream Lab frontend, bundled dream prompts, canonical dream policy controls, archive reading, and the `dev-dream` post-mining watcher.

The module stores migrated runtime data under `~/.stone_memory/developer-module-data/<thread-id>/dream-lab/`. Bundled prompts remain in `prompts/`; user Prompt overrides remain in module data. The legacy `stmem dream` CLI remains available during the compatibility period and delegates to the same Core DreamService.

Run `stmem module dream-lab migrate --thread <id> --dry-run` to inspect legacy data. Apply only after reviewing the mappings with `stmem module dream-lab migrate --thread <id> --apply`. Migration keeps legacy sources, verifies copied files, writes `migration-receipt.json`, and records durable state outside the module data directory. A failed migration leaves the legacy backend selected. Use `stmem module dream-lab rollback --thread <id>` to return to legacy only when source and module data still match; rollback never deletes either copy and refuses after module-only writes.

The module does not rename the historical `erotic*` or `nsfw*` identifiers. The user-facing terminology remains 绮梦、绮染 and 噩梦·绮染.
