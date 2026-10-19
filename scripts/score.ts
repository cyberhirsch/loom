/**
 * score — print what Loom's generative engine actually plays, as a readable
 * text score plus musical metrics. It renders the real patch (default patch or
 * template) through the same timeline the AudioWorklet is fed
 * (src/graph/timeline.ts): arranger, journey, LFO/Tension, evolve, glissando,
 * routing and mutes included. `heard` runs it through the DSP voice model
 * (src/audio/voiceModel.ts) to count what actually rings.
 *
 *   npm run score -- [--template default|ambient|lofi|techno] [--key C]
 *                    [--scale minor_pent] [--steps 16] [--bars 1] [--evolve|--no-evolve]
 *                    [--melody 101] [--chords 202] [--bass 303] [--drums 404]
 *                    [--arp 505] [--colour triad|7th|quartal] [--json]
 *                    [--sweep N [--sweep-player melody|chords|bass|drums|arp]]
 *
 * --bars N renders N timeline bars (one bar = one loop of --steps until
 * bar-based time lands; --loops is an alias). --sweep N renders the patch with
 * seeds 1..N on every player (or only on --sweep-player) and prints aggregate
 * metrics as JSON.
 */

import { renderTimeline, type BarRender, type TimelineProject } from '../src/graph/timeline';
import { defaultPatch, templatePatch, TEMPLATES, type TemplateId } from '../src/graph/templates';
import { chordAt, chordMidi, isChangeAt, type ChordColour } from '../src/theory/harmony';
import { NOTE_NAMES, SCALES, type ScaleId } from '../src/theory/scales';
import type { PlayerKind } from '../src/graph/types';
import type { WireDrum, WireNote } from '../src/graph/timeline';
import { partInstruments, ringingAt, simulateVoices, tailClashes, type Envelope, type ModelEvent, type VoiceKind } from '../src/audio/voiceModel';
import {
  aggregate, bassRootOnChangePct, chordPcsAt, clashes, drumStats, longestSameRun, maxRestSteps, nn, partMetrics, pc,
  pitchedStream, registerBounds, similarity, sweepMetrics, variation, voiceMotionPerChange, PITCHED,
} from './scoreMetrics';

// ---------------------------------------------------------------------------
// args → the patch
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KINDS: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];
const templateName = opt('template') ?? 'default';
const base = templateName in TEMPLATES ? templatePatch(templateName as TemplateId) : defaultPatch();

function withOverrides(seeds: Partial<Record<PlayerKind, number>> = {}): TimelineProject {
  const p = JSON.parse(JSON.stringify(base)) as TimelineProject;
  const c = p.conductor;
  if (opt('key')) c.keyIndex = Math.max(0, NOTE_NAMES.indexOf(opt('key')!.toUpperCase()));
  if (opt('scale')) c.scaleId = opt('scale') as ScaleId;
  if (opt('steps')) c.steps = Number(opt('steps'));
  if (flag('evolve')) c.evolveOn = true;
  if (flag('no-evolve')) c.evolveOn = false;
  c.liveKeyIndex = c.keyIndex;
  c.liveScaleId = c.scaleId;
  for (const n of p.nodes) {
    const kind = n.type as PlayerKind;
    if (!KINDS.includes(kind)) continue;
    if (opt(kind)) n.data.seed = Number(opt(kind));
    if (seeds[kind] !== undefined) n.data.seed = seeds[kind];
    if (kind === 'chords' && opt('colour')) n.data.colour = opt('colour') as ChordColour;
  }
  return p;
}

const project = withOverrides();
const nBars = Math.max(1, Number(opt('bars') ?? opt('loops') ?? 1));
const asJson = flag('json');

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

if (opt('sweep')) {
  const n = Number(opt('sweep'));
  const only = opt('sweep-player') as PlayerKind | undefined;
  const rows = [];
  for (let seed = 1; seed <= n; seed++) {
    const seeds: Partial<Record<PlayerKind, number>> = {};
    for (const k of only ? [only] : KINDS) seeds[k] = seed;
    rows.push(sweepMetrics(renderTimeline(withOverrides(seeds), 0, nBars)));
  }
  console.log(JSON.stringify({ patch: templateName, scale: project.conductor.scaleId, steps: Number(project.conductor.steps), bars: nBars, sweptPlayers: only ?? 'all', ...aggregate(rows) }, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const bars: BarRender[] = renderTimeline(project, 0, nBars);
const steps = Number(project.conductor.steps) || 16;
const tempo = project.conductor.tempo;
const totalSteps = bars.reduce((a, b) => a + b.steps, 0);

/** the stream's sounding notes per part, from the wire patterns */
const sounding = (bar: BarRender, kind: PlayerKind) => (bar.audible.includes(kind) ? bar.patterns[kind] : undefined);

// ---------------------------------------------------------------------------
// heard: the voice model over the rendered bars
// ---------------------------------------------------------------------------

const VOICE_KINDS: VoiceKind[] = ['melody', 'chords', 'bass', 'arp'];
const instruments = (() => {
  const parts = partInstruments(project.nodes, project.edges);
  const env = {} as Record<VoiceKind, Envelope>;
  const glide: Partial<Record<VoiceKind, boolean>> = {};
  for (const kind of VOICE_KINDS) {
    env[kind] = parts[kind].env;
    glide[kind] = parts[kind].portamento > 0;
  }
  return { env, glide };
})();

/** What is actually heard: the bars through the DSP voice model (real ADSR tails, mono
 *  lead/bass, pad choke), preceded by the last bar as a wrap-around so tails ringing into
 *  bar 1 count. Clashes/voices only count above -20 dB. */
function tails() {
  const stepSec = 60 / (tempo * 4);
  const played = [bars[bars.length - 1], ...bars];
  const events: ModelEvent[] = [];
  let t0 = 0;
  for (const bar of played) {
    for (const kind of VOICE_KINDS) {
      for (const n of (sounding(bar, kind) ?? []) as WireNote[]) {
        events.push({ kind, t: (t0 + n.step) * stepSec, midis: n.midis, lenSec: n.lenSteps * stepSec });
      }
    }
    t0 += bar.steps;
  }
  const from = played[0].steps * stepSec;
  const to = t0 * stepSec;
  const heard = simulateVoices(events, instruments.env, instruments.glide, to + 3);
  const c = tailClashes(heard, from, to);
  const voicesRinging: Partial<Record<VoiceKind, { mean: number; max: number }>> = {};
  for (const kind of VOICE_KINDS) {
    if (!bars[0].audible.includes(kind)) continue;
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
  const nb = totalSteps / 16;
  return {
    tailClashesPerBar: +(c.cross / nb).toFixed(2),
    tailClashesSamePartPerBar: +(c.same / nb).toFixed(2),
    voicesRinging,
    examples: c.examples,
  };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

function chordName(midis: number[]): string {
  const root = pc(midis[0]);
  const ivs = [...new Set(midis.map((m) => (pc(m) - root + 12) % 12))].sort((a, b) => a - b).join(',');
  const SUFFIX: Record<string, string> = {
    '0,4,7': '', '0,3,7': 'm', '0,3,6': 'dim', '0,4,8': 'aug', '0,5,7': 'sus4', '0,2,7': 'sus2',
    '0,4,7,11': 'maj7', '0,3,7,10': 'm7', '0,4,7,10': '7', '0,3,6,10': 'm7b5',
    // quartal colour: stacked fourths (a major third where the mode has no perfect fourth)
    '0,5,10': '4ths', '0,5,9': '4ths', '0,4,9': '4ths',
  };
  const s = SUFFIX[ivs];
  return s !== undefined ? `${NOTE_NAMES[root]}${s}` : `${NOTE_NAMES[root]}?{${midis.map((m) => NOTE_NAMES[pc(m)]).join('-')}}`;
}

const first = bars[0];
const ctx0 = first.ctx;
const changeSteps = ctx0.chordIdxAtStep.map((_, i) => i).filter((i) => isChangeAt(ctx0, i));
const secondsPerLoop = (steps * 60) / (tempo * 4);
const kickSet = new Set(((sounding(first, 'drums') ?? []) as WireDrum[]).filter((d) => d.lane === 0).map((d) => d.step));
const bassNotes = pitchedStream(bars, 'bass');
const stream = Object.fromEntries(PITCHED.map((k) => [k, pitchedStream(bars, k)]));

const metrics = {
  patch: templateName,
  key: NOTE_NAMES[project.conductor.keyIndex],
  scale: project.conductor.scaleId,
  tempo,
  steps,
  bars: nBars,
  secondsPerLoop: +secondsPerLoop.toFixed(2),
  evolve: project.conductor.evolveOn,
  audible: first.audible,
  form: bars.some((b) => b.sectionId >= 0 || b.keyIndex !== project.conductor.keyIndex)
    ? bars.map((b) => `${b.absBar + 1}:${b.sectionId >= 0 ? `s${b.sectionId}` : '-'} ${NOTE_NAMES[b.keyIndex]} ${b.scaleId}`)
    : null,
  harmony: {
    progression: ctx0.chords.length,
    chordChangesPerLoop: changeSteps.length,
    chordChangesPerBar: +(changeSteps.length / (steps / 16)).toFixed(2),
    secondsPerChord: +(secondsPerLoop / changeSteps.length).toFixed(2),
    chords: changeSteps.map((i) => `@${i} ${chordName(chordMidi(ctx0, chordAt(ctx0, i).degree, 0))}`),
    roman: changeSteps.map((i) => `${chordAt(ctx0, i).roman} ${chordAt(ctx0, i).func}`),
  },
  parts: PITCHED.filter((k) => bars.some((b) => b.audible.includes(k))).map((k) => partMetrics(bars, k)),
  drums: drumStats(bars),
  bassKickLock: bassNotes.length && kickSet.size
    ? Math.round((pitchedStream([first], 'bass').filter((n) => kickSet.has(n.step)).length / Math.max(1, pitchedStream([first], 'bass').length)) * 100)
    : null,
  bassOnRootPct: bassNotes.length
    ? Math.round((bassNotes.filter((n) => pc(n.midis[0]) === chordAt(bars[n.bar].ctx, n.step).rootPc).length / bassNotes.length) * 100)
    : null,
  bassRootOnChangePct: bassRootOnChangePct(bars),
  longestSameRun: stream.melody.length ? longestSameRun(stream.melody) : null,
  melodyMaxRestSteps: stream.melody.length ? maxRestSteps(stream.melody, totalSteps) : null,
  voiceMotionPerChange: voiceMotionPerChange(stream.chords),
  registerBounds: Object.fromEntries(PITCHED.map((k) => [k, registerBounds(stream[k])])),
  semitoneClashes: clashes(bars),
  heard: tails(),
  variation: variation(bars),
  loopToLoopSimilarity:
    bars.length > 1
      ? bars.slice(1).map((b, i) => ({
          bar: i + 2,
          melody: similarity(sounding(bars[i], 'melody'), sounding(b, 'melody')),
          bass: similarity(sounding(bars[i], 'bass'), sounding(b, 'bass')),
          arp: similarity(sounding(bars[i], 'arp'), sounding(b, 'arp')),
        }))
      : null,
};

if (asJson) {
  const loops = bars.map((b) =>
    Object.fromEntries(
      PITCHED.filter((k) => sounding(b, k)).map((k) => [k, (sounding(b, k) as WireNote[]).map((n) => ({ step: n.step, midis: n.midis, vel: n.vel, len: n.lenSteps }))]),
    ),
  );
  console.log(JSON.stringify({ metrics, loops, bars: bars.map((b) => ({ absBar: b.absBar, sectionId: b.sectionId, keyIndex: b.keyIndex, scaleId: b.scaleId, audible: b.audible, patterns: b.patterns })) }, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// text score
// ---------------------------------------------------------------------------

const CELL = 5;
const pad = (s: string) => (s.length >= CELL ? s.slice(0, CELL) : s + ' '.repeat(CELL - s.length));
const sep = (s: number) => (s % 16 === 0 ? '|' : s % 4 === 0 ? ':' : ' ');
const ruler = (n: number) => {
  let out = '         ';
  for (let s = 0; s < n; s++) out += sep(s) + pad(String(s));
  return out;
};

function rowFor(label: string, bar: BarRender, kind: PlayerKind, mark: (n: WireNote, m: number) => string = () => '') {
  const notes = sounding(bar, kind) as WireNote[] | undefined;
  const cells = new Array<string>(bar.steps).fill(notes ? '.' : ' ');
  // grace notes: glissando steps the player's own take does not have
  const nodeId = project.nodes.find((n) => n.type === kind)?.id;
  const own = new Set(((nodeId ? bar.parts[nodeId] : undefined) ?? []).map((e) => e.step));
  for (const n of notes ?? []) {
    const grace = kind !== 'chords' && own.size > 0 && !own.has(n.step) ? '^' : '';
    cells[n.step] = n.midis.length > 1 ? chordName(n.midis) : nn(n.midis[0]) + mark(n, n.midis[0]) + grace;
    for (let k = 1; k < n.lenSteps && n.step + k < bar.steps; k++) if (cells[n.step + k] === '.') cells[n.step + k] = '~';
  }
  let out = pad(label).padEnd(9);
  for (let s = 0; s < bar.steps; s++) out += sep(s) + pad(cells[s]);
  return out + (notes ? '' : '  (silent: muted or unrouted)');
}

function drumRow(label: string, lane: 0 | 1 | 2, bar: BarRender) {
  const drums = sounding(bar, 'drums') as WireDrum[] | undefined;
  let out = pad(label).padEnd(9);
  for (let s = 0; s < bar.steps; s++) {
    const hit = drums?.find((d) => d.step === s && d.lane === lane);
    out += sep(s) + pad(drums ? (hit ? (hit.vel >= 0.8 ? 'X' : 'x') : '.') : ' ');
  }
  return out + (drums ? '' : '  (silent: muted or unrouted)');
}

const sections = (project.nodes.find((n) => n.type === 'arranger')?.data.sections ?? []) as Array<{ name: string }>;
console.log(`\n${metrics.patch} · ${metrics.key} ${SCALES[project.conductor.scaleId].name} · ${tempo} bpm · ${steps} steps (${steps / 16} bar) = ${metrics.secondsPerLoop}s per loop${project.conductor.evolveOn ? ' · evolve on' : ''}`);
console.log(`(* = not a tone of the sounding chord, ^ = glissando grace note, ~ = held)\n`);
for (const bar of bars) {
  const nonChord = (n: WireNote, m: number) => (chordPcsAt(bar.ctx, n.step).has(pc(m)) ? '' : '*');
  if (bars.length > 1 || bar.sectionId >= 0) {
    const section = bar.sectionId >= 0 ? ` · section "${sections[bar.sectionId]?.name ?? bar.sectionId}"` : '';
    console.log(`--- bar ${bar.absBar + 1}${section} · ${NOTE_NAMES[bar.keyIndex]} ${SCALES[bar.scaleId].name} ---`);
  }
  console.log(ruler(bar.steps));
  let cr = pad('harmony').padEnd(9);
  for (let s = 0; s < bar.steps; s++) cr += sep(s) + pad(isChangeAt(bar.ctx, s) ? chordName(chordMidi(bar.ctx, chordAt(bar.ctx, s).degree, 0)) : '');
  console.log(cr);
  console.log(rowFor('melody', bar, 'melody', nonChord));
  console.log(rowFor('arp', bar, 'arp', nonChord));
  console.log(rowFor('chords', bar, 'chords'));
  console.log(rowFor('bass', bar, 'bass', nonChord));
  console.log(drumRow('kick', 0, bar));
  console.log(drumRow('snare', 1, bar));
  console.log(drumRow('hat', 2, bar));
  console.log('');
}
console.log(JSON.stringify(metrics, null, 1));
