import type { Embedder } from "../src/core/embed.ts";
import { normalize } from "../src/core/vectors.ts";

// Words in one group share a dimension, so they "mean" the same thing; any other word lands in a hashed dimension.
const CONCEPTS = [
  ["auth", "authentication", "login", "jwt", "token", "tokens", "session", "sessions"],
  ["deploy", "deploying", "aws", "ec2", "server", "ship"],
  ["database", "sqlite", "postgres", "db", "locked"],
];
const HASHED = 64;

export const fakeEmbedder = (model = "fake-v1", { fail = false } = {}) => {
  const e = {
    model,
    minSimilarity: 0.5,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      if (fail) throw new Error("embedder down");
      return texts.map((t) => {
        const v = new Float32Array(CONCEPTS.length + HASHED);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const c = CONCEPTS.findIndex((ws) => ws.includes(w));
          if (c >= 0) v[c]! += 1;
          else v[CONCEPTS.length + ([...w].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7) % HASHED)]! += 0.3;
        }
        return normalize(v);
      });
    },
  } satisfies Embedder & { calls: number };
  return e;
};
