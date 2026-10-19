import { describe, it, expect } from 'vitest';
import { generateTheme, SHAPES, type Shape } from './motif';
import { buildContext, contextFromDegrees, type HarmonicContext } from './harmony';
import { SCALES, SCALE_IDS, degreeToMidi, type ScaleId } from './scales';
import { degreeSemis, scoreCandidates, withGlissando, type NoteEvent } from './melody';

function ctxFor(steps: number, scaleId: ScaleId = 'minor_pent', chordSeed = 202): HarmonicContext {
  return buildContext(0, scaleId, steps, chordSeed);
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

  it('Aseq is a real sequence: its strong beat never falls back onto the motif pitch', () => {
    let starts = 0;
    let same = 0;
    for (const scaleId of SCALE_IDS) {
      for (let seed = 1; seed <= 40; seed++) {
        const theme = generateTheme(ctxFor(16, scaleId, 1000 + seed * 7), { ...base, seed });
        const a = theme.find((e) => e.step === 0);
        const s = theme.find((e) => e.step === 4);
        if (!a || !s) continue;
        starts++;
        if (a.degree === s.degree) same++;
      }
    }
    expect(same / starts).toBeLessThanOrEqual(0.02);
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

describe('melody hotfixes: no climax fold, cadence exemption, semitone intervals', () => {
  const pitches = (ctx: HarmonicContext, theme: NoteEvent[]) => theme.map((e) => degreeToMidi(0, ctx.scaleId, e.degree));
  const sweep = (steps: number, scaleId: ScaleId, generation = 0) =>
    Array.from({ length: 40 }, (_, i) => {
      const seed = i + 1;
      const ctx = ctxFor(steps, scaleId, 1000 + seed * 7);
      const density = [0.2, 0.35, 0.55, 0.7, 0.9][seed % 5];
      const adventurousness = [0.1, 0.35, 0.6, 0.9][seed % 4];
      return { ctx, theme: generateTheme(ctx, { seed, density, adventurousness, generation }) };
    });
  const unresolvedTritones = (mel: number[]) =>
    mel.filter((m, i) => {
      if (i === 0 || Math.abs(m - mel[i - 1]) % 12 !== 6) return false;
      const move = mel[i + 1] - m;
      return !(i + 1 < mel.length && Math.sign(move) === -Math.sign(m - mel[i - 1]) && Math.abs(move) >= 1 && Math.abs(move) <= 2);
    }).length;

  it('no drones: never three identical pitches in a row, and no theme parks on one pitch', () => {
    for (const steps of [16, 32]) {
      const shares: number[] = [];
      for (const scaleId of SCALE_IDS) {
        for (const { ctx, theme } of sweep(steps, scaleId)) {
          const mel = pitches(ctx, theme);
          for (let i = 2; i < mel.length; i++) expect(mel[i] === mel[i - 1] && mel[i] === mel[i - 2]).toBe(false);
          const counts = new Map<number, number>();
          for (const m of mel) counts.set(m, (counts.get(m) ?? 0) + 1);
          shares.push(Math.max(...counts.values()) / mel.length);
        }
      }
      expect(shares.reduce((a, b) => a + b, 0) / shares.length).toBeLessThanOrEqual(0.35);
      expect(shares.filter((s) => s >= 0.5).length / shares.length).toBeLessThanOrEqual(0.05);
    }
  });

  it('cadences are exempt from the climax: always home on the tonic, and the 32-step half cadence on ^5', () => {
    for (const steps of [16, 32]) {
      for (const scaleId of SCALE_IDS) {
        for (const { ctx, theme } of sweep(steps, scaleId)) {
          const mel = pitches(ctx, theme);
          expect(mel[mel.length - 1] % 12).toBe(0);
          expect(theme[theme.length - 1].lengthSteps).toBeGreaterThanOrEqual(2);
          if (steps === 32) {
            const half = theme.filter((e) => e.step >= 12 && e.step < 16).pop()!;
            expect(degreeToMidi(0, scaleId, half.degree) % 12).toBe(7);
          }
        }
      }
    }
  });

  it('one climax, in the contrast cell: no note outside it reaches the peak', () => {
    for (const steps of [16, 32]) {
      const climaxCell = steps === 16 ? 2 : 6;
      for (const scaleId of SCALE_IDS) {
        for (const { theme } of sweep(steps, scaleId)) {
          const peak = Math.max(...theme.map((e) => e.degree));
          for (const e of theme) if (Math.floor(e.step / 4) !== climaxCell) expect(e.degree).toBeLessThan(peak);
        }
      }
    }
  });

  it('every melodic tritone resolves inward by step, in every mode and through evolve generations', () => {
    for (const steps of [16, 32]) {
      for (const scaleId of SCALE_IDS) {
        for (const generation of [0, 1, 3]) {
          for (const { ctx, theme } of sweep(steps, scaleId, generation)) expect(unresolvedTritones(pitches(ctx, theme))).toBe(0);
        }
      }
    }
  });

  it('the 32-step consequent restates the motif at its own pitch', () => {
    let same = 0;
    let n = 0;
    for (const scaleId of SCALE_IDS) {
      for (const { theme } of sweep(32, scaleId)) {
        const cell = (c: number) => theme.filter((e) => Math.floor(e.step / 4) === c).map((e) => e.degree).join(',');
        n++;
        if (cell(4) === cell(0)) same++;
      }
    }
    expect(same / n).toBeGreaterThanOrEqual(0.9);
  });

  it('velocity follows the contour: the peak is the single loudest note, the cadence tapers', () => {
    for (const { theme } of sweep(16, 'minor_pent')) {
      const peak = Math.max(...theme.map((e) => e.degree));
      const top = theme.find((e) => e.degree === peak && Math.floor(e.step / 4) === 2)!;
      expect(top.velocity).toBe(1);
      for (const e of theme) if (e !== top) expect(e.velocity).toBeLessThan(1);
      for (const e of theme.filter((x) => x.step >= 12)) expect(e.velocity).toBeLessThanOrEqual(0.82);
    }
  });

  it('the coach measures intervals in semitones: a tritone leap scores below an equally-placed 6th', () => {
    // lydian over the II chord (D F# A): from C, F# (tritone) and A (major 6th) are both chord-tone leaps
    const ctx = contextFromDegrees(0, 'lydian', 16, [1]);
    const score = new Map(scoreCandidates(ctx, 5, 0, null, 0.35));
    expect(score.get(3)!).toBeLessThan(score.get(5)!);
  });

  it('the distinct last beats vary across seeds (no single cadence formula)', () => {
    const ctx = ctxFor(16, 'minor_pent', 202);
    const endings = new Set(
      [1, 7, 42, 999, 12345, 101, 2024, 31337].map((seed) =>
        generateTheme(ctx, { ...base, seed })
          .filter((e) => e.step >= 12)
          .map((e) => `${e.step}:${e.degree}`)
          .join(' '),
      ),
    );
    expect(endings.size).toBeGreaterThanOrEqual(3);
  });

  it('8 steps keeps one climax: the A cell peaks once and the cadence fits under it', () => {
    for (const scaleId of SCALE_IDS) {
      for (const density of [0, 0.2, 0.55, 0.9, 1]) {
        for (let seed = 1; seed <= 40; seed++) {
          const ctx = ctxFor(8, scaleId, 1000 + seed * 7);
          const theme = generateTheme(ctx, { seed, density, adventurousness: 0.35 });
          const mel = pitches(ctx, theme);
          const peak = Math.max(...mel);
          expect(mel.filter((m) => m === peak).length).toBe(1);
          mel.forEach((m, i) => { if (theme[i].step >= 4) expect(m).toBeLessThan(peak); });
          expect(mel[mel.length - 1] % 12).toBe(0);
        }
      }
    }
  });

  it('a one-note rhythm cell (density 0) still does not park half the theme on one pitch', () => {
    for (const steps of [16, 32]) {
      let parked = 0;
      let n = 0;
      for (const scaleId of SCALE_IDS) {
        for (const adventurousness of [0, 0.35, 0.9]) {
          for (let seed = 1; seed <= 40; seed++) {
            const ctx = ctxFor(steps, scaleId, 1000 + seed * 7);
            const mel = pitches(ctx, generateTheme(ctx, { seed, density: 0, adventurousness }));
            const counts = new Map<number, number>();
            for (const m of mel) counts.set(m, (counts.get(m) ?? 0) + 1);
            n++;
            if (Math.max(...counts.values()) * 2 >= mel.length) parked++;
          }
        }
      }
      expect(parked / n).toBeLessThanOrEqual(0.05);
    }
  });

  it('glissando grace notes run strictly inside the leap (pentatonic 4ths never re-strike the origin)', () => {
    let graces = 0;
    for (const scaleId of SCALE_IDS) {
      for (const steps of [16, 32]) {
        for (const { theme } of sweep(steps, scaleId)) {
          const notes = [...theme].sort((a, b) => a.step - b.step);
          const out = withGlissando(notes, scaleId);
          const orig = new Set(notes);
          expect(out.filter((e) => orig.has(e)).length).toBe(notes.length);
          for (const g of out.filter((e) => !orig.has(e))) {
            graces++;
            const prev = notes.filter((e) => e.step < g.step).pop()!;
            const next = notes.find((e) => e.step > g.step)!;
            expect(Math.abs(degreeSemis(scaleId, next.degree) - degreeSemis(scaleId, prev.degree))).toBeGreaterThanOrEqual(5);
            expect(g.degree).toBeGreaterThan(Math.min(prev.degree, next.degree));
            expect(g.degree).toBeLessThan(Math.max(prev.degree, next.degree));
          }
        }
      }
    }
    expect(graces).toBeGreaterThan(0);
    // C -> F in minor pentatonic is a 4th of two degrees: exactly one grace, on Eb
    const leap = withGlissando([{ step: 0, degree: 0, velocity: 0.9, lengthSteps: 1 }, { step: 4, degree: 2, velocity: 0.9, lengthSteps: 1 }], 'minor_pent');
    expect(leap.map((e) => e.degree)).toEqual([0, 1, 2]);
  });
});
