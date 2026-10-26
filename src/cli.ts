#!/usr/bin/env node
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { defaultDbPath, openDb } from "./core/db.ts";
import { DEFAULT_MODEL } from "./core/embed.ts";
import { describeError, Mind } from "./core/mind.ts";
import { projectRoots, resolveProject } from "./core/project.ts";
import { MemoryStore } from "./core/store.ts";
import { type Kind, type MemoryRow, MindError } from "./core/types.ts";
import { contextMarkdown, memoryBlock, memoryLine, memoryTable, projectsTable, statsTable } from "./format.ts";

const HELP = `mind — shared long-term memory for coding agents

Usage: mind <command> [options]          (add --json for machine-readable output)

  recall <query...>      Search by meaning + keywords  [-p project|global] [-k kind] [-n limit] [--superseded]
  remember <title>       Save a memory      -k kind [-b body | -b - (stdin)] [-t tags] [-p project|global]
                                            [-i 1-5] [-f file,...] [--supersedes id,...]
  get <id...>            Show full memories
  update <id>            Edit a memory      [--title] [-b] [-k] [-t] [-p] [-i] [-f]
  forget <id>            Soft-delete        [--hard]
  list                   Recent memories    [-p] [-k] [-n limit]
  projects               Projects with memory counts
  context                Session-start digest (for hooks)  [--cwd dir]
  export [file]          JSONL dump (stdout by default), includes superseded/deleted
  import <file>          Load a JSONL dump (duplicates skipped)
  stats                  Counts and semantic index coverage
  reindex                Embed memories missing a current vector  [--force: re-embed all]
  mcp                    Run the MCP server on stdio
  serve                  Run the MCP server over HTTP at /mcp     [--port 7077] [--host 127.0.0.1]

Kinds: fact, decision, preference, gotcha, howto, episode
Project defaults to the cwd's top-level folder under a project root, else its git repo name.
Lists print as tables at a terminal and as markdown lines when piped.

Roots (MIND_ROOT): ${projectRoots().join(", ") || "none"}
DB: ${defaultDbPath()}
Embeddings (MIND_EMBED_URL): ${process.env.MIND_EMBED_URL ? `${process.env.MIND_EMBED_URL}, model ${process.env.MIND_EMBED_MODEL || DEFAULT_MODEL}` : "off, keyword search only"}`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    project: { type: "string", short: "p" },
    kind: { type: "string", short: "k" },
    limit: { type: "string", short: "n" },
    body: { type: "string", short: "b" },
    tags: { type: "string", short: "t" },
    importance: { type: "string", short: "i" },
    files: { type: "string", short: "f" },
    supersedes: { type: "string" },
    superseded: { type: "boolean" },
    title: { type: "string" },
    hard: { type: "boolean" },
    cwd: { type: "string" },
    source: { type: "string" },
    force: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
  },
});

const [cmd, ...args] = positionals;
const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
const int = (s: string | undefined, name: string) => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n)) throw new MindError(`${name} must be an integer`);
  return n;
};
const ids = (xs: string[]) => xs.map((x) => int(x.replace(/^#/, ""), "id")!);
const print = (human: string, data: unknown) => console.log(o.json ? JSON.stringify(data, null, 2) : human);
// Tables for a person at a terminal; markdown lines (compact, what agents read best) when piped.
const show = (table: () => string, plain: () => string, data: unknown) =>
  print(o.json ? "" : process.stdout.isTTY ? table() : plain(), data);
const readBody = async (b?: string) => (b === "-" ? (await text(process.stdin)).trim() : b);

async function main() {
  if (o.help || !cmd || cmd === "help") return console.log(HELP);
  if (cmd === "mcp") return (await import("./mcp.ts")).startMcpServer();
  if (cmd === "serve") {
    const { startHttpServer } = await import("./serve.ts");
    const http = await startHttpServer({
      port: int(o.port ?? process.env.MIND_PORT, "port") ?? 7077,
      host: o.host ?? process.env.MIND_HOST ?? "127.0.0.1",
      token: process.env.MIND_TOKEN || undefined,
      allowedHosts: list(process.env.MIND_ALLOWED_HOSTS),
    });
    // As a container's PID 1, Node gets no default SIGTERM handling; without this `docker stop` waits 10s to kill it.
    const stop = () => {
      http.closeAllConnections();
      http.close(() => process.exit(0));
    };
    process.once("SIGTERM", stop).once("SIGINT", stop);
    return;
  }

  const store = new MemoryStore(openDb());
  const mind = new Mind(store);
  const cwdProject = () => resolveProject(o.cwd ?? process.cwd());
  const kind = o.kind as Kind | undefined;

  switch (cmd) {
    case "recall": {
      if (!args.length) throw new MindError("recall needs a query");
      const { memories, semantic } = await mind.recall({
        query: args.join(" "),
        project: o.project,
        boostProject: cwdProject(),
        kind,
        limit: int(o.limit, "limit"),
        includeSuperseded: o.superseded,
      });
      if (mind.embedder && !semantic) console.error(`mind: semantic search unavailable, keyword matches only (${mind.error})`);
      if (!memories.length) return print("No matching memories.", memories);
      return show(() => memoryTable(memories, { detail: "body" }), () => memories.map((m) => memoryLine(m)).join("\n"), memories);
    }
    case "remember": {
      const title = args.join(" ");
      if (!kind) throw new MindError("remember needs -k <kind>");
      const { memory, duplicate, similar } = await mind.remember({
        kind,
        title,
        body: await readBody(o.body),
        tags: list(o.tags),
        files: list(o.files),
        project: o.project ?? cwdProject(),
        importance: int(o.importance, "importance"),
        supersedes: o.supersedes ? ids(list(o.supersedes)!) : undefined,
        source: o.source ?? process.env.MIND_SOURCE ?? "cli",
      });
      const lines = duplicate ? [`Already stored as #${memory.id}`] : ["Saved", memoryLine(memory)];
      if (similar.length) lines.push("", "Similar existing memories (supersede or forget if redundant):", ...similar.map((m) => `${memoryLine(m)} (similarity ${m.score})`));
      return print(lines.join("\n"), { duplicate, memory, similar });
    }
    case "get": {
      const res = ids(args).map((id) => store.get(id));
      if (res.some((m) => !m)) process.exitCode = 1;
      return print(res.map((m, i) => (m ? memoryBlock(m) : `#${args[i]} not found`)).join("\n\n---\n\n"), res);
    }
    case "update": {
      const [id] = ids(args);
      if (id === undefined) throw new MindError("update needs an id");
      const m = await mind.update(id, {
        title: o.title,
        body: await readBody(o.body),
        kind,
        tags: list(o.tags),
        files: list(o.files),
        project: o.project,
        importance: int(o.importance, "importance"),
      });
      return print(`Updated\n${memoryLine(m)}`, m);
    }
    case "forget": {
      const [id] = ids(args);
      if (id === undefined) throw new MindError("forget needs an id");
      const ok = store.forget(id, { hard: o.hard });
      if (!ok) process.exitCode = 1;
      return print(ok ? `Forgot #${id}` : `#${id} not found`, { ok });
    }
    case "list": {
      const res = store.list({ project: o.project, kind, limit: int(o.limit, "limit"), includeSuperseded: o.superseded });
      if (!res.length) return print("No memories.", res);
      return show(() => memoryTable(res), () => res.map((m) => memoryLine(m)).join("\n"), res);
    }
    case "projects": {
      const res = store.listProjects();
      if (!res.length) return print("No memories.", res);
      return show(
        () => projectsTable(res),
        () => res.map((p) => `${p.project.padEnd(28)} ${String(p.count).padStart(4)}  ${p.last_updated.slice(0, 10)}`).join("\n"),
        res,
      );
    }
    case "context": {
      const project = o.project ?? cwdProject();
      return print(contextMarkdown(store, project), store.context(project));
    }
    case "stats": {
      const stats = { ...store.stats(), semantic: mind.status() };
      return show(() => statsTable(stats, stats.semantic), () => JSON.stringify(stats, null, 2), stats);
    }
    case "reindex": {
      if (!mind.embedder) throw new MindError("no embedder configured: set MIND_EMBED_URL (see README)");
      const progress = (n: number) => process.stderr.isTTY && process.stderr.write(`\rEmbedded ${n}…`);
      const n = await mind.sync({ force: o.force, onProgress: progress }).catch((e: unknown) => {
        throw new MindError(`embedding failed: ${describeError(e)}`);
      });
      if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
      const { embedded, total } = mind.status()!;
      return print(`Embedded ${n} memories with ${mind.embedder.model} (${embedded}/${total} indexed)`, { embedded: n, indexed: embedded, total });
    }
    case "export": {
      const lines = [...store.exportRows()].map((r) => JSON.stringify(r)).join("\n") + "\n";
      if (args[0]) {
        writeFileSync(args[0], lines);
        console.error(`Exported to ${args[0]}`);
      } else process.stdout.write(lines);
      return;
    }
    case "import": {
      if (!args[0]) throw new MindError("import needs a file");
      const rows: MemoryRow[] = [];
      for await (const line of createInterface({ input: createReadStream(args[0]) })) if (line.trim()) rows.push(JSON.parse(line));
      const res = store.importRows(rows);
      return print(`Imported ${res.imported}, skipped ${res.skipped} duplicate(s)`, res);
    }
    default:
      throw new MindError(`unknown command "${cmd}" (see mind --help)`);
  }
}

main().catch((e) => {
  console.error(e instanceof MindError ? `mind: ${e.message}` : e);
  process.exit(1);
});
