/**
 * score — print what Loom's generative engine actually plays, as a readable
 * text score plus musical metrics. The theory engine is pure and seeded, so
 * this is the exact music the AudioWorklet would receive (minus glissando).
 * `heard` runs it through the DSP voice model (src/audio/voiceModel.ts) to
 * count what actually rings: tail-aware clashes and voices sounding per part.
 *
 *   npm run score -- [--template default|ambient|lofi|techno] [--key C]
 *                    [--scale minor_pent] [--steps 16] [--loops 1] [--evolve]
 *                    [--melody 101] [--chords 202] [--bass 303] [--drums 404]
 *                    [--arp 505] [--json]
 */

import { computeContext, computeBasePattern, ROLE_OCTAVE } from '../src/graph/session';
import { chordMidi, type HarmonicContext } from '../src/theory/harmony';
import { degreeToMidi, NOTE_NAMES, SCALES, type ScaleId } from '../src/theory/scales';
import { evolveMelody, type NoteEvent } from '../src/theory/melody';
import type { DrumEvent } from '../src/theory/parts';
import type { ConductorState, PlayerData, PlayerKind } from '../src/graph/types';
import { DEFAULT_SCRIPT } from '../src/graph/defaultScript';
import { parseLoomScript } from '../src/script/loomscript';
import { partInstruments, ringingAt, simulateVoices, tailClashes, type Envelope, type ModelEvent, type VoiceKind } from '../src/audio/voiceModel';

// ---------------------------------------------------------------------------
// patches (mirrors DEFAULT_SCRIPT + TEMPLATES in src/graph/store.ts)
// ---------------------------------------------------------------------------

type Players = Record<PlayerKind, Partial<PlayerData>>;
interface Patch {
  keyIndex: number;
  scaleId: ScaleId;
  tempo: number;
  players: Players;
}

const BASE: Players = {
  melody: { seed: 101, density: 0.55, adventurousness: 0.35, register: 0 },
  chords: { seed: 202, density: 0.5, register: 0 },
  bass: { seed: 303, density: 0.5, register: 0 },
  drums: { seed: 404, density: 0.6, syncopation: 0.3 },
  arp: { seed: 505, density: 0.45, register: 1 },
};

const PATCHES: Record<string, Patch> = {
  default: { keyIndex: 0, scaleId: 'minor_pent', tempo: 102, players: BASE },
  ambient: {
    keyIndex: 2, scaleId: 'lydian', tempo: 74,
    players: {
      melody: { seed: 811, density: 0.3, adventurousness: 0.25, register: 0 },
      chords: { seed: 812, density: 0.55, register: 0 },
      bass: { seed: 813, density: 0.25, register: 0 },
      drums: { seed: 814, density: 0.2, syncopation: 0.1, mute: true },
      arp: { seed: 815, density: 0.35, register: 1 },
    },
  },
  lofi: {
    keyIndex: 9, scaleId: 'dorian', tempo: 84,
    players: {
      melody: { seed: 921, density: 0.45, adventurousness: 0.4, register: 0 },
      chords: { seed: 922, density: 0.5, register: 0 },
      bass: { seed: 923, density: 0.5, register: 0 },
      drums: { seed: 924, density: 0.55, syncopation: 0.45 },
      arp: { seed: 925, density: 0.3, register: 0, mute: true },
    },
  },
  techno: {
    keyIndex: 0, scaleId: 'minor_pent', tempo: 128,
    players: {
      melody: { seed: 731, density: 0.35, adventurousness: 0.5, register: 0, mute: true },
      chords: { seed: 732, density: 0.3, register: 0 },
      bass: { seed: 733, density: 0.75, register: 0 },
      drums: { seed: 734, density: 0.85, syncopation: 0.5 },
      arp: { seed: 735, density: 0.8, register: 1 },
    },
  },
};

/** Instruments come from the default patch itself (every template keeps its
 *  synth nodes): the Synth node and Expression each part is cabled through. */
const VOICE_KINDS: VoiceKind[] = ['melody', 'chords', 'bass', 'arp'];
const instruments = (() => {
  const r = parseLoomScript(DEFAULT_SCRIPT);
  if (!r.ok) throw new Error('default LoomScript is invalid');
  const parts = partInstruments(r.project.nodes, r.project.edges);
  const env = {} as Record<VoiceKind, Envelope>;
  const glide: Partial<Record<VoiceKind, boolean>> = {};
  for (const kind of VOICE_KINDS) {
    env[kind] = parts[kind].env;
    glide[kind] = parts[kind].portamento > 0;
  }
  return { env, glide };
})();

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const patch: Patch = JSON.parse(JSON.stringify(PATCHES[opt('template') ?? 'default'] ?? PATCHES.default));
if (opt('key')) patch.keyIndex = Math.max(0, NOTE_NAMES.indexOf(opt('key')!.toUpperCase()));
if (opt('scale')) patch.scaleId = opt('scale') as ScaleId;
for (const k of ['melody', 'chords', 'bass', 'drums', 'arp'] as PlayerKind[]) {
  if (opt(k)) patch.players[k].seed = Number(opt(k));
}
const steps = Number(opt('steps') ?? 16);
const loops = Number(opt('loops') ?? 1);
const evolve = flag('evolve');
const asJson = flag('json');

const fullData = (p: Partial<PlayerData>): PlayerData => ({
  seed: 1, density: 0.5, adventurousness: 0.35, syncopation: 0.3, register: 0, mute: false, volume: -9, ...p,
}) as PlayerData;

const conductor: ConductorState = {
  keyIndex: patch.keyIndex, scaleId: patch.scaleId, tempo: patch.tempo, steps,
  evolveOn: evolve, journeyOn: false, modEvery: 4, journeyLabel: 'home',
  liveKeyIndex: patch.keyIndex, liveScaleId: patch.scaleId,
};

// ---------------------------------------------------------------------------
// resolve theory → concrete MIDI exactly like wasmEngine.resolve()
// ---------------------------------------------------------------------------

interface Sounding {
  step: number;
  midis: number[];
  vel: number;
  len: number;
}

function resolvePitched(kind: PlayerKind, ctx: HarmonicContext, pattern: NoteEvent[], register: number): Sounding[] {
  const octave = ROLE_OCTAVE[kind] + register;
  return [...pattern]
    .sort((a, b) => a.step - b.step)
    .map((ev) => ({
      step: ev.step,
      midis: kind === 'chords' ? chordMidi(ctx, ev.degree, octave) : [degreeToMidi(ctx.keyIndex, ctx.scaleId, ev.degree, octave)],
      vel: ev.velocity,
      len: ev.lengthSteps,
    }));
}

const pc = (m: number) => ((m % 12) + 12) % 12;
const nn = (m: number) => `${NOTE_NAMES[pc(m)]}${Math.floor(m / 12) - 1}`;

function chordName(midis: number[]): string {
  const root = pc(midis[0]);
  const ivs = [...new Set(midis.map((m) => (pc(m) - root + 12) % 12))].sort((a, b) => a - b).join(',');
  const SUFFIX: Record<string, string> = {
    '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug', '0,5,7': 'sus4', '0,2,7': 'sus2',
    '0,4,7,11': 'maj7', '0,3,7,10': 'm7', '0,4,7,10': '7', '0,3,6,10': 'm7b5',
  };
  const s = SUFFIX[ivs];
  return s !== undefined ? `${NOTE_NAMES[root]}${s}` : `${NOTE_NAMES[root]}?{${midis.map((m) => NOTE_NAMES[pc(m)]).join('-')}}`;
}

// ---------------------------------------------------------------------------
// generate N loops (evolve mirrors the engine: melody regenerates by
// generation; arp/bass mutate one note per loop)
// ---------------------------------------------------------------------------

const ORDER: PlayerKind[] = ['arp', 'melody', 'chords', 'bass', 'drums'];
const chordsSeed = Number(patch.players.chords.seed);
const ctx = computeContext(conductor, chordsSeed);

interface Loop {
  pitched: Partial<Record<PlayerKind, Sounding[]>>;
  drums: DrumEvent[] | null;
  raw: Partial<Record<PlayerKind, NoteEvent[] | DrumEvent[]>>;
}

const history: Loop[] = [];
let generation = 0;
let prevRaw: Loop['raw'] = {};
for (let l = 0; l < loops; l++) {
  const raw: Loop['raw'] = {};
  for (const kind of ORDER) {
    const data = fullData(patch.players[kind]);
    if (data.mute) continue;
    if (l > 0 && evolve && (kind === 'melody' || kind === 'arp' || kind === 'bass')) {
      raw[kind] =
        kind === 'melody'
          ? computeBasePattern(kind, ctx, data, { generation: ++generation })
          : evolveMelody(ctx, prevRaw[kind] as NoteEvent[], data.seed, ++generation);
    } else raw[kind] = l > 0 && prevRaw[kind] ? prevRaw[kind] : computeBasePattern(kind, ctx, data);
  }
  const pitched: Loop['pitched'] = {};
  for (const kind of ['melody', 'chords', 'bass', 'arp'] as PlayerKind[]) {
    if (raw[kind]) pitched[kind] = resolvePitched(kind, ctx, raw[kind] as NoteEvent[], Number(patch.players[kind].register ?? 0));
  }
  history.push({ pitched, drums: (raw.drums as DrumEvent[]) ?? null, raw });
  prevRaw = raw;
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/** pitch classes of the chord sounding at a step (the actual chord MIDI, octave-free) */
const chordPcsAt = (s: number) => new Set(chordMidi(ctx, ctx.chordAtStep[s], 0).map(pc));

function partMetrics(kind: PlayerKind, notes: Sounding[]) {
  const flat = notes.flatMap((n) => n.midis.map((m) => ({ ...n, m })));
  const mel = notes.map((n) => n.midis[0]);
  const ivs = mel.slice(1).map((m, i) => Math.abs(m - mel[i]));
  const chordTone = flat.filter((n) => chordPcsAt(n.step).has(pc(n.m))).length;
  const strong = flat.filter((n) => n.step % 4 === 0);
  const strongCT = strong.filter((n) => chordPcsAt(n.step).has(pc(n.m))).length;
  return {
    kind,
    notes: notes.length,
    distinctPitches: new Set(flat.map((n) => n.m)).size,
    rangeSemis: flat.length ? Math.max(...flat.map((n) => n.m)) - Math.min(...flat.map((n) => n.m)) : 0,
    lowest: flat.length ? nn(Math.min(...flat.map((n) => n.m))) : '-',
    highest: flat.length ? nn(Math.max(...flat.map((n) => n.m))) : '-',
    meanInterval: ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(2) : 0,
    maxLeap: ivs.length ? Math.max(...ivs) : 0,
    onBeatPct: notes.length ? Math.round((notes.filter((n) => n.step % 4 === 0).length / notes.length) * 100) : 0,
    chordTonePct: flat.length ? Math.round((chordTone / flat.length) * 100) : 0,
    strongBeatChordTonePct: strong.length ? Math.round((strongCT / strong.length) * 100) : null,
    meanLenSteps: notes.length ? +(notes.reduce((a, n) => a + n.len, 0) / notes.length).toFixed(2) : 0,
  };
}

/** semitone clashes: two parts sounding pitches a minor 2nd / major 7th apart at the same time */
function clashes(loop: Loop) {
  const sounding: Array<{ kind: string; m: number; from: number; to: number }> = [];
  for (const [kind, notes] of Object.entries(loop.pitched)) {
    for (const n of notes!) for (const m of n.midis) sounding.push({ kind, m, from: n.step, to: n.step + Math.max(1, n.len) });
  }
  let count = 0;
  const examples: string[] = [];
  for (let i = 0; i < sounding.length; i++) {
    for (let j = i + 1; j < sounding.length; j++) {
      const a = sounding[i];
      const b = sounding[j];
      if (a.kind === b.kind) continue;
      if (a.from >= b.to || b.from >= a.to) continue;
      const d = Math.abs(pc(a.m) - pc(b.m));
      if (d === 1 || d === 11) {
        count++;
        if (examples.length < 6) examples.push(`step ${Math.max(a.from, b.from)}: ${a.kind} ${nn(a.m)} vs ${b.kind} ${nn(b.m)}`);
      }
    }
  }
  return { count, examples };
}

/** What is actually heard: the loops run through the DSP voice model (real
 *  ADSR tails, mono lead/bass, pad choke), preceded by one wrap-around loop so
 *  tails ringing into loop 1 count. Clashes/voices only count above -20 dB. */
function tails(hist: Loop[]) {
  const stepSec = 60 / (patch.tempo * 4);
  const loopSec = steps * stepSec;
  const played = [hist[hist.length - 1], ...hist];
  const events: ModelEvent[] = [];
  played.forEach((loop, l) => {
    for (const kind of VOICE_KINDS) {
      for (const n of loop.pitched[kind] ?? []) {
        events.push({ kind, t: (l * steps + n.step) * stepSec, midis: n.midis, lenSec: n.len * stepSec });
      }
    }
  });
  const from = loopSec;
  const to = played.length * loopSec;
  const heard = simulateVoices(events, instruments.env, instruments.glide, to + 3);
  const bars = (hist.length * steps) / 16;
  const c = tailClashes(heard, from, to);
  const voicesRinging: Partial<Record<VoiceKind, { mean: number; max: number }>> = {};
  for (const kind of VOICE_KINDS) {
    if (!hist[0].pitched[kind]) continue;
    let sum = 0;
    let max = 0;
    let n = 0;
    // sample between grid points: exactly on an onset the new note is still in its attack
    for (let t = from + stepSec / 8; t < to; t += stepSec / 4, n++) {
      const r = ringingAt(heard, kind, t);
      sum += r;
      max = Math.max(max, r);
    }
    voicesRinging[kind] = { mean: +(sum / n).toFixed(2), max };
  }
  return {
    tailClashesPerBar: +(c.cross / bars).toFixed(2),
    tailClashesSamePartPerBar: +(c.same / bars).toFixed(2),
    voicesRinging,
    examples: c.examples,
  };
}

function similarity(a: Sounding[] | undefined, b: Sounding[] | undefined): number | null {
  if (!a || !b) return null;
  const key = (n: Sounding) => `${n.step}:${n.midis.join('.')}`;
  const A = new Set(a.map(key));
  const B = new Set(b.map(key));
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? +(inter / union).toFixed(2) : 1;
}

const first = history[0];
const kick = new Set((first.drums ?? []).filter((d) => d.lane === 0).map((d) => d.step));
const bassNotes = first.pitched.bass ?? [];
const chordChanges = ctx.chordAtStep.filter((c, i) => i === 0 || c !== ctx.chordAtStep[i - 1]).length;
const secondsPerLoop = (steps * 60) / (patch.tempo * 4);

const metrics = {
  patch: opt('template') ?? 'default',
  key: NOTE_NAMES[patch.keyIndex],
  scale: patch.scaleId,
  tempo: patch.tempo,
  steps,
  bars: steps / 16,
  secondsPerLoop: +secondsPerLoop.toFixed(2),
  harmony: {
    progression: [...new Set(ctx.chordAtStep.map((c, i) => `${i}:${c}`))].length,
    chordChangesPerLoop: chordChanges,
    chordChangesPerBar: +(chordChanges / (steps / 16)).toFixed(2),
    secondsPerChord: +(secondsPerLoop / chordChanges).toFixed(2),
    chords: ctx.chordAtStep
      .map((c, i) => (i === 0 || c !== ctx.chordAtStep[i - 1] ? `@${i} ${chordName(chordMidi(ctx, c, 0))}` : null))
      .filter(Boolean),
  },
  parts: Object.entries(first.pitched).map(([k, notes]) => partMetrics(k as PlayerKind, notes!)),
  drums: first.drums
    ? {
        kicks: first.drums.filter((d) => d.lane === 0).map((d) => d.step),
        snares: first.drums.filter((d) => d.lane === 1).map((d) => d.step),
        hats: first.drums.filter((d) => d.lane === 2).length,
        velocitiesDistinct: new Set(first.drums.map((d) => d.velocity)).size,
      }
    : null,
  bassKickLock: bassNotes.length
    ? Math.round((bassNotes.filter((n) => kick.has(n.step)).length / bassNotes.length) * 100)
    : null,
  bassOnRootPct: bassNotes.length
    ? Math.round(
        (bassNotes.filter((n) => pc(n.midis[0]) === pc(chordMidi(ctx, ctx.chordAtStep[n.step], 0)[0])).length / bassNotes.length) * 100,
      )
    : null,
  semitoneClashes: clashes(first),
  heard: tails(history),
  loopToLoopSimilarity:
    history.length > 1
      ? history.slice(1).map((h, i) => ({
          loop: i + 2,
          melody: similarity(history[i].pitched.melody, h.pitched.melody),
          bass: similarity(history[i].pitched.bass, h.pitched.bass),
          arp: similarity(history[i].pitched.arp, h.pitched.arp),
        }))
      : null,
};

if (asJson) {
  console.log(JSON.stringify({ metrics, loops: history.map((h) => h.pitched) }, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// text score
// ---------------------------------------------------------------------------

const CELL = 5;
const pad = (s: string) => (s.length >= CELL ? s.slice(0, CELL) : s + ' '.repeat(CELL - s.length));
const ruler = () => {
  let out = '         ';
  for (let s = 0; s < steps; s++) out += (s % 16 === 0 ? '|' : s % 4 === 0 ? ':' : ' ') + pad(String(s));
  return out;
};

function rowFor(label: string, notes: Sounding[] | undefined, mark: (n: Sounding, m: number) => string = () => '') {
  const cells = new Array<string>(steps).fill('.');
  for (const n of notes ?? []) {
    cells[n.step] = n.midis.length > 1 ? chordName(n.midis) : nn(n.midis[0]) + mark(n, n.midis[0]);
    for (let k = 1; k < n.len && n.step + k < steps; k++) if (cells[n.step + k] === '.') cells[n.step + k] = '~';
  }
  let out = pad(label).padEnd(9);
  for (let s = 0; s < steps; s++) out += (s % 16 === 0 ? '|' : s % 4 === 0 ? ':' : ' ') + pad(cells[s]);
  return out;
}

function drumRow(label: string, lane: 0 | 1 | 2, drums: DrumEvent[] | null) {
  let out = pad(label).padEnd(9);
  for (let s = 0; s < steps; s++) {
    const hit = drums?.find((d) => d.step === s && d.lane === lane);
    out += (s % 16 === 0 ? '|' : s % 4 === 0 ? ':' : ' ') + pad(hit ? (hit.velocity >= 0.8 ? 'X' : 'x') : '.');
  }
  return out;
}

const nonChord = (n: Sounding, m: number) => (chordPcsAt(n.step).has(pc(m)) ? '' : '*');

console.log(`\n${metrics.patch} · ${metrics.key} ${SCALES[patch.scaleId].name} · ${patch.tempo} bpm · ${steps} steps (${metrics.bars} bar) = ${metrics.secondsPerLoop}s per loop`);
console.log(`(* = not a tone of the sounding chord, ~ = held)\n`);
for (let l = 0; l < history.length; l++) {
  const h = history[l];
  if (history.length > 1) console.log(`--- loop ${l + 1} ---`);
  console.log(ruler());
  const chordRow = ctx.chordAtStep.map((c, i) => (i === 0 || c !== ctx.chordAtStep[i - 1] ? chordName(chordMidi(ctx, c, 0)) : ''));
  let cr = pad('harmony').padEnd(9);
  for (let s = 0; s < steps; s++) cr += (s % 16 === 0 ? '|' : s % 4 === 0 ? ':' : ' ') + pad(chordRow[s] || '');
  console.log(cr);
  console.log(rowFor('melody', h.pitched.melody, nonChord));
  console.log(rowFor('arp', h.pitched.arp, nonChord));
  console.log(rowFor('chords', h.pitched.chords));
  console.log(rowFor('bass', h.pitched.bass, nonChord));
  console.log(drumRow('kick', 0, h.drums));
  console.log(drumRow('snare', 1, h.drums));
  console.log(drumRow('hat', 2, h.drums));
  console.log('');
}
const { loops: _omit, ...printable } = { ...metrics, loops: undefined };
console.log(JSON.stringify(printable, null, 1));
