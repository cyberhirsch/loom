/**
 * Loom M2 engine controller (PRD §8/§10 M2): Rust→WASM DSP core hosted in an
 * AudioWorklet. This main-thread side feeds the worklet one timeline bar at a
 * time (src/graph/timeline.ts, the loop brain) and keeps the UI on the bar the
 * worklet echoes as sounding; the worklet owns the sample clock.
 */

import { useLoomStore } from '../graph/store';
import { mixMessages, routingMessages } from '../graph/routing';
import { renderBar, type BarRender, type TimelineProject } from '../graph/timeline';
import { barMessage, sessionMessages } from './messages';

/** what the engine needs of an AudioWorkletNode's port (a fake one runs it headless) */
export interface EnginePort {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

const projectOf = (): TimelineProject => {
  const { nodes, edges, conductor } = useLoomStore.getState();
  return { nodes, edges, conductor };
};

export class WasmEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private port: EnginePort | null = null;
  private analyser: AnalyserNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private routingSig = '';
  /** bars posted but not yet sounding, keyed by bar: the UI shows each when the worklet echoes it */
  private inFlight = new Map<number, BarRender>();

  /** Bring up the audio stack without starting the transport — the live MIDI
   *  path plays through a stopped transport (render always runs). Must be
   *  called from a user gesture the first time (browser autoplay policy). */
  async ensureAudio() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(new URL('loom-worklet.js', document.baseURI).href);
      this.node = new AudioWorkletNode(this.ctx, 'loom-engine', {
        numberOfInputs: 0,
        outputChannelCount: [2],
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.node.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      const bytes = await (await fetch(new URL('loom-dsp.wasm', document.baseURI).href)).arrayBuffer();
      const port = this.node.port;
      await new Promise<void>((resolve) => {
        port.onmessage = (e) => {
          if (e.data.type === 'ready') resolve();
        };
        port.postMessage({ type: 'wasm', bytes });
      });
      this.connectPort(port as unknown as EnginePort);
      for (const msg of mixMessages(useLoomStore.getState().nodes)) this.post(msg);
      this.syncRouting(true);
    }
    await this.ctx.resume();
  }

  /** Attach the worklet's port and follow the store (ensureAudio does this; tests pass a fake port). */
  connectPort(port: EnginePort) {
    this.port = port;
    port.onmessage = (e) => this.onMessage(e.data as { type: string });
    this.unsubscribe?.();
    this.subscribeStore();
  }

  async start() {
    await this.ensureAudio();
    this.startTransport();
  }

  /** From bar 0: session state, the first bar to play at once, then the clock. */
  startTransport() {
    const project = projectOf();
    for (const msg of sessionMessages(project)) this.post(msg);
    this.routingSig = routingMessages(project.nodes, project.edges).signature;
    this.inFlight.clear();
    this.sendBar(0, true);
    this.post({ type: 'start' });
    useLoomStore.getState().setPlaying(true);
  }

  // ---- live MIDI/MPE input (MIDI Input node) -------------------------------
  // Immediate, unquantized, independent of the transport. `id` is the MPE
  // member channel (0..15) or the note number in plain-MIDI mode.

  liveNoteOn(id: number, midi: number, vel: number) {
    this.post({ type: 'liveOn', id, midi, vel });
  }

  liveNoteOff(id: number) {
    this.post({ type: 'liveOff', id });
  }

  liveNoteUpdate(id: number, midi: number, pressure: number, timbre: number) {
    this.post({ type: 'liveUpd', id, midi, pressure, timbre });
  }

  /** panic/cleanup: release every live id (device unplugged, node deleted) */
  liveAllNotesOff() {
    for (let id = 0; id < 128; id++) this.post({ type: 'liveOff', id });
  }

  get audioReady(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  stop() {
    this.post({ type: 'stop' });
    useLoomStore.getState().setPlaying(false);
    useLoomStore.getState().setStep(-1);
  }

  private post(msg: unknown) {
    this.port?.postMessage(msg);
  }

  private sendBar(absBar: number, immediate: boolean) {
    const bar = renderBar(projectOf(), absBar);
    this.inFlight.set(absBar, bar);
    this.post(barMessage(bar, immediate));
  }

  private onMessage(msg: { type: string; step?: number; loop?: number; absBar?: number }) {
    if (msg.type === 'debug-nan') {
      console.error('[loom] NaN in worklet output:', JSON.stringify(msg));
      return;
    }
    const store = useLoomStore.getState();
    if (msg.type === 'step' && msg.step !== undefined) {
      store.setStep(msg.step);
    } else if (msg.type === 'loop' && msg.absBar !== undefined) {
      // the worklet just started sounding bar `absBar`: show it, then queue the next one (double-buffered)
      this.showBar(msg.absBar);
      this.sendBar(msg.absBar + 1, false);
    }
  }

  /** Displays follow the audio: section, key, previews and modulation of the bar now sounding. */
  private showBar(absBar: number) {
    const bar = this.inFlight.get(absBar) ?? renderBar(projectOf(), absBar);
    for (const k of [...this.inFlight.keys()]) if (k <= absBar) this.inFlight.delete(k);
    const store = useLoomStore.getState();
    store.setLoopCount(absBar + 1);
    if (store.arrangerSection !== bar.sectionId) store.setArrangerSection(bar.sectionId);
    const c = store.conductor;
    if (c.liveKeyIndex !== bar.keyIndex || c.liveScaleId !== bar.scaleId || c.journeyLabel !== bar.journeyLabel) {
      store.updateConductor({ liveKeyIndex: bar.keyIndex, liveScaleId: bar.scaleId, journeyLabel: bar.journeyLabel });
    }
    for (const [id, pattern] of Object.entries(bar.parts)) {
      if (useLoomStore.getState().patterns[id] !== pattern) store.publishPattern(id, pattern);
    }
    for (const [id, value] of Object.entries(bar.modDensity)) store.publishEffDensity(id, value);
    store.publishEnergy(bar.energy);
  }

  private subscribeStore() {
    this.unsubscribe = useLoomStore.subscribe((state, prev) => {
      if (state.conductor.tempo !== prev.conductor.tempo) {
        this.post({ type: 'tempo', bpm: state.conductor.tempo });
      }
      if (state.conductor.steps !== prev.conductor.steps) {
        this.post({ type: 'steps', value: Number(state.conductor.steps) || 16 });
      }
      if (state.nodes !== prev.nodes) for (const msg of mixMessages(state.nodes, prev.nodes)) this.post(msg);
      if (state.nodes !== prev.nodes || state.edges !== prev.edges) this.syncRouting(false);
    });
  }

  /** Make the DSP obey the cables (unrouted players are silent; node params land on the core). */
  private syncRouting(force: boolean) {
    const { nodes, edges } = useLoomStore.getState();
    const { messages, signature } = routingMessages(nodes, edges);
    if (!force && signature === this.routingSig) return;
    this.routingSig = signature;
    for (const msg of messages) this.post(msg);
  }

  /** dev probe: output RMS, used to verify the DSP core is audibly alive */
  getRms(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
}

export const engine = new WasmEngine();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__loomEngine = engine;
}
