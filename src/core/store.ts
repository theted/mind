import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { immediate } from "./db.ts";
import { normalizeProject } from "./project.ts";

type Params = Record<string, SQLInputValue>;

export const KINDS = ["fact", "decision", "preference", "gotcha", "howto", "episode"] as const;
export type Kind = (typeof KINDS)[number];

export interface Memory {
  id: number;
  project: string | null;
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  files: string[];
  source: string | null;
  importance: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  superseded_by: number | null;
  score?: number;
}

export interface RememberInput {
  kind: Kind;
  title: string;
  body?: string;
  tags?: string[];
  files?: string[];
  project?: string | null;
  source?: string | null;
  importance?: number;
  /** ids of older memories this one replaces */
  supersedes?: number[];
}

export type UpdateInput = Partial<Pick<RememberInput, "kind" | "title" | "body" | "tags" | "files" | "project" | "importance">>;

export interface RecallInput {
  query: string;
  /** Restrict results to this project + global. Omit to search everything. */
  project?: string | null;
  /** Project to rank higher when not restricting (usually the caller's cwd). */
  boostProject?: string | null;
  kind?: Kind;
  limit?: number;
  includeSuperseded?: boolean;
}

export interface ListInput {
  project?: string | null;
  kind?: Kind;
  limit?: number;
  includeSuperseded?: boolean;
}

// A type alias, not an interface, so node:sqlite's untyped rows (Record<string, SQLOutputValue>) can be cast to it.
type Row = {
  id: number;
  project: string | null;
  kind: Kind;
  title: string;
  body: string;
  tags: string;
  files: string;
  source: string | null;
  importance: number;
  content_hash: string;
  created_at: number;
  updated_at: number;
  last_accessed_at: number | null;
  access_count: number;
  superseded_by: number | null;
  deleted_at: number | null;
};

export class MindError extends Error {}

const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 120;

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

const toMemory = (r: Row, score?: number): Memory => ({
  id: r.id,
  project: r.project,
  kind: r.kind,
  title: r.title,
  body: r.body,
  tags: r.tags ? r.tags.split(" ") : [],
  files: JSON.parse(r.files),
  source: r.source,
  importance: r.importance,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  last_accessed_at: iso(r.last_accessed_at),
  access_count: r.access_count,
  superseded_by: r.superseded_by,
  ...(score === undefined ? {} : { score: Number(score.toPrecision(3)) }),
});

const normTags = (tags: string[] = []) =>
  [...new Set(tags.flatMap((t) => t.split(/[\s,]+/)).map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))].join(" ");

const hashOf = (kind: string, title: string, body: string) =>
  createHash("sha256")
    .update(`${kind}\0${title.trim().toLowerCase().replace(/\s+/g, " ")}\0${body.trim().replace(/\s+/g, " ")}`)
    .digest("hex");

function assertKind(kind: string): asserts kind is Kind {
  if (!KINDS.includes(kind as Kind)) throw new MindError(`invalid kind "${kind}" (expected one of ${KINDS.join(", ")})`);
}

function clampImportance(i: number | undefined) {
  if (i === undefined) return 3;
  if (!Number.isInteger(i) || i < 1 || i > 5) throw new MindError("importance must be an integer 1-5");
  return i;
}

/**
 * Turn free text into a safe FTS5 query: every token quoted (so operators and
 * punctuation can't break the syntax), OR-joined so partial matches still rank.
 * A trailing `*` on a token keeps prefix matching.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((raw) => {
      const prefix = raw.endsWith("*");
      const tok = raw.replace(/["*]/g, "").trim();
      return tok ? `"${tok}"${prefix ? "*" : ""}` : "";
    })
    .filter(Boolean);
  return terms.length ? terms.join(" OR ") : null;
}

export class MemoryStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  remember(input: RememberInput, now = Date.now()): { memory: Memory; duplicate: boolean } {
    assertKind(input.kind);
    const title = input.title?.trim();
    if (!title) throw new MindError("title is required");
    const body = input.body?.trim() ?? "";
    const project = normalizeProject(input.project);
    const hash = hashOf(input.kind, title, body);

    return this.write(() => {
      const existing = this.db
        .prepare("SELECT * FROM memories WHERE ifnull(project,'') = ? AND content_hash = ? AND deleted_at IS NULL")
        .get(project ?? "", hash) as Row | undefined;
      if (existing) return { memory: toMemory(existing), duplicate: true };

      const row = this.db
        .prepare(
          `INSERT INTO memories (project, kind, title, body, tags, files, source, importance, content_hash, created_at, updated_at)
           VALUES ($project, $kind, $title, $body, $tags, $files, $source, $importance, $hash, $now, $now)
           RETURNING *`,
        )
        .get({
          project,
          kind: input.kind,
          title,
          body,
          tags: normTags(input.tags),
          files: JSON.stringify(input.files ?? []),
          source: input.source ?? null,
          importance: clampImportance(input.importance),
          hash,
          now,
        }) as Row;

      for (const oldId of input.supersedes ?? []) this.supersedeIn(oldId, row.id, now);
      return { memory: toMemory(row), duplicate: false };
    });
  }

  get(id: number): Memory | null {
    const r = this.row(id);
    return r ? toMemory(r) : null;
  }

  update(id: number, patch: UpdateInput, now = Date.now()): Memory {
    const cur = this.row(id);
    if (!cur) throw new MindError(`memory #${id} not found`);
    if (patch.kind !== undefined) assertKind(patch.kind);
    const next = {
      kind: patch.kind ?? cur.kind,
      title: patch.title?.trim() ?? cur.title,
      body: patch.body?.trim() ?? cur.body,
      tags: patch.tags !== undefined ? normTags(patch.tags) : cur.tags,
      files: patch.files !== undefined ? JSON.stringify(patch.files) : cur.files,
      project: patch.project !== undefined ? normalizeProject(patch.project) : cur.project,
      importance: patch.importance !== undefined ? clampImportance(patch.importance) : cur.importance,
    };
    if (!next.title) throw new MindError("title cannot be empty");
    try {
      const row = this.write(() => this.db
        .prepare(
          `UPDATE memories SET kind=$kind, title=$title, body=$body, tags=$tags, files=$files, project=$project,
             importance=$importance, content_hash=$hash, updated_at=$now
           WHERE id=$id RETURNING *`,
        )
        .get({ ...next, hash: hashOf(next.kind, next.title, next.body), now, id }) as Row);
      return toMemory(row);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new MindError("an identical memory already exists in that project");
      throw e;
    }
  }

  supersede(oldId: number, newId: number, now = Date.now()) {
    this.write(() => this.supersedeIn(oldId, newId, now));
  }

  private supersedeIn(oldId: number, newId: number, now: number) {
    if (oldId === newId) throw new MindError("a memory cannot supersede itself");
    if (!this.row(oldId)) throw new MindError(`memory #${oldId} not found`);
    this.db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?").run(newId, now, oldId);
  }

  /** Soft delete by default so an agent's mistake is recoverable from the DB. */
  forget(id: number, { hard = false } = {}, now = Date.now()): boolean {
    const res = this.write(() =>
      hard
        ? this.db.prepare("DELETE FROM memories WHERE id = ?").run(id)
        : this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, id),
    );
    return res.changes > 0;
  }

  recall(input: RecallInput, now = Date.now()): Memory[] {
    const fts = toFtsQuery(input.query);
    if (!fts) return [];
    const limit = input.limit ?? 10;
    const restrict = input.project !== undefined;
    const project = normalizeProject(restrict ? input.project : input.boostProject);
    if (input.kind) assertKind(input.kind);

    const where = ["memories_fts MATCH $fts", "m.deleted_at IS NULL"];
    if (!input.includeSuperseded) where.push("m.superseded_by IS NULL");
    if (input.kind) where.push("m.kind = $kind");
    if (restrict) where.push(project ? "(m.project = $project OR m.project IS NULL)" : "m.project IS NULL");

    // Pull a generous candidate set by text relevance, then re-rank with project/importance/recency.
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 4.0, 1.0, 2.0) AS rank
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY rank LIMIT 200`,
      )
      .all({ fts, ...(input.kind ? { kind: input.kind } : {}), ...(restrict && project ? { project } : {}) }) as (Row & { rank: number })[];

    const scored = rows
      .map((r) => {
        const relevance = -r.rank; // bm25 is negative; more negative = better
        const projectBoost = project && r.project === project ? 1.5 : r.project === null ? 1.2 : 1.0;
        const importanceBoost = 0.6 + 0.2 * r.importance;
        const ageDays = (now - r.updated_at) / DAY_MS;
        const recencyBoost = 0.6 + 0.4 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
        return { r, score: relevance * projectBoost * importanceBoost * recencyBoost };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this.touch(scored.map((s) => s.r.id), now);
    return scored.map((s) => toMemory(s.r, s.score));
  }

  list(input: ListInput = {}): Memory[] {
    const where = ["deleted_at IS NULL"];
    const params: Params = { limit: input.limit ?? 50 };
    if (!input.includeSuperseded) where.push("superseded_by IS NULL");
    if (input.kind) {
      assertKind(input.kind);
      where.push("kind = $kind");
      params.kind = input.kind;
    }
    if (input.project !== undefined) {
      const p = normalizeProject(input.project);
      where.push(p ? "project = $project" : "project IS NULL");
      if (p) params.project = p;
    }
    return (
      this.db
        .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $limit`)
        .all(params) as Row[]
    ).map((r) => toMemory(r));
  }

  listProjects(): { project: string; count: number; last_updated: string }[] {
    return (
      this.db
        .prepare(
          `SELECT project, count(*) AS count, max(updated_at) AS last FROM memories
           WHERE deleted_at IS NULL AND superseded_by IS NULL GROUP BY project ORDER BY last DESC`,
        )
        .all() as { project: string | null; count: number; last: number }[]
    ).map((r) => ({ project: r.project ?? "global", count: r.count, last_updated: iso(r.last)! }));
  }

  /** The most useful memories for starting a session in `project`: highest importance, then most recent. */
  context(project: string | null, { limit = 15, globalLimit = 8 } = {}): { project: Memory[]; global: Memory[] } {
    const top = (where: string, n: number, params: Params) =>
      (
        this.db
          .prepare(
            `SELECT * FROM memories WHERE deleted_at IS NULL AND superseded_by IS NULL AND kind != 'episode' AND ${where}
             ORDER BY importance DESC, updated_at DESC LIMIT $n`,
          )
          .all({ ...params, n }) as Row[]
      ).map((r) => toMemory(r));
    const p = normalizeProject(project);
    return {
      project: p ? top("project = $p", limit, { p }) : [],
      global: top("project IS NULL AND (kind = 'preference' OR importance >= 4)", globalLimit, {}),
    };
  }

  stats() {
    const q = <T>(sql: string) => this.db.prepare(sql).get() as T;
    return {
      memories: q<{ n: number }>("SELECT count(*) n FROM memories WHERE deleted_at IS NULL AND superseded_by IS NULL").n,
      superseded: q<{ n: number }>("SELECT count(*) n FROM memories WHERE deleted_at IS NULL AND superseded_by IS NOT NULL").n,
      deleted: q<{ n: number }>("SELECT count(*) n FROM memories WHERE deleted_at IS NOT NULL").n,
      by_kind: Object.fromEntries(
        (
          this.db
            .prepare(
              "SELECT kind, count(*) n FROM memories WHERE deleted_at IS NULL AND superseded_by IS NULL GROUP BY kind ORDER BY n DESC",
            )
            .all() as { kind: string; n: number }[]
        ).map((r) => [r.kind, r.n]),
      ),
      projects: this.listProjects().length,
    };
  }

  /** Raw rows (including superseded and deleted) for lossless JSONL backup. */
  *exportRows(): Generator<Row> {
    yield* this.db.prepare("SELECT * FROM memories ORDER BY id").iterate() as Iterable<Row>;
  }

  /** Import rows from exportRows(); ids are remapped, duplicates skipped. */
  importRows(rows: Iterable<Row>): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    this.write(() => {
      const idMap = new Map<number, number>();
      const pending: [number, number][] = [];
      const insert = this.db.prepare(
        `INSERT INTO memories (project, kind, title, body, tags, files, source, importance, content_hash,
           created_at, updated_at, last_accessed_at, access_count, deleted_at)
         VALUES ($project, $kind, $title, $body, $tags, $files, $source, $importance, $content_hash,
           $created_at, $updated_at, $last_accessed_at, $access_count, $deleted_at)
         ON CONFLICT DO NOTHING RETURNING id`,
      );
      for (const r of rows) {
        assertKind(r.kind);
        const { id: oldId, superseded_by, ...rest } = r;
        const res = insert.get({ ...rest, content_hash: hashOf(r.kind, r.title, r.body) }) as { id: number } | undefined;
        if (!res) {
          skipped++;
          continue;
        }
        imported++;
        idMap.set(oldId, res.id);
        if (superseded_by != null) pending.push([res.id, superseded_by]);
      }
      const link = this.db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?");
      for (const [newId, oldTarget] of pending) {
        const target = idMap.get(oldTarget);
        if (target) link.run(target, newId);
      }
    });
    return { imported, skipped };
  }

  /**
   * Every write goes through BEGIN IMMEDIATE: under WAL a deferred transaction that reads first
   * fails with SQLITE_BUSY_SNAPSHOT (not retried by busy_timeout) when another agent wrote meanwhile.
   */
  private write<T>(fn: () => T): T {
    return immediate(this.db, fn);
  }

  private row(id: number): Row | null {
    return (this.db.prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as Row | undefined) ?? null;
  }

  private touch(ids: number[], now: number) {
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?");
    this.write(() => ids.forEach((id) => stmt.run(now, id)));
  }
}

export type { Row as MemoryRow };
