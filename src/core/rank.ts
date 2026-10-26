import type { MemoryRow } from "./types.ts";

const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 120;
// Reciprocal rank fusion constant. The usual 60 flattens the top ranks so much that the project/importance/recency
// boosts below would decide the order on their own; at 10 a 1.5x project boost lifts a result about four places near the top.
const RRF_K = 10;

export type KeywordHit = MemoryRow & { rank: number };
export interface SemanticHit {
  row: MemoryRow;
  similarity: number;
}

interface RankContext {
  /** Project whose memories rank higher (global ranks between it and other projects). */
  project: string | null;
  now: number;
  limit: number;
}

/** Context multiplier: current project, then global; important and recently updated memories first. */
const boost = (r: MemoryRow, { project, now }: RankContext) => {
  const projectBoost = project && r.project === project ? 1.5 : r.project === null ? 1.2 : 1.0;
  const importanceBoost = 0.6 + 0.2 * r.importance;
  const ageDays = (now - r.updated_at) / DAY_MS;
  const recencyBoost = 0.6 + 0.4 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return projectBoost * importanceBoost * recencyBoost;
};

/**
 * Merge keyword (BM25, best first) and semantic (cosine, best first) candidates into one ranking.
 * Without a semantic list the relevance is BM25 itself; with one, the two rankings are fused by
 * reciprocal rank, so a memory both retrievers agree on beats one that only one of them found.
 */
export function rank(keyword: KeywordHit[], semantic: SemanticHit[] | null, ctx: RankContext) {
  const relevance = new Map<number, { row: MemoryRow; score: number }>();
  const add = (row: MemoryRow, score: number) =>
    relevance.set(row.id, { row, score: (relevance.get(row.id)?.score ?? 0) + score });

  if (semantic) {
    const rrf = (i: number) => 1 / (RRF_K + i + 1);
    keyword.forEach((r, i) => add(r, rrf(i)));
    semantic.forEach((s, i) => add(s.row, rrf(i)));
  } else keyword.forEach((r) => add(r, -r.rank)); // bm25 is negative; more negative = better

  return [...relevance.values()]
    .map(({ row, score }) => ({ row, score: score * boost(row, ctx) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, ctx.limit);
}
