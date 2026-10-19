/**
 * Musical metrics over rendered timeline bars (src/graph/timeline.ts) — the
 * score tool's regression numbers. Everything here reads what the worklet
 * plays: resolved MIDI of the audible parts.
 */

import { chordAt, isChangeAt, type HarmonicContext } from '../src/theory/harmony';
import { NOTE_NAMES } from '../src/theory/scales';
import type { BarRender, WireDrum, WireNote } from '../src/graph/timeline';
import type { PlayerKind } from '../src/graph/types';

export type Bar = Pick<BarRender, 'steps' | 'patterns' | 'audible' | 'ctx'>;
export type PitchedKind = Exclude<PlayerKind, 'drums'>;
export const PITCHED: PitchedKind[] = ['melody', 'chords', 'bass', 'arp'];

export const pc = (m: number) => ((m % 12) + 12) % 12;
export const nn = (m: number) => `${NOTE_NAMES[pc(m)]}${Math.floor(m / 12) - 1}`;

/** a sounding note on the stream's absolute step clock */
export interface StreamNote extends WireNote {
  t: number;
  bar: number;
}

const audible = (bar: Bar, kind: PlayerKind) => bar.audible.includes(kind);

export function pitchedStream(bars: Bar[], kind: PitchedKind): StreamNote[] {
  const out: StreamNote[] = [];
  let base = 0;
  bars.forEach((bar, i) => {
    if (audible(bar, kind)) for (const ev of (bar.patterns[kind] ?? []) as WireNote[]) out.push({ ...ev, t: base + ev.step, bar: i });
    base += bar.steps;
  });
  return out;
}

export function drumStream(bars: Bar[]): Array<WireDrum & { t: number }> | null {
  if (!bars.some((b) => audible(b, 'drums'))) return null;
  const out: Array<WireDrum & { t: number }> = [];
  let base = 0;
  for (const bar of bars) {
    if (audible(bar, 'drums')) for (const ev of (bar.patterns.drums ?? []) as WireDrum[]) out.push({ ...ev, t: base + ev.step });
    base += bar.steps;
  }
  return out;
}

const totalSteps = (bars: Bar[]) => bars.reduce((a, b) => a + b.steps, 0);

/** The groove skeleton per 4/4 bar (16 steps of the stream): downbeat kicks and both backbeats. */
export function drumStats(bars: Bar[]) {
  const drums = drumStream(bars);
  if (!drums) return null;
  const n = Math.max(1, Math.floor(totalSteps(bars) / 16));
  let kick1 = 0;
  let backbeats = 0;
  for (let b = 0; b < n; b++) {
    const at = (lane: number, s: number) => drums.some((d) => d.lane === lane && d.t === b * 16 + s);
    if (at(0, 0)) kick1++;
    if (at(1, 4) && at(1, 12)) backbeats++;
  }
  return {
    kickOnBeat1Pct: Math.round((kick1 / n) * 100),
    backbeatsPct: Math.round((backbeats / n) * 100),
    kicksEmpty: !drums.some((d) => d.lane === 0),
    kicksPerBar: +(drums.filter((d) => d.lane === 0).length / n).toFixed(2),
    snaresPerBar: +(drums.filter((d) => d.lane === 1).length / n).toFixed(2),
    hatsPerBar: +(drums.filter((d) => d.lane === 2).length / n).toFixed(2),
  };
}

/** chord changes across the stream: the bar's context at each change step */
function changes(bars: Bar[]): Array<{ t: number; ctx: HarmonicContext; step: number }> {
  const out: Array<{ t: number; ctx: HarmonicContext; step: number }> = [];
  let base = 0;
  for (const bar of bars) {
    for (let s = 0; s < bar.steps; s++) if (isChangeAt(bar.ctx, s)) out.push({ t: base + s, ctx: bar.ctx, step: s });
    base += bar.steps;
  }
  return out;
}

/** % of chord changes where the bass plays that chord's root right on the change */
export function bassRootOnChangePct(bars: Bar[]): number | null {
  if (!bars.some((b) => audible(b, 'bass'))) return null;
  const bass = pitchedStream(bars, 'bass');
  const ch = changes(bars);
  const hits = ch.filter((c) => bass.some((n) => n.t === c.t && pc(n.midis[0]) === chordAt(c.ctx, c.step).rootPc)).length;
  return ch.length ? Math.round((hits / ch.length) * 100) : null;
}

/** longest run of consecutive melody notes on the same pitch */
export function longestSameRun(notes: StreamNote[]): number {
  let best = notes.length ? 1 : 0;
  let run = 1;
  for (let i = 1; i < notes.length; i++) {
    run = notes[i].midis[0] === notes[i - 1].midis[0] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** longest stretch with no note sounding, around the loop (the stream repeats) */
export function maxRestSteps(notes: StreamNote[], total: number): number {
  if (!notes.length) return total;
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  let best = 0;
  let soundingUntil = Math.max(...sorted.map((n) => n.t + n.lenSteps)) - total;
  for (const n of sorted) {
    best = Math.max(best, n.t - soundingUntil);
    soundingUntil = Math.max(soundingUntil, n.t + n.lenSteps);
  }
  return +Math.max(0, best).toFixed(2);
}

/** mean semitones the chord voices move per chord change (voices matched low to high) */
export function voiceMotionPerChange(notes: StreamNote[]): number | null {
  let moves = 0;
  let sum = 0;
  for (let i = 1; i < notes.length; i++) {
    const a = [...notes[i - 1].midis].sort((x, y) => x - y);
    const b = [...notes[i].midis].sort((x, y) => x - y);
    if (a.join() === b.join()) continue;
    const k = Math.min(a.length, b.length);
    for (let v = 0; v < k; v++) sum += Math.abs(a[v] - b[v]);
    moves++;
  }
  return moves ? +(sum / moves).toFixed(2) : null;
}

export function registerBounds(notes: StreamNote[]) {
  const all = notes.flatMap((n) => n.midis);
  if (!all.length) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  return { low: nn(lo), high: nn(hi), lowMidi: lo, highMidi: hi };
}

const key = (ev: WireNote | WireDrum) => ('midis' in ev ? `${ev.step}:${ev.midis.join('.')}` : `${ev.step}:d${ev.lane}`);

/** Jaccard similarity of two bars' events (step + pitches) */
export function similarity(a: Array<WireNote | WireDrum> | undefined, b: Array<WireNote | WireDrum> | undefined): number | null {
  if (!a || !b) return null;
  const A = new Set(a.map(key));
  const B = new Set(b.map(key));
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? +(inter / union).toFixed(2) : 1;
}

const partOf = (bar: Bar, kind: PlayerKind) => (audible(bar, kind) ? ((bar.patterns[kind] ?? []) as Array<WireNote | WireDrum>) : undefined);

/** how much the music changes over time: distinct bars, and each bar against bar 1 */
export function variation(bars: Bar[]) {
  const kinds = [...new Set(bars.flatMap((b) => b.audible))];
  const barKey = (bar: Bar) => JSON.stringify(kinds.map((k) => partOf(bar, k)?.map(key) ?? null));
  const distinct: Record<string, number> = { all: new Set(bars.map(barKey)).size };
  const vsFirst: Record<string, number | null> = {};
  for (const k of kinds) {
    distinct[k] = new Set(bars.map((b) => JSON.stringify(partOf(b, k)?.map(key) ?? null))).size;
    const sims = bars.slice(1).map((b) => similarity(partOf(bars[0], k), partOf(b, k))).filter((x): x is number => x !== null);
    vsFirst[k] = sims.length ? +(sims.reduce((a, x) => a + x, 0) / sims.length).toFixed(2) : null;
  }
  return { bars: bars.length, distinctBars: distinct, vsFirstSimilarity: vsFirst };
}

/** pitch classes of the chord sounding at a bar step (its colour tones included) */
export const chordPcsAt = (ctx: HarmonicContext, s: number) => new Set([...chordAt(ctx, s).pcs, ...(chordAt(ctx, s).ext ?? [])]);

export function partMetrics(bars: Bar[], kind: PitchedKind) {
  const notes = pitchedStream(bars, kind);
  const flat = notes.flatMap((n) => n.midis.map((m) => ({ ...n, m })));
  const mel = notes.map((n) => n.midis[0]);
  const ivs = mel.slice(1).map((m, i) => Math.abs(m - mel[i]));
  const isCT = (n: StreamNote & { m: number }) => chordPcsAt(bars[n.bar].ctx, n.step).has(pc(n.m));
  const chordTone = flat.filter(isCT).length;
  const strong = flat.filter((n) => n.step % 4 === 0);
  const strongCT = strong.filter(isCT).length;
  return {
    kind,
    notes: notes.length,
    notesPerBar: +((notes.length * 16) / Math.max(1, totalSteps(bars))).toFixed(2),
    distinctPitches: new Set(flat.map((n) => n.m)).size,
    rangeSemis: flat.length ? Math.max(...flat.map((n) => n.m)) - Math.min(...flat.map((n) => n.m)) : 0,
    lowest: flat.length ? nn(Math.min(...flat.map((n) => n.m))) : '-',
    highest: flat.length ? nn(Math.max(...flat.map((n) => n.m))) : '-',
    meanInterval: ivs.length ? +(ivs.reduce((a, b) => a + b, 0) / ivs.length).toFixed(2) : 0,
    maxLeap: ivs.length ? Math.max(...ivs) : 0,
    onBeatPct: notes.length ? Math.round((notes.filter((n) => n.step % 4 === 0).length / notes.length) * 100) : 0,
    chordTonePct: flat.length ? Math.round((chordTone / flat.length) * 100) : 0,
    strongBeatChordTonePct: strong.length ? Math.round((strongCT / strong.length) * 100) : null,
    meanLenSteps: notes.length ? +(notes.reduce((a, n) => a + n.lenSteps, 0) / notes.length).toFixed(2) : 0,
  };
}

/** semitone clashes between parts: pitches a minor 2nd / major 7th apart sounding together (notated lengths) */
export function clashes(bars: Bar[]) {
  const sounding: Array<{ kind: string; m: number; from: number; to: number }> = [];
  for (const kind of PITCHED) {
    for (const n of pitchedStream(bars, kind)) for (const m of n.midis) sounding.push({ kind, m, from: n.t, to: n.t + Math.max(1, n.lenSteps) });
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
  return { count, perBar: +((count * 16) / Math.max(1, totalSteps(bars))).toFixed(2), examples };
}

/** the compact per-seed numbers a sweep aggregates */
export function sweepMetrics(bars: Bar[]) {
  const melody = pitchedStream(bars, 'melody');
  const bassNotes = pitchedStream(bars, 'bass');
  const drums = drumStats(bars);
  const v = variation(bars);
  const m = partMetrics(bars, 'melody');
  return {
    kickOnBeat1Pct: drums?.kickOnBeat1Pct ?? null,
    backbeatsPct: drums?.backbeatsPct ?? null,
    kicksEmpty: drums ? drums.kicksEmpty : null,
    bassRootOnChangePct: bassRootOnChangePct(bars),
    bassOnRootPct: bassNotes.length
      ? Math.round((bassNotes.filter((n) => pc(n.midis[0]) === chordAt(bars[n.bar].ctx, n.step).rootPc).length / bassNotes.length) * 100)
      : null,
    melodyNotesPerBar: melody.length ? m.notesPerBar : null,
    melodyChordTonePct: melody.length ? m.chordTonePct : null,
    longestSameRun: melody.length ? longestSameRun(melody) : null,
    melodyMaxRestSteps: melody.length ? maxRestSteps(melody, totalSteps(bars)) : null,
    voiceMotionPerChange: voiceMotionPerChange(pitchedStream(bars, 'chords')),
    clashesPerBar: clashes(bars).perBar,
    distinctBars: v.distinctBars.all,
    melodyVsFirst: v.vsFirstSimilarity.melody ?? null,
  };
}

/** mean / percentiles of numbers, share of true for booleans */
export function aggregate(rows: Array<Record<string, number | boolean | null>>) {
  const out: Record<string, unknown> = { n: rows.length };
  for (const k of Object.keys(rows[0] ?? {})) {
    const vals = rows.map((r) => r[k]).filter((x) => x !== null);
    if (!vals.length) {
      out[k] = null;
    } else if (typeof vals[0] === 'boolean') {
      out[k] = { truePct: +((vals.filter(Boolean).length / vals.length) * 100).toFixed(1) };
    } else {
      const xs = (vals as number[]).slice().sort((a, b) => a - b);
      const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
      out[k] = { mean: +(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(2), p10: q(0.1), p50: q(0.5), p90: q(0.9) };
    }
  }
  return out;
}
