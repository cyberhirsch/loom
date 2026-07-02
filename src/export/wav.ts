/**
 * Offline WAV bounce (PRD §6.10): renders the current loop through the SAME
 * Rust/WASM DSP core in an OfflineAudioContext — faster than real time.
 */

import { useLoomStore, STEPS } from '../graph/store';
import { computeContext, computeBasePattern, ROLE_OCTAVE } from '../graph/session';
import { degreeToMidi } from '../theory/scales';
import { chordMidi } from '../theory/harmony';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';
import type { PlayerData, PlayerKind } from '../graph/types';

const PLAYER_KINDS: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Resolve current store patterns into the worklet wire format. */
function resolveWire() {
  const s = useLoomStore.getState();
  const chordsNode = s.nodes.find((n) => n.type === 'chords');
  const ctx = computeContext(s.conductor, chordsNode ? Number(chordsNode.data.seed) : 1);
  const wire: Record<string, unknown> = {};
  for (const node of s.nodes) {
    if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
    const kind = node.type as PlayerKind;
    const data = node.data as unknown as PlayerData;
    const pattern =
      (data.frozen && (data.frozenPattern as NoteEvent[] | DrumEvent[])) ||
      s.patterns[node.id] ||
      computeBasePattern(kind, ctx, data);
    if (kind === 'drums') {
      wire.drums = (pattern as DrumEvent[]).map((ev) => ({ step: ev.step, lane: ev.lane, vel: ev.velocity }));
    } else {
      const octave = ROLE_OCTAVE[kind] + Number(data.register ?? 0);
      wire[kind] = (pattern as NoteEvent[]).map((ev) => ({
        step: ev.step,
        midis: kind === 'chords' ? chordMidi(ctx, ev.degree, octave) : [degreeToMidi(ctx.keyIndex, ctx.scaleId, ev.degree, octave)],
        vel: ev.velocity,
        lenSteps: ev.lengthSteps,
      }));
    }
  }
  return wire;
}

export async function bounceWav(loops = 4): Promise<{ rms: number; seconds: number }> {
  const s = useLoomStore.getState();
  const tempo = s.conductor.tempo;
  const sr = 48000;
  const loopSeconds = (STEPS * 60) / (tempo * 4);
  const seconds = loops * loopSeconds + 1.5; // reverb/release tail
  const offctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);

  await offctx.audioWorklet.addModule(new URL('loom-worklet.js', document.baseURI).href);
  const node = new AudioWorkletNode(offctx, 'loom-engine', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(offctx.destination);

  const bytes = await (await fetch(new URL('loom-dsp.wasm', document.baseURI).href)).arrayBuffer();
  await new Promise<void>((resolve) => {
    node.port.onmessage = (e) => {
      if (e.data.type === 'ready') resolve();
    };
    node.port.postMessage({ type: 'wasm', bytes });
  });

  node.port.postMessage({ type: 'tempo', bpm: tempo });
  for (const n of s.nodes) {
    if (!PLAYER_KINDS.includes(n.type as PlayerKind)) continue;
    node.port.postMessage({ type: 'gain', kind: n.type, value: dbToLinear(Number(n.data.volume)) * 0.4 });
    node.port.postMessage({ type: 'mute', kind: n.type, value: Boolean(n.data.mute) });
  }
  node.port.postMessage({ type: 'patterns', patterns: resolveWire(), immediate: true });
  node.port.postMessage({ type: 'start' });

  const buffer = await offctx.startRendering();

  // 16-bit PCM WAV
  const frames = buffer.length;
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const data = new DataView(new ArrayBuffer(44 + frames * 4));
  const writeStr = (off: number, text: string) => [...text].forEach((c, i) => data.setUint8(off + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  data.setUint32(4, 36 + frames * 4, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 2, true); // stereo
  data.setUint32(24, sr, true);
  data.setUint32(28, sr * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  writeStr(36, 'data');
  data.setUint32(40, frames * 4, true);
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    const cl = Math.max(-1, Math.min(1, l[i]));
    const cr = Math.max(-1, Math.min(1, r[i]));
    sum += cl * cl + cr * cr;
    data.setInt16(44 + i * 4, cl * 0x7fff, true);
    data.setInt16(46 + i * 4, cr * 0x7fff, true);
  }
  const rms = Math.sqrt(sum / (frames * 2));

  if (rms < 1e-6) throw new Error('bounce rendered silence');
  const blob = new Blob([data.buffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'loom-loop.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { rms, seconds };
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__loomBounce = bounceWav;
}
