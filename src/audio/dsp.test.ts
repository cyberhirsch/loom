import { describe, it, expect, beforeAll } from 'vitest';
import { DEFAULT_SCRIPT } from '../graph/defaultScript';
import { parseLoomScript } from '../script/loomscript';
import { computeContext, computeBasePattern, ROLE_OCTAVE } from '../graph/session';
import { eventMidis } from '../theory/harmony';
import type { NoteEvent } from '../theory/melody';
import type { ConductorState, PlayerData, PlayerKind, SynthData } from '../graph/types';
import { partInstruments, ringingAt, simulateVoices, type ModelEvent, type VoiceKind } from './voiceModel';

// node:fs without @types/node in the app tsconfig
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (p: URL) => Uint8Array<ArrayBuffer> };

/** The shipped DSP core, driven in node exactly like the worklet does. */
const WASM = readFileSync(new URL('../../public/loom-dsp.wasm', import.meta.url));
const SR = 48000;
const KIND: Record<VoiceKind, number> = { melody: 0, chords: 1, bass: 2, arp: 3 };
const BPM = 102;
const SPS = (SR * 60) / (BPM * 4);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dsp = Record<string, any>;

const project = (() => {
  const r = parseLoomScript(DEFAULT_SCRIPT);
  if (!r.ok) throw new Error('bad default script');
  return r.project;
})();
const parts = partInstruments(project.nodes, project.edges);

function voiceArgs(kind: VoiceKind, s: SynthData | null) {
  const opt = (v: unknown) => (v === undefined ? -1 : Number(v));
  return s ? [KIND[kind], Number(s.wave), Number(s.attack), opt(s.decay), opt(s.sustain), Number(s.release), Number(s.cutoff)] : null;
}

async function dsp(): Promise<Dsp> {
  const { instance } = await WebAssembly.instantiate(WASM, {});
  const w = instance.exports as Dsp;
  w.init(SR);
  for (const kind of Object.keys(KIND) as VoiceKind[]) {
    const args = voiceArgs(kind, parts[kind].synth);
    if (args) w.set_voice(...args);
    w.set_sends(KIND[kind], 0, 0);
  }
  w.set_reverb(0);
  w.set_delay(1000, 0, 0);
  return w;
}

const renderSecs = (w: Dsp, secs: number) => {
  for (let i = 0; i < Math.ceil((secs * SR) / 128); i++) w.render();
};

/** seconds until the note's envelope falls below -20 dB (level 0.1) */
async function ringSecs(kind: VoiceKind, midi: number, lenSteps: number): Promise<number> {
  const w = await dsp();
  w.note_on(KIND[kind], midi, 0.9, Math.floor(lenSteps * SPS * 0.95), 0);
  let last = 0;
  for (let b = 0; b < (SR * 6) / 128; b++) {
    w.render();
    if (w.voice_level(KIND[kind], midi) > 0.1) last = b + 1;
  }
  return (last * 128) / SR;
}

describe('DSP envelope (release from the current level)', () => {
  it('ring time is non-decreasing in note length for every kind, and a 16th lead note is short', async () => {
    for (const [kind, midi] of [['melody', 67], ['chords', 55], ['bass', 36], ['arp', 91]] as Array<[VoiceKind, number]>) {
      let prev = 0;
      for (const len of [1, 2, 3, 4, 6, 8, 16]) {
        const r = await ringSecs(kind, midi, len);
        expect(r, `${kind} len ${len}`).toBeGreaterThanOrEqual(prev - 128 / SR);
        prev = r;
      }
    }
    expect(await ringSecs('melody', 67, 1)).toBeLessThan(0.4);
  });

  it('decay/sustain from the Synth node land in the DSP; unset (-1) keeps the kind default', async () => {
    const w = await dsp();
    w.set_voice(KIND.arp, 1, 0.002, 0.05, 0.6, 0.2, 5000);
    w.note_on(KIND.arp, 72, 1, SR, 0);
    renderSecs(w, 0.3);
    expect(w.voice_level(KIND.arp, 72)).toBeCloseTo(0.6, 2);
    w.set_voice(KIND.arp, 1, 0.002, -1, -1, 0.2, 5000);
    w.note_on(KIND.arp, 74, 1, SR, 0);
    renderSecs(w, 0.3);
    expect(w.voice_level(KIND.arp, 74)).toBeCloseTo(0.02, 2); // params_for arp sustain
  });
});

describe('DSP voice allocation', () => {
  it('a same-pitch re-strike retriggers the sounding voice instead of stacking one', async () => {
    for (const kind of ['chords', 'arp', 'melody', 'bass'] as VoiceKind[]) {
      const w = await dsp();
      w.note_on(KIND[kind], 60, 0.8, Math.floor(SPS * 4), 0);
      renderSecs(w, 0.1);
      const before = w.voices_active(KIND[kind], 0);
      w.note_on(KIND[kind], 60, 0.8, Math.floor(SPS * 4), 0);
      expect(w.voices_active(KIND[kind], 0), kind).toBe(before);
      renderSecs(w, 0.05);
      expect(w.voices_active(KIND[kind], 0), kind).toBe(1);
    }
  });

  it('melody and bass are monophonic: a new note hands the previous one off within ~10 ms', async () => {
    for (const kind of ['melody', 'bass'] as VoiceKind[]) {
      const w = await dsp();
      w.set_glide(KIND[kind], 0);
      w.note_on(KIND[kind], 60, 0.8, Math.floor(SPS * 8), 0);
      renderSecs(w, 0.1);
      w.note_on(KIND[kind], 63, 0.8, Math.floor(SPS * 8), 0);
      renderSecs(w, 0.012);
      expect(w.voice_level(KIND[kind], 60), kind).toBeLessThan(0.1);
      expect(w.voices_active(KIND[kind], 0.1), kind).toBe(1);
    }
    // chords and arp stay polyphonic
    const w = await dsp();
    w.note_on(KIND.chords, 60, 0.8, Math.floor(SPS * 8), 0);
    w.note_on(KIND.chords, 64, 0.8, Math.floor(SPS * 8), 0);
    renderSecs(w, 0.2);
    expect(w.voices_active(KIND.chords, 0.1)).toBe(2);
  });

  it('with portamento, overlapping lead notes glide on one voice', async () => {
    const w = await dsp();
    w.set_glide(KIND.melody, 0.045 * SR);
    w.note_on(KIND.melody, 60, 0.8, Math.floor(SPS * 2), 0);
    renderSecs(w, SPS / SR);
    w.note_on(KIND.melody, 67, 0.8, Math.floor(SPS * 2), 0);
    expect(w.voices_active(KIND.melody, 0)).toBe(1);
    expect(w.voice_level(KIND.melody, 67)).toBeGreaterThan(0.1);
    renderSecs(w, 0.1);
    expect(w.voices_active(KIND.melody, 0)).toBe(1);
  });

  it('choke_kind releases the previous pad chord below -12 dB within half the new chord', async () => {
    const w = await dsp();
    const lenSteps = 4;
    for (const m of [60, 64, 67]) w.note_on(KIND.chords, m, 0.8, Math.floor(lenSteps * SPS * 0.95), 0);
    renderSecs(w, (lenSteps * SPS) / SR);
    const atChange = w.voice_level(KIND.chords, 64);
    const half = (0.5 * lenSteps * SPS) / SR;
    w.choke_kind(KIND.chords, half * 1000);
    for (const m of [62, 65, 69]) w.note_on(KIND.chords, m, 0.8, Math.floor(lenSteps * SPS * 0.95), 0);
    renderSecs(w, half);
    expect(w.voice_level(KIND.chords, 64)).toBeLessThan(atChange * 0.25);
    expect(w.voice_level(KIND.chords, 62)).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// the real worklet host (public/loom-worklet.js) against the score tool's voice model
// ---------------------------------------------------------------------------

interface Proc {
  onMessage(msg: unknown): Promise<void>;
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  wasm: Dsp;
}

let Processor: new () => Proc;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  g.AudioWorkletProcessor = class {
    port = { postMessage() {}, onmessage: null as unknown };
  };
  g.registerProcessor = (_name: string, cls: new () => Proc) => {
    Processor = cls;
  };
  // @ts-expect-error plain-JS worklet module outside src
  await import('../../public/loom-worklet.js');
});

function defaultWire(scaleId: ConductorState['scaleId']) {
  const conductor = { keyIndex: 0, scaleId, tempo: BPM, steps: 16, evolveOn: false, journeyOn: false, modEvery: 4, journeyLabel: 'home', liveKeyIndex: 0, liveScaleId: scaleId } as ConductorState;
  const ctx = computeContext(conductor, Number(project.nodes.find((n) => n.type === 'chords')!.data.seed));
  const wire: Partial<Record<VoiceKind, Array<{ step: number; midis: number[]; vel: number; lenSteps: number }>>> = {};
  for (const kind of ['melody', 'chords', 'bass', 'arp'] as VoiceKind[]) {
    const data = project.nodes.find((n) => n.type === kind)!.data as unknown as PlayerData;
    const oct = ROLE_OCTAVE[kind as PlayerKind] + Number(data.register ?? 0);
    const pat = (computeBasePattern(kind as PlayerKind, ctx, data) as NoteEvent[]).slice().sort((a, b) => a.step - b.step);
    wire[kind] = pat.map((ev) => ({
      step: ev.step,
      midis: eventMidis(ctx, kind, ev.degree, oct),
      vel: ev.velocity,
      lenSteps: ev.lengthSteps,
    }));
  }
  return wire;
}

describe('worklet + DSP vs the voice model', () => {
  it('voices ringing per part match the model the score tool uses', async () => {
    for (const scaleId of ['minor_pent', 'aeolian'] as const) {
      const p = new Processor();
      await p.onMessage({ type: 'wasm', bytes: WASM });
      for (const kind of Object.keys(KIND) as VoiceKind[]) {
        const s = parts[kind].synth!;
        p.onMessage({ type: 'voice', kind, wave: s.wave, attack: s.attack, decay: s.decay, sustain: s.sustain, release: s.release, cutoff: s.cutoff });
        p.onMessage({ type: 'sends', kind, rev: 0, del: 0 });
        p.onMessage({ type: 'glide', kind, seconds: parts[kind].portamento * 0.3 });
      }
      p.onMessage({ type: 'tempo', bpm: BPM });
      const wire = defaultWire(scaleId);
      p.onMessage({ type: 'patterns', patterns: wire, immediate: true });
      p.onMessage({ type: 'start' });

      const loops = 3;
      const stepSec = SPS / SR;
      const blocks = Math.floor((loops * 16 * SPS) / 128);
      const measured: Record<VoiceKind, number[]> = { melody: [], chords: [], bass: [], arp: [] };
      const out = [[new Float32Array(128), new Float32Array(128)]];
      for (let b = 0; b < blocks; b++) {
        p.process([], out);
        const t = ((b + 1) * 128) / SR;
        if (t < 16 * stepSec) continue; // skip loop 1 (no tails yet)
        for (const kind of Object.keys(KIND) as VoiceKind[]) measured[kind].push(p.wasm.voices_active(KIND[kind], 0.1));
      }

      const events: ModelEvent[] = [];
      for (let l = 0; l < loops; l++)
        for (const kind of Object.keys(KIND) as VoiceKind[])
          for (const ev of wire[kind] ?? []) events.push({ kind, t: (l * 16 + ev.step) * stepSec, midis: ev.midis, lenSec: ev.lenSteps * stepSec });
      const env = Object.fromEntries((Object.keys(KIND) as VoiceKind[]).map((k) => [k, parts[k].env])) as Record<VoiceKind, (typeof parts)['melody']['env']>;
      const glide = Object.fromEntries((Object.keys(KIND) as VoiceKind[]).map((k) => [k, parts[k].portamento > 0]));
      const heard = simulateVoices(events, env, glide, loops * 16 * stepSec + 1);
      for (const kind of Object.keys(KIND) as VoiceKind[]) {
        const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const model: number[] = [];
        for (let b = 0; b < blocks; b++) {
          const t = ((b + 1) * 128) / SR;
          if (t >= 16 * stepSec) model.push(ringingAt(heard, kind, t));
        }
        expect(Math.abs(mean(measured[kind]) - mean(model)), `${scaleId} ${kind}`).toBeLessThan(0.05);
        if (kind === 'melody' || kind === 'bass') expect(Math.max(...measured[kind])).toBeLessThanOrEqual(2);
      }
    }
  });
});
