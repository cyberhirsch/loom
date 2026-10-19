/**
 * Diatonic harmony (PRD §5.3): pitch-class chords built in the parent mode,
 * per-mode functional progressions (tonic / subdominant / dominant) that close
 * on a modal cadence, and key journeys.
 *
 * A pentatonic scale is a melodic filter over its parent mode: its chords are
 * real triads of the parent (C minor pent → Cm, Eb, Fm, Gm, Bb, Ab), while the
 * melody and arp stay inside the five notes.
 */

import { SCALES, degreeToMidi, parentScale, pcOf, type ScaleId } from './scales';
import { mulberry32, pickWeighted, type Rng } from './rng';

export type ChordFunc = 'T' | 'S' | 'D';
export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug' | 'quartal';
/** How chords are built on their root: parent-mode triads (default), triads plus the
 *  diatonic 7th, or stacked fourths (the old pentatonic sound, now opt-in). */
export type ChordColour = 'triad' | '7th' | 'quartal';
export const CHORD_COLOURS: ChordColour[] = ['triad', '7th', 'quartal'];

export interface Chord {
  /** root degree in the parent mode (0..6) */
  degree: number;
  rootPc: number;
  /** absolute pitch classes, root first: the triad (or the quartal stack) */
  pcs: number[];
  quality: ChordQuality;
  func: ChordFunc;
  roman: string;
  /** colour tones above the chord (the 7th), absolute pitch classes */
  ext?: number[];
}

export interface HarmonicContext {
  keyIndex: number; // 0..11, C = 0
  scaleId: ScaleId;
  steps: number; // steps per loop (16)
  colour: ChordColour;
  /** the progression, one chord per slot */
  chords: Chord[];
  /** index into `chords` sounding at each step */
  chordIdxAtStep: number[];
}

type Heptatonic = 'ionian' | 'aeolian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian';

interface ModeHarmony {
  /** [parent degree, weight] per function; the mode's diminished triad is in none of them */
  T: Array<[number, number]>;
  S: Array<[number, number]>;
  D: Array<[number, number]>;
  /** cadences as the chords before the tonic arrival (the loop restart supplies the tonic) */
  cadences: Array<[number[], number]>;
  /** dominant may fall back to subdominant (modal/rock retrogression) */
  retro: boolean;
}

const MODE_HARMONY: Record<Heptatonic, ModeHarmony> = {
  ionian: {
    T: [[0, 1], [5, 0.8], [2, 0.25]],
    S: [[3, 1], [1, 0.7]],
    D: [[4, 1]],
    cadences: [[[4], 1], [[3], 0.6], [[1, 4], 0.8]],
    retro: false,
  },
  aeolian: {
    T: [[0, 1], [2, 0.7]],
    S: [[3, 0.8], [5, 1]],
    D: [[4, 0.5], [6, 1]],
    cadences: [[[5, 6], 1], [[6], 0.8], [[3], 0.6]],
    retro: true,
  },
  dorian: {
    T: [[0, 1], [2, 0.6]],
    S: [[3, 1], [1, 0.7]],
    D: [[4, 0.6], [6, 1]],
    cadences: [[[3], 1], [[6], 0.8]],
    retro: true,
  },
  phrygian: {
    T: [[0, 1]],
    S: [[3, 0.8], [5, 1]],
    D: [[1, 1], [6, 0.7]],
    cadences: [[[1], 1]],
    retro: false,
  },
  lydian: {
    T: [[0, 1], [5, 0.7]],
    S: [[1, 1], [2, 0.6]],
    D: [[4, 1], [6, 0.5]],
    cadences: [[[1], 1]],
    retro: false,
  },
  mixolydian: {
    T: [[0, 1]],
    S: [[3, 1], [1, 0.6]],
    D: [[6, 1], [4, 0.6]],
    cadences: [[[6], 1], [[3], 0.7]],
    retro: true,
  },
};

/** Pentatonic palettes: weight multipliers over the parent's chords (absent = never). Every
 *  chord kept shares at least two pitch classes with the pentatonic the melody plays. */
const PENTA_PALETTE: Partial<Record<ScaleId, Record<number, number>>> = {
  minor_pent: { 0: 1, 2: 1, 3: 1, 4: 1, 6: 1, 5: 0.3 },
  major_pent: { 0: 1, 1: 1, 3: 1, 4: 1, 5: 1 },
};

const FUNC_NEXT: Record<ChordFunc, Array<[ChordFunc, number]>> = {
  T: [['S', 0.45], ['D', 0.2], ['T', 0.35]],
  S: [['D', 0.55], ['T', 0.25], ['S', 0.2]],
  D: [['T', 0.75], ['S', 0.25]],
};

/** The scale's functional chord table: [degree, weight] per function, pentatonic palette applied. */
export function chordPalette(scaleId: ScaleId): Record<ChordFunc, Array<[number, number]>> {
  const mode = MODE_HARMONY[parentScale(scaleId) as Heptatonic];
  const pal = PENTA_PALETTE[scaleId];
  const keep = (list: Array<[number, number]>) =>
    list.flatMap(([d, w]): Array<[number, number]> => {
      if (!pal) return [[d, w]];
      return pal[d] === undefined ? [] : [[d, w * pal[d]]];
    });
  return { T: keep(mode.T), S: keep(mode.S), D: keep(mode.D) };
}

/** The scale's cadences (chords before the tonic), restricted to its palette. */
export function cadenceTable(scaleId: ScaleId): Array<[number[], number]> {
  const pal = PENTA_PALETTE[scaleId];
  return MODE_HARMONY[parentScale(scaleId) as Heptatonic].cadences.flatMap(([c, w]): Array<[number[], number]> => {
    if (!pal) return [[c, w]];
    if (c.some((d) => pal[d] === undefined)) return [];
    return [[c, c.reduce((acc, d) => acc * pal[d], w)]];
  });
}

export function functionOf(scaleId: ScaleId, degree: number): ChordFunc {
  const pal = chordPalette(scaleId);
  for (const f of ['T', 'S', 'D'] as ChordFunc[]) if (pal[f].some(([d]) => d === degree)) return f;
  // only reachable for frozen takes on chords outside the palette
  return degree === 0 ? 'T' : 'S';
}

/**
 * Seeded progression of `length` chords (parent-mode root degrees): opens on the tonic,
 * walks a function chain (T→S→D→T) with no chord repeated back to back, and ends on one
 * of the mode's cadences. Open (the default), the progression stops on the cadence's last
 * chord before the tonic and resolves into the next downbeat (the loop restart); closed
 * (3 chords and up), the cadence arrives on the tonic in the last slot.
 */
export function generateProgression(seed: number, scaleId: ScaleId, length = 4, close = false): number[] {
  const n = Math.max(1, Math.round(length));
  const rng = mulberry32(seed);
  const pal = chordPalette(scaleId);
  const retro = MODE_HARMONY[parentScale(scaleId) as Heptatonic].retro;
  const full = pickWeighted(rng, cadenceTable(scaleId));
  const tail = close && n >= 3 ? 1 : 0;
  const room = n - 1 - tail;
  const cadence = full.slice(Math.max(0, full.length - room));
  const prog: number[] = [0];
  const middle = room - cadence.length;
  for (let i = 0; i < middle; i++) {
    const prev = prog[prog.length - 1];
    const avoid = new Set([prev]);
    const last = i === middle - 1;
    const next = cadence.length ? cadence[0] : 0;
    if (last) avoid.add(next);
    prog.push(pickNext(rng, pal, functionOf(scaleId, prev), avoid, retro, last ? functionOf(scaleId, next) : undefined));
  }
  prog.push(...cadence);
  if (tail) prog.push(0);
  return prog;
}

const transition = (from: ChordFunc, to: ChordFunc, retro: boolean) =>
  from === 'D' && to === 'S' && !retro ? 0 : (FUNC_NEXT[from].find(([f]) => f === to)?.[1] ?? 0);

/** The next chord after a `from`-function chord; with `into`, the chain must also lead into that function. */
function pickNext(
  rng: Rng,
  pal: Record<ChordFunc, Array<[number, number]>>,
  from: ChordFunc,
  avoid: Set<number>,
  retro: boolean,
  into?: ChordFunc,
): number {
  const options: Array<[number, number]> = [];
  for (const [f] of FUNC_NEXT[from]) {
    const pf = transition(from, f, retro) * (into ? transition(f, into, retro) : 1);
    const cands = pal[f].filter(([d]) => !avoid.has(d));
    const total = cands.reduce((a, [, w]) => a + w, 0);
    if (pf > 0) for (const [d, w] of cands) options.push([d, (pf * w) / total]);
  }
  if (options.length) return pickWeighted(rng, options);
  // a dominant whose only resolution is avoided: any palette chord that is not
  const any = (['T', 'S', 'D'] as ChordFunc[]).flatMap((f) => pal[f]).filter(([d]) => !avoid.has(d));
  return any.length ? pickWeighted(rng, any) : 0;
}

/** Map each step to its progression slot (slots of equal length). */
export function progressionToSteps(slots: number, steps: number): number[] {
  const out = new Array<number>(steps);
  const section = Math.max(1, Math.floor(steps / slots));
  for (let s = 0; s < steps; s++) out[s] = Math.min(slots - 1, Math.floor(s / section));
  return out;
}

/** Chord tones of the chord on parent degree `degree`, in semitones above the tonic, ascending from the root. */
export function chordSemis(scaleId: ScaleId, degree: number, colour: ChordColour = 'triad'): number[] {
  const parent = parentScale(scaleId);
  const st = (d: number) => degreeToMidi(0, parent, d) - 60;
  if (colour === 'quartal') {
    // stacked diatonic fourths; the one augmented fourth of the mode gives way to a major third
    const inKey = new Set(SCALES[parent].intervals);
    const out = [st(degree)];
    while (out.length < 3) {
      const top = out[out.length - 1];
      out.push(inKey.has((((top + 5) % 12) + 12) % 12) ? top + 5 : top + 4);
    }
    return out;
  }
  const degs = colour === '7th' ? [0, 2, 4, 6] : [0, 2, 4];
  return degs.map((k) => st(degree + k));
}

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const IONIAN = SCALES.ionian.intervals;

function qualityOf(semis: number[], colour: ChordColour): ChordQuality {
  if (colour === 'quartal') return 'quartal';
  const third = semis[1] - semis[0];
  const fifth = semis[2] - semis[0];
  if (fifth === 6) return 'dim';
  if (fifth === 8) return 'aug';
  return third === 3 ? 'min' : 'maj';
}

/** The chord on a parent-mode degree, with its pitch classes, quality, function and roman numeral. */
export function makeChord(keyIndex: number, scaleId: ScaleId, degree: number, colour: ChordColour = 'triad'): Chord {
  const d = ((degree % 7) + 7) % 7;
  const tones = chordSemis(scaleId, d, colour);
  const triad = colour === '7th' ? tones.slice(0, 3) : tones;
  const quality = qualityOf(triad, colour);
  const acc = tones[0] - IONIAN[d];
  const numeral = quality === 'min' || quality === 'dim' ? NUMERALS[d].toLowerCase() : NUMERALS[d];
  const chord: Chord = {
    degree: d,
    rootPc: pcOf(keyIndex + tones[0]),
    pcs: triad.map((t) => pcOf(keyIndex + t)),
    quality,
    func: functionOf(scaleId, d),
    roman: (acc < 0 ? 'b' : acc > 0 ? '#' : '') + numeral + (quality === 'dim' ? '°' : quality === 'aug' ? '+' : ''),
  };
  if (colour === '7th') chord.ext = [pcOf(keyIndex + tones[3])];
  return chord;
}

/** A context from explicit progression degrees (one slot each). */
export function contextFromDegrees(
  keyIndex: number,
  scaleId: ScaleId,
  steps: number,
  degrees: number[],
  colour: ChordColour = 'triad',
): HarmonicContext {
  return {
    keyIndex,
    scaleId,
    steps,
    colour,
    chords: degrees.map((d) => makeChord(keyIndex, scaleId, d, colour)),
    chordIdxAtStep: progressionToSteps(degrees.length, steps),
  };
}

/** The shared harmonic context: the Chords player's seed picks the progression (harmony-first). */
export function buildContext(
  keyIndex: number,
  scaleId: ScaleId,
  steps: number,
  chordsSeed: number,
  colour: ChordColour = 'triad',
): HarmonicContext {
  return contextFromDegrees(keyIndex, scaleId, steps, generateProgression(chordsSeed, scaleId), colour);
}

export function chordAt(ctx: HarmonicContext, step: number): Chord {
  const s = Math.max(0, Math.min(ctx.steps - 1, step));
  return ctx.chords[ctx.chordIdxAtStep[s]];
}

export const isChangeAt = (ctx: HarmonicContext, s: number) => s === 0 || ctx.chordIdxAtStep[s] !== ctx.chordIdxAtStep[s - 1];

/** Is live-scale `degree` a tone of the chord sounding at `step`? (pitch-class membership) */
export function isChordToneAt(ctx: HarmonicContext, step: number, degree: number): boolean {
  return chordAt(ctx, step).pcs.includes(pcOf(degreeToMidi(ctx.keyIndex, ctx.scaleId, degree)));
}

export type PitchedRole = 'melody' | 'chords' | 'bass' | 'arp';

/** The scale a role's degrees count in: chords and bass speak the parent mode (the key
 *  collection), melody and arp the live scale (the pentatonic filter). */
export function roleScale(ctx: HarmonicContext, role: PitchedRole): ScaleId {
  return role === 'chords' || role === 'bass' ? parentScale(ctx.scaleId) : ctx.scaleId;
}

/** The context as a role hears it (its degrees in `roleScale`). */
export function roleContext(ctx: HarmonicContext, role: PitchedRole): HarmonicContext {
  const scaleId = roleScale(ctx, role);
  return scaleId === ctx.scaleId ? ctx : { ...ctx, scaleId };
}

/** Chord MIDI notes for a chord rooted on parent degree `degree`, root position, at an octave offset. */
export function chordMidi(ctx: HarmonicContext, degree: number, octave: number): number[] {
  const oct = Math.floor(degree / 7);
  return chordSemis(ctx.scaleId, ((degree % 7) + 7) % 7, ctx.colour).map((t) => 60 + ctx.keyIndex + t + 12 * (octave + oct));
}

/** One event's MIDI notes for a role: the single place theory degrees become pitches. */
export function eventMidis(ctx: HarmonicContext, role: PitchedRole, degree: number, octave: number): number[] {
  return role === 'chords' ? chordMidi(ctx, degree, octave) : [degreeToMidi(ctx.keyIndex, roleScale(ctx, role), degree, octave)];
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
