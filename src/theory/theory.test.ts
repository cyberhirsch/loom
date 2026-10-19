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

});

describe('groove skeleton and bass foundation', () => {
  const MANY = Array.from({ length: 150 }, (_, i) => i * 7919 + 1);
  const DENSITIES = [0.2, 0.3, 0.45, 0.6, 0.8, 1];
  const ctxSteps = (seed: number, scaleId: (typeof SCALE_IDS)[number], steps: number): HarmonicContext => ({
    keyIndex: 0,
    scaleId,
    steps,
    chordAtStep: progressionToSteps(generateProgression(seed, scaleId), steps),
  });
  const changes = (ctx: HarmonicContext) =>
    ctx.chordAtStep.map((_, s) => s).filter((s) => s === 0 || ctx.chordAtStep[s] !== ctx.chordAtStep[s - 1]);

  it('kick on 1 and snare on 2 & 4 in every bar, every seed, every density from 0.2; never a snare on 1', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      for (const steps of [16, 32]) {
        const ctx = ctxSteps(seed, 'ionian', steps);
        for (const density of DENSITIES) {
          for (const syncopation of [0, 0.5, 1]) {
            const hits = new Set(generateDrums(ctx, { seed, density, syncopation }).map((e) => `${e.step}:${e.lane}`));
            for (let bar = 0; bar < steps; bar += 16) {
              if (!hits.has(`${bar}:0`) || !hits.has(`${bar + 4}:1`) || !hits.has(`${bar + 12}:1`) || hits.has(`${bar}:1`))
                bad.push(`seed ${seed} d${density} sync${syncopation} bar@${bar}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('below density 0.2 nothing outlives the skeleton: any hit in a bar means kick on 1 and both backbeats', () => {
    const bad: string[] = [];
    let barsOn = 0;
    for (const seed of MANY) {
      for (const steps of [8, 16, 32]) {
        const ctx = ctxSteps(seed, 'ionian', steps);
        for (const density of [0, 0.05, 0.1, 0.15]) {
          for (const syncopation of [0, 1]) {
            const drums = generateDrums(ctx, { seed, density, syncopation });
            if (density === 0 && drums.length) bad.push(`seed ${seed} d0 not silent`);
            const hits = new Set(drums.map((e) => `${e.step}:${e.lane}`));
            for (let bar = 0; bar < steps; bar += 16) {
              const inBar = drums.filter((e) => e.step >= bar && e.step < bar + 16);
              if (!inBar.length) continue;
              barsOn++;
              const backbeats = [4, 12].filter((p) => bar + p < steps);
              if (!hits.has(`${bar}:0`) || backbeats.some((p) => !hits.has(`${bar + p}:1`)))
                bad.push(`seed ${seed} ${steps} d${density} sync${syncopation} bar@${bar}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(barsOn).toBeGreaterThan(0);
  });

  it('bass stays inside its range, approach tones included, and articulation 0 still sounds', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      for (const scaleId of SCALE_IDS) {
        for (const steps of [8, 16, 32]) {
          const ctx = ctxSteps(seed, scaleId, steps);
          const kickSteps = generateDrums(ctx, { seed, density: 0.6, syncopation: 0.4 }).filter((e) => e.lane === 0).map((e) => e.step);
          for (const density of [0.2, 0.6, 1]) {
            for (const e of generateBass(ctx, { seed, density, register: 0, kickSteps, articulation: 0 })) {
              const semis = degreeToMidi(0, scaleId, e.degree, -2) - degreeToMidi(0, scaleId, 0, -2);
              if (semis < -5 || semis > 12) bad.push(`seed ${seed} ${scaleId} ${steps} d${density} @${e.step} ${semis}`);
              if (!(e.lengthSteps > 0)) bad.push(`seed ${seed} ${scaleId} ${steps} d${density} @${e.step} len ${e.lengthSteps}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('drum patterns nest: raising density only adds hits, velocities unchanged', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      const ctx = ctxSteps(seed, 'dorian', 16);
      for (let i = 1; i < DENSITIES.length; i++) {
        const key = (e: { step: number; lane: number; velocity: number }) => `${e.step}:${e.lane}:${e.velocity}`;
        const hi = new Set(generateDrums(ctx, { seed, density: DENSITIES[i], syncopation: 0.4 }).map(key));
        for (const e of generateDrums(ctx, { seed, density: DENSITIES[i - 1], syncopation: 0.4 })) if (!hi.has(key(e))) bad.push(`seed ${seed} ${key(e)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('ghost snares are quiet and only on the e/a around the backbeats', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      const drums = generateDrums(ctxSteps(seed, 'ionian', 16), { seed, density: 1, syncopation: 0 });
      for (const e of drums.filter((d) => d.lane === 1 && d.step !== 4 && d.step !== 12)) {
        if (![3, 7, 9, 15].includes(e.step) || e.velocity < 0.2 || e.velocity > 0.3) bad.push(`seed ${seed} step ${e.step} v${e.velocity}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('chords strike every change and never ring past the next change or the next strike', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      for (const scaleId of SCALE_IDS) {
        for (const steps of [16, 32]) {
          const ctx = ctxSteps(seed, scaleId, steps);
          const cs = changes(ctx);
          for (const density of DENSITIES) {
            const chords = generateChords(ctx, { seed, density, register: 0 });
            const at = new Set(chords.map((e) => e.step));
            for (const c of cs) if (!at.has(c)) bad.push(`seed ${seed} ${scaleId} no chord @${c}`);
            chords.forEach((e, i) => {
              const end = Math.min(cs.find((c) => c > e.step) ?? steps, chords[i + 1]?.step ?? steps);
              if (e.step + e.lengthSteps > end) bad.push(`seed ${seed} ${scaleId} chord @${e.step} rings past ${end}`);
            });
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('bass plays the chord root on step 0 and every change, leaps at most an octave (wrap included), nests across density', () => {
    const bad: string[] = [];
    for (const seed of MANY) {
      for (const scaleId of SCALE_IDS) {
        for (const steps of [16, 32]) {
          const ctx = ctxSteps(seed, scaleId, steps);
          const cs = changes(ctx);
          const kickSteps = generateDrums(ctx, { seed: seed + 1, density: 0.6, syncopation: 0.4 })
            .filter((e) => e.lane === 0)
            .map((e) => e.step);
          const midi = (deg: number) => degreeToMidi(0, scaleId, deg, -2);
          const tag = `seed ${seed} ${scaleId} ${steps}`;
          let lower: Map<number, number> | null = null;
          for (const density of DENSITIES) {
            const bass = generateBass(ctx, { seed, density, register: 0, kickSteps });
            const byStep = new Map(bass.map((e) => [e.step, e.degree]));
            for (const c of cs) {
              const deg = byStep.get(c);
              if (deg === undefined || (midi(deg) - midi(ctx.chordAtStep[c]) + 120) % 12 !== 0) bad.push(`${tag} d${density}: no root @${c}`);
            }
            const line = bass.map((e) => midi(e.degree));
            line.forEach((m, i) => {
              if (Math.abs(line[(i + 1) % line.length] - m) > 12) bad.push(`${tag} d${density}: leap after note ${i}`);
            });
            bass.forEach((e, i) => {
              if (e.step + e.lengthSteps > (bass[i + 1]?.step ?? steps)) bad.push(`${tag} d${density}: overlap @${e.step}`);
              if (e.passing && (cs.find((c) => c > e.step) ?? steps) - 1 !== e.step) bad.push(`${tag} d${density}: passing tone off the pickup @${e.step}`);
            });
            if (lower) for (const [step, degree] of lower) if (byStep.get(step) !== degree) bad.push(`${tag} d${density}: not nested @${step}`);
            lower = byStep;
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('lock mode pulls the in-between bass notes onto the kick', () => {
    let lockedOn = 0;
    let lockedAll = 0;
    let freeOn = 0;
    let freeAll = 0;
    for (const seed of MANY) {
      const ctx = ctxSteps(seed, 'minor_pent', 16);
      const kicks = new Set(generateDrums(ctx, { seed, density: 0.7, syncopation: 0.6 }).filter((e) => e.lane === 0).map((e) => e.step));
      const between = (ev: { step: number; passing?: boolean }) => !ev.passing && !changes(ctx).includes(ev.step);
      for (const ev of generateBass(ctx, { seed, density: 0.8, register: 0, kickSteps: [...kicks] }).filter(between)) {
        lockedAll++;
        if (kicks.has(ev.step)) lockedOn++;
      }
      for (const ev of generateBass(ctx, { seed, density: 0.8, register: 0 }).filter(between)) {
        freeAll++;
        if (kicks.has(ev.step)) freeOn++;
      }
    }
    expect(lockedOn / lockedAll).toBeGreaterThan((2 * freeOn) / freeAll);
  });
});
