# AGENTS.md — mind

Shared memory service for coding agents (projects live under the `MIND_ROOT` directories). See `README.md` for the model and CLI.

- **Runtime:** Node ≥ 24 from the system package (`pacman -S nodejs npm`), with no mise and no build step. Node runs the `.ts` sources directly through type stripping, and the database is the built-in `node:sqlite`. `bin/mind` is the entry point.
- **Type stripping:** only erasable TypeScript is allowed: no enums, namespaces or constructor parameter properties. Relative imports need the `.ts` extension, and type-only imports need `import type`. `tsc` enforces all of this (`erasableSyntaxOnly`, `verbatimModuleSyntax`).
- **Layout:**
  - `src/core/` contains all the logic: db, schema, project resolution, `store.ts` (SQL), `rank.ts` (fusion and boosts), `embed.ts` (embedder client), and `mind.ts` (`Mind`, the store plus its best-effort semantic index).
  - `src/mcp.ts` (tools, stdio), `src/serve.ts` (HTTP) and `src/cli.ts` are thin wrappers over it, sharing formatting from `src/format.ts` and `src/table.ts`.
  - `Dockerfile` and `compose.yaml` hold the self-contained stack: `mind serve` plus a TEI embedder.
- **Writes:** every write goes through `MemoryStore.write()` (`immediate()` in `db.ts`, which runs `BEGIN IMMEDIATE`). Several agent processes share the DB, so a deferred read-then-write transaction fails with `SQLITE_BUSY_SNAPSHOT`. The concurrency test covers this.
- **Schema:** append migrations to `src/core/schema.ts` and never edit shipped ones. Keep the FTS triggers in sync with any new searchable column.
- **Embeddings are optional:** go through `Mind` for anything that should embed (`recall`, `remember`, `update`). Every path must still work, keyword-only, when `MIND_EMBED_URL` is unset or the embedder is down. Never hold the write lock across an embedder call.
- **Checks:** run `npm test` and `npm run typecheck` before committing. Tests use the fake embedder in `test/helpers.ts` and must not need a running model.
- **Live DB:** the real database is `data/mind.db`. Tests and experiments use `MIND_DB=<temp path>` and must never touch it.
