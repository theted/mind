# mind

Shared long-term memory for every coding agent on a machine: Claude Code, Codex, and anything else that speaks MCP or can run a shell command. Memories are scoped per project, where a project is a top-level folder under one of your [project roots](#project-roots).

It is a single SQLite database (WAL + FTS5) accessed through Node's built-in `node:sqlite`, with optional [semantic search](#semantic-search) through a local embedding model. One core (`src/core/`) is exposed three ways:

- **MCP server over stdio** (`mind mcp`): tools `recall`, `remember`, `get`, `update`, `forget`, `list`, `list_projects`
- **MCP server over HTTP** (`mind serve`, or the [Docker stack](#docker)): the same tools for any number of agents
- **CLI** (`mind <cmd>`): the same operations, plus `context`, `export`/`import`, `stats` and `reindex`

## Model

| field | notes |
| --- | --- |
| `project` | top-level folder under a project root, inferred from cwd (worktrees map to their main repo). `global` = cross-project |
| `kind` | `fact` · `decision` · `preference` · `gotcha` · `howto` · `episode` |
| `title` / `body` | one-line claim / why + how to apply |
| `tags`, `files`, `importance` (1–5), `source` | `source` is the MCP client name (e.g. `claude-code`) or `cli` |
| `superseded_by` | newer memory replacing this one; superseded memories are hidden from recall by default |

- **Recall ranking:** BM25 over title, body and tags (title weighted highest, stop words ignored). With [semantic search](#semantic-search) on, the BM25 ranking and an embedding similarity ranking are merged by reciprocal rank fusion. The result is multiplied by:
  - project match (current project ×1.5, global ×1.2)
  - importance
  - recency (half-life of 120 days)
- **Duplicates:** an identical kind + title + body within the same project is rejected. With semantic search on, `remember` also lists existing memories that say nearly the same thing, so the agent can supersede or drop one.
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
mind reindex                          # embed memories that have no current vector (--force: all)
mind serve --port 7077                # MCP over HTTP at /mcp
```

At a terminal, `list`, `recall`, `projects` and `stats` print tables sized to the window; piped, they print the compact markdown lines agents read best. Add `--json` to any command for machine-readable output.

```
╭────┬────────────┬──────────┬───────┬──────────────────────────────────────────┬────────────┬─────────╮
│  # │ Kind       │ Project  │ Imp   │ Title                                    │ Tags       │ Updated │
├────┼────────────┼──────────┼───────┼──────────────────────────────────────────┼────────────┼─────────┤
│ 14 │ gotcha     │ snippets │ ★★★★  │ EC2 deploy needs docker compose v2       │ deploy, d… │  3d ago │
│ 13 │ preference │ global   │ ★★★★★ │ Prefer arrow functions and modern array… │            │  1w ago │
│ 12 │ decision   │ kolla    │ ★★★   │ Auth uses JWT now (→ #15)                │ auth       │  2w ago │
╰────┴────────────┴──────────┴───────┴──────────────────────────────────────────┴────────────┴─────────╯
```

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

## Semantic search

Keyword search only finds a memory when the query shares words with it: "login tokens" misses "Auth uses JWT now". With an embedding model, `mind` also stores a vector for every memory's title and body. `recall` then ranks by meaning as well as by keywords, and `remember` points out near-duplicates.

- **How it works:** vectors live in the same SQLite file (`memory_vectors`). Recall compares the query vector with every memory's vector in JS, about 6 ms per 1,000 memories (384 dimensions), so there is no vector index to maintain. The BM25 ranking and the similarity ranking are merged by reciprocal rank fusion, so a memory both rankings agree on comes first. Exact identifiers like `SQLITE_BUSY` still match through BM25, which embeddings handle poorly.
- **Embedder:** any server with an OpenAI-compatible `POST /v1/embeddings`. The [Docker stack](#docker) runs [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) with `BAAI/bge-small-en-v1.5` on CPU: about 130 MB of weights, about 300 MB of RAM, and 15–40 ms to embed a query. Ollama (`MIND_EMBED_URL=http://localhost:11434/v1`, `MIND_EMBED_MODEL=nomic-embed-text`), llama.cpp, vLLM or a hosted API work too.
- **Best effort:** if the embedder is unset or unreachable, everything falls back to keyword search. Memories written meanwhile are embedded later: inline by the next `recall` or `remember` (64 at a time), every minute by `mind serve`, or all at once by `mind reindex`. A memory whose title or body changes is re-embedded, and so is every memory after you switch models.
- **Models:** retrieval models want a prefix on queries (and some on documents). `mind` knows the right ones for the `bge-*-en`, `nomic-embed-text` and `e5` families, and the `MIND_EMBED_*_PREFIX` variables cover any other model. `MIND_EMBED_MIN_SIMILARITY` sets the cosine similarity below which a memory doesn't count as a match. Defaults were measured on short memories: 0.55 for bge, 0.52 for nomic, 0.5 otherwise. For non-English memories, try `intfloat/multilingual-e5-small` or `Qwen/Qwen3-Embedding-0.6B`, then raise the threshold until unrelated queries come back empty.

## Docker

`compose.yaml` runs everything locally: the embedder plus `mind serve`, the MCP server over Streamable HTTP. It shares `./data/mind.db` with `bin/mind` on the host.

```sh
docker compose up -d          # first start downloads the model into a volume
curl localhost:7077/health    # {"ok":true,"semantic":{"model":"BAAI/bge-small-en-v1.5","embedded":…}}
```

Pick one of two ways to connect agents:

1. **Host stdio server with the container's embedder** (recommended on Linux). Agents keep launching `bin/mind mcp`, which knows the project from its working directory exactly as before. Point it at the embedder the stack publishes on port 8089:
   ```sh
   export MIND_EMBED_URL=http://localhost:8089/v1                    # ~/.bashrc: CLI and hooks
   claude mcp add --scope user mind -e MIND_EMBED_URL=http://localhost:8089/v1 -- ~/code/mind/bin/mind mcp
   ```
   Running just the embedder (`docker compose up -d embedder`) is enough for this setup.
2. **HTTP only**, with no Node on the host:
   ```sh
   claude mcp add --scope user --transport http mind http://localhost:7077/mcp
   ```
   An HTTP server can't see the agent's working directory, so a session names its project in one of these ways (the first one present wins):
   - an `X-Mind-Project: kolla` header, or `?project=kolla` on the URL;
   - an `X-Mind-Cwd: /home/you/Playground/kolla` header, or `?cwd=`, mapped through `MIND_ROOT` like a local cwd (export `MIND_ROOT` with absolute paths before `docker compose up`);
   - the client's MCP roots, for clients that advertise them.

   Clients that send none of these get tools that ask for `project` explicitly, and memories default to `global`. For per-repo scoping in Claude Code, add the header in each repo's `.mcp.json`: `{"mcpServers": {"mind": {"type": "http", "url": "http://localhost:7077/mcp", "headers": {"X-Mind-Project": "kolla"}}}}`.

Notes:
- **Ports:** both ports are published on 127.0.0.1 only. The server also rejects Host headers other than localhost, which blocks DNS rebinding from web pages. To reach it from other machines, publish the port on another address in `compose.yaml`, set `MIND_TOKEN` (clients then send `Authorization: Bearer <token>`), and list the host names clients use in `MIND_ALLOWED_HOSTS`.
- **Sharing the DB file:** the host CLI and the container can share it on Linux only. SQLite's WAL needs both sides on the same kernel, so on macOS or Windows don't point `bin/mind` at the same file; use the CLI through `docker compose exec mind node src/cli.ts …` instead. The container runs as uid 1000; if your user's uid differs, set `MIND_UID` and `MIND_GID` in `.env` so both sides can write the DB.
- **GPU:** for a GPU embedder, use a CUDA tag of the same TEI version instead of `cpu-1.9`.

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
| `MIND_EMBED_URL` | unset (keyword search only). OpenAI-compatible API base, e.g. `http://localhost:8089/v1` |
| `MIND_EMBED_MODEL` | `BAAI/bge-small-en-v1.5`. Must name the model the server runs: it keys the stored vectors |
| `MIND_EMBED_API_KEY` | bearer token for hosted embedding APIs |
| `MIND_EMBED_MIN_SIMILARITY` | per model family (see [Semantic search](#semantic-search)) |
| `MIND_EMBED_QUERY_PREFIX`, `MIND_EMBED_DOCUMENT_PREFIX` | per model family |
| `MIND_EMBED_TIMEOUT_MS` | `10000` |
| `MIND_PORT`, `MIND_HOST` | `7077`, `127.0.0.1` (`0.0.0.0` in the container) for `mind serve` |
| `MIND_TOKEN` | unset. Bearer token required by `mind serve` |
| `MIND_ALLOWED_HOSTS` | Host header names accepted besides localhost, comma-separated |
| `MIND_UID`, `MIND_GID`, `MIND_EMBED_PORT` | compose only: container user (`1000`), host port of the embedder (`8089`) |

## Development

```sh
npm install
npm test              # store, semantic index (with a fake embedder), tables, HTTP server, concurrent writers
npm run typecheck
npx @modelcontextprotocol/inspector bin/mind mcp
```

Tests never need a running embedder: `test/helpers.ts` provides a deterministic fake.

Schema changes go in a new entry appended to `src/core/schema.ts` (tracked via `PRAGMA user_version`).

Possible later additions:
- A cross-encoder reranker over the top results (TEI serves rerankers too, e.g. `BAAI/bge-reranker-base`).
- `sqlite-vec` for an ANN index, if a store outgrows the exhaustive scan (about 120 ms at 20k memories).
- Importing the per-project `~/.claude/projects/*/memory` files.
