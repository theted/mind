import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openDb } from "../src/core/db.ts";
import { resolveProject } from "../src/core/project.ts";
import { MemoryStore, toFtsQuery } from "../src/core/store.ts";
import { migrations } from "../src/core/schema.ts";

let dir: string;
let store: MemoryStore;
const dbPath = () => join(dir, "mind.db");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mind-test-"));
  store = new MemoryStore(openDb(dbPath()));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("schema", () => {
  test("migrates to latest version, idempotently", () => {
    const db = openDb(dbPath());
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  });
});

describe("remember / recall", () => {
  test("round-trips and ranks by relevance", () => {
    store.remember({ kind: "gotcha", title: "EC2 deploy needs docker compose v2", body: "Use `docker compose`, not docker-compose", project: "snippets" });
    store.remember({ kind: "fact", title: "Kolla indexes videos with ffprobe", project: "kolla" });
    const res = store.recall({ query: "docker deploy" });
    assert.equal(res.length, 1);
    assert.match(res[0]!.title, /EC2/);
    assert.ok(res[0]!.score! > 0);
  });

  test("stemming and prefix matching", () => {
    store.remember({ kind: "howto", title: "Deploying the frontend to S3" });
    assert.equal(store.recall({ query: "deploy" }).length, 1);
    assert.equal(store.recall({ query: "front*" }).length, 1);
  });

  test("hostile query syntax does not throw", () => {
    store.remember({ kind: "fact", title: "quote test" });
    for (const q of [`"unbalanced`, "AND OR NOT", "a:b", "(x", "NEAR(", "*", "-foo"]) assert.doesNotThrow(() => store.recall({ query: q }));
    assert.equal(toFtsQuery('  "  '), null);
  });

  test("boosts current project, then global, over other projects", () => {
    const other = store.remember({ kind: "fact", title: "tailwind config lives in root", project: "guitar" }).memory;
    const global = store.remember({ kind: "fact", title: "tailwind config prefers css variables", project: "global" }).memory;
    const mine = store.remember({ kind: "fact", title: "tailwind config uses glass tokens", project: "kolla" }).memory;
    const ids = store.recall({ query: "tailwind config", boostProject: "kolla" }).map((m) => m.id);
    assert.deepEqual(ids, [mine.id, global.id, other.id]);
  });

  test("project filter restricts to project + global", () => {
    store.remember({ kind: "fact", title: "nginx proxy setup", project: "kolla" });
    store.remember({ kind: "fact", title: "nginx global defaults", project: null });
    store.remember({ kind: "fact", title: "nginx on notes", project: "notes" });
    const projects = store.recall({ query: "nginx", project: "kolla" }).map((m) => m.project);
    assert.deepEqual(projects.sort(), ["kolla", null].sort());
    assert.deepEqual(store.recall({ query: "nginx", project: "global" }).map((m) => m.project), [null]);
  });

  test("tracks access", () => {
    const { memory } = store.remember({ kind: "fact", title: "access counting works" });
    store.recall({ query: "access" });
    store.recall({ query: "counting" });
    assert.equal(store.get(memory.id)!.access_count, 2);
  });
});

describe("dedupe, update, supersede, forget", () => {
  test("rejects duplicates within a project (whitespace/case-insensitive title)", () => {
    const a = store.remember({ kind: "fact", title: "Same thing", body: "x", project: "kolla" });
    const b = store.remember({ kind: "fact", title: "  same   THING ", body: "x ", project: "kolla" });
    assert.equal(b.duplicate, true);
    assert.equal(b.memory.id, a.memory.id);
    assert.equal(store.remember({ kind: "fact", title: "Same thing", body: "x", project: "notes" }).duplicate, false);
  });

  test("update keeps FTS in sync", () => {
    const { memory } = store.remember({ kind: "fact", title: "uses postgres" });
    store.update(memory.id, { title: "uses sqlite" });
    assert.equal(store.recall({ query: "postgres" }).length, 0);
    assert.equal(store.recall({ query: "sqlite" }).length, 1);
  });

  test("superseded memories are hidden unless asked for", () => {
    const old = store.remember({ kind: "decision", title: "auth via sessions" }).memory;
    const neu = store.remember({ kind: "decision", title: "auth via JWT", body: "sessions dropped", supersedes: [old.id] }).memory;
    assert.deepEqual(store.recall({ query: "auth" }).map((m) => m.id), [neu.id]);
    assert.equal(store.recall({ query: "auth", includeSuperseded: true }).length, 2);
    assert.equal(store.get(old.id)!.superseded_by, neu.id);
  });

  test("forget soft-deletes and allows re-adding", () => {
    const { memory } = store.remember({ kind: "fact", title: "temporary" });
    assert.equal(store.forget(memory.id), true);
    assert.equal(store.get(memory.id), null);
    assert.equal(store.recall({ query: "temporary" }).length, 0);
    assert.equal(store.remember({ kind: "fact", title: "temporary" }).duplicate, false);
    assert.equal(store.forget(memory.id), false);
  });

  test("validates input", () => {
    assert.throws(() => store.remember({ kind: "nope" as never, title: "x" }), /invalid kind/);
    assert.throws(() => store.remember({ kind: "fact", title: "  " }), /title/);
    assert.throws(() => store.remember({ kind: "fact", title: "x", importance: 9 }), /importance/);
  });

  test("a failed write rolls back and leaves the store usable", () => {
    const a = store.remember({ kind: "fact", title: "kept" }).memory;
    assert.throws(() => store.remember({ kind: "fact", title: "dangling", supersedes: [9999] }), /not found/);
    assert.equal(store.recall({ query: "dangling" }).length, 0);
    assert.equal(store.get(a.id)!.title, "kept");
    assert.equal(store.remember({ kind: "fact", title: "after rollback" }).duplicate, false);
  });
});

describe("context, export/import", () => {
  test("context ranks by importance and includes global preferences", () => {
    store.remember({ kind: "fact", title: "minor", project: "kolla", importance: 1 });
    store.remember({ kind: "gotcha", title: "critical", project: "kolla", importance: 5 });
    store.remember({ kind: "preference", title: "concise commits", project: "global" });
    store.remember({ kind: "fact", title: "unimportant global", project: "global", importance: 2 });
    const ctx = store.context("kolla");
    assert.deepEqual(ctx.project.map((m) => m.title), ["critical", "minor"]);
    assert.deepEqual(ctx.global.map((m) => m.title), ["concise commits"]);
  });

  test("export -> import into a fresh DB preserves supersede links and skips dupes", () => {
    const a = store.remember({ kind: "fact", title: "v1" }).memory;
    store.remember({ kind: "fact", title: "v2", supersedes: [a.id] });
    const rows = [...store.exportRows()];
    const fresh = new MemoryStore(openDb(join(dir, "other.db")));
    assert.deepEqual(fresh.importRows(rows), { imported: 2, skipped: 0 });
    assert.deepEqual(fresh.importRows(rows), { imported: 0, skipped: 2 });
    const byTitle = Object.fromEntries(fresh.list({ includeSuperseded: true }).map((m) => [m.title, m]));
    const [v1, v2] = [byTitle.v1, byTitle.v2];
    assert.equal(v1!.superseded_by, v2!.id);
  });
});

describe("project resolution", () => {
  test("maps nested paths, worktrees and the root", () => {
    const root = join(dir, "Playground");
    mkdirSync(join(root, "kolla/client/src"), { recursive: true });
    mkdirSync(join(root, "kolla-feature"), { recursive: true });
    writeFileSync(join(root, "kolla-feature/.git"), `gitdir: ${root}/kolla/.git/worktrees/kolla-feature\n`);
    process.env.MIND_ROOT = root;
    try {
      assert.equal(resolveProject(join(root, "kolla/client/src")), "kolla");
      assert.equal(resolveProject(join(root, "kolla-feature")), "kolla");
      assert.equal(resolveProject(root), null);
    } finally {
      delete process.env.MIND_ROOT;
    }
  });
});

describe("concurrency", () => {
  test("parallel writer processes don't hit 'database is locked'", { timeout: 60_000 }, async () => {
    const script = join(import.meta.dirname, "../src/cli.ts");
    const env = { ...process.env, MIND_DB: dbPath() };
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        (_, w) =>
          new Promise<number | null>((done) =>
            spawn(
              "bash",
              ["-c", `for i in $(seq 1 5); do "${process.execPath}" "${script}" remember "worker ${w} note $i" -k fact -p global >/dev/null || exit 1; done`],
              { env, stdio: "ignore" },
            ).on("close", done),
          ),
      ),
    );
    assert.ok(codes.every((c) => c === 0));
    assert.equal(store.stats().memories, 30);
  });
});
