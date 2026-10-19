/**
 * Melody engine — the Coach's voice-leading scorer as a generator (PRD §5.3).
 * Rules: stepwise > small leap > repetition > wide leap; chord-tone pull;
 * leap recovery; phrase roles (question/answer); half cadence on the 5th,
 * perfect cadence on the root. Seeded and deterministic.
 */

import { SCALES, degreeToMidi, type ScaleId } from './scales';
import { isChordToneAt, type HarmonicContext } from './harmony';
import { mulberry32, pickWeighted, type Rng } from './rng';

/** Semitones above the tonic (key-independent): interval logic is measured in
 *  semitones, since a scale degree is 2–3 st in pentatonic but 1–2 st in 7-note scales. */
export function degreeSemis(scaleId: ScaleId, degree: number): number {
  return degreeToMidi(0, scaleId, degree) - 60;
}

export function isTritone(scaleId: ScaleId, a: number, b: number): boolean {
  return Math.abs(degreeSemis(scaleId, b) - degreeSemis(scaleId, a)) % 12 === 6;
}

/** c moves back inside the a→b leap by a step (1–2 semitones): the counterpoint resolution of a tritone. */
export function resolvesInward(scaleId: ScaleId, a: number, b: number, c: number): boolean {
  const leap = degreeSemis(scaleId, b) - degreeSemis(scaleId, a);
  const move = degreeSemis(scaleId, c) - degreeSemis(scaleId, b);
  return Math.sign(move) === -Math.sign(leap) && Math.abs(move) >= 1 && Math.abs(move) <= 2;
}

export interface NoteEvent {
  step: number;
  degree: number; // scale degree, can exceed scale length (octave up)
  velocity: number;
  lengthSteps: number;
  /** weak-beat approach/passing tone: allowed off the chord */
  passing?: boolean;
}

export interface MelodyParams {
  seed: number;
  density: number; // 0..1 — how busy
  adventurousness: number; // 0..1 — tension notes, wider leaps
  register: number; // octave offset
}

type PhraseRole = 'open' | 'qbody' | 'qend' | 'abody' | 'aend';

function phraseRole(step: number, steps: number): PhraseRole {
  const half = Math.floor(steps / 2);
  if (step < Math.max(1, Math.ceil(steps / 8))) return 'open';
  if (step === half - 1 || step === half - 2) return 'qend';
  if (step >= steps - 2) return 'aend';
  return step < half ? 'qbody' : 'abody';
}

/** Degree of the perfect fifth in this scale, or -1. */
function fifthDegree(scaleLen: number, intervals: number[]): number {
  return intervals.indexOf(7);
}

/** Score all candidate degrees for a step, given the previous two notes.
 *  Exported for the theme grammar (motif.ts), which uses it inside motif slots. */
export function scoreCandidates(
  ctx: HarmonicContext,
  step: number,
  last: number | null,
  prev: number | null,
  adventurousness: number,
): Array<[number, number]> {
  const intervals = SCALES[ctx.scaleId].intervals;
  const scaleLen = intervals.length;
  const range = scaleLen + Math.ceil(scaleLen / 2); // ~1.5 octaves of degrees
  const role = phraseRole(step, ctx.steps);
  const fifth = fifthDegree(scaleLen, intervals);
  const st = (d: number) => degreeSemis(ctx.scaleId, d);
  // a leap of a 5th or more wants recovery the other way
  const leap = last != null && prev != null && Math.abs(st(last) - st(prev)) >= 7;
  const leapDir = leap ? Math.sign(last! - prev!) : 0;
  const tritoneIn = last != null && prev != null && isTritone(ctx.scaleId, prev, last);

  const out: Array<[number, number]> = [];
  for (let d = 0; d < range; d++) {
    let score = 1;
    const chordTone = isChordToneAt(ctx, step, d);
    if (last != null) {
      const dist = Math.abs(st(d) - st(last));
      if (dist === 0) score += 14;
      else if (dist <= 2) score += 40; // step
      else if (dist < 5) score += 26; // skip of a third
      else score += 7 + adventurousness * 14; // leaps (P4 and up) get likelier when adventurous
      if (dist % 12 === 6) score -= 40;
      if (leap && Math.sign(d - last) === -leapDir && dist >= 1 && dist <= 2) score += 30; // leap recovery by step
      if (tritoneIn && resolvesInward(ctx.scaleId, prev!, last, d)) score += 30;
    }
    if (chordTone) score += 22;
    else score += adventurousness * 16; // tension notes when adventurous
    if (role === 'open' && chordTone) score += 30;
    if (role === 'qend' && fifth >= 0 && d % scaleLen === fifth) score += 46; // half cadence
    if (role === 'aend') {
      if (d % scaleLen === 0) score += 55; // perfect cadence home
      else if (chordTone) score += 20;
    }
    if (role === 'abody' && step >= ctx.steps - 4 && d % scaleLen === 0) score += 26; // head home
    out.push([d, Math.max(1, score)]);
  }
  return out;
}

export function generateMelody(ctx: HarmonicContext, params: MelodyParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = [];
  let last: number | null = null;
  let prev: number | null = null;

  for (let s = 0; s < ctx.steps; s++) {
    const role = phraseRole(s, ctx.steps);
    // rhythmic placement: strong beats likelier; density scales everything
    const strong = s % 4 === 0;
    const half = s % 2 === 0;
    let p = strong ? 0.85 : half ? 0.55 : 0.3;
    p *= 0.25 + params.density * 0.95;
    if (role === 'aend' && s === ctx.steps - 2) p = Math.max(p, 0.9); // land the cadence
    if (rng() >= p) continue;

    const cands = scoreCandidates(ctx, s, last, prev, params.adventurousness);
    // soften determinism: sample among top-weighted candidates
    const degree = pickWeighted(rng, cands.map(([d, w]) => [d, Math.pow(w, 2.2)] as [number, number]));
    prev = last;
    last = degree;
    events.push({
      step: s,
      degree,
      velocity: strong ? 0.9 : 0.7,
      lengthSteps: 1,
    });
  }
  // guarantee an anchor: open on a chord tone if empty start
  if (!events.some((e) => e.step === 0)) {
    let degree = 0;
    while (degree < SCALES[ctx.scaleId].intervals.length && !isChordToneAt(ctx, 0, degree)) degree++;
    events.unshift({ step: 0, degree, velocity: 0.9, lengthSteps: 1 });
  }
  return events;
}

/**
 * Evolve — coach-guided mutation on loop boundaries (PRD §5.3).
 * Deterministic: pass a step counter so each evolution derives from seed+generation.
 */
export function evolveMelody(
  ctx: HarmonicContext,
  events: NoteEvent[],
  seed: number,
  generation: number,
): NoteEvent[] {
  const rng = mulberry32(seed ^ (generation * 0x9e3779b9));
  const occupied = new Set(events.map((e) => e.step));
  const fill = occupied.size / ctx.steps;
  const roll = rng();
  const action = fill < 0.35 ? (roll < 0.78 ? 'add' : 'move') : fill > 0.7 ? (roll < 0.5 ? 'move' : roll < 0.85 ? 'remove' : 'add') : roll < 0.5 ? 'add' : roll < 0.82 ? 'move' : 'remove';

  const isAnchor = (e: NoteEvent) =>
    (e.step < Math.max(1, Math.ceil(ctx.steps / 8)) || e.step >= ctx.steps - 2) && e.degree % SCALES[ctx.scaleId].intervals.length === 0;

  const next = events.map((e) => ({ ...e }));
  if (action === 'add') {
    const empties: number[] = [];
    for (let s = 0; s < ctx.steps; s++) if (!occupied.has(s)) empties.push(s);
    if (empties.length) {
      const s = empties[Math.floor(rng() * empties.length)];
      const before = [...next].reverse().find((e) => e.step < s) ?? next[next.length - 1];
      const cands = scoreCandidates(ctx, s, before?.degree ?? null, null, 0.3);
      const degree = pickWeighted(rng, cands.map(([d, w]) => [d, Math.pow(w, 2.2)] as [number, number]));
      next.push({ step: s, degree, velocity: 0.7, lengthSteps: 1 });
      next.sort((a, b) => a.step - b.step);
    }
  } else if (action === 'move') {
    const movable = next.filter((e) => !isAnchor(e));
    if (movable.length) {
      const target = movable[Math.floor(rng() * movable.length)];
      const cands = scoreCandidates(ctx, target.step, target.degree, null, 0.3);
      target.degree = pickWeighted(rng, cands.map(([d, w]) => [d, Math.pow(w, 2.2)] as [number, number]));
    }
  } else {
    const removable = next.filter((e) => !isAnchor(e));
    if (removable.length > 2) {
      const victim = removable[Math.floor(rng() * removable.length)];
      const idx = next.indexOf(victim);
      next.splice(idx, 1);
    }
  }
  return next;
}

/** Scale-locked glissando (Expression node, PRD §5.2): before a leap of a 4th
 *  or more, insert quiet grace notes running the scale into the target.
 *  Degrees stay in-scale by construction — the run can never go chromatic. */
export function withGlissando(events: NoteEvent[], scaleId: ScaleId): NoteEvent[] {
  const occupied = new Set(events.map((e) => e.step));
  const graces: NoteEvent[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    const diff = cur.degree - prev.degree;
    if (Math.abs(degreeSemis(scaleId, cur.degree) - degreeSemis(scaleId, prev.degree)) < 5) continue;
    const dir = Math.sign(diff);
    // only degrees strictly inside the leap: a 4th in pentatonic is 2 degrees, so g = 2 would re-strike the origin
    for (let g = 1; g <= Math.min(2, Math.abs(diff) - 1); g++) {
      const step = cur.step - g;
      if (step <= prev.step || occupied.has(step)) continue;
      occupied.add(step);
      graces.push({ step, degree: cur.degree - dir * g, velocity: cur.velocity * 0.5, lengthSteps: 1 });
    }
  }
  return graces.length ? [...events, ...graces].sort((a, b) => a.step - b.step) : events;
}
