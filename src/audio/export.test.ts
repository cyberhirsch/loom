import { describe, it, expect } from 'vitest';
import { useLoomStore } from '../graph/store';
import { defaultPatch, templatePatch, type Patch } from '../graph/templates';
import { renderBar, renderTimeline, type TimelineProject, type WireDrum, type WireNote } from '../graph/timeline';
import { mixMessages, routingMessages } from '../graph/routing';
import { buildMidi } from '../export/midi';
import { WasmEngine, type EnginePort } from './wasmEngine';
import { bounceMessages } from './messages';

// node:fs without @types/node in the app tsconfig
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as {
  readFileSync: { (p: URL): Uint8Array<ArrayBuffer>; (p: URL, enc: string): string };
};
const WASM = readFileSync(new URL('../../public/loom-dsp.wasm', import.meta.url));
const WORKLET = readFileSync(new URL('../../public/loom-worklet.js', import.meta.url), 'utf8');

type Msg = Record<string, unknown> & { type: string };

/** The shipped worklet (public/loom-worklet.js) instantiated in node around the shipped WASM core. */
interface Worklet {
  onMessage(msg: unknown): Promise<void>;
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  port: { postMessage(m: Msg): void; onmessage: ((e: { data: unknown }) => void) | null };
  absBar: number;
  patterns: unknown;
}

async function makeWorklet(sampleRate: number, onPost: (m: Msg) => void): Promise<Worklet> {
  let Processor: (new () => Worklet) | null = null;
  class AudioWorkletProcessor {
    port = { postMessage: (m: Msg) => onPost(m), onmessage: null };
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WORKLET)(
    AudioWorkletProcessor,
    (_name: string, cls: new () => Worklet) => (Processor = cls),
    sampleRate,
  );
  const w = new Processor!();
  await w.onMessage({ type: 'wasm', bytes: WASM });
  return w;
}

const deliver = (w: Worklet, msg: unknown) => w.port.onmessage!({ data: JSON.parse(JSON.stringify(msg)) });

/** Render `frames` samples, calling `after` after every 128-sample block. */
function run(w: Worklet, frames: number, after?: () => void): Float32Array[] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const out = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < frames; i += 128) {
    w.process([], out);
    L.set(out[0][0].subarray(0, Math.min(128, frames - i)), i);
    R.set(out[0][1].subarray(0, Math.min(128, frames - i)), i);
    after?.();
  }
  return [L, R];
}

function load(project: Patch) {
  useLoomStore.setState({
    nodes: project.nodes, edges: project.edges, conductor: project.conductor,
    patterns: {}, effDensity: {}, arrangerSection: -1, loopCount: 0, playing: false,
  });
}

/** Live playback: the engine and the worklet talking through ports, as in the browser
 *  (delivery is synchronous, so each next bar lands well before its downbeat). */
async function live(project: Patch, sampleRate: number) {
  load(project);
  const engine = new WasmEngine();
  const posted: Msg[] = [];
  const port: EnginePort = { postMessage: (m) => { posted.push(m as Msg); deliver(worklet, m); }, onmessage: null };
  const worklet = await makeWorklet(sampleRate, (m) => port.onmessage?.({ data: m }));
  engine.connectPort(port);
  // ensureAudio's bring-up, then the transport
  for (const m of [...mixMessages(project.nodes), ...routingMessages(project.nodes, project.edges).messages]) port.postMessage(m);
  engine.startTransport();
  return { engine, worklet, posted };
}

async function offline(project: TimelineProject, bars: number, sampleRate: number) {
  const worklet = await makeWorklet(sampleRate, () => {});
  for (const m of bounceMessages(project, bars)) deliver(worklet, m);
  return worklet;
}

const barFrames = (p: TimelineProject, sr: number) => Math.round((Number(p.conductor.steps) * 60 * sr) / (p.conductor.tempo * 4));

describe('exports equal live playback', () => {
  for (const [name, make, bars] of [
    ['default', () => defaultPatch(), 4],
    ['ambient', () => templatePatch('ambient'), 3],
    ['techno', () => templatePatch('techno'), 6],
  ] as const) {
    it(`${name}: the WAV bounce renders sample-identical audio to live playback`, async () => {
      const SR = 24000;
      const project = make();
      const frames = bars * barFrames(project, SR);
      const { worklet } = await live(project, SR);
      const a = run(worklet, frames);
      const b = run(await offline(project, bars, SR), frames + 2 * SR);
      let peak = 0;
      let diffs = 0;
      for (let i = 0; i < frames; i++) {
        peak = Math.max(peak, Math.abs(a[0][i]));
        if (a[0][i] !== b[0][i] || a[1][i] !== b[1][i]) diffs++;
      }
      expect(peak).toBeGreaterThan(0.01);
      expect(diffs).toBe(0);
      // after the bounced bars nothing new starts: the tails ring out to silence
      let tail = 0;
      for (let i = b[0].length - SR / 10; i < b[0].length; i++) tail = Math.max(tail, Math.abs(b[0][i]));
      expect(tail).toBeLessThan(0.02);
    });
  }

  it('the MIDI file holds exactly the notes live playback posts (audible parts only)', () => {
    const project = templatePatch('lofi');
    load(project);
    const posted: Msg[] = [];
    const engine = new WasmEngine();
    const port: EnginePort = { postMessage: (m) => posted.push(m as Msg), onmessage: null };
    engine.connectPort(port);
    engine.startTransport();
    for (let b = 0; b < 3; b++) port.onmessage!({ data: { type: 'loop', loop: b + 1, absBar: b } });
    const liveBars = posted.filter((m) => m.type === 'patterns').map((m) => m.patterns as Record<string, Array<WireNote | WireDrum>>);
    const steps = Number(project.conductor.steps);
    const bars = renderTimeline(project, 0, 4);
    const audible = bars[0].audible;

    // expected note-ons per track from the live stream
    const expected = new Map<string, string[]>();
    for (const kind of audible) {
      const ons: string[] = [];
      liveBars.forEach((bar, i) => {
        for (const ev of bar[kind] ?? []) {
          const tick = (i * steps + ev.step) * 120;
          if ('midis' in ev) for (const m of ev.midis) ons.push(`${tick}:${m}:${Math.round(ev.vel * 127)}`);
          else ons.push(`${tick}:${({ 0: 36, 1: 38, 2: 42 } as Record<number, number>)[ev.lane]}:${Math.round(ev.vel * 127)}`);
        }
      });
      expected.set(kind, ons);
    }

    const bytes = buildMidi(bars, project.conductor.tempo);
    const tracks = new Map<string, string[]>();
    let offset = 14;
    while (offset < bytes.length) {
      const len = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      const end = offset + 8 + len;
      let i = offset + 8;
      let tick = 0;
      let name = '';
      const ons: string[] = [];
      while (i < end) {
        let delta = 0;
        while (bytes[i] & 0x80) delta = (delta << 7) | (bytes[i++] & 0x7f);
        delta = (delta << 7) | bytes[i++];
        tick += delta;
        if (bytes[i] === 0xff) {
          if (bytes[i + 1] === 0x03) name = String.fromCharCode(...bytes.slice(i + 3, i + 3 + bytes[i + 2]));
          i += 3 + bytes[i + 2];
        } else {
          if ((bytes[i] & 0xf0) === 0x90) ons.push(`${tick}:${bytes[i + 1]}:${bytes[i + 2]}`);
          i += 3;
        }
      }
      if (name !== 'Loom') tracks.set(name, ons);
      offset = end;
    }
    expect([...tracks.keys()].sort()).toEqual([...audible].sort());
    expect(audible).not.toContain('arp'); // lofi mutes the arp
    for (const kind of audible) expect([...tracks.get(kind)!].sort()).toEqual([...expected.get(kind)!].sort());
  });
});

describe('UI follows the audio', () => {
  it('section and key labels change on the block the worklet starts sounding the bar', async () => {
    const SR = 8000;
    const project = templatePatch('techno');
    const { worklet, posted } = await live(project, SR);
    const changes: Array<[number, number]> = [];
    let lastBar = -1;
    let checked = 0;
    run(worklet, 14 * barFrames(project, SR) - 256, () => {
      const store = useLoomStore.getState();
      if (worklet.absBar !== lastBar) {
        lastBar = worklet.absBar;
        changes.push([lastBar, store.arrangerSection]);
      }
      if (store.loopCount === 0) return; // nothing sounding before the first downbeat
      const bar = renderBar(project, worklet.absBar);
      expect(store.loopCount).toBe(worklet.absBar + 1);
      expect(store.arrangerSection).toBe(bar.sectionId);
      expect(store.conductor.liveKeyIndex).toBe(bar.keyIndex);
      expect(store.conductor.liveScaleId).toBe(bar.scaleId);
      expect(JSON.parse(JSON.stringify(worklet.patterns))).toEqual(JSON.parse(JSON.stringify(bar.patterns)));
      checked++;
    });
    expect(checked).toBeGreaterThan(100);
    expect(changes.map(([b]) => b)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(changes.map(([, s]) => s)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    // each bar is posted (tagged) one bar ahead of its downbeat
    const tagged = posted.filter((m) => m.type === 'patterns').map((m) => m.absBar);
    expect(tagged.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  it('a late bar repeats the current one and is never played twice', async () => {
    const SR = 8000;
    const project = defaultPatch();
    load(project);
    const worklet = await makeWorklet(SR, () => {});
    const bars = renderTimeline(project, 0, 3);
    deliver(worklet, { type: 'patterns', absBar: 0, patterns: bars[0].patterns, immediate: true });
    deliver(worklet, { type: 'start' });
    const seen: number[] = [];
    let last = -1;
    const frames = barFrames(project, SR);
    const watch = () => {
      if (worklet.absBar !== last) seen.push((last = worklet.absBar));
    };
    run(worklet, frames + 256, watch); // bar 1 not delivered yet: bar 0 repeats
    deliver(worklet, { type: 'patterns', absBar: 1, patterns: bars[1].patterns, immediate: false });
    deliver(worklet, { type: 'patterns', absBar: 1, patterns: bars[1].patterns, immediate: false });
    deliver(worklet, { type: 'patterns', absBar: 2, patterns: bars[2].patterns, immediate: false });
    run(worklet, 2 * frames, watch);
    expect(seen).toEqual([0, 1, 2]);
  });
});
