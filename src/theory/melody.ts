/**
 * Melody engine — the Coach's voice-leading scorer as a generator (PRD §5.3).
 * Rules: stepwise > small leap > repetition > wide leap; chord-tone pull;
 * leap recovery; phrase roles (question/answer); half cadence on the 5th,
 * perfect cadence on the root. Seeded and deterministic.
 */

import { SCALES, isChordTone } from './scales';
import type { HarmonicContext } from './harmony';
import { mulberry32, pickWeighted, type Rng } from './rng';

export interface NoteEvent {
  step: number;
  degree: number; // scale degree, can exceed scale length (octave up)
  velocity: number;
  lengthSteps: number;
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
  const chordDeg = ctx.chordAtStep[step];
  const leap = last != null && prev != null && Math.abs(last - prev) >= 3;
  const leapDir = leap ? Math.sign(last! - prev!) : 0;

  const out: Array<[number, number]> = [];
  for (let d = 0; d < range; d++) {
    let score = 1;
    const chordTone = isChordTone(d, chordDeg, scaleLen);
    if (last != null) {
      const dist = Math.abs(d - last);
      if (dist === 1) score += 40;
      else if (dist === 2) score += 26;
      else if (dist === 0) score += 14;
      else score += 7 + adventurousness * 14; // wide leaps get likelier when adventurous
      if (leap && Math.sign(d - last) === -leapDir && dist >= 1 && dist <= 2) score += 30; // leap recovery
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
    out.push([d, score]);
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
    events.unshift({ step: 0, degree: ctx.chordAtStep[0], velocity: 0.9, lengthSteps: 1 });
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
