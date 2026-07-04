/**
 * Theme grammar (PRD §5.3, "better melodies" pass): melodies built the way
 * composers build them — a short motif (rhythm cell + pitch cell) developed
 * through a sentence plan (statement, restatement, contrast, cadence) under a
 * contour shape with one climax. On top, an audition: several candidate takes
 * are generated and a holistic critic keeps the strongest.
 *
 * Identity split (Motif node, PRD §5.2 expose-on-demand):
 *   ideaSeed → the IDEA (rhythm cell, motif pitches, structural choices)
 *   seed     → the TAKE (contrast realization, approach notes, jitter)
 * With a Motif node patched in, re-rolling the player keeps the idea.
 * Everything is seeded and deterministic, like the rest of the theory core.
 */

import { SCALES, isChordTone } from './scales';
import type { HarmonicContext } from './harmony';
import { mulberry32, pickWeighted, type Rng } from './rng';
import { scoreCandidates, type NoteEvent } from './melody';

export type Shape = 'arch' | 'rise' | 'fall' | 'wave';
export const SHAPES: Shape[] = ['arch', 'rise', 'fall', 'wave'];

export interface ThemeParams {
  seed: number;
  density: number; // 0..1
  adventurousness: number; // 0..1
  /** motif identity — defaults to seed (no Motif node patched) */
  ideaSeed?: number;
  /** contour — defaults to a seeded pick */
  shape?: Shape;
  /** evolve depth: 0 = the theme itself, n = nth variation (ornaments, new contrast) */
  generation?: number;
}

const CELL = 4; // steps per cell — themes are built in 4-step units
const AUDITION_TAKES = 6;

interface Onset {
  offset: number; // 0..3 within the cell
  length: number;
  accent: boolean;
}

/** Rhythm-cell templates. Density picks the tier, adventurousness admits syncopation. */
const CELL_TEMPLATES: Array<{ onsets: Array<[number, number]>; busy: number; sync?: boolean }> = [
  { onsets: [[0, 3]], busy: 0.1 },
  { onsets: [[0, 2], [2, 2]], busy: 0.25 },
  { onsets: [[0, 1], [2, 2]], busy: 0.35 },
  { onsets: [[0, 2], [2, 1], [3, 1]], busy: 0.5 },
  { onsets: [[0, 1], [2, 1], [3, 1]], busy: 0.55 },
  { onsets: [[0, 1], [1, 1], [2, 2]], busy: 0.6 },
  { onsets: [[1, 1], [2, 2]], busy: 0.4, sync: true },
  { onsets: [[0, 1], [3, 1]], busy: 0.3, sync: true },
  { onsets: [[0, 1], [1, 1], [2, 1], [3, 1]], busy: 0.85 },
];

function generateRhythmCell(rng: Rng, density: number, adventurousness: number): Onset[] {
  const options: Array<[number, number]> = CELL_TEMPLATES.map((t, i) => {
    let w = 1 / (0.12 + Math.abs(t.busy - density));
    if (t.sync) w *= adventurousness * 1.6 + 0.08;
    return [i, w];
  });
  const tpl = CELL_TEMPLATES[pickWeighted(rng, options)];
  return tpl.onsets.map(([offset, length]) => ({ offset, length, accent: offset === 0 }));
}

/** Contour target 0..1 across the theme (t = position 0..1). */
function contourTarget(shape: Shape, t: number): number {
  switch (shape) {
    case 'arch':
      return Math.sin(Math.PI * Math.min(1, t / 0.72) * 0.5) * (t <= 0.72 ? 1 : 1 - (t - 0.72) / 0.28 * 0.7);
    case 'rise':
      return 0.15 + t * 0.85;
    case 'fall':
      return 1 - t * 0.85;
    case 'wave':
      return 0.5 + 0.5 * Math.sin(Math.PI * 2 * t - Math.PI / 2) * 0.9;
  }
}

type CellRole = 'A' | 'Aseq' | 'B' | 'half' | 'cad';

/** Sentence plans by cell count (8/16/32 steps → 2/4/8 cells). */
function planFor(cells: number): CellRole[] {
  if (cells <= 2) return ['A', 'cad'];
  if (cells <= 4) return ['A', 'Aseq', 'B', 'cad'];
  // 32 steps: antecedent (question → half cadence) + consequent (answer → home)
  return ['A', 'Aseq', 'B', 'half', 'A', 'Aseq', 'B', 'cad'];
}

function nearestChordTone(degree: number, chordDeg: number, scaleLen: number): number {
  for (let dist = 0; dist <= scaleLen; dist++) {
    for (const dir of [0, -1, 1]) {
      const d = degree + dist * dir;
      if (d >= 0 && isChordTone(d, chordDeg, scaleLen)) return d;
    }
  }
  return degree;
}

/** Nearest tonic degree (0, scaleLen, 2·scaleLen …) to a reference. */
function nearestTonic(ref: number, scaleLen: number): number {
  const below = Math.floor(ref / scaleLen) * scaleLen;
  return ref - below <= below + scaleLen - ref ? Math.max(0, below) : below + scaleLen;
}

function buildTheme(ctx: HarmonicContext, params: ThemeParams, takeSeed: number): NoteEvent[] {
  const scaleLen = SCALES[ctx.scaleId].intervals.length;
  const range = scaleLen + Math.ceil(scaleLen / 2);
  const cells = Math.max(2, Math.floor(ctx.steps / CELL));
  const plan = planFor(cells);
  const ideaSeed = params.ideaSeed ?? params.seed;
  const rngIdea = mulberry32(ideaSeed);
  const rngTake = mulberry32(takeSeed);
  const shape = params.shape ?? SHAPES[Math.floor(rngIdea() * SHAPES.length)];

  // the idea: one rhythm cell + structural choices, all from the idea stream
  const rhythmA = generateRhythmCell(rngIdea, params.density, params.adventurousness);
  const seqDir = shape === 'fall' ? -1 : shape === 'wave' ? (rngIdea() < 0.5 ? 1 : -1) : 1;
  const bInverts = rngIdea() < 0.45 + params.adventurousness * 0.3;

  // contrast cell rhythm: fragmentation — the head of A, twice
  const head = rhythmA.slice(0, Math.max(1, Math.ceil(rhythmA.length / 2)));
  const rhythmB: Onset[] =
    head.length && head[head.length - 1].offset < 2
      ? [...head, ...head.map((o) => ({ ...o, offset: o.offset + 2, accent: false }))]
      : rhythmA.map((o) => ({ ...o }));
  const rhythmCad: Onset[] = [{ offset: 0, length: 1, accent: false }, { offset: 2, length: 2, accent: true }];

  // pitch line for A: coach-scored + contour-pulled
  const climaxCell = Math.max(1, Math.round(cells * 0.65));
  const contourBonus = (step: number, d: number): number => {
    const t = step / Math.max(1, ctx.steps - 1);
    const target = contourTarget(shape, t) * (range - 2) + 1;
    return 26 * Math.max(0, 1 - Math.abs(d - target) / (range * 0.55));
  };

  const pickDegree = (rng: Rng, step: number, last: number | null, prev: number | null): number => {
    const cands = scoreCandidates(ctx, step, last, prev, params.adventurousness).map(([d, w]) => {
      let score = w + contourBonus(step, d);
      // tessitura: keep out of the extremes unless the contour asks
      if (d === 0 || d >= range - 1) score *= 0.7;
      return [d, Math.pow(score, 2.2)] as [number, number];
    });
    return pickWeighted(rng, cands);
  };

  const cellStart = (i: number) => i * CELL;
  let last: number | null = null;
  let prev: number | null = null;
  const aDegrees: number[] = [];
  const events: NoteEvent[] = [];

  const emitCell = (cellIdx: number, rhythm: Onset[], degreeFor: (onsetIdx: number, step: number) => number) => {
    for (let oi = 0; oi < rhythm.length; oi++) {
      const o = rhythm[oi];
      const step = cellStart(cellIdx) + o.offset;
      if (step >= ctx.steps) continue;
      const degree = Math.max(0, Math.min(range - 1, degreeFor(oi, step)));
      events.push({
        step,
        degree,
        velocity: o.accent ? 0.92 : step % 4 === 0 ? 0.85 : 0.72,
        lengthSteps: o.length,
      });
      prev = last;
      last = degree;
    }
  };

  let aOccurrence = 0;
  for (let ci = 0; ci < plan.length && ci < cells; ci++) {
    const role = plan[ci];
    const chordDeg = ctx.chordAtStep[Math.min(ctx.steps - 1, cellStart(ci))];
    if (role === 'A') {
      aOccurrence++;
      emitCell(ci, rhythmA, (oi, step) => {
        if (aOccurrence === 1) {
          const d = pickDegree(rngIdea, step, last, prev);
          aDegrees.push(d);
          return d;
        }
        return aDegrees[oi] ?? aDegrees[aDegrees.length - 1] ?? scaleLen;
      });
    } else if (role === 'Aseq') {
      // sequence: the motif again, one scale step along the shape, strong beat snapped to the chord
      emitCell(ci, rhythmA, (oi, step) => {
        const base = (aDegrees[oi] ?? scaleLen) + seqDir;
        return step % CELL === 0 ? nearestChordTone(base, ctx.chordAtStep[Math.min(ctx.steps - 1, step)], scaleLen) : base;
      });
    } else if (role === 'B') {
      // contrast: inversion of the motif around its first note, or a fresh coach line — the TAKE decides details
      const pivot = aDegrees[0] ?? scaleLen;
      emitCell(ci, rhythmB, (oi, step) => {
        if (bInverts) {
          const src = aDegrees[oi % aDegrees.length] ?? pivot;
          const inv = 2 * pivot - src + (rngTake() < 0.25 ? seqDir : 0);
          return step % CELL === 0 ? nearestChordTone(inv, chordDeg, scaleLen) : inv;
        }
        return pickDegree(rngTake, step, last, prev);
      });
    } else {
      // cadence cell: approach note then a held landing — 5th for the half cadence, tonic for home
      const fifth = SCALES[ctx.scaleId].intervals.indexOf(7);
      const ref = last ?? scaleLen;
      let landing = nearestTonic(ref, scaleLen);
      if (role === 'half' && fifth >= 0) {
        const below = landing - scaleLen + fifth;
        const above = landing + fifth;
        landing = below >= 0 && Math.abs(below - ref) <= Math.abs(above - ref) ? below : above;
      }
      const isLastCell = ci === Math.min(plan.length, cells) - 1;
      const cadLength = isLastCell ? Math.max(2, ctx.steps - (cellStart(ci) + 2)) : 2;
      emitCell(ci, rhythmCad, (oi) =>
        oi === rhythmCad.length - 1 ? landing : nearestChordTone(landing + (rngTake() < 0.5 ? 1 : 2), chordDeg, scaleLen),
      );
      const landed = events[events.length - 1];
      if (landed) landed.lengthSteps = cadLength;
    }
  }

  // one climax: the single highest note lives in the climax cell — fold intruders down
  const climaxLo = cellStart(climaxCell);
  const climaxHi = climaxLo + CELL;
  let peak = -1;
  for (const e of events) if (e.step >= climaxLo && e.step < climaxHi && e.degree > peak) peak = e.degree;
  if (peak > 0) {
    for (const e of events) {
      if ((e.step < climaxLo || e.step >= climaxHi) && e.degree >= peak) {
        e.degree = Math.max(0, e.degree - (e.degree - peak + 1));
      }
    }
  }

  // variation pass (Evolve, PRD §5.3): generation n ornaments the theme, never the anchors
  const generation = params.generation ?? 0;
  if (generation > 0) {
    const rngVar = mulberry32(ideaSeed ^ (generation * 0x9e3779b9));
    const occupied = new Set(events.map((e) => e.step));
    const varied = events.map((e) => ({ ...e }));
    for (let i = 1; i < varied.length - 1; i++) {
      const cur = varied[i];
      const nxt = varied[i + 1];
      // passing-note ornament into a gap of a third
      if (
        rngVar() < 0.3 &&
        Math.abs(nxt.degree - cur.degree) === 2 &&
        nxt.step - cur.step >= 2 &&
        !occupied.has(cur.step + 1)
      ) {
        occupied.add(cur.step + 1);
        varied.splice(i + 1, 0, {
          step: cur.step + 1,
          degree: cur.degree + Math.sign(nxt.degree - cur.degree),
          velocity: 0.62,
          lengthSteps: 1,
        });
        i++;
      } else if (rngVar() < 0.18 && cur.step % CELL !== 0 && cur.step < ctx.steps - 2) {
        // neighbor-tone wiggle off the strong beats
        cur.degree = Math.max(0, cur.degree + (rngVar() < 0.5 ? 1 : -1));
      }
    }
    return varied.sort((a, b) => a.step - b.step);
  }

  return events.sort((a, b) => a.step - b.step);
}

/** Holistic critic — what makes a take a keeper. */
function criticScore(ctx: HarmonicContext, events: NoteEvent[], rhythmMatchTarget = 0.55): number {
  if (events.length < 3) return -100;
  const scaleLen = SCALES[ctx.scaleId].intervals.length;
  let score = 0;

  // rhythm recurrence: how many cells repeat the first cell's onset pattern
  const cellOf = new Map<number, number[]>();
  for (const e of events) {
    const c = Math.floor(e.step / CELL);
    if (!cellOf.has(c)) cellOf.set(c, []);
    cellOf.get(c)!.push(e.step % CELL);
  }
  const cellsArr = [...cellOf.values()].map((v) => v.sort((a, b) => a - b).join(','));
  const first = cellsArr[0];
  const recur = cellsArr.filter((c) => c === first).length / Math.max(1, cellsArr.length);
  score += 34 - Math.abs(recur - rhythmMatchTarget) * 60;

  // one clear climax, ideally past the midpoint
  const max = Math.max(...events.map((e) => e.degree));
  const peaks = events.filter((e) => e.degree === max);
  if (peaks.length === 1) {
    score += 18;
    const t = peaks[0].step / Math.max(1, ctx.steps - 1);
    if (t > 0.45 && t < 0.9) score += 14;
  } else score -= (peaks.length - 1) * 6;

  // strong beats want chord tones
  const strong = events.filter((e) => e.step % CELL === 0);
  const inChord = strong.filter((e) => isChordTone(e.degree, ctx.chordAtStep[e.step], scaleLen)).length;
  score += 26 * (strong.length ? inChord / strong.length : 0);

  // singable flow: mostly steps, some variety, no monotone
  let stepwise = 0;
  const distinct = new Set(events.map((e) => e.degree));
  for (let i = 1; i < events.length; i++) {
    if (Math.abs(events[i].degree - events[i - 1].degree) <= 2) stepwise++;
  }
  score += 22 * (stepwise / (events.length - 1));
  if (distinct.size < 3) score -= 25;
  if (distinct.size >= 4) score += 8;

  // ends home
  const lastEv = events[events.length - 1];
  if (lastEv.degree % scaleLen === 0) score += 15;

  return score;
}

/**
 * The generator: audition several takes of the same idea, keep the strongest.
 * Deterministic — same params, same theme (verified by test).
 */
export function generateTheme(ctx: HarmonicContext, params: ThemeParams): NoteEvent[] {
  let best: NoteEvent[] | null = null;
  let bestScore = -Infinity;
  for (let k = 0; k < AUDITION_TAKES; k++) {
    const take = buildTheme(ctx, params, (params.seed ^ (k * 0x9e3779b9)) >>> 0);
    const s = criticScore(ctx, take);
    if (s > bestScore) {
      bestScore = s;
      best = take;
    }
  }
  return best ?? [];
}
