import { MindError } from "./types.ts";
import { normalize } from "./vectors.ts";

export type EmbedMode = "query" | "document";

export interface Embedder {
  /** Names the vector space: stored vectors are only compared with queries embedded by the same model. */
  readonly model: string;
  /** Cosine similarity below which a memory doesn't count as a semantic match for a query. */
  readonly minSimilarity: number;
  /** Unit-length vectors, one per text. */
  embed(texts: string[], mode: EmbedMode): Promise<Float32Array[]>;
}

export const DEFAULT_MODEL = "BAAI/bge-small-en-v1.5";

interface ModelProfile {
  queryPrefix: string;
  documentPrefix: string;
  minSimilarity: number;
}

const BASE_PROFILE: ModelProfile = { queryPrefix: "", documentPrefix: "", minSimilarity: 0.5 };

// Retrieval models trained with asymmetric prompts expect them on each side. Similarity floors were measured
// on short memories: unrelated pairs sit around 0.45 for both bge-small and nomic, relevant ones above 0.57.
const PROFILES: [RegExp, Partial<ModelProfile>][] = [
  [/bge-.*-en/i, { queryPrefix: "Represent this sentence for searching relevant passages: ", minSimilarity: 0.55 }],
  [/nomic-embed-text/i, { queryPrefix: "search_query: ", documentPrefix: "search_document: ", minSimilarity: 0.52 }],
  [/(^|[/-])e5-/i, { queryPrefix: "query: ", documentPrefix: "passage: " }],
];

export const profileFor = (model: string): ModelProfile => ({
  ...BASE_PROFILE,
  ...PROFILES.find(([re]) => re.test(model))?.[1],
});

/** The text a memory is embedded as. Tags stay keyword-only, so the vector tracks memories.content_hash. */
export const embeddingText = (m: { title: string; body: string }) => (m.body ? `${m.title}\n\n${m.body}` : m.title);

export interface HttpEmbedderOptions extends Partial<ModelProfile> {
  /** Base URL of an OpenAI-compatible API, e.g. http://localhost:8089/v1 (TEI) or http://localhost:11434/v1 (Ollama). */
  url: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Texts per request (TEI accepts 32 by default). */
  batchSize?: number;
}

/** Client for any server implementing POST /embeddings from the OpenAI API: TEI, Ollama, llama.cpp, vLLM, OpenAI. */
export const httpEmbedder = ({ url, model = DEFAULT_MODEL, apiKey, timeoutMs = 10_000, batchSize = 32, ...overrides }: HttpEmbedderOptions): Embedder => {
  const endpoint = `${url.replace(/\/+$/, "")}/embeddings`;
  const profile = { ...profileFor(model), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };

  const request = async (input: string[]) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new MindError(`embedder ${endpoint} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { data } = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    if (data?.length !== input.length) throw new MindError(`embedder returned ${data?.length ?? 0} vectors for ${input.length} texts`);
    return data.toSorted((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
  };

  return {
    model,
    minSimilarity: profile.minSimilarity,
    async embed(texts, mode) {
      const prefix = mode === "query" ? profile.queryPrefix : profile.documentPrefix;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) out.push(...(await request(texts.slice(i, i + batchSize).map((t) => prefix + t))));
      return out;
    },
  };
};

const num = (v: string | undefined) => (v ? Number(v) : undefined);

/** The embedder configured by MIND_EMBED_* variables, or null (keyword search only) when MIND_EMBED_URL is unset. */
export const embedderFromEnv = (env = process.env): Embedder | null =>
  env.MIND_EMBED_URL
    ? httpEmbedder({
        url: env.MIND_EMBED_URL,
        model: env.MIND_EMBED_MODEL || undefined,
        apiKey: env.MIND_EMBED_API_KEY || undefined,
        timeoutMs: num(env.MIND_EMBED_TIMEOUT_MS),
        minSimilarity: num(env.MIND_EMBED_MIN_SIMILARITY),
        queryPrefix: env.MIND_EMBED_QUERY_PREFIX,
        documentPrefix: env.MIND_EMBED_DOCUMENT_PREFIX,
      })
    : null;
