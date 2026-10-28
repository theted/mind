import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ListRootsResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDb } from "./core/db.ts";
import { Mind } from "./core/mind.ts";
import { resolveProject } from "./core/project.ts";
import { MemoryStore } from "./core/store.ts";
import { KINDS } from "./core/types.ts";
import { memoryBlock, memoryLine } from "./format.ts";

const VERSION = "0.2.0";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(`Error: ${e instanceof Error ? e.message : String(e)}`), isError: true });

/** What a connection knows about its caller. `project` is undefined until known (HTTP clients may never say). */
export interface Session {
  project?: string | null;
  /** Ask a client that advertises MCP roots for its workspace folder when nothing else named the project. */
  askRoots?: boolean;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The mind tools on a fresh McpServer, bound to one client session. */
export function createMcpServer(mind: Mind, session: Session): McpServer {
  const { store } = mind;
  const server = new McpServer({ name: "mind", version: VERSION });
  const source = () => server.server.getClientVersion()?.name ?? "mcp";
  const current = () => session.project ?? null;
  const known = session.project !== undefined;

  const projectArg = z
    .string()
    .optional()
    .describe(
      known
        ? 'Project name (a top-level folder under a project root, e.g. "kolla") or "global". Defaults to the current project.'
        : 'Project name: the repository folder name, e.g. "kolla". This server can\'t see your working directory, so pass it unless the memory applies everywhere ("global", the default).',
    );

  // Asked during the first tool call rather than at initialization: over HTTP a server-to-client request
  // needs an open stream, and the tool call's response stream is one.
  let rootsAsked = false;
  const learnProject = async (extra: Extra) => {
    if (session.project !== undefined || !session.askRoots || rootsAsked || !server.server.getClientCapabilities()?.roots) return;
    rootsAsked = true;
    try {
      const { roots } = await extra.sendRequest({ method: "roots/list" }, ListRootsResultSchema, { timeout: 5_000 });
      const root = roots.find((r) => r.uri.startsWith("file:"));
      if (root) session.project = resolveProject(fileURLToPath(root.uri));
    } catch {
      // Roots are a hint; without them the agent passes project explicitly.
    }
  };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => string | Promise<string>,
    readOnly = false,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, (async (args: never, extra: Extra) => {
      try {
        await learnProject(extra);
        return text(await run(args));
      } catch (e) {
        return fail(e);
      }
    }) as never);

  tool(
    "recall",
    `Search the shared long-term memory (all agents, all projects) by meaning and keywords. Use it before non-trivial work, when something seems to have history ("why is X done this way?"), or when hitting an error that may be a known gotcha. Results from the current project${session.project ? ` (${session.project})` : ""} rank higher. Describe what you need in plain words or keywords; exact identifiers (error codes, file names) match literally, and a trailing * does prefix matching.`,
    {
      query: z.string().min(1).describe("A question or keywords, e.g. 'how do we deploy to ec2' or 'SQLITE_BUSY'"),
      project: z.string().optional().describe('Restrict to this project + global. Omit to search all projects; use "global" for global-only.'),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
      include_superseded: z.boolean().optional(),
    },
    async (a) => {
      const { memories } = await mind.recall({
        query: a.query,
        project: a.project,
        boostProject: current(),
        kind: a.kind,
        limit: a.limit,
        includeSuperseded: a.include_superseded,
      });
      return memories.length
        ? `${memories.length} result(s); use get for full text:\n${memories.map((m) => memoryLine(m, 300)).join("\n")}`
        : "No matching memories.";
    },
    true,
  );

  tool(
    "remember",
    `Save a durable, non-obvious learning to shared long-term memory so future agents (any tool, any project) benefit. Good: decisions and their reasons, gotchas and fixes, user preferences, environment/deploy quirks, how-tos that took effort to figure out. Do NOT save: things obvious from the code or git history, temporary task state, secrets/credentials. Keep the title a specific one-line claim; put the why and how-to-apply in body. If this replaces an older memory, pass its id in supersedes (recall first to check). The reply lists existing memories that say nearly the same thing.`,
    {
      kind: z
        .enum(KINDS)
        .describe("fact | decision (with why) | preference (how the user likes things) | gotcha (pitfall + fix) | howto (procedure) | episode (what happened in a session)"),
      title: z.string().min(1).max(200),
      body: z.string().optional().describe("Details: why, context, how to apply"),
      tags: z.array(z.string()).optional(),
      project: projectArg,
      importance: z.number().int().min(1).max(5).optional().describe("1-5, default 3. 5 = must know before touching this project"),
      files: z.array(z.string()).optional().describe("Related file paths"),
      supersedes: z.array(z.number().int()).optional().describe("Ids of memories this replaces"),
    },
    async (a) => {
      const { memory, duplicate, similar } = await mind.remember({
        ...a,
        project: a.project === undefined ? current() : a.project,
        source: source(),
      });
      if (duplicate) return `Already stored as #${memory.id}; nothing added.`;
      const out = [`Saved #${memory.id}.`, memoryLine(memory)];
      if (similar.length) {
        out.push(
          "",
          "Similar existing memories. If the new one replaces any, call forget on it or remember again with supersedes; if it repeats one, forget the new one:",
          ...similar.map((m) => `${memoryLine(m)} (similarity ${m.score})`),
        );
      }
      return out.join("\n");
    },
  );

  tool(
    "get",
    "Fetch full memories by id.",
    { ids: z.array(z.number().int()).min(1) },
    (a) =>
      a.ids
        .map((id) => store.get(id))
        .map((m, i) => (m ? memoryBlock(m) : `#${a.ids[i]} not found`))
        .join("\n\n---\n\n"),
    true,
  );

  tool(
    "update",
    "Edit an existing memory in place (fix a typo, add detail). If the fact itself changed, prefer remember with supersedes so history is kept.",
    {
      id: z.number().int(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      tags: z.array(z.string()).optional(),
      project: projectArg,
      importance: z.number().int().min(1).max(5).optional(),
      files: z.array(z.string()).optional(),
    },
    async ({ id, ...patch }) => `Updated.\n${memoryLine(await mind.update(id, patch))}`,
  );

  tool(
    "forget",
    "Delete a memory that is wrong or no longer useful (soft delete). If it was replaced by a newer fact, prefer remember with supersedes instead.",
    { id: z.number().int() },
    (a) => (store.forget(a.id) ? `Forgot #${a.id}.` : `#${a.id} not found.`),
  );

  tool(
    "list",
    "List the most recently updated memories, optionally filtered by project and kind. For topic search use recall.",
    {
      project: z.string().optional().describe('Project name or "global". Omit for all.'),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
    },
    (a) => {
      const res = store.list({ project: a.project, kind: a.kind, limit: a.limit ?? 20 });
      return res.length ? res.map((m) => memoryLine(m)).join("\n") : "No memories.";
    },
    true,
  );

  tool(
    "list_projects",
    "List projects that have memories, with counts.",
    {},
    () =>
      [
        `current project: ${session.project === undefined ? "unknown (pass project explicitly)" : (session.project ?? "global")}`,
        ...store.listProjects().map((p) => `- ${p.project}: ${p.count} (updated ${p.last_updated.slice(0, 10)})`),
      ].join("\n"),
    true,
  );

  return server;
}

/** stdio server: MCP clients launch it in the session's working directory, which names the project. */
export async function startMcpServer() {
  const mind = new Mind(new MemoryStore(openDb()));
  const server = createMcpServer(mind, { project: process.env.MIND_PROJECT ?? resolveProject() });
  await server.connect(new StdioServerTransport());
}
