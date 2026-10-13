// The ONLY place randomness lives (SPEC §4). Every seed is derived from state
// (session key, pulse index, layer, layout size), never from time, so the
// same Sim state always renders the same frame.

/** 32-bit integer mix of any number of ints (murmur3 finalizer per step). */
export function hash32(...xs: number[]): number {
  let h = 0x9e3779b9 | 0;
  for (const x of xs) {
    let k = Math.imul(x | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG → floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct integers from [0, n), in pick order. */
export function pickK(n: number, k: number, rng: () => number): number[] {
  k = Math.max(0, Math.min(k, n));
  const out: number[] = [];
  const seen = new Set<number>();
  while (out.length < k) {
    const v = Math.floor(rng() * n);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** m distinct indices from [0, nFilled), biased toward the most recent (highest) ones. */
export function pickRecent(nFilled: number, m: number, rng: () => number): number[] {
  m = Math.max(0, Math.min(m, nFilled));
  const out: number[] = [];
  const seen = new Set<number>();
  let guard = 0;
  while (out.length < m && guard++ < m * 20) {
    const idx = nFilled - 1 - Math.floor(nFilled * Math.pow(rng(), 2.2));
    if (idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}
