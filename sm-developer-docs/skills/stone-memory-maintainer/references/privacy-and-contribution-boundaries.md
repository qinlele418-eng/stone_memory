# Privacy and contribution boundaries

Stone Memory processes intimate, long-running conversations. Treat all local memory data as sensitive by default.

## Never publish

- API keys, auth tokens, provider credentials, or local auth files;
- real archive/full conversation content;
- real feelings, features, rules, or retained original-message ranges;
- private thread IDs, session filenames, user/AI names, or home-directory paths;
- collaborator invitation lists or private repository membership;
- ignored personal planning, employment, patent, legal, or relationship documents;
- logs containing prompts, upstream raw responses, or conversation excerpts.

Do not infer that data is safe because it already appears in terminal output or an Agent context.

## Fixtures and reports

- Prefer synthetic identities, dates, thread IDs, paths, and dialogue.
- Preserve the shape of the bad case without preserving its personal content.
- Keep fixtures small enough to review.
- Redact provider responses to the minimum needed for parser behavior.
- Describe counts and timings in public reports; avoid quoting sensitive memories.
- If a real sample is essential, obtain explicit permission and keep it outside Git unless publication is separately authorized.

## Local ignored material

Respect `.gitignore` and repository policy. In particular, do not force-add ignored internal documents merely to “save the work.” Keep private design history local when the repository deliberately excludes it.

Before commit:

```text
git status --short
git diff --check
git diff --cached
```

Search staged changes for obvious secrets, absolute personal paths, thread identifiers, and copied conversation text.

## Generalizing community prototypes

Remove:

- contributor HOME paths;
- fixed ports and sidecar assumptions;
- hardcoded provider/model/CLI choices;
- default-first-thread behavior;
- direct SQLite/config writes;
- private companion servers that duplicate core services.

Preserve:

- the product insight;
- the contributor's interaction design where compatible;
- attribution;
- original audit or safety intent;
- a detachable experimental path when the feature is not yet core-ready.

Do not describe a rewritten integration as if the contributor supplied every final architectural change. Distinguish original contribution from maintainer integration.

## Destructive operations

Deletion, permanent trimming, overwrite, rebuild apply, migration, remote mutation, and permission changes require clear scope and authority.

- Preview when possible.
- Confirm the target memory body/repository.
- Back up before irreversible local mutation.
- Fail closed on ambiguity.
- Never broaden a request for diagnosis into a destructive repair.
