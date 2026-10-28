export const KINDS = ["fact", "decision", "preference", "gotcha", "howto", "episode"] as const;
export type Kind = (typeof KINDS)[number];

export class MindError extends Error {}

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
  /** Recall ranking score, or cosine similarity for near-duplicate hints. */
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

/** An embedded query: the vector plus the model it belongs to (vectors from other models are never compared). */
export interface SemanticQuery {
  model: string;
  vector: Float32Array;
  /** Cosine similarity below which a memory doesn't count as a semantic match. */
  minSimilarity: number;
}

// A type alias, not an interface, so node:sqlite's untyped rows (Record<string, SQLOutputValue>) can be cast to it.
export type MemoryRow = {
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
