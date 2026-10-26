/** Scale to unit length, so cosine similarity is a plain dot product. */
export const normalize = (v: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(v);
  const norm = Math.hypot(...out);
  return norm ? out.map((x) => x / norm) : out;
};

/** Dot product; vectors of different dimensions (another model) never match. */
export const dot = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

export const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** A view on the BLOB's bytes; copied only when misaligned (node:sqlite gives each BLOB its own buffer, so rarely). */
export const fromBlob = (b: Uint8Array) =>
  b.byteOffset % 4 === 0
    ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
    : new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
