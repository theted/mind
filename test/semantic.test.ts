import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openDb } from "../src/core/db.ts";
import { type Embedder, embeddingText, profileFor } from "../src/core/embed.ts";
import { Mind } from "../src/core/mind.ts";
import { MemoryStore } from "../src/core/store.ts";
import { fakeEmbedder } from "./helpers.ts";

let dir: string;
let db: DatabaseSync;
let store: MemoryStore;
const mindWith = (embedder: Embedder | null = fakeEmbedder()) => new Mind(store, embedder);
const vectorCount = () => (db.prepare("SELECT count(*) n FROM memory_vectors").get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mind-semantic-"));
  db = openDb(join(dir, "mind.db"));
  store = new MemoryStore(db);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("semantic recall", () => {
  test("finds memories by meaning when no keyword matches", async () => {
    const mind = mindWith();
    const auth = (await mind.remember({ kind: "decision", title: "Auth uses JWT now", body: "Sessions were dropped", project: "kolla" })).memory;
    await mind.remember({ kind: "gotcha", title: "EC2 deploy needs compose v2", project: "snippets" });
    assert.deepEqual(store.recall({ query: "login" }), [], "keyword search alone misses it");
    const res = await mind.recall({ query: "login" });
    assert.equal(res.semantic, true);
    assert.deepEqual(res.memories.map((m) => m.id), [auth.id]);
  });

  test("a memory both retrievers agree on ranks first", async () => {
    const mind = mindWith();
    await mind.remember({ kind: "fact", title: "Session cookies expire after a day" });
    const both = (await mind.remember({ kind: "fact", title: "JWT tokens are signed with RS256" })).memory;
    await mind.remember({ kind: "fact", title: "Login page lives under /auth" });
    assert.equal((await mind.recall({ query: "jwt" })).memories[0]!.id, both.id);
  });

  test("semantic hits obey the same filters as keyword hits", async () => {
    const mind = mindWith();
    const kolla = (await mind.remember({ kind: "decision", title: "Auth uses JWT", project: "kolla" })).memory;
    const other = (await mind.remember({ kind: "fact", title: "Login via OAuth", project: "notes" })).memory;
    const old = (await mind.remember({ kind: "fact", title: "Sessions in redis", project: "kolla" })).memory;
    const neu = (await mind.remember({ kind: "fact", title: "Sessions in postgres", project: "kolla", supersedes: [old.id] })).memory;
    const gone = (await mind.remember({ kind: "fact", title: "Token refresh flow", project: "kolla" })).memory;
    store.forget(gone.id);

    const ids = async (input: Parameters<Mind["recall"]>[0]) => (await mind.recall(input)).memories.map((m) => m.id);
    assert.deepEqual(await ids({ query: "authentication", project: "kolla" }), [kolla.id, neu.id]);
    assert.deepEqual(await ids({ query: "authentication", kind: "fact" }), [other.id, neu.id]);
    assert.ok((await ids({ query: "authentication", includeSuperseded: true })).includes(old.id));
    assert.ok(!(await ids({ query: "authentication" })).includes(gone.id));
  });

  test("current project ranks above other projects", async () => {
    const mind = mindWith();
    const other = (await mind.remember({ kind: "fact", title: "Login uses OAuth", project: "notes" })).memory;
    const mine = (await mind.remember({ kind: "fact", title: "Login uses OAuth too", project: "kolla" })).memory;
    const res = await mind.recall({ query: "authentication", boostProject: "kolla" });
    assert.deepEqual(res.memories.map((m) => m.id), [mine.id, other.id]);
  });
});

describe("semantic index upkeep", () => {
  test("embeds on write and again after an edit", async () => {
    const mind = mindWith();
    const { memory } = await mind.remember({ kind: "fact", title: "uses postgres" });
    assert.deepEqual(store.embeddingCoverage("fake-v1"), { embedded: 1, total: 1 });
    store.update(memory.id, { title: "deploys to ec2" }); // bypasses Mind, as another process might
    assert.deepEqual(store.staleEmbeddings("fake-v1", 10).map((s) => s.id), [memory.id]);
    assert.equal((await mind.recall({ query: "aws" })).memories[0]?.id, memory.id, "recall syncs before searching");
    assert.deepEqual(store.staleEmbeddings("fake-v1", 10), []);
  });

  test("a different model re-embeds everything; force clears first", async () => {
    await mindWith().remember({ kind: "fact", title: "one" });
    await mindWith().remember({ kind: "fact", title: "two" });
    const v2 = mindWith(fakeEmbedder("fake-v2"));
    assert.equal(store.staleEmbeddings("fake-v2", 10).length, 2);
    assert.equal(await v2.sync(), 2);
    assert.equal(await v2.sync(), 0);
    assert.equal(await v2.sync({ force: true }), 2);
    assert.deepEqual(v2.status(), { model: "fake-v2", embedded: 2, total: 2, error: null });
  });

  test("hard delete drops the vector, soft delete keeps it out of results", async () => {
    const mind = mindWith();
    const a = (await mind.remember({ kind: "fact", title: "login flow" })).memory;
    const b = (await mind.remember({ kind: "fact", title: "jwt flow" })).memory;
    store.forget(a.id, { hard: true });
    assert.equal(vectorCount(), 1);
    store.forget(b.id);
    assert.deepEqual((await mind.recall({ query: "auth" })).memories, []);
  });

  test("vectors computed for an outdated version stay stale", async () => {
    const { memory } = await mindWith(null).remember({ kind: "fact", title: "v1 text" });
    const [stale] = store.staleEmbeddings("fake-v1", 1);
    store.update(memory.id, { title: "v2 text" });
    store.saveEmbeddings("fake-v1", [{ ...stale!, vector: new Float32Array(4) }]);
    assert.deepEqual(store.staleEmbeddings("fake-v1", 1).map((s) => s.text), ["v2 text"]);
  });
});

describe("near-duplicate hints", () => {
  test("remember lists similar memories in the same scope", async () => {
    const mind = mindWith();
    const first = (await mind.remember({ kind: "fact", title: "Auth uses JWT tokens", project: "kolla" })).memory;
    await mind.remember({ kind: "fact", title: "Login authentication uses JWT", project: "notes" });
    const res = await mind.remember({ kind: "fact", title: "Authentication uses JWT tokens", project: "kolla" });
    assert.deepEqual(res.similar.map((m) => m.id), [first.id]);
    assert.ok(res.similar[0]!.score! >= 0.85);
    assert.deepEqual((await mind.remember({ kind: "fact", title: "Deploy to ec2", project: "kolla" })).similar, []);
  });
});

describe("embedder failures", () => {
  test("fall back to keyword search and back off", async () => {
    const embedder = fakeEmbedder("fake-v1", { fail: true });
    const mind = mindWith(embedder);
    const { memory, similar } = await mind.remember({ kind: "fact", title: "JWT secret rotates monthly" });
    assert.deepEqual(similar, []);
    assert.match(mind.error!, /embedder down/);
    const res = await mind.recall({ query: "jwt" });
    assert.equal(res.semantic, false);
    assert.deepEqual(res.memories.map((m) => m.id), [memory.id]);
    assert.equal(embedder.calls, 1, "no retry inside the back-off window");
    await assert.rejects(mind.sync(), /embedder down/, "an explicit sync reports the failure");
  });

  test("no embedder: keyword search only", async () => {
    const mind = mindWith(null);
    await mind.remember({ kind: "fact", title: "JWT secret rotates monthly" });
    assert.equal((await mind.recall({ query: "jwt" })).semantic, false);
    assert.equal(mind.status(), null);
    assert.equal(await mind.sync(), 0);
  });
});

describe("embedder config", () => {
  test("model profiles pick retrieval prefixes and floors", () => {
    assert.match(profileFor("BAAI/bge-small-en-v1.5").queryPrefix, /^Represent this sentence/);
    assert.deepEqual(
      [profileFor("nomic-embed-text").queryPrefix, profileFor("nomic-ai/nomic-embed-text-v1.5").documentPrefix],
      ["search_query: ", "search_document: "],
    );
    assert.equal(profileFor("intfloat/multilingual-e5-small").queryPrefix, "query: ");
    assert.equal(profileFor("something-else").queryPrefix, "");
    assert.equal(embeddingText({ title: "t", body: "" }), "t");
  });
});
