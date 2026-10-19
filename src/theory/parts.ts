/** Bass, Chords, Arp generators — followers of the harmonic context (PRD §5.2). */

import { chordAt, chordSemis, isChangeAt, type HarmonicContext } from './harmony';
import { mulberry32, pickWeighted } from './rng';
import type { NoteEvent } from './melody';
import { SCALES, parentScale, pcOf, scalePcs } from './scales';

export interface PartParams {
  seed: number;
  density: number; // 0..1
  register: number; // octave offset
}

export interface BassParams extends PartParams {
  /** kick steps of the drum part: when given, bass onsets lock to the kick */
  kickSteps?: readonly number[];
  /** gate as a fraction of the gap to the next bass onset (0.95 legato … 0.5 staccato), clamped to 0.1..1 */
  articulation?: number;
}

/** Lowest/highest bass pitch, in semitones from the tonic at the bass octave (G1..C3 in C). */
const BASS_LOW = -5;
const BASS_HIGH = 12;

/**
 * Bass: monophonic foundation, in parent-mode degrees (the key collection). The
 * chord root always lands on step 0 and on every chord change; density only adds
 * the notes in between (weighted onto the kick when kickSteps hold any kick): the
 * root, the chord's perfect fifth (its next tone when it has none) and the octave,
 * plus a diatonic approach tone, inside the bass range, on the 16th before each
 * change. Every pitch is fixed by the root chain, not by which other notes fired,
 * so raising density only adds notes.
 */
export function generateBass(ctx: HarmonicContext, params: BassParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const iv = SCALES[parentScale(ctx.scaleId)].intervals;
  const len = iv.length;
  const semis = (deg: number) => iv[((deg % len) + len) % len] + 12 * Math.floor(deg / len);
  const inRange = (deg: number) => semis(deg) >= BASS_LOW && semis(deg) <= BASS_HIGH;
  /** the octave placement of `deg` inside the bass range nearest to `target` semitones */
  const place = (deg: number, target: number) => {
    const base = ((deg % len) + len) % len;
    let best = base;
    for (const cand of [base - len, base, base + len]) {
      if (inRange(cand) && (!inRange(best) || Math.abs(semis(cand) - target) < Math.abs(semis(best) - target))) best = cand;
    }
    return best;
  };
  const kicks = params.kickSteps?.length ? new Set(params.kickSteps) : null;
  const d = params.density;
  const steps = ctx.steps;

  // root chain: each chord root placed nearest the previous one, density-independent
  const segStarts: number[] = [];
  for (let s = 0; s < steps; s++) if (isChangeAt(ctx, s)) segStarts.push(s);
  const roots: number[] = [];
  const fifthStep: number[] = [];
  for (const s of segStarts) {
    const chord = chordAt(ctx, s);
    roots.push(roots.length ? place(chord.degree, semis(roots[roots.length - 1])) : chord.degree);
    // the perfect fifth when the chord has one, else the chord's next tone above the root
    const tones = chordSemis(ctx.scaleId, chord.degree, ctx.colour);
    const fifth = tones.find((t) => t - tones[0] === 7) ?? tones[1];
    fifthStep.push(iv.indexOf(pcOf(fifth)) - chord.degree);
  }
  const segOf = (s: number) => {
    let i = 0;
    while (i + 1 < segStarts.length && segStarts[i + 1] <= s) i++;
    return i;
  };
  // after the last segment the loop restarts on the first root
  const nextRootOf = (seg: number) => (seg + 1 < roots.length ? roots[seg + 1] : roots[0]);
  const nextChangeOf = (seg: number) => (seg + 1 < segStarts.length ? segStarts[seg + 1] : steps);
  const near = (a: number, b: number) => Math.abs(semis(a) - semis(b)) <= 12;

  const pApproach = 0.3 + 0.4 * d;
  const onsets: Array<{ step: number; degree: number; velocity: number; passing?: true }> = [];
  for (let s = 0; s < steps; s++) {
    const rOn = rng();
    const rPick = rng();
    const seg = segOf(s);
    const root = roots[seg];
    const next = nextRootOf(seg);
    if (s === segStarts[seg]) {
      onsets.push({ step: s, degree: root, velocity: 0.95 });
      continue;
    }
    if (s === nextChangeOf(seg) - 1) {
      if (rOn >= pApproach) continue;
      // diatonic neighbour of the next root; the other side when the seeded one would leap past an octave
      const order = rPick < 0.5 ? [next - 1, next + 1] : [next + 1, next - 1];
      const segNotes = segmentNotes(seg, root, next);
      const fit = order.find((a) => inRange(a) && segNotes.every((x) => x === undefined || near(a, x)));
      if (fit !== undefined) onsets.push({ step: s, degree: fit, velocity: 0.7, passing: true });
      continue;
    }
    let p = (s % 4 === 0 ? 0.6 : s % 2 === 0 ? 0.3 : 0.12) * (0.3 + 0.9 * d);
    if (kicks) p *= kicks.has(s) ? 1.8 : 0.35;
    if (rOn >= Math.min(1, p)) continue;
    const [fifth, octave] = segmentNotes(seg, root, next).slice(1);
    const pick = pickWeighted(() => rPick, [
      [root, 5],
      [fifth ?? root, fifth === undefined ? 0 : 1.6],
      [octave ?? root, octave === undefined ? 0 : 0.4],
    ]);
    onsets.push({ step: s, degree: pick, velocity: kicks?.has(s) ? 0.85 : 0.75 });
  }

  /** root, then the fifth and octave when they fit the range and stay within an octave of the next root */
  function segmentNotes(seg: number, root: number, next: number): [number, number | undefined, number | undefined] {
    const top = root + ((fifthStep[seg] % len) + len) % len;
    const fifth = [top, top - len].find((x) => inRange(x) && near(x, next));
    const octave = [root + len, root - len].find((x) => inRange(x) && near(x, next) && (fifth === undefined || near(x, fifth)));
    return [root, fifth, octave];
  }

  const articulation = Math.max(0.1, Math.min(1, params.articulation ?? 0.95));
  return onsets.map((o, i) => {
    const gap = (i + 1 < onsets.length ? onsets[i + 1].step : steps) - o.step;
    const ev: NoteEvent = { step: o.step, degree: o.degree, velocity: o.velocity, lengthSteps: Math.round(gap * articulation * 100) / 100 };
    if (o.passing) ev.passing = true;
    return ev;
  });
}

/** Chords: comping — the chord struck on every change plus occasional pushes, each held no further
 *  than the next change. degree = the chord's root in the parent mode; tones come from the context's colour. */
export function generateChords(ctx: HarmonicContext, params: PartParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = [];
  for (let s = 0; s < ctx.steps; s++) {
    const slot = ctx.chordIdxAtStep[s];
    const isChange = isChangeAt(ctx, s);
    const p = isChange ? 1 : s % 8 === 4 ? 0.25 + params.density * 0.5 : params.density * 0.12;
    if (rng() >= p) continue;
    let len = 1;
    for (let k = s + 1; k < ctx.steps && ctx.chordIdxAtStep[k] === slot && k - s < 8; k++) len = k - s + 1;
    const prev = events[events.length - 1];
    if (prev) prev.lengthSteps = Math.min(prev.lengthSteps, s - prev.step);
    events.push({ step: s, degree: chordAt(ctx, s).degree, velocity: isChange ? 0.8 : 0.6, lengthSteps: len });
  }
  return events;
}

/** Arp patterns as indices into the chord tones it plays (root first, ascending); an index past the last tone wraps an octave up. */
const ARP_PATTERNS: Array<[number[], number]> = [
  [[0, 1, 2, 3], 2], // up
  [[3, 2, 1, 0], 1], // down
  [[0, 2, 1, 3], 1.2], // skip
  [[0, 1, 2, 1], 1.4], // up-back
];

/** Arp: runs over the current chord's tones, direction-seeded, ornament density. It plays only the
 *  chord tones inside the live scale (a pentatonic filter drops the parent-mode ones, which the
 *  pad still sounds), so it stays in the melody's note set and never rubs against the chord; its
 *  degrees are live-scale degrees. */
export function generateArp(ctx: HarmonicContext, params: PartParams): NoteEvent[] {
  const rng = mulberry32(params.seed);
  const events: NoteEvent[] = [];
  const pattern = pickWeighted(rng, ARP_PATTERNS);
  const iv = SCALES[ctx.scaleId].intervals;
  const len = iv.length;
  const filter = new Set(scalePcs(0, ctx.scaleId));
  /** semitones above the tonic (a filter tone) → live-scale degree */
  const toDegree = (t: number) => iv.indexOf(pcOf(t)) + len * Math.floor(t / 12);
  for (let s = 0; s < ctx.steps; s++) {
    const p = (0.2 + params.density * 0.85) * (s % 2 === 0 ? 1 : 0.75);
    if (rng() >= p) continue;
    const all = chordSemis(ctx.scaleId, chordAt(ctx, s).degree, ctx.colour);
    let tones = all.filter((t) => filter.has(pcOf(t)));
    // every palette chord keeps two filter tones; a frozen or foreign root falls back to its nearest one
    if (!tones.length) tones = [[0, -1, 1, -2, 2].map((d) => all[0] + d).find((t) => filter.has(pcOf(t)))!];
    // with the root dropped, the run starts in the root's octave rather than one above
    const base = 12 * Math.floor(tones[0] / 12);
    tones = tones.map((t) => t - base);
    const k = pattern[s % pattern.length];
    const t = tones[k % tones.length] + 12 * Math.floor(k / tones.length);
    events.push({ step: s, degree: toDegree(t), velocity: 0.55 + (s % 4 === 0 ? 0.2 : 0), lengthSteps: 1 });
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

/** hat accent per 16th of a beat (1 e & a) */
const HAT_ACCENT = [0.75, 0.35, 0.55, 0.35];
/** ghost-snare slots: the e/a around the backbeats, never beat 1 */
const GHOST_STEPS = new Set([3, 7, 9, 15]);
const ramp = (x: number, from: number, to: number) => Math.min(1, Math.max(0, (x - from) / (to - from)));
const vel = (v: number) => Math.round(Math.min(1, v) * 100) / 100;

/**
 * Drums: a protected skeleton (kick on 1, snare on 2 and 4) plus ornaments.
 * Lowering density removes the least important layer first: 16th hats,
 * ghost snares, syncopated kicks, the 8th hats, and below density 0.15 whole
 * bars, skeleton included, so nothing ever plays in a bar without its
 * downbeat. Fixed draws per step (hits, velocities) and per bar (gate)
 * regardless of outcome, so patterns nest across densities and velocities
 * never move.
 */
export function generateDrums(ctx: HarmonicContext, params: DrumParams): DrumEvent[] {
  const rng = mulberry32(params.seed);
  const jitter = mulberry32(params.seed ^ 0x5bd1e995);
  const d = params.density;
  const sync = params.syncopation;
  const gate = mulberry32(params.seed ^ 0x27d4eb2f);
  const pBar = Math.min(1, d / 0.15);
  const pKick3 = 0.85 * (0.6 + 0.4 * d);
  const pSync = ramp(d, 0.05, 0.55);
  const pGhost = 0.35 * ramp(d, 0.15, 0.75);
  const pHat8 = 0.35 + 0.6 * d;
  const pHat16 = Math.max(0, 1.2 * d - 0.3);
  const events: DrumEvent[] = [];
  const bar = 16; // pattern thinks in 16ths within the loop
  let barOn = false;
  for (let s = 0; s < ctx.steps; s++) {
    const pos = s % bar;
    if (pos === 0) barOn = gate() < pBar;
    const jk = (jitter() - 0.5) * 0.1;
    const js = (jitter() - 0.5) * 0.1;
    const jh = (jitter() - 0.5) * 0.1;
    const backbeat = pos === 4 || pos === 12;
    const on = barOn ? 1 : 0;
    const pKick = on * (pos === 0 ? 1 : pos === 8 ? pKick3 : (pos === 6 || pos === 10 ? sync * 0.5 : 0.02 + sync * 0.08) * pSync);
    const pSnare = on * (backbeat ? 1 : pos === 14 ? sync * 0.35 * pSync : GHOST_STEPS.has(pos) ? pGhost : 0);
    const pHat = on * (pos % 2 === 0 ? pHat8 : pHat16);
    if (rng() < pKick) events.push({ step: s, lane: 0, velocity: vel((pos === 0 ? 1 : pos === 8 ? 0.9 : 0.8) + jk) });
    if (rng() < pSnare) events.push({ step: s, lane: 1, velocity: vel((backbeat ? 0.9 : pos === 14 ? 0.6 : 0.25) + js) });
    if (rng() < pHat) events.push({ step: s, lane: 2, velocity: vel(HAT_ACCENT[pos % 4] + jh) });
  }
  return events;
}
