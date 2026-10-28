import { type Embedder, embedderFromEnv } from "./embed.ts";
import type { MemoryStore } from "./store.ts";
import type { Memory, RecallInput, RememberInput, SemanticQuery, UpdateInput } from "./types.ts";

/** Memories embedded per request to the embedder. */
const BATCH = 32;
/** Backlog embedded inline by recall/remember; `mind reindex` (or `mind serve`) handles the rest. */
const INLINE_SYNC = 64;
/** After an embedder failure, stay keyword-only this long instead of waiting on a dead service every call. */
const RETRY_AFTER_MS = 30_000;
/** Measured: paraphrased duplicates score 0.88+ with bge-small and nomic, the nearest unrelated memory ~0.63. */
const NEAR_DUPLICATE = 0.85;

export interface RecallResult {
  memories: Memory[];
  /** False when no embedder is configured or it failed: results are keyword-only. */
  semantic: boolean;
}

export interface RememberResult {
  memory: Memory;
  duplicate: boolean;
  /** Existing memories in the same scope that say nearly the same thing: candidates for supersedes or forget. */
  similar: Memory[];
}

export interface SemanticStatus {
  model: string;
  embedded: number;
  total: number;
  error: string | null;
}

/** fetch() hides the useful part ("ECONNREFUSED") in the cause. */
export const describeError = (e: unknown): string =>
  e instanceof Error ? (e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message) : String(e);

/**
 * The store plus its optional semantic index. Embedding is best effort: when the embedder is unset or down,
 * every operation still works on keyword search, and the vectors catch up on a later sync.
 */
export class Mind {
  readonly store: MemoryStore;
  readonly embedder: Embedder | null;
  private retryAt = 0;
  private lastError: string | null = null;

  constructor(store: MemoryStore, embedder: Embedder | null = embedderFromEnv()) {
    this.store = store;
    this.embedder = embedder;
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const semantic = await this.semantic(async (e): Promise<SemanticQuery> => {
      await this.syncWith(e, INLINE_SYNC);
      const [vector] = await e.embed([input.query], "query");
      return { model: e.model, vector: vector!, minSimilarity: e.minSimilarity };
    });
    return { memories: this.store.recall(input, { semantic: semantic ?? undefined }), semantic: semantic !== null };
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const res = this.store.remember(input);
    if (res.duplicate) return { ...res, similar: [] };
    const similar = await this.semantic(async (e) => {
      await this.syncWith(e, INLINE_SYNC); // most recently updated first, so this embeds the new memory
      return this.store.similarTo(res.memory.id, e.model, NEAR_DUPLICATE);
    });
    return { ...res, similar: similar ?? [] };
  }

  async update(id: number, patch: UpdateInput): Promise<Memory> {
    const memory = this.store.update(id, patch);
    await this.semantic((e) => this.syncWith(e, INLINE_SYNC));
    return memory;
  }

  /**
   * Embed every memory whose vector is missing or stale. Throws when the embedder fails;
   * returns how many memories were embedded (0 without an embedder).
   */
  async sync({ force = false, onProgress }: { force?: boolean; onProgress?: (done: number) => void } = {}): Promise<number> {
    if (!this.embedder) return 0;
    if (force) {
      await this.embedder.embed(["ping"], "query"); // fail before dropping the index, not after
      this.store.clearEmbeddings();
    }
    return this.syncWith(this.embedder, Number.POSITIVE_INFINITY, onProgress);
  }

  /** The last embedder failure, cleared by the next success. */
  get error() {
    return this.lastError;
  }

  status(): SemanticStatus | null {
    return this.embedder && { model: this.embedder.model, ...this.store.embeddingCoverage(this.embedder.model), error: this.lastError };
  }

  private async syncWith(e: Embedder, limit: number, onProgress?: (done: number) => void) {
    let done = 0;
    while (done < limit) {
      const batch = this.store.staleEmbeddings(e.model, Math.min(BATCH, limit - done));
      if (!batch.length) break;
      const vectors = await e.embed(batch.map((b) => b.text), "document");
      const saved = this.store.saveEmbeddings(e.model, batch.map((b, i) => ({ ...b, vector: vectors[i]! })));
      if (!saved) break; // every row vanished meanwhile; don't spin
      done += saved;
      onProgress?.(done);
    }
    return done;
  }

  /** Run an embedder call; on failure note the error and fall back (null) to keyword-only for a while. */
  private async semantic<T>(fn: (e: Embedder) => Promise<T>): Promise<T | null> {
    if (!this.embedder || Date.now() < this.retryAt) return null;
    try {
      const res = await fn(this.embedder);
      this.lastError = null;
      return res;
    } catch (e) {
      this.lastError = describeError(e);
      this.retryAt = Date.now() + RETRY_AFTER_MS;
      return null;
    }
  }
}
