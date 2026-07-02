/** Bass, Chords, Arp generators — followers of the harmonic context (PRD §5.2). */

import type { HarmonicContext } from './harmony';
import { mulberry32, pickWeighted } from './rng';
import type { NoteEvent } from './melody';

export interface PartParams {
  seed: number;
  density: number; // 0..1
  register: number; // octave offset
}

/** Bass: monophonic, root-driven; walks to approach tones at chord changes. */
export function generateBass(ctx: HarmonicContext, params: PartParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = [];
  let prevChord = -1;
  for (let s = 0; s < ctx.steps; s++) {
    const chord = ctx.chordAtStep[s];
    const isChange = chord !== prevChord;
    prevChord = chord;
    const strong = s % 4 === 0;
    let p = isChange ? 0.95 : strong ? 0.6 : s % 2 === 0 ? 0.3 : 0.12;
    p *= 0.3 + params.density * 0.9;
    if (rng() >= p) continue;
    // mostly root; sometimes fifth (chord degree + 4 in scale thirds => the triad's fifth)
    const degree = pickWeighted(rng, [
      [chord, 5],
      [chord + 4, isChange ? 0.5 : 1.6],
      [chord + 7, 0.4], // octave-ish reach
    ]);
    events.push({ step: s, degree, velocity: strong || isChange ? 0.95 : 0.75, lengthSteps: s % 4 === 0 ? 2 : 1 });
  }
  if (!events.length) events.push({ step: 0, degree: ctx.chordAtStep[0], velocity: 0.9, lengthSteps: 2 });
  return events;
}

/** Chords: comping — sustained triads at chord changes plus occasional pushes. */
export function generateChords(ctx: HarmonicContext, params: PartParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = []; // degree = chord root degree; voicing resolved at playback
  let prevChord = -1;
  for (let s = 0; s < ctx.steps; s++) {
    const chord = ctx.chordAtStep[s];
    const isChange = chord !== prevChord;
    prevChord = chord;
    let p = isChange ? 0.96 : s % 8 === 4 ? 0.25 + params.density * 0.5 : params.density * 0.12;
    if (rng() >= p) continue;
    // hold until next chord change (or a few steps)
    let len = 2;
    for (let k = s + 1; k < ctx.steps && ctx.chordAtStep[k] === chord && k - s < 8; k++) len = k - s + 1;
    events.push({ step: s, degree: chord, velocity: isChange ? 0.8 : 0.6, lengthSteps: len });
  }
  return events;
}

/** Arp: runs over the current chord's tones, direction-seeded, ornament density. */
export function generateArp(ctx: HarmonicContext, params: PartParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = [];
  const pattern = pickWeighted(rng, [
    [[0, 2, 4, 7], 2], // up
    [[7, 4, 2, 0], 1], // down
    [[0, 4, 2, 7], 1.2], // skip
    [[0, 2, 4, 2], 1.4], // up-back
  ] as Array<[number[], number]>);
  for (let s = 0; s < ctx.steps; s++) {
    const p = (0.2 + params.density * 0.85) * (s % 2 === 0 ? 1 : 0.75);
    if (rng() >= p) continue;
    const chord = ctx.chordAtStep[s];
    const offset = pattern[s % pattern.length];
    events.push({ step: s, degree: chord + offset, velocity: 0.55 + (s % 4 === 0 ? 0.2 : 0), lengthSteps: 1 });
  }
  return events;
}

/** Drums: role-aware kit patterns (PRD §5.2 Drums player). Lanes: 0 kick, 1 snare, 2 hat. */
export interface DrumEvent {
  step: number;
  lane: 0 | 1 | 2;
  velocity: number;
}

export interface DrumParams {
  seed: number;
  density: number;
  syncopation: number; // 0..1
}

export function generateDrums(ctx: HarmonicContext, params: DrumParams): DrumEvent[] {
  const rng = mulberry32(params.seed);
  const events: DrumEvent[] = [];
  const bar = 16; // pattern thinks in 16ths within the loop
  for (let s = 0; s < ctx.steps; s++) {
    const pos = s % bar;
    // Kick anchors: beat 1 always, beat 3 usually; syncopated pushes when asked
    let pKick = pos === 0 ? 1 : pos === 8 ? 0.85 : pos === 10 || pos === 6 ? params.syncopation * 0.5 : 0.02 + params.syncopation * 0.08;
    // Snare answers: backbeats 2 & 4
    let pSnare = pos === 4 || pos === 12 ? 0.96 : pos === 14 ? params.syncopation * 0.35 : 0.015;
    // Hats fill: eighths, upgraded to sixteenths with density
    let pHat = pos % 2 === 0 ? 0.9 : 0.15 + params.density * 0.75;
    pKick *= 0.35 + params.density * 0.8;
    pSnare *= 0.4 + params.density * 0.75;
    if (rng() < pKick) events.push({ step: s, lane: 0, velocity: pos === 0 ? 1 : 0.85 });
    if (rng() < pSnare) events.push({ step: s, lane: 1, velocity: pos === 4 || pos === 12 ? 0.9 : 0.6 });
    if (rng() < pHat) events.push({ step: s, lane: 2, velocity: pos % 4 === 0 ? 0.7 : 0.45 });
  }
  return events;
}
