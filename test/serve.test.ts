import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../src/core/db.ts";
import { Mind } from "../src/core/mind.ts";
import { MemoryStore } from "../src/core/store.ts";
import { startHttpServer } from "../src/serve.ts";
import { fakeEmbedder } from "./helpers.ts";

const TOKEN = "s3cret";
let dir: string;
let http: Server;
let mind: Mind;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "mind-serve-"));
  mind = new Mind(new MemoryStore(openDb(join(dir, "mind.db"))), fakeEmbedder());
  http = await startHttpServer({ port: 0, host: "127.0.0.1", token: TOKEN, mind, log: () => {} });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
after(() => {
  http.closeAllConnections();
  http.close();
  rmSync(dir, { recursive: true, force: true });
});

const connect = async (headers: Record<string, string> = {}, path = "/mcp", root?: string) => {
  const client = new Client({ name: "test-agent", version: "1.0.0" }, root ? { capabilities: { roots: {} } } : {});
  if (root) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: root }] }));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, base), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...headers } } }),
  );
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!res.isError, res.content[0]?.text);
  return res.content[0]!.text;
};

describe("HTTP MCP server", () => {
  test("the X-Mind-Project header scopes a session", async () => {
    const client = await connect({ "x-mind-project": "kolla" });
    assert.match(await call(client, "remember", { kind: "decision", title: "Auth uses JWT" }), /Saved #\d+/);
    assert.equal(mind.store.list()[0]!.project, "kolla");
    assert.equal(mind.store.list()[0]!.source, "test-agent");
    assert.match(await call(client, "list_projects"), /current project: kolla/);
    assert.match(await call(client, "recall", { query: "login" }), /Auth uses JWT/);
    await client.close();
  });

  test("?project= works too; without either, agents are told to pass project", async () => {
    const viaQuery = await connect({}, "/mcp?project=notes");
    assert.match(await call(viaQuery, "list_projects"), /current project: notes/);
    await viaQuery.close();

    const anonymous = await connect();
    assert.match(await call(anonymous, "list_projects"), /current project: unknown/);
    const { tools } = await anonymous.listTools();
    const remember = tools.find((t) => t.name === "remember")!;
    assert.match(JSON.stringify(remember.inputSchema), /can't see your working directory/);
    await call(anonymous, "remember", { kind: "fact", title: "Global by default" });
    assert.equal(mind.store.list()[0]!.project, null);
    await anonymous.close();
  });

  test("X-Mind-Cwd and MCP roots map a path to its project through MIND_ROOT", async () => {
    const prev = process.env.MIND_ROOT;
    process.env.MIND_ROOT = "/srv/code";
    try {
      const viaCwd = await connect({ "x-mind-cwd": "/srv/code/kolla/client/src" });
      assert.match(await call(viaCwd, "list_projects"), /current project: kolla/);
      await viaCwd.close();
      const viaRoots = await connect({}, "/mcp", "file:///srv/code/guitar");
      assert.match(await call(viaRoots, "list_projects"), /current project: guitar/);
      await viaRoots.close();
    } finally {
      if (prev === undefined) delete process.env.MIND_ROOT;
      else process.env.MIND_ROOT = prev;
    }
  });

  test("remember reports near-duplicates", async () => {
    const client = await connect({ "x-mind-project": "kolla" });
    assert.match(await call(client, "remember", { kind: "fact", title: "Authentication uses JWT" }), /Similar existing memories[\s\S]*Auth uses JWT/);
    await client.close();
  });

  test("rejects bad tokens, foreign Host headers, unknown sessions and bad JSON", async () => {
    const raw = (path: string, headers: Record<string, string>, body = "{}") =>
      new Promise<number>((done, fail) =>
        request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
          res.resume();
          done(res.statusCode!);
        })
          .on("error", fail)
          .end(body),
      );
    assert.equal(await raw("/mcp", { authorization: "Bearer wrong" }), 401);
    assert.equal(await raw("/mcp", { authorization: `Bearer ${TOKEN}`, host: "evil.example:80" }), 403);
    assert.equal(await raw("/mcp", { authorization: `Bearer ${TOKEN}`, "mcp-session-id": "nope" }), 404);
    assert.equal(await raw("/mcp", { authorization: `Bearer ${TOKEN}` }), 400);
    assert.equal(await raw("/mcp", { authorization: `Bearer ${TOKEN}` }, "{not json"), 400);
  });

  test("health reports semantic index coverage", async () => {
    const res = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; semantic: { model: string } };
    assert.equal(res.ok, true);
    assert.equal(res.semantic.model, "fake-v1");
  });
});
