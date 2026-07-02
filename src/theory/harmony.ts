/** Diatonic harmony: chord cycles, progressions, voicings, key journeys (PRD §5.3). */

import { SCALES, type ScaleId, degreeToMidi } from './scales';
import { mulberry32, pickWeighted } from './rng';

export interface HarmonicContext {
  keyIndex: number; // 0..11, C = 0
  scaleId: ScaleId;
  steps: number; // steps per loop (16)
  /** chord scale-degree active at each step */
  chordAtStep: number[];
}

/** Chord degrees that voice-lead well, per scale size (from the prototype). */
export function chordCycle(scaleId: ScaleId): number[] {
  return SCALES[scaleId].intervals.length === 5 ? [0, 2, 3] : [0, 3, 4, 5, 1];
}

/** Seeded 4-chord progression across the loop, always opening on the tonic. */
export function generateProgression(seed: number, scaleId: ScaleId): number[] {
  const rng = mulberry32(seed);
  const cyc = chordCycle(scaleId);
  const prog: number[] = [0];
  for (let i = 1; i < 4; i++) {
    const prev = prog[i - 1];
    const options: Array<[number, number]> = cyc.map((d) => [
      d,
      d === prev ? 0.4 : 1, // discourage repeats
    ]);
    // final slot: pull toward dominant/subdominant for a cadence into the loop restart
    if (i === 3) {
      for (const opt of options) {
        if (opt[0] === 4 || opt[0] === 3) opt[1] *= 2.2;
        if (opt[0] === 2 && cyc.length === 3) opt[1] *= 2.0;
      }
    }
    prog.push(pickWeighted(rng, options));
  }
  return prog;
}

/** Expand a 4-chord progression to a per-step chord map. */
export function progressionToSteps(prog: number[], steps: number): number[] {
  const out = new Array<number>(steps);
  const section = Math.max(1, Math.floor(steps / prog.length));
  for (let s = 0; s < steps; s++) {
    out[s] = prog[Math.min(prog.length - 1, Math.floor(s / section))];
  }
  return out;
}

/** Triad MIDI notes for a chord on `degree` (stacked scale thirds), at an octave offset. */
export function chordMidi(ctx: HarmonicContext, degree: number, octave: number): number[] {
  return [degree, degree + 2, degree + 4].map((d) => degreeToMidi(ctx.keyIndex, ctx.scaleId, d, octave));
}

/** Harmonic journey — related keys/modes to visit over time (PRD §5.3 Modulate). */
export interface JourneyStop {
  offset: number; // semitones from home key
  scaleId: ScaleId;
  label: string;
}

export function buildJourney(homeScale: ScaleId): JourneyStop[] {
  const penta = SCALES[homeScale].intervals.length === 5;
  return penta
    ? [
        { offset: 0, scaleId: homeScale, label: 'home' },
        { offset: 7, scaleId: 'major_pent', label: 'the bright fifth' },
        { offset: 9, scaleId: 'minor_pent', label: 'the relative minor' },
        { offset: 5, scaleId: 'major_pent', label: 'the warm fourth' },
      ]
    : [
        { offset: 0, scaleId: homeScale, label: 'home' },
        { offset: 7, scaleId: 'mixolydian', label: 'the bright fifth (V)' },
        { offset: 9, scaleId: 'aeolian', label: 'the relative minor (vi)' },
        { offset: 5, scaleId: 'lydian', label: 'the warm fourth (IV)' },
      ];
}
