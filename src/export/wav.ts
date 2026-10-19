/**
 * Offline WAV bounce (PRD §6.10): renders the first bars of the timeline through
 * the SAME Rust/WASM DSP core in an OfflineAudioContext — faster than real time.
 * It sends the worklet the very messages live playback sends (src/audio/messages.ts).
 */

import { useLoomStore } from '../graph/store';
import { bounceMessages } from '../audio/messages';

export async function bounceWav(bars = 4): Promise<{ rms: number; seconds: number }> {
  const { nodes, edges, conductor } = useLoomStore.getState();
  const sr = 48000;
  const steps = Number(conductor.steps) || 16;
  const barSeconds = (steps * 60) / (conductor.tempo * 4);
  const seconds = bars * barSeconds + 1.5; // reverb/release tail
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

  for (const msg of bounceMessages({ nodes, edges, conductor }, bars)) node.port.postMessage(msg);

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

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__loomBounce = bounceWav;
}
