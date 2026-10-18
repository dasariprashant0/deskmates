// cyrb53 core, generic over a sequence of 0..65535 units so strings and pixel bytes share one hash.
const core = (len: number, at: (i: number) => number, seed: number): number => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < len; i++) {
    const ch = at(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** 53-bit string hash. */
export const cyrb53 = (s: string, seed = 0): number => core(s.length, (i) => s.charCodeAt(i), seed)

/** Same hash over bytes (internal, used by hashSheet). */
export const hashBytes = (b: ArrayLike<number>, seed = 0): number => core(b.length, (i) => b[i] ?? 0, seed)

/** Small fast seeded PRNG returning floats in [0,1). */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
