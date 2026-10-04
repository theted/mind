import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db";
import { resolveProject } from "../src/core/project";
import { MemoryStore, toFtsQuery } from "../src/core/store";
import { migrations } from "../src/core/schema";

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
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(migrations.length);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  });
});

describe("remember / recall", () => {
  test("round-trips and ranks by relevance", () => {
    store.remember({ kind: "gotcha", title: "EC2 deploy needs docker compose v2", body: "Use `docker compose`, not docker-compose", project: "snippets" });
    store.remember({ kind: "fact", title: "Kolla indexes videos with ffprobe", project: "kolla" });
    const res = store.recall({ query: "docker deploy" });
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toContain("EC2");
    expect(res[0]!.score).toBeGreaterThan(0);
  });

  test("stemming and prefix matching", () => {
    store.remember({ kind: "howto", title: "Deploying the frontend to S3" });
    expect(store.recall({ query: "deploy" })).toHaveLength(1);
    expect(store.recall({ query: "front*" })).toHaveLength(1);
  });

  test("hostile query syntax does not throw", () => {
    store.remember({ kind: "fact", title: "quote test" });
    for (const q of [`"unbalanced`, "AND OR NOT", "a:b", "(x", "NEAR(", "*", "-foo"]) expect(() => store.recall({ query: q })).not.toThrow();
    expect(toFtsQuery('  "  ')).toBeNull();
  });

  test("boosts current project, then global, over other projects", () => {
    const other = store.remember({ kind: "fact", title: "tailwind config lives in root", project: "guitar" }).memory;
    const global = store.remember({ kind: "fact", title: "tailwind config prefers css variables", project: "global" }).memory;
    const mine = store.remember({ kind: "fact", title: "tailwind config uses glass tokens", project: "kolla" }).memory;
    const ids = store.recall({ query: "tailwind config", boostProject: "kolla" }).map((m) => m.id);
    expect(ids).toEqual([mine.id, global.id, other.id]);
  });

  test("project filter restricts to project + global", () => {
    store.remember({ kind: "fact", title: "nginx proxy setup", project: "kolla" });
    store.remember({ kind: "fact", title: "nginx global defaults", project: null });
    store.remember({ kind: "fact", title: "nginx on notes", project: "notes" });
    const projects = store.recall({ query: "nginx", project: "kolla" }).map((m) => m.project);
    expect(projects.sort()).toEqual(["kolla", null].sort() as never);
    expect(store.recall({ query: "nginx", project: "global" }).map((m) => m.project)).toEqual([null]);
  });

  test("tracks access", () => {
    const { memory } = store.remember({ kind: "fact", title: "access counting works" });
    store.recall({ query: "access" });
    store.recall({ query: "counting" });
    expect(store.get(memory.id)!.access_count).toBe(2);
  });
});

describe("dedupe, update, supersede, forget", () => {
  test("rejects duplicates within a project (whitespace/case-insensitive title)", () => {
    const a = store.remember({ kind: "fact", title: "Same thing", body: "x", project: "kolla" });
    const b = store.remember({ kind: "fact", title: "  same   THING ", body: "x ", project: "kolla" });
    expect(b.duplicate).toBe(true);
    expect(b.memory.id).toBe(a.memory.id);
    expect(store.remember({ kind: "fact", title: "Same thing", body: "x", project: "notes" }).duplicate).toBe(false);
  });

  test("update keeps FTS in sync", () => {
    const { memory } = store.remember({ kind: "fact", title: "uses postgres" });
    store.update(memory.id, { title: "uses sqlite" });
    expect(store.recall({ query: "postgres" })).toHaveLength(0);
    expect(store.recall({ query: "sqlite" })).toHaveLength(1);
  });

  test("superseded memories are hidden unless asked for", () => {
    const old = store.remember({ kind: "decision", title: "auth via sessions" }).memory;
    const neu = store.remember({ kind: "decision", title: "auth via JWT", body: "sessions dropped", supersedes: [old.id] }).memory;
    expect(store.recall({ query: "auth" }).map((m) => m.id)).toEqual([neu.id]);
    expect(store.recall({ query: "auth", includeSuperseded: true })).toHaveLength(2);
    expect(store.get(old.id)!.superseded_by).toBe(neu.id);
  });

  test("forget soft-deletes and allows re-adding", () => {
    const { memory } = store.remember({ kind: "fact", title: "temporary" });
    expect(store.forget(memory.id)).toBe(true);
    expect(store.get(memory.id)).toBeNull();
    expect(store.recall({ query: "temporary" })).toHaveLength(0);
    expect(store.remember({ kind: "fact", title: "temporary" }).duplicate).toBe(false);
    expect(store.forget(memory.id)).toBe(false);
  });

  test("validates input", () => {
    expect(() => store.remember({ kind: "nope" as never, title: "x" })).toThrow(/invalid kind/);
    expect(() => store.remember({ kind: "fact", title: "  " })).toThrow(/title/);
    expect(() => store.remember({ kind: "fact", title: "x", importance: 9 })).toThrow(/importance/);
  });
});

describe("context, export/import", () => {
  test("context ranks by importance and includes global preferences", () => {
    store.remember({ kind: "fact", title: "minor", project: "kolla", importance: 1 });
    store.remember({ kind: "gotcha", title: "critical", project: "kolla", importance: 5 });
    store.remember({ kind: "preference", title: "concise commits", project: "global" });
    store.remember({ kind: "fact", title: "unimportant global", project: "global", importance: 2 });
    const ctx = store.context("kolla");
    expect(ctx.project.map((m) => m.title)).toEqual(["critical", "minor"]);
    expect(ctx.global.map((m) => m.title)).toEqual(["concise commits"]);
  });

  test("export -> import into a fresh DB preserves supersede links and skips dupes", () => {
    const a = store.remember({ kind: "fact", title: "v1" }).memory;
    store.remember({ kind: "fact", title: "v2", supersedes: [a.id] });
    const rows = [...store.exportRows()];
    const fresh = new MemoryStore(openDb(join(dir, "other.db")));
    expect(fresh.importRows(rows)).toEqual({ imported: 2, skipped: 0 });
    expect(fresh.importRows(rows)).toEqual({ imported: 0, skipped: 2 });
    const byTitle = Object.fromEntries(fresh.list({ includeSuperseded: true }).map((m) => [m.title, m]));
    const [v1, v2] = [byTitle.v1, byTitle.v2];
    expect(v1!.superseded_by).toBe(v2!.id);
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
      expect(resolveProject(join(root, "kolla/client/src"))).toBe("kolla");
      expect(resolveProject(join(root, "kolla-feature"))).toBe("kolla");
      expect(resolveProject(root)).toBeNull();
    } finally {
      delete process.env.MIND_ROOT;
    }
  });
});

describe("concurrency", () => {
  test("parallel writer processes don't hit 'database is locked'", async () => {
    const script = join(import.meta.dir, "../src/cli.ts");
    const env = { ...process.env, MIND_DB: dbPath() };
    const procs = Array.from({ length: 6 }, (_, w) =>
      Bun.spawn(
        ["bash", "-c", `for i in $(seq 1 5); do "${process.execPath}" "${script}" remember "worker ${w} note $i" -k fact -p global >/dev/null || exit 1; done`],
        { env, stderr: "pipe" },
      ),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(store.stats().memories).toBe(30);
  }, 60_000);
});
