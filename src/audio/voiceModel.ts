/**
 * Pure mirror of the DSP voice engine (loom-dsp/src/lib.rs) and of the
 * worklet's note scheduling (public/loom-worklet.js triggerStep): linear
 * attack/decay, exponential release from the current level, monophonic
 * melody/bass with last-note priority (fingered glide when portamento is on),
 * same-pitch retrigger, and the pad choke at every chord event. Lets node
 * tools measure what is actually heard, tails included, not just the notation.
 */

import type { Edge } from '@xyflow/react';
import type { ExpressionData, LoomNode, SynthData } from '../graph/types';

export type VoiceKind = 'melody' | 'chords' | 'bass' | 'arp';

export interface Envelope {
  attack: number; // s
  decay: number; // s
  sustain: number; // 0..1
  release: number; // s, to -60 dB
}

/** params_for() in lib.rs — what a kind uses for anything its Synth node leaves unset */
export const DSP_DEFAULT_ENV: Record<VoiceKind, Envelope> = {
  melody: { attack: 0.004, decay: 0.32, sustain: 0.06, release: 0.5 },
  chords: { attack: 0.1, decay: 0.4, sustain: 0.55, release: 1.3 },
  bass: { attack: 0.008, decay: 0.3, sustain: 0.3, release: 0.3 },
  arp: { attack: 0.002, decay: 0.14, sustain: 0.02, release: 0.25 },
};

export const MONO_KINDS: ReadonlySet<VoiceKind> = new Set(['melody', 'bass']);
const MONO_HANDOFF_SECS = 0.008;
const RELEASE_LN = 6.9;
const OFF_LEVEL = 1e-4;
/** worklet: gate = lenSteps × step × GATE */
export const GATE = 0.95;
/** worklet: the pad chokes over CHOKE × the new chord's length */
export const CHOKE = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

/** The envelope a kind plays with, given the Synth node it is routed to (set_voice clamps included). */
export function envelopeFor(kind: VoiceKind, synth?: Partial<SynthData> | null): Envelope {
  const d = DSP_DEFAULT_ENV[kind];
  if (!synth) return { ...d };
  return {
    attack: clamp(Number(synth.attack ?? 0.005), 0.0005, 2),
    decay: isSet(synth.decay) ? clamp(Number(synth.decay), 0.005, 4) : d.decay,
    sustain: isSet(synth.sustain) ? clamp(Number(synth.sustain), 0, 1) : d.sustain,
    release: clamp(Number(synth.release ?? 0.4), 0.02, 4),
  };
}

export interface PartInstrument {
  synth: SynthData | null;
  /** Expression portamento on the note path (0 = no glide) */
  portamento: number;
  env: Envelope;
}

/** Follow each part's note cable through Expression nodes to its Synth (as wasmEngine traceRoute does). */
export function partInstruments(nodes: LoomNode[], edges: Edge[]): Record<VoiceKind, PartInstrument> {
  const out = {} as Record<VoiceKind, PartInstrument>;
  for (const kind of ['melody', 'chords', 'bass', 'arp'] as VoiceKind[]) {
    let cur = nodes.find((n) => n.type === kind)?.id;
    let synth: SynthData | null = null;
    let portamento = 0;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const edge = edges.find((e) => e.source === cur && e.sourceHandle === 'notes-out');
      const next = edge && nodes.find((n) => n.id === edge.target);
      if (!next) break;
      if (next.type === 'expression') portamento = Number((next.data as ExpressionData).portamento) || 0;
      else if (next.type === 'synth') {
        synth = next.data as SynthData;
        break;
      } else break;
      cur = next.id;
    }
    out[kind] = { synth, portamento, env: envelopeFor(kind, synth) };
  }
  return out;
}

export interface ModelEvent {
  kind: VoiceKind;
  /** onset, seconds */
  t: number;
  midis: number[];
  /** notated length, seconds (lenSteps × step) */
  lenSec: number;
}

/** One voice sounding one pitch above the audibility threshold, [t0, t1] seconds. */
export interface Heard {
  kind: VoiceKind;
  midi: number;
  t0: number;
  t1: number;
}

const enum St { Off, A, D, S, R }

interface V {
  kind: VoiceKind;
  midi: number;
  st: St;
  level: number;
  remaining: number;
  relCoef: number;
  seg: Heard | null;
}

/**
 * Run the events through the voice engine and return every audible span.
 * `threshold` is the envelope level counted as heard (0.1 = -20 dB).
 */
export function simulateVoices(
  events: ModelEvent[],
  env: Record<VoiceKind, Envelope>,
  glide: Partial<Record<VoiceKind, boolean>>,
  endT: number,
  threshold = 0.1,
  dt = 1 / 4000,
): Heard[] {
  const evs = [...events].sort((a, b) => a.t - b.t);
  const voices: V[] = [];
  const mono: Partial<Record<VoiceKind, V>> = {};
  const heard: Heard[] = [];
  const coefFor = (secs: number) => Math.exp(-RELEASE_LN * dt / Math.max(0.001, secs));
  const release = (v: V, secs: number) => {
    const c = coefFor(secs);
    if (v.st === St.R) v.relCoef = Math.min(v.relCoef, c);
    else if (v.st !== St.Off) {
      v.st = St.R;
      v.relCoef = c;
    }
  };
  const retrigger = (v: V, gate: number) => {
    v.st = St.A;
    v.remaining = gate;
  };
  const start = (kind: VoiceKind, midi: number, gate: number): V => {
    const v: V = { kind, midi, st: St.A, level: 0, remaining: gate, relCoef: 0, seg: null };
    voices.push(v);
    return v;
  };

  const apply = (ev: ModelEvent) => {
    const { kind } = ev;
    const gate = ev.lenSec * GATE;
    if (kind === 'chords') {
      const secs = Math.min(CHOKE * ev.lenSec, env.chords.release);
      for (const v of voices) if (v.kind === kind) release(v, secs);
    }
    for (const midi of ev.midis) {
      if (MONO_KINDS.has(kind)) {
        const cur = mono[kind] && mono[kind]!.st !== St.Off ? mono[kind]! : null;
        const reuse = cur && (cur.midi === midi || glide[kind]) ? cur : null;
        for (const v of voices) if (v.kind === kind && v !== reuse) release(v, MONO_HANDOFF_SECS);
        if (reuse) {
          if (reuse.midi !== midi) {
            reuse.midi = midi;
            reuse.seg = null; // the old pitch ends here; the glide target starts a new span
          }
          retrigger(reuse, gate);
        } else mono[kind] = start(kind, midi, gate);
        continue;
      }
      const same = voices.find((v) => v.kind === kind && v.st !== St.Off && v.midi === midi);
      if (same) retrigger(same, gate);
      else start(kind, midi, gate);
    }
  };

  let ei = 0;
  const ticks = Math.ceil(endT / dt);
  for (let i = 0; i <= ticks; i++) {
    const t = i * dt;
    while (ei < evs.length && evs[ei].t <= t + 1e-9) apply(evs[ei++]);
    for (const v of voices) {
      const p = env[v.kind];
      switch (v.st) {
        case St.A:
          v.level += dt / p.attack;
          if (v.level >= 1) {
            v.level = 1;
            v.st = St.D;
          }
          break;
        case St.D:
          v.level -= ((1 - p.sustain) * dt) / p.decay;
          if (v.level <= p.sustain) {
            v.level = p.sustain;
            v.st = St.S;
          }
          break;
        case St.R:
          v.level *= v.relCoef;
          if (v.level <= OFF_LEVEL) {
            v.level = 0;
            v.st = St.Off;
          }
          break;
      }
      if (v.st !== St.Off) {
        v.remaining -= dt;
        if (v.remaining <= 0 && v.st !== St.R) release(v, p.release);
      }
      const audible = v.st !== St.Off && v.level > threshold;
      if (audible) {
        if (!v.seg) {
          v.seg = { kind: v.kind, midi: v.midi, t0: t, t1: t };
          heard.push(v.seg);
        } else v.seg.t1 = t;
      } else v.seg = null;
    }
    for (let k = voices.length - 1; k >= 0; k--) if (voices[k].st === St.Off) voices.splice(k, 1);
  }
  return heard;
}

const pc = (m: number) => ((m % 12) + 12) % 12;
const overlaps = (a: Heard, b: Heard) => a.t0 <= b.t1 && b.t0 <= a.t1;

/**
 * Semitone (m2 / M7) clashes between heard spans whose later onset lies in
 * [from, to): `cross` = between parts, `same` = within one part.
 */
export function tailClashes(heard: Heard[], from: number, to: number) {
  let cross = 0;
  let same = 0;
  const examples: string[] = [];
  for (let i = 0; i < heard.length; i++) {
    for (let j = i + 1; j < heard.length; j++) {
      const a = heard[i];
      const b = heard[j];
      const d = Math.abs(pc(a.midi) - pc(b.midi));
      if (d !== 1 && d !== 11) continue;
      const onset = Math.max(a.t0, b.t0);
      if (onset < from || onset >= to || !overlaps(a, b)) continue;
      if (a.kind === b.kind) same++;
      else {
        cross++;
        if (examples.length < 6) examples.push(`${a.kind} ${a.midi} × ${b.kind} ${b.midi} @${onset.toFixed(2)}s`);
      }
    }
  }
  return { cross, same, examples };
}

/** Voices of `kind` heard at time t. */
export function ringingAt(heard: Heard[], kind: VoiceKind, t: number): number {
  let n = 0;
  for (const h of heard) if (h.kind === kind && h.t0 <= t && h.t1 >= t) n++;
  return n;
}
