/**
 * Property tests for the theory engine (PRD §10 M1 exit tests):
 * determinism (same seed -> same music), always-in-scale, cadence landing.
 */

import { describe, it, expect } from 'vitest';
import { SCALES, SCALE_IDS, degreeToMidi, parentScale, pcOf } from './scales';
import {
  buildContext, cadenceTable, chordAt, chordMidi, chordPalette, contextFromDegrees, generateProgression, isChangeAt,
  makeChord, buildJourney, CHORD_COLOURS, type HarmonicContext,
} from './harmony';
import { generateTheme } from './motif';
import { generateMelody, evolveMelody } from './melody';
import { generateBass, generateChords, generateArp, generateDrums } from './parts';
import { mulberry32 } from './rng';

const STEPS = 16;

function ctxFor(seed: number, keyIndex: number, scaleId: (typeof SCALE_IDS)[number]): HarmonicContext {
  return buildContext(keyIndex, scaleId, STEPS, seed);
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
  it('every generated pitch is in key: melody and arp in the scale, bass in its parent mode', () => {
    for (const seed of SEEDS) {
      for (const scaleId of SCALE_IDS) {
        for (const keyIndex of [0, 3, 7, 11]) {
          const ctx = ctxFor(seed, keyIndex, scaleId);
          const inScale = (id: typeof scaleId, midi: number) => SCALES[id].intervals.includes((((midi - 60 - keyIndex) % 12) + 12) % 12);
          const params = { seed, density: 0.8, adventurousness: 0.9, register: 0 };
          for (const ev of [...generateMelody(ctx, params), ...generateArp(ctx, params)]) {
            expect(inScale(scaleId, degreeToMidi(keyIndex, scaleId, ev.degree, 0))).toBe(true);
          }
          const parent = parentScale(scaleId);
          for (const ev of generateBass(ctx, params)) expect(inScale(parent, degreeToMidi(keyIndex, parent, ev.degree, 0))).toBe(true);
        }
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
  const ctxSteps = (seed: number, scaleId: (typeof SCALE_IDS)[number], steps: number): HarmonicContext =>
    buildContext(0, scaleId, steps, seed);
  const changes = (ctx: HarmonicContext) => ctx.chordIdxAtStep.map((_, s) => s).filter((s) => isChangeAt(ctx, s));

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
              const semis = degreeToMidi(0, parentScale(scaleId), e.degree, -2) - degreeToMidi(0, scaleId, 0, -2);
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
          const midi = (deg: number) => degreeToMidi(0, parentScale(scaleId), deg, -2);
          const tag = `seed ${seed} ${scaleId} ${steps}`;
          let lower: Map<number, number> | null = null;
          for (const density of DENSITIES) {
            const bass = generateBass(ctx, { seed, density, register: 0, kickSteps });
            const byStep = new Map(bass.map((e) => [e.step, e.degree]));
            for (const c of cs) {
              const deg = byStep.get(c);
              if (deg === undefined || (midi(deg) - midi(chordAt(ctx, c).degree) + 120) % 12 !== 0) bad.push(`${tag} d${density}: no root @${c}`);
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

  it('lock mode needs a kick: an empty kick list plays exactly like no lock', () => {
    for (const seed of MANY.slice(0, 40)) {
      for (const scaleId of SCALE_IDS) {
        const ctx = ctxSteps(seed, scaleId, 16);
        for (const density of [0.3, 0.8]) {
          expect(generateBass(ctx, { seed, density, register: 0, kickSteps: [] })).toEqual(generateBass(ctx, { seed, density, register: 0 }));
        }
      }
    }
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

describe('pitch-class chords from the parent mode, per-mode functional progressions', () => {
  const SEEDS_20K = Array.from({ length: 20000 }, (_, i) => ((i + 1) * 2654435761) >>> 0);
  const MANY = Array.from({ length: 400 }, (_, i) => i * 7919 + 1);

  it('20000 seeds × 8 scales: no diminished chord, opens on the tonic (T), ends on a cadence of the mode, no chord twice in a row', () => {
    const bad: string[] = [];
    for (const scaleId of SCALE_IDS) {
      const endings = cadenceTable(scaleId).flatMap(([c]) => c.map((_, i) => c.slice(i).join(',')));
      for (const seed of SEEDS_20K) {
        const prog = generateProgression(seed, scaleId);
        const chords = prog.map((d) => makeChord(0, scaleId, d));
        if (chords.some((c) => c.quality === 'dim')) bad.push(`${scaleId} ${seed} dim ${prog}`);
        if (prog[0] !== 0 || chords[0].func !== 'T') bad.push(`${scaleId} ${seed} opens ${prog}`);
        if (!endings.some((e) => prog.join(',').endsWith(',' + e))) bad.push(`${scaleId} ${seed} ends ${prog}`);
        if (prog.some((d, i) => i > 0 && d === prog[i - 1])) bad.push(`${scaleId} ${seed} repeat ${prog}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('closed progressions arrive on the tonic after a full cadence', () => {
    for (const scaleId of SCALE_IDS) {
      const cads = cadenceTable(scaleId).map(([c]) => c);
      for (const seed of SEEDS_20K.slice(0, 2000)) {
        const prog = generateProgression(seed, scaleId, 4, true);
        expect(prog).toHaveLength(4);
        expect(prog[3]).toBe(0);
        const before = prog.slice(1, 3).join(',');
        expect(cads.some((c) => before.endsWith(c.join(',')))).toBe(true);
      }
    }
  });

  it('every mode sounds its signature chord in at least 15% of progressions', () => {
    const SIGNATURE: Array<[(typeof SCALE_IDS)[number], number, string]> = [
      ['aeolian', 6, 'bVII'], ['mixolydian', 6, 'bVII'], ['dorian', 3, 'IV'], ['phrygian', 1, 'bII'], ['lydian', 1, 'II'], ['minor_pent', 6, 'bVII'],
    ];
    for (const [scaleId, degree, roman] of SIGNATURE) {
      expect(makeChord(0, scaleId, degree).roman).toBe(roman);
      const hits = SEEDS_20K.slice(0, 4000).filter((seed) => generateProgression(seed, scaleId).includes(degree)).length;
      expect(hits / 4000, scaleId).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('pentatonic chords are real triads of the parent: the C minor pent tonic is Cm, every palette chord shares 2+ notes with the pentatonic', () => {
    expect(makeChord(0, 'minor_pent', 0)).toMatchObject({ pcs: [0, 3, 7], quality: 'min', roman: 'i', func: 'T' });
    expect(makeChord(0, 'major_pent', 0)).toMatchObject({ pcs: [0, 4, 7], quality: 'maj', roman: 'I' });
    expect(makeChord(0, 'minor_pent', 6)).toMatchObject({ pcs: [10, 2, 5], quality: 'maj', roman: 'bVII' });
    for (const scaleId of ['minor_pent', 'major_pent'] as const) {
      const pent = new Set(SCALES[scaleId].intervals);
      const pal = chordPalette(scaleId);
      for (const [d] of [...pal.T, ...pal.S, ...pal.D]) {
        expect(makeChord(0, scaleId, d).pcs.filter((p) => pent.has(p)).length).toBeGreaterThanOrEqual(2);
      }
    }
    // every chord tone of every colour is in the key collection (the parent mode)
    for (const scaleId of SCALE_IDS) {
      for (const keyIndex of [0, 5, 11]) {
        const inKey = new Set(SCALES[parentScale(scaleId)].intervals.map((iv) => (iv + keyIndex) % 12));
        for (const colour of CHORD_COLOURS) {
          const ctx = contextFromDegrees(keyIndex, scaleId, 16, [0], colour);
          for (let d = 0; d < 7; d++) for (const m of chordMidi(ctx, d, 0)) expect(inKey.has(pcOf(m))).toBe(true);
        }
      }
    }
  });

  it('colours: 7th adds the diatonic seventh, quartal stacks fourths and never a tritone', () => {
    const c7 = makeChord(0, 'ionian', 4, '7th');
    expect(c7.pcs).toEqual([7, 11, 2]);
    expect(c7.ext).toEqual([5]);
    for (const scaleId of SCALE_IDS) {
      const ctx = contextFromDegrees(0, scaleId, 16, [0], 'quartal');
      for (let d = 0; d < 7; d++) {
        const m = chordMidi(ctx, d, 0);
        for (let i = 1; i < m.length; i++) expect([4, 5]).toContain(m[i] - m[i - 1]);
        expect(makeChord(0, scaleId, d, 'quartal').quality).toBe('quartal');
      }
    }
    // the old pentatonic C-F-Bb, now an opt-in colour
    expect(chordMidi(contextFromDegrees(0, 'minor_pent', 16, [0], 'quartal'), 0, 0)).toEqual([60, 65, 70]);
  });

  it('bass speaks the parent mode: the root of every chord, and every in-between tone is the perfect fifth or the octave', () => {
    const bad: string[] = [];
    let fifths = 0;
    for (const seed of MANY) {
      for (const scaleId of SCALE_IDS) {
        const ctx = buildContext(seed % 12, scaleId, 16, seed + 3);
        const kickSteps = generateDrums(ctx, { seed, density: 0.6, syncopation: 0.4 }).filter((e) => e.lane === 0).map((e) => e.step);
        for (const e of generateBass(ctx, { seed, density: 1, register: 0, kickSteps })) {
          if (e.passing) continue;
          const c = chordAt(ctx, e.step);
          const rel = pcOf(degreeToMidi(ctx.keyIndex, parentScale(scaleId), e.degree, -2) - c.rootPc);
          if (rel === 7) fifths++;
          else if (rel !== 0) bad.push(`${scaleId} seed ${seed} @${e.step} +${rel} over ${c.roman}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(fifths).toBeGreaterThan(100);
  });

  it('arp follows the sounding chord through the pentatonic filter: over the minor-pent tonic it plays the minor 3rd 25%+', () => {
    let tonic = 0;
    let third = 0;
    for (const seed of MANY) {
      const ctx = buildContext(0, 'minor_pent', 16, seed + 3);
      for (const e of generateArp(ctx, { seed, density: 0.6, register: 0 })) {
        if (chordAt(ctx, e.step).degree !== 0) continue;
        tonic++;
        if (pcOf(degreeToMidi(0, 'minor_pent', e.degree)) === 3) third++;
      }
    }
    expect(third / tonic).toBeGreaterThanOrEqual(0.25);
  });

  it('melody strong beats land on the sounding chord (pitch classes) and the pentatonic 5th is no longer avoided', () => {
    for (const scaleId of SCALE_IDS) {
      let strong = 0;
      let inChord = 0;
      let overTonic = 0;
      let fifth = 0;
      for (const seed of MANY.slice(0, 250)) {
        const ctx = buildContext(seed % 12, scaleId, 16, seed + 13);
        const theme = generateTheme(ctx, { seed: seed + 9, density: [0.3, 0.45, 0.55, 0.7][seed % 4], adventurousness: 0.35 });
        for (const e of theme) {
          if (e.step % 4 !== 0) continue;
          const c = chordAt(ctx, e.step);
          const pc = pcOf(degreeToMidi(ctx.keyIndex, scaleId, e.degree));
          strong++;
          if (c.pcs.includes(pc)) inChord++;
          if (c.degree !== 0) continue;
          overTonic++;
          if (pc === pcOf(ctx.keyIndex + 7)) fifth++;
        }
      }
      expect(inChord / strong, scaleId).toBeGreaterThanOrEqual(0.85);
      expect(fifth / overTonic, scaleId).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('the chord model is deterministic: same seed and colour, same context', () => {
    for (const scaleId of SCALE_IDS) {
      for (const colour of CHORD_COLOURS) {
        expect(buildContext(7, scaleId, 16, 4242, colour)).toEqual(buildContext(7, scaleId, 16, 4242, colour));
      }
    }
  });
});
