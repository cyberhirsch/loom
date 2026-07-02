/** Deterministic seeded PRNG (mulberry32). Same seed -> same music (PRD §5.2). */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Weighted pick: entries of [item, weight]. */
export function pickWeighted<T>(rng: Rng, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [item, w] of entries) {
    roll -= w;
    if (roll <= 0) return item;
  }
  return entries[entries.length - 1][0];
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
