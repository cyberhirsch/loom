/**
 * The shared resolver: one bar's theory parts (degrees) become the MIDI the
 * worklet plays, through each role's fixed pitch window (src/theory/voicing.ts).
 * The timeline calls it for every bar, so the engine, previews, score tool and
 * MIDI/WAV exports all hear the same pitches.
 *
 * Order matters: the melody sets the ceiling the chords are voiced under, and
 * the chords set the floor the bass stays below.
 */

import { chordAt, isChangeAt, makeChord, roleScale, type HarmonicContext, type PitchedRole } from '../theory/harmony';
import type { NoteEvent } from '../theory/melody';
import { degreeToMidi, pcOf } from '../theory/scales';
import {
  ARP_WINDOW, BASS_ROOT_WINDOW, BASS_WINDOW, CHORD_WINDOW, melodyTonic, placeArpRun, placeBassNote, placeBassRoot,
  shiftWindow, voiceChords, type ChordSlot, type ChordSpread,
} from '../theory/voicing';

/** worklet wire format: a pitched event resolved to MIDI */
export interface WireNote {
  step: number;
  midis: number[];
  vel: number;
  lenSteps: number;
}

/** Where the voices left off: what the next bar of the same phrase continues from. */
export interface ResolveState {
  chords: number[] | null;
  bassRoot: number | null;
  arp: number | null;
}

export interface ResolveInput {
  ctx: HarmonicContext;
  /** each role's events this bar, step order (glissando graces included) */
  parts: Partial<Record<PitchedRole, NoteEvent[]>>;
  /** octave shift of each role's window */
  register?: Partial<Record<PitchedRole, number>>;
  spread?: ChordSpread;
  /** 2: the arp window opens an octave higher so a two-octave run climbs instead of folding back */
  arpOctaves?: number;
  /** null or absent: the bar starts a phrase, voices start from their canonical places */
  prev?: ResolveState | null;
}

export interface ResolvedBar {
  notes: Partial<Record<PitchedRole, WireNote[]>>;
  state: ResolveState;
}

/** with a bass playing, no pad voice under E2: the bass keeps an octave of its own below the pad */
const PAD_FLOOR = 40;

const wire = (ev: NoteEvent, midis: number[]): WireNote => ({ step: ev.step, midis, vel: ev.velocity, lenSteps: ev.lengthSteps });
/** the steps an event sounds on (at least its onset) */
const span = (step: number, len: number) => Array.from({ length: Math.max(1, Math.ceil(len)) }, (_, k) => step + k);
/** a pitch-class distance as the nearest signed interval (-6..5) */
const signed = (d: number) => (pcOf(d) > 5 ? pcOf(d) - 12 : pcOf(d));

export function resolveBar(input: ResolveInput): ResolvedBar {
  const { ctx, parts } = input;
  const reg = (role: PitchedRole) => 12 * Math.round(Number(input.register?.[role] ?? 0));
  const prev = input.prev ?? null;
  const notes: ResolvedBar['notes'] = {};

  // melody: the tonic's fixed octave, the line's own intervals untouched
  const melody = parts.melody?.map((ev) => {
    const tonic = melodyTonic(ctx.keyIndex) + reg('melody');
    return wire(ev, [tonic + degreeToMidi(0, ctx.scaleId, ev.degree) - 60]);
  });
  if (melody) notes.melody = melody;
  const melodyLowAt = new Map<number, number>();
  for (const n of melody ?? []) {
    for (const s of span(n.step, n.lenSteps)) melodyLowAt.set(s, Math.min(melodyLowAt.get(s) ?? Infinity, n.midis[0]));
  }

  // bass roots first: a chain in the root window, one per chord change
  const bassRootWindow = shiftWindow(BASS_ROOT_WINDOW, reg('bass'));
  const starts: number[] = [];
  for (let s = 0; s < ctx.steps; s++) if (isChangeAt(ctx, s)) starts.push(s);
  const roots: number[] = [];
  if (parts.bass) {
    for (const s of starts) roots.push(placeBassRoot(chordAt(ctx, s).rootPc, roots.length ? roots[roots.length - 1] : (prev?.bassRoot ?? null), bassRootWindow));
  }
  const segOf = (step: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= step) i++;
    return i;
  };

  // chords: one voicing per run of strikes on the same chord, voice-led under the melody and over the bass root
  let chordsEnd = prev?.chords ?? null;
  const padLowAt = new Map<number, number>();
  if (parts.chords) {
    const evs = parts.chords;
    const runs: Array<{ degree: number; events: NoteEvent[] }> = [];
    for (const ev of evs) {
      const d = ((ev.degree % 7) + 7) % 7;
      const last = runs[runs.length - 1];
      if (last && last.degree === d) last.events.push(ev);
      else runs.push({ degree: d, events: [ev] });
    }
    const slots: ChordSlot[] = runs.map((r) => {
      const chord = makeChord(ctx.keyIndex, ctx.scaleId, r.degree, ctx.colour);
      let ceil = Infinity;
      let floor = -Infinity;
      for (const ev of r.events) {
        for (const s of span(ev.step, ev.lengthSteps)) {
          ceil = Math.min(ceil, (melodyLowAt.get(s) ?? Infinity) - 1);
          if (roots.length && s < ctx.steps) floor = Math.max(floor, roots[segOf(s)] + 1, PAD_FLOOR + reg('bass'));
        }
      }
      return {
        pcs: [...chord.pcs, ...(chord.ext ?? [])],
        rootPc: chord.rootPc,
        quartal: ctx.colour === 'quartal',
        ceil: Number.isFinite(ceil) ? ceil : undefined,
        floor: Number.isFinite(floor) ? floor : undefined,
      };
    });
    const voicings = voiceChords(slots, {
      window: shiftWindow(CHORD_WINDOW, reg('chords')),
      spread: input.spread,
      bassHasRoot: Boolean(parts.bass?.length),
      prev: prev?.chords,
      cyclic: true,
    });
    notes.chords = runs.flatMap((r, i) => r.events.map((ev) => wire(ev, voicings[i])));
    for (const n of notes.chords) {
      for (const s of span(n.step, n.lenSteps)) padLowAt.set(s, Math.min(padLowAt.get(s) ?? Infinity, n.midis[0]));
    }
    if (voicings.length) chordsEnd = voicings[voicings.length - 1];
  }

  // bass: a root chain in the root window, everything else kept on its interval to the root, under the pad
  let bassEnd = prev?.bassRoot ?? null;
  if (parts.bass) {
    const parent = roleScale(ctx, 'bass');
    const window = shiftWindow(BASS_WINDOW, reg('bass'));
    // after the bar the phrase starts again on the first chord
    const after = placeBassRoot(chordAt(ctx, 0).rootPc, null, bassRootWindow);
    const natural = (ev: NoteEvent) => degreeToMidi(ctx.keyIndex, parent, ev.degree, -2);
    const isRoot = (ev: NoteEvent) => isChangeAt(ctx, ev.step) && pcOf(natural(ev)) === chordAt(ctx, ev.step).rootPc;
    let last: number | null = null;
    notes.bass = parts.bass.map((ev) => {
      const seg = segOf(ev.step);
      const root = roots[seg];
      const x = natural(ev);
      const below = Math.min(...span(ev.step, ev.lengthSteps).map((s) => padLowAt.get(s) ?? Infinity));
      const next = seg + 1 < roots.length ? roots[seg + 1] : after;
      // leaps stay within an octave of the note before
      const near = (...anchors: number[]) => (last === null ? anchors : [...anchors, last]);
      let midi: number;
      if (isRoot(ev)) {
        midi = root;
      } else if (ev.passing) {
        const nextPc = seg + 1 < starts.length ? chordAt(ctx, starts[seg + 1]).rootPc : chordAt(ctx, 0).rootPc;
        midi = placeBassNote(pcOf(x), next + signed(x - nextPc), { below, near: near(next) }, window);
      } else {
        const rootEv = parts.bass!.find((e) => e.step === starts[seg] && isRoot(e));
        const rootNatural = rootEv ? natural(rootEv) : x - pcOf(x - chordAt(ctx, ev.step).rootPc);
        midi = placeBassNote(pcOf(x), root + x - rootNatural, { below, near: near(root, next) }, window);
      }
      last = midi;
      return wire(ev, [midi]);
    });
    if (roots.length) bassEnd = roots[roots.length - 1];
  }

  // arp: each chord's run moved by octaves into the window, starting near where the last one ended
  let arpEnd = prev?.arp ?? null;
  if (parts.arp) {
    const base = shiftWindow(ARP_WINDOW, reg('arp'));
    const window = input.arpOctaves === 2 ? { lo: base.lo, hi: base.hi + 12 } : base;
    const runs: NoteEvent[][] = [];
    for (const ev of parts.arp) {
      const last = runs[runs.length - 1];
      if (last && !isChangeBetween(ctx, last[last.length - 1].step, ev.step)) last.push(ev);
      else runs.push([ev]);
    }
    notes.arp = runs.flatMap((run) => {
      const placed = placeArpRun(run.map((ev) => degreeToMidi(ctx.keyIndex, ctx.scaleId, ev.degree)), arpEnd, window);
      arpEnd = placed[placed.length - 1];
      return run.map((ev, i) => wire(ev, [placed[i]]));
    });
  }

  return { notes, state: { chords: chordsEnd, bassRoot: bassEnd, arp: arpEnd } };
}

/** a chord change after step `a`, up to and including step `b` */
function isChangeBetween(ctx: HarmonicContext, a: number, b: number): boolean {
  for (let s = a + 1; s <= b; s++) if (isChangeAt(ctx, s)) return true;
  return false;
}
