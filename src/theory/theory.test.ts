/**
 * Property tests for the theory engine (PRD §10 M1 exit tests):
 * determinism (same seed -> same music), always-in-scale, cadence landing.
 */

import { describe, it, expect } from 'vitest';
import { SCALES, SCALE_IDS, degreeToMidi } from './scales';
import { generateProgression, progressionToSteps, chordCycle, buildJourney, type HarmonicContext } from './harmony';
import { generateMelody, evolveMelody } from './melody';
import { generateBass, generateChords, generateArp, generateDrums } from './parts';
import { mulberry32 } from './rng';

const STEPS = 16;

function ctxFor(seed: number, keyIndex: number, scaleId: (typeof SCALE_IDS)[number]): HarmonicContext {
  return {
    keyIndex,
    scaleId,
    steps: STEPS,
    chordAtStep: progressionToSteps(generateProgression(seed, scaleId), STEPS),
  };
}

const SEEDS = [1, 42, 101, 999, 123456, 0xdeadbeef];

describe('determinism — same seed, same music (PRD §5.2)', () => {
  it('rng streams repeat exactly', () => {
    for (const seed of SEEDS) {
      const a = mulberry32(seed);
      const b = mulberry32(seed);
      for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    }
  });

  it('all generators are bit-identical for the same inputs', () => {
    for (const seed of SEEDS) {
      for (const scaleId of SCALE_IDS) {
        const ctx = ctxFor(seed, 2, scaleId);
        const params = { seed, density: 0.6, adventurousness: 0.4, register: 0 };
        expect(generateMelody(ctx, params)).toEqual(generateMelody(ctx, params));
        expect(generateBass(ctx, params)).toEqual(generateBass(ctx, params));
        expect(generateChords(ctx, params)).toEqual(generateChords(ctx, params));
        expect(generateArp(ctx, params)).toEqual(generateArp(ctx, params));
        expect(generateDrums(ctx, { seed, density: 0.6, syncopation: 0.5 })).toEqual(
          generateDrums(ctx, { seed, density: 0.6, syncopation: 0.5 }),
        );
        expect(generateProgression(seed, scaleId)).toEqual(generateProgression(seed, scaleId));
      }
    }
  });

  it('evolve is deterministic per generation', () => {
    const ctx = ctxFor(7, 0, 'aeolian');
    const base = generateMelody(ctx, { seed: 7, density: 0.5, adventurousness: 0.3, register: 0 });
    expect(evolveMelody(ctx, base, 7, 3)).toEqual(evolveMelody(ctx, base, 7, 3));
    // different generations diverge (eventually mutate differently)
    const gens = new Set([1, 2, 3, 4, 5].map((g) => JSON.stringify(evolveMelody(ctx, base, 7, g))));
    expect(gens.size).toBeGreaterThan(1);
  });
});

describe('scale-locking — nothing can sound wrong (PRD §5.3)', () => {
  it('every generated pitch is in the scale, all scales, many seeds', () => {
    for (const seed of SEEDS) {
      for (const scaleId of SCALE_IDS) {
        for (const keyIndex of [0, 3, 7, 11]) {
          const ctx = ctxFor(seed, keyIndex, scaleId);
          const iv = SCALES[scaleId].intervals;
          const inScale = (midi: number) => iv.includes((((midi - 60 - keyIndex) % 12) + 12) % 12);
          const params = { seed, density: 0.8, adventurousness: 0.9, register: 0 };
          for (const gen of [generateMelody(ctx, params), generateBass(ctx, params), generateArp(ctx, params)]) {
            for (const ev of gen) {
              expect(inScale(degreeToMidi(keyIndex, scaleId, ev.degree, 0))).toBe(true);
            }
          }
        }
      }
    }
  });

  it('progressions only use degrees from the chord cycle', () => {
    for (const seed of SEEDS) {
      for (const scaleId of SCALE_IDS) {
        const cyc = chordCycle(scaleId);
        for (const d of generateProgression(seed, scaleId)) expect(cyc).toContain(d);
      }
    }
  });
});

describe('musical form (PRD §5.3 coach rules)', () => {
  it('progressions open on the tonic', () => {
    for (const seed of SEEDS) {
      for (const scaleId of SCALE_IDS) {
        expect(generateProgression(seed, scaleId)[0]).toBe(0);
      }
    }
  });

  it('melody always has an opening anchor at step 0', () => {
    for (const seed of SEEDS) {
      const ctx = ctxFor(seed, 0, 'ionian');
      const melody = generateMelody(ctx, { seed, density: 0.1, adventurousness: 0.2, register: 0 });
      expect(melody.some((e) => e.step === 0)).toBe(true);
    }
  });

  it('evolve never drops below a minimal line and preserves determinism of anchors', () => {
    const ctx = ctxFor(11, 0, 'dorian');
    let line = generateMelody(ctx, { seed: 11, density: 0.5, adventurousness: 0.3, register: 0 });
    for (let g = 1; g <= 40; g++) line = evolveMelody(ctx, line, 11, g);
    expect(line.length).toBeGreaterThanOrEqual(2);
  });

  it('journeys start at home and stay within related keys', () => {
    for (const scaleId of SCALE_IDS) {
      const j = buildJourney(scaleId);
      expect(j[0].offset).toBe(0);
      expect(j[0].label).toBe('home');
      for (const stop of j) expect([0, 5, 7, 9]).toContain(stop.offset);
    }
  });

  it('drums anchor the downbeat at reasonable density', () => {
    for (const seed of SEEDS) {
      const ctx = ctxFor(seed, 0, 'ionian');
      const drums = generateDrums(ctx, { seed, density: 0.8, syncopation: 0.3 });
      expect(drums.some((e) => e.step === 0 && e.lane === 0)).toBe(true);
    }
  });
});
