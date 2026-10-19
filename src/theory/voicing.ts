/**
 * Voicing and tessitura (PRD §5.3 layers & voicing): where each role's pitches
 * sit, independent of key. Every role has a fixed pitch window, so a key change
 * or a journey modulation moves the music by at most a few semitones instead of
 * dragging whole registers up and down; chords are voice-led inside theirs.
 *
 * Pure numbers in, MIDI out — src/graph/resolve.ts applies it to a bar.
 */

import { pcOf } from './scales';

export interface PitchWindow {
  lo: number;
  hi: number;
}

/** The melody's tonic sits in this octave (G3..F#4), so the theme's middle lands between F4 and E5 in every key. */
export const MELODY_TONIC: PitchWindow = { lo: 55, hi: 66 };
/** Pad: C3..C5, its top voice under the sounding melody; a low melody may push it down to the voicing floor. */
export const CHORD_WINDOW: PitchWindow = { lo: 48, hi: 72 };
/** Bass: every note E1..D3; chord roots on the changes G1..G2, where the fundamental stays 49-98 Hz. */
export const BASS_WINDOW: PitchWindow = { lo: 28, hi: 50 };
export const BASS_ROOT_WINDOW: PitchWindow = { lo: 31, hi: 43 };
/** Arp: C5..A6, just above the lead. */
export const ARP_WINDOW: PitchWindow = { lo: 72, hi: 93 };

export const shiftWindow = (w: PitchWindow, semis: number): PitchWindow => ({ lo: w.lo + semis, hi: w.hi + semis });

/** The melody tonic's MIDI note in a key: the one placement of its pitch class inside MELODY_TONIC. */
export function melodyTonic(keyIndex: number): number {
  const { lo } = MELODY_TONIC;
  return lo + pcOf(keyIndex - lo);
}

/** Placements of a pitch class inside a window, low to high. */
export function placements(pc: number, w: PitchWindow): number[] {
  const out: number[] = [];
  for (let m = w.lo + pcOf(pc - w.lo); m <= w.hi; m += 12) out.push(m);
  return out;
}

/** Fold a note into a window (at least an octave wide) by octaves. */
export function foldInto(midi: number, w: PitchWindow): number {
  let m = midi;
  while (m > w.hi) m -= 12;
  while (m < w.lo) m += 12;
  return m;
}

// ---------------------------------------------------------------------------
// chords
// ---------------------------------------------------------------------------

const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
const topOf = (v: number[]) => v[v.length - 1];

export type ChordSpread = 'close' | 'open' | 'rootless';
export const CHORD_SPREADS: ChordSpread[] = ['close', 'open', 'rootless'];

/** One chord to voice: its tones and the ceiling the melody leaves it. */
export interface ChordSlot {
  /** absolute pitch classes, root first (triad, plus colour tones) */
  pcs: number[];
  rootPc: number;
  /** stacked fourths: the stack as built is preferred over its rotations (fourths and seconds) */
  quartal?: boolean;
  /** highest MIDI note the top voice may take (the sounding melody minus a semitone) */
  ceil?: number;
  /** lowest MIDI note any voice may take (above the bass root it sounds over) */
  floor?: number;
}

export interface VoiceOpts {
  window: PitchWindow;
  spread?: ChordSpread;
  /** lowest note any voice may take; default an octave under the window */
  floor?: number;
  /** the bass plays the roots: a pad voicing with the root at the bottom doubles it */
  bassHasRoot?: boolean;
  /** voicing the phrase continues from (voice leading carries over); null starts the phrase */
  prev?: number[] | null;
  /** the slots repeat (a loop): the last chord also leads back into the first */
  cyclic?: boolean;
}

/** close position of `pcs` over its first tone, as offsets above it */
function closeOffsets(pcs: number[]): number[] {
  const out = [0];
  for (let i = 1; i < pcs.length; i++) {
    let o = pcOf(pcs[i] - pcs[0]);
    while (o <= out[out.length - 1]) o += 12;
    out.push(o);
  }
  return out;
}

interface Shape {
  bottomPc: number;
  offsets: number[];
  /** close spacing inside an open spread: fine from C4 up, a last resort below */
  highOnly?: boolean;
  extra?: number;
}

function shapesOf(slot: ChordSlot, spread: ChordSpread): Shape[] {
  if (slot.quartal) {
    // the stack as built, root at the bottom; its rotations mix fourths and seconds
    return slot.pcs.map((p, i) => ({ bottomPc: p, offsets: closeOffsets([...slot.pcs.slice(i), ...slot.pcs.slice(0, i)]), extra: i ? 2 : 0 }));
  }
  let tones = [...new Set(slot.pcs)];
  // rootless: the bass has the root (a triad becomes its 3rd and 5th)
  if (spread === 'rootless' && tones.length > 2) tones = tones.filter((p) => p !== slot.rootPc);
  const shapes: Shape[] = tones.map((p, i) => ({ bottomPc: p, offsets: closeOffsets([...tones.slice(i), ...tones.slice(0, i)]) }));
  if (spread !== 'open' || tones.length < 3) return shapes;
  // drop-2: the second voice from the top an octave down
  const drop2 = shapes.map((s) => {
    const k = s.offsets.length - 2;
    const dropped = s.offsets[k] - 12;
    const offsets = [dropped, ...s.offsets.slice(0, k), ...s.offsets.slice(k + 1)].map((o) => o - dropped);
    return { bottomPc: pcOf(s.bottomPc + dropped), offsets };
  });
  return [...drop2, ...shapes.map((s) => ({ ...s, highOnly: true }))];
}

interface Candidate {
  notes: number[];
  /** a fallback shape's extra cost */
  extra: number;
}

/** Every voicing of a slot between `floor` and the window's top, low to high. */
function candidatesOf(slot: ChordSlot, window: PitchWindow, spread: ChordSpread, floorAll: number): Candidate[] {
  const floor = Math.max(floorAll, slot.floor ?? -Infinity);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const shape of shapesOf(slot, spread)) {
    const top = shape.offsets[shape.offsets.length - 1];
    for (const m of placements(shape.bottomPc, { lo: floor, hi: window.hi - top })) {
      const notes = shape.offsets.map((o) => m + o);
      const key = notes.join();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ notes, extra: (shape.extra ?? 0) + (shape.highOnly && m < 60 ? 6 : 0) });
    }
  }
  return out.sort((a, b) => a.notes[0] - b.notes[0] || topOf(a.notes) - topOf(b.notes));
}

/** Every voicing of a slot whose top fits the window (the bottom may dip up to an octave under it), low to high. */
export function chordCandidates(slot: ChordSlot, window: PitchWindow, spread: ChordSpread = 'close', floor = window.lo - 12): number[][] {
  return candidatesOf(slot, window, spread, floor).map((c) => c.notes);
}

/** Semitones the voices move from `a` to `b` (matched low to high), plus a top-voice leap penalty. */
export function motionCost(a: number[], b: number[]): number {
  const x = sorted(a);
  const y = sorted(b);
  const k = Math.min(x.length, y.length);
  let sum = 3 * Math.abs(x.length - y.length);
  for (let i = 0; i < k; i++) sum += Math.abs(x[i] - y[i]);
  if (Math.abs(topOf(x) - topOf(y)) > 4) sum += 4;
  return sum;
}

/** How well a voicing sits on its own: inside the window, under the melody, not doubling the bass root. */
function placementCost(v: number[], slot: ChordSlot, opts: VoiceOpts): number {
  const { lo } = opts.window;
  const top = topOf(v);
  let cost = 0;
  if (v[0] < lo) cost += 2 * (lo - v[0]);
  if (slot.ceil !== undefined) {
    if (top > slot.ceil) cost += 200 + 10 * (top - slot.ceil);
    else if (top > slot.ceil - 2) cost += 2;
  }
  if (opts.bassHasRoot && !slot.quartal && pcOf(v[0]) === slot.rootPc) cost += 3;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  cost += 0.15 * Math.abs(mean - (lo + 10));
  return cost;
}

/**
 * Voice-led chords: of every inversion and octave placement in the window, the
 * sequence with the least total voice motion (common tones held, the rest by
 * step), each top voice under the melody's ceiling. Without `prev` the phrase
 * starts fresh; `cyclic` also scores the move from the last chord back to the
 * first, so a repeating progression loops as smoothly as it moves.
 */
export function voiceChords(slots: ChordSlot[], opts: VoiceOpts): number[][] {
  if (!slots.length) return [];
  const spread = opts.spread ?? 'close';
  const floor = opts.floor ?? opts.window.lo - 12;
  const found = slots.map((s) => {
    const c = candidatesOf(s, opts.window, spread, floor);
    return c.length ? c : candidatesOf(s, { lo: opts.window.lo, hi: opts.window.hi + 12 }, spread, floor);
  });
  const cands = found.map((cs) => cs.map((c) => c.notes));
  const unary = found.map((cs, i) => cs.map((c) => c.extra + placementCost(c.notes, slots[i], opts)));
  const prev = opts.prev?.length ? opts.prev : null;

  /** Viterbi over the slots; `first` pins slot 0 to one candidate */
  const solve = (first: number | null) => {
    let cost = cands[0].map((v, j) =>
      first !== null && j !== first ? Infinity : unary[0][j] + (prev ? motionCost(prev, v) : 0),
    );
    const back: number[][] = [];
    for (let i = 1; i < slots.length; i++) {
      const next: number[] = [];
      const from: number[] = [];
      cands[i].forEach((v, j) => {
        let best = Infinity;
        let arg = 0;
        cands[i - 1].forEach((u, k) => {
          const c = cost[k] + motionCost(u, v);
          if (c < best) {
            best = c;
            arg = k;
          }
        });
        next.push(best + unary[i][j]);
        from.push(arg);
      });
      back.push(from);
      cost = next;
    }
    return { cost, back };
  };

  const trace = (back: number[][], last: number) => {
    const idx = [last];
    for (let i = back.length - 1; i >= 0; i--) idx.unshift(back[i][idx[0]]);
    return idx.map((j, i) => cands[i][j]);
  };

  if (!opts.cyclic || prev) {
    const { cost, back } = solve(null);
    return trace(back, argmin(cost));
  }
  let best = Infinity;
  let path: number[][] = [];
  for (let s = 0; s < cands[0].length; s++) {
    const { cost, back } = solve(s);
    const total = cost.map((c, j) => c + (slots.length > 1 ? motionCost(cands[slots.length - 1][j], cands[0][s]) : 0));
    const j = argmin(total);
    if (total[j] < best) {
      best = total[j];
      path = trace(back, j);
    }
  }
  return path;
}

function argmin(xs: number[]): number {
  let j = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[j]) j = i;
  return j;
}

// ---------------------------------------------------------------------------
// bass
// ---------------------------------------------------------------------------

/**
 * The next chord root in the root window: the placement nearest the previous
 * root, a falling fifth or rising fourth counting as two semitones closer; the
 * first root of a phrase takes the one nearest the window's middle (the lower on a tie).
 */
export function placeBassRoot(pc: number, prevRoot: number | null, w: PitchWindow = BASS_ROOT_WINDOW): number {
  const opts = placements(pc, w);
  if (!opts.length) return foldInto(pc + 36, w);
  const ref = prevRoot ?? (w.lo + w.hi) / 2;
  const cost = (m: number) => {
    const d = m - ref;
    return Math.abs(d) - (prevRoot !== null && (d === -7 || d === 5) ? 2 : 0);
  };
  return opts.reduce((best, m) => (cost(m) < cost(best) ? m : best));
}

/** A bass note that is not the root on a change: its pitch class near `target`, inside the window, under the pad. */
export function placeBassNote(
  pc: number,
  target: number,
  limits: { below: number; near: number[] },
  w: PitchWindow = BASS_WINDOW,
): number {
  const all = placements(pc, w);
  if (!all.length) return foldInto(target, w);
  const ok = (m: number) => m < limits.below;
  const close = (m: number) => limits.near.every((r) => Math.abs(m - r) <= 12);
  const pool = [all.filter((m) => ok(m) && close(m)), all.filter(ok), all].find((p) => p.length)!;
  return pool.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best));
}

// ---------------------------------------------------------------------------
// arp
// ---------------------------------------------------------------------------

/**
 * One chord's run of arp notes moved by whole octaves into the window: the
 * octave that needs the fewest folds, its first note nearest `ref` (the last
 * arp note, or the window's lower middle at a phrase start); a note still
 * outside folds back by an octave.
 */
export function placeArpRun(naturals: number[], ref: number | null, w: PitchWindow = ARP_WINDOW): number[] {
  if (!naturals.length) return [];
  const anchor = ref ?? w.lo + 7;
  const first = naturals[0];
  let bestShift = 0;
  let bestCost = Infinity;
  for (const m of placements(pcOf(first), w)) {
    const shift = m - first;
    const folds = naturals.filter((n) => n + shift < w.lo || n + shift > w.hi).length;
    const cost = 6 * folds + Math.abs(m - anchor);
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  return naturals.map((n) => foldInto(n + bestShift, w));
}
