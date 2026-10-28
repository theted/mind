import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "./core/db.ts";
import { describeError, Mind } from "./core/mind.ts";
import { normalizeProject, resolveProject } from "./core/project.ts";
import { MemoryStore } from "./core/store.ts";
import { createMcpServer, type Session } from "./mcp.ts";

/** Sessions idle this long are dropped; a client that comes back gets 404 and re-initializes. */
const SESSION_TTL_MS = 6 * 3_600_000;
/** How often the background sync embeds memories written by processes without an embedder. */
const SYNC_EVERY_MS = 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ServeOptions {
  port: number;
  host: string;
  /** Bearer token required on /mcp when set. */
  token?: string;
  /** Host header names accepted besides localhost (DNS rebinding protection). */
  allowedHosts?: string[];
  mind?: Mind;
  log?: (msg: string) => void;
}

const header = (req: IncomingMessage, name: string) => [req.headers[name]].flat()[0]?.trim() || undefined;

/**
 * The caller's project, from (first match wins) the X-Mind-Project header, ?project=, the X-Mind-Cwd header or
 * ?cwd= (mapped through MIND_ROOT like a local cwd). Undefined when the request names none.
 */
export const projectFromRequest = (req: IncomingMessage): string | null | undefined => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const project = header(req, "x-mind-project") ?? url.searchParams.get("project") ?? undefined;
  if (project !== undefined) return normalizeProject(project);
  const cwd = header(req, "x-mind-cwd") ?? url.searchParams.get("cwd") ?? undefined;
  return cwd === undefined ? undefined : resolveProject(cwd);
};

const send = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const rpcError = (res: ServerResponse, status: number, message: string) =>
  send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });

const readJson = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if ((size += chunk.length) > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
};

const sameSecret = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Serve the MCP tools over Streamable HTTP at /mcp, plus GET /health. Resolves once listening. */
export async function startHttpServer({ port, host, token, allowedHosts = [], mind, log = console.error }: ServeOptions) {
  mind ??= new Mind(new MemoryStore(openDb()));
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", ...allowedHosts]);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; seen: number }>();

  const openSession = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    // No project in the request: a client that supports MCP roots is asked for its workspace on first use.
    const session: Session = { project: projectFromRequest(req), askRoots: true };
    const server = createMcpServer(mind, session);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => void sessions.set(id, { transport, seen: Date.now() }),
    });
    transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
    server.server.oninitialized = () => {
      const client = server.server.getClientVersion()?.name ?? "client";
      log(`session ${transport.sessionId?.slice(0, 8)}: ${client}, project ${session.project === undefined ? "from roots or unknown" : (session.project ?? "global")}`);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!hosts.has(hostname)) return rpcError(res, 403, `host "${hostname}" not allowed (MIND_ALLOWED_HOSTS)`);
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === "/health") return send(res, 200, { ok: true, sessions: sessions.size, semantic: mind.status() });
    if (pathname !== "/mcp") return rpcError(res, 404, "not found; the MCP endpoint is /mcp");
    if (token && !sameSecret(req.headers.authorization ?? "", `Bearer ${token}`)) return rpcError(res, 401, "unauthorized");

    const sessionId = header(req, "mcp-session-id");
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (entry) {
      entry.seen = Date.now();
      return entry.transport.handleRequest(req, res, body);
    }
    if (sessionId) return rpcError(res, 404, "session not found; initialize again");
    if (req.method === "POST" && isInitializeRequest(body)) return openSession(req, res, body);
    return rpcError(res, 400, "missing mcp-session-id header");
  };

  const http = createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (!(e instanceof HttpError)) log(`request failed: ${describeError(e)}`);
      if (!res.headersSent) rpcError(res, e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.message : "internal error");
    }),
  );

  // Background upkeep: catch up on embeddings, drop idle sessions.
  let syncing = false;
  const sync = async () => {
    if (syncing || !mind.embedder) return;
    syncing = true;
    try {
      const n = await mind.sync();
      if (n) log(`embedded ${n} memories with ${mind.embedder.model}`);
    } catch (e) {
      log(`embedding sync failed (keyword search still works): ${describeError(e)}`);
    } finally {
      syncing = false;
    }
  };
  const timer = setInterval(() => {
    void sync();
    for (const [id, s] of sessions) if (Date.now() - s.seen > SESSION_TTL_MS) void s.transport.close().finally(() => sessions.delete(id));
  }, SYNC_EVERY_MS);
  http.on("close", () => clearInterval(timer));
  void sync();

  await new Promise<void>((done) => http.listen(port, host, done));
  const address = http.address();
  log(`mind MCP server on http://${host}:${typeof address === "object" && address ? address.port : port}/mcp`);
  return http;
}
