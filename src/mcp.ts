import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./core/db";
import { resolveProject } from "./core/project";
import { KINDS, MemoryStore } from "./core/store";
import { memoryBlock, memoryLine } from "./format";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ ...text(`Error: ${e instanceof Error ? e.message : String(e)}`), isError: true });

const projectArg = z
  .string()
  .optional()
  .describe('Project name (a folder in ~/Playground, e.g. "kolla") or "global". Defaults to the current project.');

export async function startMcpServer() {
  const store = new MemoryStore(openDb());
  // MCP clients launch the server in the session's working directory.
  const cwdProject = process.env.MIND_PROJECT ?? resolveProject();
  const server = new McpServer({ name: "mind", version: "0.1.0" });
  const source = () => server.server.getClientVersion()?.name ?? "mcp";

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => string,
    readOnly = false,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, ((args: never) => {
      try {
        return text(run(args));
      } catch (e) {
        return fail(e);
      }
    }) as never);

  tool(
    "recall",
    `Search the shared long-term memory (all agents, all ~/Playground projects) by keywords. Use it before non-trivial work, when something seems to have history ("why is X done this way?"), or when hitting an error that may be a known gotcha. Results from the current project${cwdProject ? ` (${cwdProject})` : ""} rank higher. Use several distinct keywords; a trailing * does prefix matching.`,
    {
      query: z.string().min(1).describe("Keywords, e.g. 'docker deploy ec2 env'"),
      project: z.string().optional().describe('Restrict to this project + global. Omit to search all projects; use "global" for global-only.'),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
      include_superseded: z.boolean().optional(),
    },
    (a) => {
      const res = store.recall({
        query: a.query,
        project: a.project,
        boostProject: cwdProject,
        kind: a.kind,
        limit: a.limit,
        includeSuperseded: a.include_superseded,
      });
      return res.length
        ? `${res.length} result(s); use get for full text:\n${res.map((m) => memoryLine(m, 300)).join("\n")}`
        : "No matching memories.";
    },
    true,
  );

  tool(
    "remember",
    `Save a durable, non-obvious learning to shared long-term memory so future agents (any tool, any project) benefit. Good: decisions and their reasons, gotchas and fixes, user preferences, environment/deploy quirks, how-tos that took effort to figure out. Do NOT save: things obvious from the code or git history, temporary task state, secrets/credentials. Keep the title a specific one-line claim; put the why and how-to-apply in body. If this replaces an older memory, pass its id in supersedes (recall first to check).`,
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
    (a) => {
      const { memory, duplicate } = store.remember({
        ...a,
        project: a.project === undefined ? cwdProject : a.project,
        source: source(),
      });
      return duplicate ? `Already stored as #${memory.id}; nothing added.` : `Saved #${memory.id}.\n${memoryLine(memory)}`;
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
    ({ id, ...patch }) => `Updated.\n${memoryLine(store.update(id, patch))}`,
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
      [`current project: ${cwdProject ?? "global"}`, ...store.listProjects().map((p) => `- ${p.project}: ${p.count} (updated ${p.last_updated.slice(0, 10)})`)].join("\n"),
    true,
  );

  await server.connect(new StdioServerTransport());
}
