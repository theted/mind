# mind

Shared long-term memory for every coding agent on a machine: Claude Code, Codex, and anything else that speaks MCP or can run a shell command. Memories are scoped per project, where a project is a top-level folder under one of your [project roots](#project-roots).

It is a single SQLite database (WAL + FTS5) accessed through Node's built-in `node:sqlite`. One core (`src/core/`) is exposed two ways:

- **MCP server** (`mind mcp`): tools `recall`, `remember`, `get`, `update`, `forget`, `list`, `list_projects`
- **CLI** (`mind <cmd>`): the same operations, plus `context`, `export`/`import` and `stats`

## Model

| field | notes |
| --- | --- |
| `project` | top-level folder under a project root, inferred from cwd (worktrees map to their main repo). `global` = cross-project |
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

## Setup

Requires Node ≥ 24. `bin/mind` runs `node src/cli.ts`: Node executes the TypeScript directly (type stripping), so there is no build step. Install Node system-wide (e.g. `pacman -S nodejs npm`) rather than through a version manager, so MCP clients and hooks that start without a shell profile still find it.

```sh
git clone <repo-url> ~/code/mind && cd ~/code/mind
npm install
ln -s "$PWD/bin/mind" ~/.local/bin/mind       # CLI on PATH
```

Point `mind` at the directories that hold your projects (see [Project roots](#project-roots)) in `~/.bashrc` / `~/.zshrc`:

```sh
export MIND_ROOT="$HOME/Playground:$HOME/work"
```

Register the MCP server with each agent, using the absolute path to `bin/mind`:

```sh
claude mcp add --scope user mind -- ~/code/mind/bin/mind mcp      # Claude Code
```

```toml
# Codex: ~/.codex/config.toml. Codex doesn't pass your shell environment through, so repeat MIND_ROOT here.
[mcp_servers.mind]
command = "/home/you/code/mind/bin/mind"
args = ["mcp"]
env = { MIND_ROOT = "~/Playground:~/work" }
```

- **Other MCP clients** (gemini, opencode, cursor-agent, …): register the stdio command `/path/to/mind/bin/mind mcp`. Set `MIND_ROOT` in the client's server config if it doesn't inherit your shell environment.
- **Session start (Claude Code):** a SessionStart hook in `~/.claude/settings.json` opens each session with the project's memories:
  ```json
  { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "mind context --cwd \"$CLAUDE_PROJECT_DIR\"" }] }] } }
  ```
- **Usage guidance for agents:** tell agents to `recall` before non-trivial work and to `remember` durable learnings, for example in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.

## Project roots

`mind` names the current project after the working directory's top-level folder under a project root, so `~/Playground/kolla/client/src` becomes `kolla`. Outside every root it falls back to the git repo's name. Anywhere else, including a root itself, the scope is `global`.

`MIND_ROOT` holds one directory, or several separated by `:` (`;` on Windows), like `PATH`:

```sh
export MIND_ROOT="$HOME/Playground:$HOME/work:$HOME/work/clients"
```

- Unset, it defaults to `~/Playground`. An empty value (`MIND_ROOT=`) turns root mapping off, leaving only the git fallback.
- A leading `~` is expanded, so the value also works in client configs that don't go through a shell.
- When roots are nested, the most specific one wins: `~/work/clients/acme/web` is `acme`, not `clients`.
- Folders with the same name under different roots share a project.
- `mind --help` prints the roots in effect.

## Environment

| var | default |
| --- | --- |
| `MIND_ROOT` | `~/Playground`. One or more project roots, `:`-separated (see [Project roots](#project-roots)) |
| `MIND_DB` | `<repo>/data/mind.db` (gitignored, so back it up with `mind export`) |
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
