#!/usr/bin/env bun
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { defaultDbPath, openDb } from "./core/db";
import { resolveProject } from "./core/project";
import { type Kind, MemoryStore, type MemoryRow, MindError } from "./core/store";
import { contextMarkdown, memoryBlock, memoryLine } from "./format";

const HELP = `mind — shared long-term memory for agents in ~/Playground

Usage: mind <command> [options]          (add --json for machine-readable output)

  recall <query...>      Search memories    [-p project|global] [-k kind] [-n limit] [--superseded]
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
  stats                  Counts
  mcp                    Run the MCP server on stdio

Kinds: fact, decision, preference, gotcha, howto, episode
Project defaults to the cwd's folder under ~/Playground. DB: ${defaultDbPath()}`;

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
const readBody = async (b?: string) => (b === "-" ? (await Bun.stdin.text()).trim() : b);

async function main() {
  if (o.help || !cmd || cmd === "help") return console.log(HELP);
  if (cmd === "mcp") return (await import("./mcp")).startMcpServer();

  const store = new MemoryStore(openDb());
  const cwdProject = () => resolveProject(o.cwd ?? process.cwd());
  const kind = o.kind as Kind | undefined;

  switch (cmd) {
    case "recall": {
      if (!args.length) throw new MindError("recall needs a query");
      const res = store.recall({
        query: args.join(" "),
        project: o.project,
        boostProject: cwdProject(),
        kind,
        limit: int(o.limit, "limit"),
        includeSuperseded: o.superseded,
      });
      return print(res.length ? res.map((m) => memoryLine(m)).join("\n") : "No matching memories.", res);
    }
    case "remember": {
      const title = args.join(" ");
      if (!kind) throw new MindError("remember needs -k <kind>");
      const { memory, duplicate } = store.remember({
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
      return print(duplicate ? `Already stored as #${memory.id}` : `Saved\n${memoryLine(memory)}`, { duplicate, memory });
    }
    case "get": {
      const res = ids(args).map((id) => store.get(id));
      if (res.some((m) => !m)) process.exitCode = 1;
      return print(res.map((m, i) => (m ? memoryBlock(m) : `#${args[i]} not found`)).join("\n\n---\n\n"), res);
    }
    case "update": {
      const [id] = ids(args);
      if (id === undefined) throw new MindError("update needs an id");
      const m = store.update(id, {
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
      return print(res.length ? res.map((m) => memoryLine(m)).join("\n") : "No memories.", res);
    }
    case "projects": {
      const res = store.listProjects();
      return print(res.map((p) => `${p.project.padEnd(28)} ${String(p.count).padStart(4)}  ${p.last_updated.slice(0, 10)}`).join("\n") || "No memories.", res);
    }
    case "context": {
      const project = o.project ?? cwdProject();
      return print(contextMarkdown(store, project), store.context(project));
    }
    case "stats":
      return print(JSON.stringify(store.stats(), null, 2), store.stats());
    case "export": {
      const lines = [...store.exportRows()].map((r) => JSON.stringify(r)).join("\n") + "\n";
      if (args[0]) {
        await Bun.write(args[0], lines);
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
