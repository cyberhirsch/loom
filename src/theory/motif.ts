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

import { SCALES, isChordTone, type ScaleId } from './scales';
import type { HarmonicContext } from './harmony';
import { mulberry32, pickWeighted, type Rng } from './rng';
import { degreeSemis, isTritone, resolvesInward, scoreCandidates, type NoteEvent } from './melody';

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

function nextChordTone(from: number, dir: number, chordDeg: number, scaleLen: number, range: number): number | null {
  for (let d = from + dir; d >= 0 && d < range; d += dir) if (isChordTone(d, chordDeg, scaleLen)) return d;
  return null;
}

/** Longest run of one repeated pitch. */
function longestRun(degrees: number[]): number {
  let best = degrees.length ? 1 : 0;
  for (let i = 1, run = 1; i < degrees.length; i++) {
    run = degrees[i] === degrees[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Tritones in a line that do not resolve inward by step (one into the last note never does). */
function unresolvedTritones(scaleId: ScaleId, line: number[]): number {
  let n = 0;
  for (let i = 1; i < line.length; i++) {
    if (!isTritone(scaleId, line[i - 1], line[i])) continue;
    if (i + 1 >= line.length || !resolvesInward(scaleId, line[i - 1], line[i], line[i + 1])) n++;
  }
  return n;
}

function buildTheme(ctx: HarmonicContext, params: ThemeParams, takeSeed: number): NoteEvent[] {
  const scaleId = ctx.scaleId;
  const scaleLen = SCALES[scaleId].intervals.length;
  const range = scaleLen + Math.ceil(scaleLen / 2);
  const cells = Math.max(2, Math.floor(ctx.steps / CELL));
  const plan = planFor(cells);
  const cellCount = Math.min(plan.length, cells);
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

  // the one climax lives in the contrast cell (the last B), before the cadence — the A cell when there is no B
  const climaxCell = Math.max(0, plan.slice(0, cellCount).lastIndexOf('B'));
  const contourBonus = (step: number, d: number): number => {
    const t = step / Math.max(1, ctx.steps - 1);
    const target = contourTarget(shape, t) * (range - 2) + 1;
    return 26 * Math.max(0, 1 - Math.abs(d - target) / (range * 0.55));
  };
  const st = (d: number) => degreeSemis(scaleId, d);
  const chordAt = (step: number) => ctx.chordAtStep[Math.min(ctx.steps - 1, step)];
  const cellStart = (i: number) => i * CELL;

  const line: number[] = []; // degrees emitted so far, in time order
  const events: NoteEvent[] = [];
  const aDegrees: number[] = [];
  // exclusive ceiling: cells before the climax leave the top degree free for it; after it nothing reaches the peak
  let ceiling = range - 1;
  let peak = -1;

  // coach-scored + contour-pulled; never a third repeat of one pitch, and no tritone leap
  // (the next note may belong to a restated cell, which cannot promise to resolve it)
  const pickDegree = (rng: Rng, step: number, hiExcl: number, last: number | null, prev: number | null, avoid?: number): number => {
    let cands = scoreCandidates(ctx, step, last, prev, params.adventurousness).filter(
      ([d]) => d < hiExcl && !(last !== null && last === prev && d === last),
    );
    const other = cands.filter(([d]) => d !== avoid);
    if (other.length) cands = other;
    const plain = cands.filter(([d]) => last === null || !isTritone(scaleId, last, d));
    if (plain.length) cands = plain;
    if (last !== null && prev !== null && isTritone(scaleId, prev, last)) {
      const resolving = cands.filter(([d]) => resolvesInward(scaleId, prev, last, d));
      if (resolving.length) cands = resolving;
    }
    if (!cands.length) return 0;
    return pickWeighted(
      rng,
      cands.map(([d, w]) => {
        let score = w + contourBonus(step, d);
        // tessitura: keep out of the extremes unless the contour asks
        if (d === 0 || d >= range - 1) score *= 0.7;
        return [d, Math.pow(score, 2.2)] as [number, number];
      }),
    );
  };

  // singleTop: no note returns to the cell's highest so far, so its peak sounds once
  const freshLine = (rng: Rng, ci: number, rhythm: Onset[], hiExcl: number, singleTop = false): number[] => {
    const out: number[] = [];
    let last = line.length ? line[line.length - 1] : null;
    let prev = line.length > 1 ? line[line.length - 2] : null;
    for (const o of rhythm) {
      const top = singleTop && out.length ? Math.max(...out) : undefined;
      const d = pickDegree(rng, cellStart(ci) + o.offset, hiExcl, last, prev, top);
      out.push(d);
      prev = last;
      last = d;
    }
    return out;
  };

  /** What a fixed (restated) cell breaks after the notes already sounding:
   *  pitch runs over 2, unresolved tritones (junction included), strong beats off the chord. */
  const cost = (ci: number, rhythm: Onset[], degs: number[]): number => {
    const ctxLen = Math.min(2, line.length);
    const seq = [...line.slice(line.length - ctxLen), ...degs];
    let c = 0;
    for (let i = 2; i < seq.length; i++) if (seq[i] === seq[i - 1] && seq[i] === seq[i - 2]) c++;
    for (let i = Math.max(1, ctxLen - 1); i < seq.length; i++) {
      if (!isTritone(scaleId, seq[i - 1], seq[i])) continue;
      if (!(i + 1 < seq.length && resolvesInward(scaleId, seq[i - 1], seq[i], seq[i + 1]))) c++;
    }
    // the restated A of a period returns as it was; only sequence and contrast bend toward the chord
    if (plan[ci] !== 'A') {
      rhythm.forEach((o, oi) => {
        const step = cellStart(ci) + o.offset;
        if (step % CELL === 0 && !isChordTone(degs[oi], chordAt(step), scaleLen)) c += 0.25;
      });
    }
    return c;
  };

  /** Whole-cell transposition (the interval pattern is kept, no pitch is merged into another):
   *  the first offset in preference order that fits [0, hiExcl) with the fewest problems. */
  const RESTATE = [0, -1, -scaleLen, 1, scaleLen, -2, 2, -3, 3];
  const fit = (
    ci: number,
    rhythm: Onset[],
    raw: number[],
    hiExcl: number,
    offsets: number[],
    reject?: (degs: number[]) => boolean,
  ): number[] | null => {
    let best: number[] | null = null;
    let bestCost = Infinity;
    for (const off of offsets) {
      const degs = raw.map((d) => d + off);
      if (Math.min(...degs) < 0 || Math.max(...degs) >= hiExcl || reject?.(degs)) continue;
      const c = cost(ci, rhythm, degs);
      if (c < bestCost) {
        best = degs;
        bestCost = c;
        if (c === 0) break;
      }
    }
    return best;
  };

  /** Tonal-sequence adjustment: a restatement whose transposition leaves a hanging tritone moves the
   *  offending note one degree (the interval narrows or widens), never onto a neighbouring pitch. */
  const mend = (ci: number, rhythm: Onset[], degs: number[], hiExcl: number, keep?: (degs: number[]) => boolean): number[] => {
    let out = degs;
    for (let k = 0; k < out.length && cost(ci, rhythm, out) >= 1; k++) {
      const before = k > 0 ? out[k - 1] : line[line.length - 1];
      if (before === undefined || !isTritone(scaleId, before, out[k])) continue;
      const dir = Math.sign(out[k] - before);
      for (const d of [out[k] - dir, out[k] + dir]) {
        if (d < 0 || d >= hiExcl || d === before || d === out[k + 1]) continue;
        const cand = out.map((x, i) => (i === k ? d : x));
        if ((!keep || keep(cand)) && cost(ci, rhythm, cand) < cost(ci, rhythm, out)) {
          out = cand;
          break;
        }
      }
    }
    return out;
  };

  /** The climax cell, transposed whole so its top note rises above everything before it. */
  const fitClimax = (ci: number, rhythm: Onset[], raw: number[]): number[] | null => {
    const priorMax = line.length ? Math.max(...line) : -1;
    const hi = Math.max(...raw);
    const offsets: number[] = [];
    for (let t = -Math.min(...raw); hi + t < range; t++) if (hi + t > priorMax) offsets.push(t);
    offsets.sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
    return fit(ci, rhythm, raw, range, offsets);
  };

  // approach vocabulary: a scale step from above or below, the ^5 below the tonic (a fourth up into
  // the final), or a skip of a third — the take decides among the ones that keep the line clean
  const approachOptions = (
    landing: number,
    chordDeg: number,
    home: boolean,
    hiExcl: number,
    last: number | null,
    prev: number | null,
  ): Array<[number, number]> => {
    const fifth = SCALES[scaleId].intervals.indexOf(7);
    const weight = new Map<number, number>([[landing + 1, 10], [landing - 1, 10], [landing + 2, 4], [landing - 2, 4]]);
    if (home && fifth > 0) weight.set(landing - (scaleLen - fifth), 8);
    const opts: Array<[number, number]> = [];
    for (const [a, base] of weight) {
      if (a < 0 || a >= hiExcl) continue;
      if (last !== null && last === prev && a === last) continue;
      if (isTritone(scaleId, a, landing)) continue;
      if (last !== null && prev !== null && isTritone(scaleId, prev, last) && !resolvesInward(scaleId, prev, last, a)) continue;
      if (last !== null && isTritone(scaleId, last, a) && !resolvesInward(scaleId, last, a, landing)) continue;
      if (last !== null && Math.abs(st(a) - st(last)) > 7) continue;
      let w = base;
      if (isChordTone(a, chordDeg, scaleLen)) w += 2;
      if (last !== null && Math.abs(st(a) - st(last)) < 5) w += 3;
      opts.push([a, w]);
    }
    return opts;
  };
  const pickApproach = (landing: number, chordDeg: number, home: boolean): number => {
    const last = line.length ? line[line.length - 1] : null;
    const prev = line.length > 1 ? line[line.length - 2] : null;
    // under the climax when possible; a low peak (a one-note motif) may have no room below it
    const opts = approachOptions(landing, chordDeg, home, Math.min(range, ceiling), last, prev);
    const any = opts.length ? opts : approachOptions(landing, chordDeg, home, range, last, prev);
    if (any.length) return pickWeighted(rngTake, any);
    return landing > 0 ? landing - 1 : landing + 1;
  };

  // cadence landing: the 5th for the half cadence, the tonic for home — exempt from the ceiling,
  // but in the in-range octave under it when there is one, nearest the line
  const cadenceLanding = (role: CellRole, ref: number, ceil: number): number => {
    const fifth = SCALES[scaleId].intervals.indexOf(7);
    const target = role === 'half' && fifth >= 0 ? fifth : 0;
    const octaves: number[] = [];
    for (let d = target; d < range; d += scaleLen) octaves.push(d);
    const under = octaves.filter((d) => d < ceil);
    return (under.length ? under : octaves).reduce((b, d) => (Math.abs(st(d) - st(ref)) < Math.abs(st(b) - st(ref)) ? d : b));
  };

  /** A climax cell straight before the cadence (the 8-step A) rises as a whole until the cadence
   *  fits under its peak — preferring a shift that keeps the strong beat on a chord tone. */
  const roomUnder = (ci: number, rhythm: Onset[], degs: number[]): number[] => {
    const next = plan[ci + 1];
    if (next !== 'cad' && next !== 'half') return degs;
    const chordNext = chordAt(cellStart(ci + 1));
    const fits = (c: number[]) => {
      const top = Math.max(...c);
      const landing = cadenceLanding(next, c[c.length - 1], top);
      if (landing >= top) return false;
      return approachOptions(landing, chordNext, next === 'cad', top, c[c.length - 1], c.length > 1 ? c[c.length - 2] : null).length > 0;
    };
    const strongOk = (c: number[]) =>
      rhythm.every((o, oi) => o.offset !== 0 || !isChordTone(degs[oi], chordAt(cellStart(ci)), scaleLen) || isChordTone(c[oi], chordAt(cellStart(ci)), scaleLen));
    const shifts: number[][] = [];
    for (let t = 0; Math.max(...degs) + t < range; t++) shifts.push(degs.map((d) => d + t));
    return shifts.find((c) => fits(c) && strongOk(c)) ?? shifts.find(fits) ?? degs;
  };


  const emit = (ci: number, rhythm: Onset[], degs: number[]) => {
    rhythm.forEach((o, oi) => {
      const step = cellStart(ci) + o.offset;
      if (step >= ctx.steps) return;
      events.push({
        step,
        degree: degs[oi],
        velocity: o.accent ? 0.92 : step % 4 === 0 ? 0.85 : 0.72,
        lengthSteps: o.length,
      });
      line.push(degs[oi]);
    });
  };

  for (let ci = 0; ci < cellCount; ci++) {
    const role = plan[ci];
    const chordDeg = chordAt(cellStart(ci));
    const climax = ci === climaxCell;
    if (role === 'A' || role === 'Aseq' || role === 'B') {
      const rhythm = role === 'B' ? rhythmB : rhythmA;
      const hiExcl = climax ? range : ceiling;
      let degs: number[] | null;
      if (role === 'A' && !aDegrees.length) {
        degs = freshLine(rngIdea, ci, rhythm, hiExcl, climax);
        if (climax) degs = roomUnder(ci, rhythm, degs);
        aDegrees.push(...degs);
      } else if (role === 'A') {
        degs = fit(ci, rhythm, rhythm.map((_, oi) => aDegrees[oi] ?? aDegrees[aDegrees.length - 1]), hiExcl, RESTATE);
      } else if (role === 'Aseq') {
        // tonal sequence: the whole motif moved along the shape so its strong beat lands on a (new) chord tone
        let shift = seqDir;
        if (rhythmA[0].offset === 0) {
          const a0 = aDegrees[0];
          let snapped = nearestChordTone(a0 + seqDir, chordDeg, scaleLen);
          if (snapped === a0) snapped = nextChordTone(a0, seqDir, chordDeg, scaleLen, range) ?? a0 + seqDir;
          shift = snapped - a0;
        }
        degs = fit(ci, rhythm, aDegrees.map((d) => d + shift), hiExcl, RESTATE, (c) => c.every((d, i) => d === aDegrees[i]));
      } else if (bInverts) {
        // contrast: inversion of the motif around its first note — the TAKE decides details
        const pivot = aDegrees[0];
        const raw = rhythm.map((o, oi) => {
          const inv = 2 * pivot - aDegrees[oi % aDegrees.length] + (rngTake() < 0.25 ? seqDir : 0);
          return (cellStart(ci) + o.offset) % CELL === 0 ? nearestChordTone(inv, chordDeg, scaleLen) : inv;
        });
        degs = climax ? fitClimax(ci, rhythm, raw) : fit(ci, rhythm, raw, hiExcl, RESTATE);
      } else {
        // contrast: a fresh coach line
        const raw = freshLine(rngTake, ci, rhythm, hiExcl);
        degs = climax ? fitClimax(ci, rhythm, raw) : raw;
      }
      const priorMax = line.length ? Math.max(...line) : -1;
      const keep = climax ? (c: number[]) => Math.max(...c) > priorMax : undefined;
      if (degs && cost(ci, rhythm, degs) >= 1) degs = mend(ci, rhythm, degs, hiExcl, keep);
      // a contrast that cannot be placed without a drone or a hanging tritone is re-heard as fresh coach lines
      for (let tries = 0; role === 'B' && tries < 3 && (!degs || cost(ci, rhythm, degs) >= 1); tries++) {
        const raw = freshLine(rngTake, ci, rhythm, hiExcl);
        const alt = climax ? fitClimax(ci, rhythm, raw) : raw;
        if (alt && (!degs || cost(ci, rhythm, alt) < cost(ci, rhythm, degs))) degs = alt;
      }
      if (!degs) {
        degs = freshLine(rngTake, ci, rhythm, hiExcl);
        if (climax) degs = fitClimax(ci, rhythm, degs) ?? degs;
      }
      emit(ci, rhythm, degs);
      if (climax) {
        peak = Math.max(...degs);
        ceiling = peak;
      }
    } else {
      // cadence cell: approach note then a held landing
      const landing = cadenceLanding(role, line.length ? line[line.length - 1] : scaleLen, ceiling);
      emit(ci, rhythmCad, [pickApproach(landing, chordDeg, role === 'cad'), landing]);
      const landed = events[events.length - 1];
      if (landed) landed.lengthSteps = ci === cellCount - 1 ? Math.max(2, ctx.steps - (cellStart(ci) + 2)) : 2;
    }
  }

  // dynamics follow the contour: a crescendo into the climax, the peak accented, the cadences tapering
  const roleAt = (step: number) => plan[Math.floor(step / CELL)];
  const peakIdx = events.findIndex((e) => Math.floor(e.step / CELL) === climaxCell && e.degree === peak);
  if (peakIdx >= 0) {
    for (let j = peakIdx - 1; j >= 0 && events[j].degree < events[j + 1].degree; j--) {
      events[j].velocity = Math.min(0.96, events[j].velocity + 0.08);
    }
    events[peakIdx].velocity = 1;
  }
  for (const e of events) {
    if (roleAt(e.step) === 'half' || roleAt(e.step) === 'cad') e.velocity -= 0.1;
    e.velocity = Math.round(Math.min(1, e.velocity) * 100) / 100;
  }

  // variation pass (Evolve, PRD §5.3): generation n ornaments the theme, never the anchors
  const generation = params.generation ?? 0;
  if (generation > 0) {
    const rngVar = mulberry32(ideaSeed ^ (generation * 0x9e3779b9));
    const occupied = new Set(events.map((e) => e.step));
    const varied = events.map((e) => ({ ...e }));
    const deg = (i: number) => varied[i]?.degree;
    const tritoneInto = (i: number) => i > 0 && isTritone(scaleId, varied[i - 1].degree, varied[i].degree);
    const isLanding = (e: NoteEvent) => (roleAt(e.step) === 'half' || roleAt(e.step) === 'cad') && e.step % CELL === 2;
    // a neighbour tone stays under the peak, off the cadences, and makes no new run or tritone
    const canWiggle = (i: number, d: number): boolean => {
      const cur = varied[i];
      if (d < 0 || d >= (peak >= 0 ? peak : range) || cur.degree === peak) return false;
      if (roleAt(cur.step) === 'half' || roleAt(cur.step) === 'cad' || tritoneInto(i - 1)) return false;
      const a = deg(i - 1);
      const b = deg(i + 1);
      if ((a === d && (deg(i - 2) === d || b === d)) || (b === d && deg(i + 2) === d)) return false;
      if ((a !== undefined && isTritone(scaleId, a, d)) || (b !== undefined && isTritone(scaleId, d, b))) return false;
      return true;
    };
    for (let i = 1; i < varied.length - 1; i++) {
      const cur = varied[i];
      const nxt = varied[i + 1];
      // passing-note ornament into a gap of a third
      if (
        rngVar() < 0.3 &&
        Math.abs(nxt.degree - cur.degree) === 2 &&
        nxt.step - cur.step >= 2 &&
        !occupied.has(cur.step + 1) &&
        !tritoneInto(i) &&
        !isLanding(cur)
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
        const d = cur.degree + (rngVar() < 0.5 ? 1 : -1);
        if (canWiggle(i, d)) cur.degree = d;
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

  // strong beats want chord tones — except the cadence approach, an embellishing scale step into the landing
  const plan = planFor(Math.max(2, Math.floor(ctx.steps / CELL)));
  const isCadence = (step: number) => plan[Math.floor(step / CELL)] === 'half' || plan[Math.floor(step / CELL)] === 'cad';
  const strong = events.filter((e) => e.step % CELL === 0 && !isCadence(e.step));
  const inChord = strong.filter((e) => isChordTone(e.degree, ctx.chordAtStep[e.step], scaleLen)).length;
  score += 26 * (strong.length ? inChord / strong.length : 0);

  // singable flow: mostly steps and thirds (under a 4th), some variety, no monotone.
  // Moves into the cadence notes are the cadence vocabulary's choice, not the flow's.
  let stepwise = 0;
  let moves = 0;
  const distinct = new Set(events.map((e) => e.degree));
  for (let i = 1; i < events.length; i++) {
    if (isCadence(events[i].step)) continue;
    moves++;
    if (Math.abs(degreeSemis(ctx.scaleId, events[i].degree) - degreeSemis(ctx.scaleId, events[i - 1].degree)) < 5) stepwise++;
  }
  score += 22 * (stepwise / Math.max(1, moves));
  if (distinct.size < 3) score -= 25;
  if (distinct.size >= 4) score += 8;
  // a sparse theme (a one-note cell) must not spend half its notes on one pitch
  const counts = new Map<number, number>();
  for (const e of events) counts.set(e.degree, (counts.get(e.degree) ?? 0) + 1);
  if (Math.max(...counts.values()) * 2 >= events.length) score -= 20;

  // no drones, no unresolved tritones, and never a tritone into the final note
  const degrees = events.map((e) => e.degree);
  score -= 12 * Math.max(0, longestRun(degrees) - 2);
  score -= 15 * unresolvedTritones(ctx.scaleId, degrees);
  if (isTritone(ctx.scaleId, degrees[degrees.length - 2], degrees[degrees.length - 1])) score -= 30;

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
