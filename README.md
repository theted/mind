# mind

Shared long-term memory for every agent working in `~/Playground`: Claude Code, Codex, and anything else that speaks MCP or can run a shell command.

It is a single SQLite database (WAL + FTS5) accessed through Node's built-in `node:sqlite`. One core (`src/core/`) is exposed two ways:

- **MCP server** (`mind mcp`): tools `recall`, `remember`, `get`, `update`, `forget`, `list`, `list_projects`
- **CLI** (`mind <cmd>`): the same operations, plus `context`, `export`/`import` and `stats`

## Model

| field | notes |
| --- | --- |
| `project` | folder name under `~/Playground`, inferred from cwd (worktrees map to their main repo). `global` = cross-project |
| `kind` | `fact` · `decision` · `preference` · `gotcha` · `howto` · `episode` |
| `title` / `body` | one-line claim / why + how to apply |
| `tags`, `files`, `importance` (1–5), `source` | `source` is the MCP client name (e.g. `claude-code`) or `cli` |
| `superseded_by` | newer memory replacing this one; superseded memories are hidden from recall by default |

- **Recall ranking:** BM25 over title, body and tags (title weighted highest), multiplied by:
  - project match (current project ×1.5, global ×1.2)
  - importance
  - recency (half-life of 120 days)
- **Duplicates:** an identical kind + title + body within the same project is rejected.
- **Deleting:** `forget` is a soft delete. Use `--hard` to remove the row entirely.

## CLI

```sh
mind recall docker deploy             # search (current project boosted)
mind recall -p kolla thumbnail*       # restrict to kolla + global
mind remember "EC2 needs compose v2" -k gotcha -b "why/how" -t deploy,docker -i 4
echo "long body" | mind remember "Title" -k howto -b -
mind remember "Auth uses JWT now" -k decision --supersedes 12
mind get 3 7 · mind list -p global · mind projects · mind context · mind stats
mind export backup.jsonl · mind import backup.jsonl
```

Add `--json` to any command for machine-readable output.

## Setup (already done on this machine)

```sh
ln -s ~/Playground/mind/bin/mind ~/.local/bin/mind                      # CLI on PATH
claude mcp add --scope user mind -- ~/Playground/mind/bin/mind mcp      # Claude Code
# Codex: ~/.codex/config.toml
#   [mcp_servers.mind]
#   command = "/home/dude/Playground/mind/bin/mind"
#   args = ["mcp"]
```

- **Session start (Claude Code):** a SessionStart hook in `~/.claude/settings.json` runs `mind context --cwd "$CLAUDE_PROJECT_DIR"`.
- **Usage guidance for agents:** `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.
- **Other MCP clients** (gemini, opencode, cursor-agent, …): register the stdio command `~/Playground/mind/bin/mind mcp`.

`bin/mind` runs `node src/cli.ts`: Node ≥ 24 executes the TypeScript directly (type stripping), so there is no build step. Node comes from the system package (`pacman -S nodejs npm`), so MCP clients and hooks that start without a shell profile still find it.

## Environment

| var | default |
| --- | --- |
| `MIND_DB` | `~/Playground/mind/data/mind.db` (gitignored, so back it up with `mind export`) |
| `MIND_ROOT` | `~/Playground` |
| `MIND_PROJECT` | override the project the MCP server infers from its cwd |
| `MIND_SOURCE` | `source` recorded by the CLI (default `cli`) |

## Development

```sh
npm install
npm test              # store, FTS sync, dedupe, supersede, rollback, import, project resolution, concurrent writers
npm run typecheck
npx @modelcontextprotocol/inspector bin/mind mcp
```

Schema changes go in a new entry appended to `src/core/schema.ts` (tracked via `PRAGMA user_version`).

Possible later additions:
- Embeddings via `sqlite-vec`, merged with keyword results using reciprocal rank fusion.
- Importing the per-project `~/.claude/projects/*/memory` files.
