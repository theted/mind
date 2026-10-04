# AGENTS.md — mind

Shared memory service for agents in `~/Playground`. See `README.md` for the model and CLI.

- **Runtime:** Bun via mise (`mise x bun@1.4.2 -- bun …`). There is no global `bun`. `bin/mind` is the entry point.
- **Layout:**
  - `src/core/` (db, schema, project resolution, store) contains all the logic.
  - `src/mcp.ts` and `src/cli.ts` are thin wrappers over it, sharing formatting from `src/format.ts`.
- **Writes:** every write goes through `MemoryStore.write()` (`BEGIN IMMEDIATE`). Several agent processes share the DB, so a deferred read-then-write transaction fails with `SQLITE_BUSY_SNAPSHOT`. The concurrency test covers this.
- **Schema:** append migrations to `src/core/schema.ts` and never edit shipped ones. Keep the FTS triggers in sync with any new searchable column.
- **Checks:** run `bun test` and `bun x tsc --noEmit` before committing.
- **Live DB:** the real database is `data/mind.db`. Tests and experiments use `MIND_DB=<temp path>` and must never touch it.
