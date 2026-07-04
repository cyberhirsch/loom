import { describe, it, expect } from 'vitest';
import { generateTheme, SHAPES, type Shape } from './motif';
import { generateProgression, progressionToSteps, type HarmonicContext } from './harmony';
import { SCALES, type ScaleId } from './scales';

function ctxFor(steps: number, scaleId: ScaleId = 'minor_pent', chordSeed = 202): HarmonicContext {
  return {
    keyIndex: 0,
    scaleId,
    steps,
    chordAtStep: progressionToSteps(generateProgression(chordSeed, scaleId), steps),
  };
}

const base = { seed: 101, density: 0.55, adventurousness: 0.35 };

describe('theme grammar (motif + sentence + audition)', () => {
  it('is deterministic: same params, same theme — bit-exact', () => {
    for (const steps of [8, 16, 32]) {
      const ctx = ctxFor(steps);
      expect(generateTheme(ctx, base)).toEqual(generateTheme(ctx, base));
    }
  });

  it('every note is a valid scale degree and inside the loop, for all scales/shapes/lengths', () => {
    for (const scaleId of Object.keys(SCALES) as ScaleId[]) {
      for (const shape of SHAPES) {
        for (const steps of [8, 16, 32]) {
          const ctx = ctxFor(steps, scaleId);
          const theme = generateTheme(ctx, { ...base, shape });
          expect(theme.length).toBeGreaterThan(2);
          for (const e of theme) {
            expect(e.step).toBeGreaterThanOrEqual(0);
            expect(e.step).toBeLessThan(steps);
            expect(Number.isInteger(e.degree)).toBe(true);
            expect(e.degree).toBeGreaterThanOrEqual(0);
            expect(e.lengthSteps).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  it('the motif recurs: the opening rhythm cell appears at least twice (16/32 steps)', () => {
    for (const steps of [16, 32]) {
      for (const seed of [101, 42, 7, 999]) {
        const ctx = ctxFor(steps);
        const theme = generateTheme(ctx, { ...base, seed });
        const cellPattern = (c: number) =>
          theme
            .filter((e) => Math.floor(e.step / 4) === c)
            .map((e) => e.step % 4)
            .sort((a, b) => a - b)
            .join(',');
        const first = cellPattern(0);
        const matches = Array.from({ length: steps / 4 }, (_, c) => cellPattern(c)).filter((p) => p === first);
        expect(matches.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('ends home: the final note is a tonic, held longer than a single step', () => {
    for (const seed of [101, 42, 7]) {
      const ctx = ctxFor(16);
      const theme = generateTheme(ctx, { ...base, seed });
      const lastNote = theme[theme.length - 1];
      const scaleLen = SCALES[ctx.scaleId].intervals.length;
      expect(lastNote.degree % scaleLen).toBe(0);
      expect(lastNote.lengthSteps).toBeGreaterThanOrEqual(2);
    }
  });

  it('has one climax: the highest degree occurs exactly once', () => {
    for (const seed of [101, 42, 999]) {
      const theme = generateTheme(ctxFor(16), { ...base, seed });
      const max = Math.max(...theme.map((e) => e.degree));
      expect(theme.filter((e) => e.degree === max)).toHaveLength(1);
    }
  });

  it('32 steps builds a question/answer: a half-cadence held note near the midpoint', () => {
    const ctx = ctxFor(32);
    const theme = generateTheme(ctx, base);
    const midHold = theme.find((e) => e.step >= 12 && e.step < 16 && e.lengthSteps >= 2);
    expect(midHold).toBeDefined();
    // and the motif from the first half returns in the second half
    const cellPattern = (c: number) =>
      theme.filter((e) => Math.floor(e.step / 4) === c).map((e) => e.step % 4).join(',');
    expect(cellPattern(4)).toBe(cellPattern(0));
  });

  it('the idea is separable from the take: same ideaSeed keeps the rhythm cell across take seeds', () => {
    const ctx = ctxFor(16);
    const a = generateTheme(ctx, { ...base, seed: 1, ideaSeed: 500, shape: 'arch' });
    const b = generateTheme(ctx, { ...base, seed: 2, ideaSeed: 500, shape: 'arch' });
    const cell = (theme: typeof a) =>
      theme.filter((e) => e.step < 4).map((e) => `${e.step}:${e.degree}`).join(' ');
    expect(cell(a)).toBe(cell(b)); // the motif itself is identical
  });

  it('generations vary the theme but preserve the motif statement and determinism', () => {
    const ctx = ctxFor(16);
    const gen0 = generateTheme(ctx, base);
    const gen3 = generateTheme(ctx, { ...base, generation: 3 });
    expect(generateTheme(ctx, { ...base, generation: 3 })).toEqual(gen3);
    expect(gen3).not.toEqual(gen0);
    // anchors survive: still ends on a tonic
    const scaleLen = SCALES[ctx.scaleId].intervals.length;
    expect(gen3[gen3.length - 1].degree % scaleLen).toBe(0);
  });

  it('shapes steer the contour: rise carries its height later than fall', () => {
    // the single climax lands in the climax cell for every shape (by rule), so
    // compare the degree-weighted step centroid: rising themes are back-loaded
    const ctx = ctxFor(16);
    const centroid = (shape: Shape) => {
      let num = 0;
      let den = 0;
      for (const seed of [101, 42, 7, 999, 12345]) {
        const theme = generateTheme(ctx, { ...base, seed, shape });
        for (const e of theme) {
          num += e.step * e.degree;
          den += e.degree;
        }
      }
      return num / Math.max(1, den);
    };
    expect(centroid('rise')).toBeGreaterThan(centroid('fall'));
  });
});
