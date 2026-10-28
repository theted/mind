import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { immediate } from "./db.ts";
import { embeddingText } from "./embed.ts";
import { normalizeProject } from "./project.ts";
import { type KeywordHit, rank, type SemanticHit } from "./rank.ts";
import {
  KINDS,
  type Kind,
  type ListInput,
  type Memory,
  MindError,
  type MemoryRow as Row,
  type RecallInput,
  type RememberInput,
  type SemanticQuery,
  type UpdateInput,
} from "./types.ts";
import { dot, fromBlob, toBlob } from "./vectors.ts";

type Params = Record<string, SQLInputValue>;

/** Candidates pulled from each retriever before re-ranking. */
const CANDIDATES = 200;

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

// Function words dropped from keyword queries: OR-joined, "how do we deploy" would otherwise match every memory
// containing "we". Natural-language questions are what the semantic pass is for.
const STOP_WORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your".split(" "),
);

/**
 * Turn free text into a safe FTS5 query: every token quoted (so operators and
 * punctuation can't break the syntax), OR-joined so partial matches still rank.
 * A trailing `*` on a token keeps prefix matching. Stop words are dropped unless
 * the query has nothing else.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((raw) => ({ tok: raw.replace(/["*]/g, "").trim(), prefix: raw.endsWith("*") }))
    .filter(({ tok }) => tok);
  const content = terms.filter(({ tok, prefix }) => prefix || !STOP_WORDS.has(tok.toLowerCase()));
  const use = content.length ? content : terms;
  return use.length ? use.map(({ tok, prefix }) => `"${tok}"${prefix ? "*" : ""}`).join(" OR ") : null;
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

  /**
   * Keyword search (FTS5/BM25), plus a semantic pass when given an embedded query, re-ranked by
   * project, importance and recency. Both passes apply the same filters.
   */
  recall(input: RecallInput, { semantic, now = Date.now() }: { semantic?: SemanticQuery; now?: number } = {}): Memory[] {
    const fts = toFtsQuery(input.query);
    if (!fts && !semantic) return [];
    const restrict = input.project !== undefined;
    const project = normalizeProject(restrict ? input.project : input.boostProject);
    if (input.kind) assertKind(input.kind);

    const where = ["m.deleted_at IS NULL"];
    const params: Params = {};
    if (!input.includeSuperseded) where.push("m.superseded_by IS NULL");
    if (input.kind) {
      where.push("m.kind = $kind");
      params.kind = input.kind;
    }
    if (restrict) {
      where.push(project ? "(m.project = $project OR m.project IS NULL)" : "m.project IS NULL");
      if (project) params.project = project;
    }

    const keyword = fts ? this.keywordHits(fts, where, params) : [];
    const ranked = rank(keyword, semantic ? this.semanticHits(semantic, where, params) : null, {
      project,
      now,
      limit: input.limit ?? 10,
    });
    this.touch(ranked.map((s) => s.row.id), now);
    return ranked.map((s) => toMemory(s.row, s.score));
  }

  private keywordHits(fts: string, where: string[], params: Params): KeywordHit[] {
    return this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 4.0, 1.0, 2.0) AS rank
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH $fts AND ${where.join(" AND ")}
         ORDER BY rank LIMIT ${CANDIDATES}`,
      )
      .all({ ...params, fts }) as KeywordHit[];
  }

  /**
   * Exhaustive cosine scan over id + vector only (whole rows are loaded for the best candidates).
   * Measured at about 6 ms per 1,000 memories, so no ANN index is needed at personal scale.
   */
  private semanticHits(q: SemanticQuery, where: string[], params: Params): SemanticHit[] {
    const scored = (
      this.db
        .prepare(
          `SELECT m.id, v.vector FROM memory_vectors v JOIN memories m ON m.id = v.memory_id
           WHERE v.model = $model AND v.content_hash = m.content_hash AND ${where.join(" AND ")}`,
        )
        .all({ ...params, model: q.model }) as { id: number; vector: Uint8Array }[]
    )
      .map(({ id, vector }) => ({ id, similarity: dot(q.vector, fromBlob(vector)) }))
      .filter((h) => h.similarity >= q.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, CANDIDATES);
    const rows = new Map(
      (
        this.db
          .prepare("SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(scored.map((h) => h.id))) as Row[]
      ).map((r) => [r.id, r]),
    );
    return scored.map((h) => ({ row: rows.get(h.id)!, similarity: h.similarity }));
  }

  /** Memories without a current vector for `model` (new, edited, or embedded by another model), most recent first. */
  staleEmbeddings(model: string, limit: number): { id: number; hash: string; text: string }[] {
    return (
      this.db
        .prepare(
          `SELECT m.id, m.content_hash, m.title, m.body FROM memories m
           LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = $model AND v.content_hash = m.content_hash
           WHERE m.deleted_at IS NULL AND v.memory_id IS NULL
           ORDER BY m.updated_at DESC LIMIT $limit`,
        )
        .all({ model, limit }) as Pick<Row, "id" | "content_hash" | "title" | "body">[]
    ).map((r) => ({ id: r.id, hash: r.content_hash, text: embeddingText(r) }));
  }

  /**
   * Store vectors computed for `staleEmbeddings()` rows. `hash` is the content they were computed from, so a memory
   * edited meanwhile stays stale. Returns how many were saved (memories deleted meanwhile are skipped).
   */
  saveEmbeddings(model: string, items: { id: number; hash: string; vector: Float32Array }[]): number {
    const upsert = this.db.prepare(
      `INSERT INTO memory_vectors (memory_id, model, content_hash, vector)
       SELECT $id, $model, $hash, $vector WHERE EXISTS (SELECT 1 FROM memories WHERE id = $id)
       ON CONFLICT (memory_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, vector = excluded.vector`,
    );
    return this.write(() =>
      items.reduce((n, { id, hash, vector }) => n + Number(upsert.run({ id, model, hash, vector: toBlob(vector) }).changes), 0),
    );
  }

  /** Drop stored vectors so the next sync re-embeds everything. */
  clearEmbeddings() {
    this.write(() => this.db.exec("DELETE FROM memory_vectors"));
  }

  /** Live memories in the same scope (its project + global) whose current vector is close to memory `id`'s. */
  similarTo(id: number, model: string, minSimilarity: number, limit = 3): Memory[] {
    const self = this.db
      .prepare(
        `SELECT m.project, v.vector FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
         WHERE m.id = ? AND v.model = ? AND v.content_hash = m.content_hash`,
      )
      .get(id, model) as { project: string | null; vector: Uint8Array } | undefined;
    if (!self) return [];
    const where = ["m.deleted_at IS NULL", "m.superseded_by IS NULL", "m.id != $id"];
    where.push(self.project === null ? "m.project IS NULL" : "(m.project = $project OR m.project IS NULL)");
    return this.semanticHits(
      { model, vector: fromBlob(self.vector), minSimilarity },
      where,
      self.project === null ? { id } : { id, project: self.project },
    )
      .slice(0, limit)
      .map((h) => toMemory(h.row, h.similarity));
  }

  /** How many live memories have a current vector for `model`. */
  embeddingCoverage(model: string): { embedded: number; total: number } {
    const { embedded, total } = this.db
      .prepare(
        `SELECT count(v.memory_id) AS embedded, count(*) AS total FROM memories m
         LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ? AND v.content_hash = m.content_hash
         WHERE m.deleted_at IS NULL AND m.superseded_by IS NULL`,
      )
      .get(model) as { embedded: number; total: number };
    return { embedded, total };
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

