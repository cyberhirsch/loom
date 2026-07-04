/**
 * Loom M2 engine controller (PRD §8/§10 M2): Rust→WASM DSP core hosted in an
 * AudioWorklet. This main-thread side owns the "loop brain" — journey, evolve,
 * LFO/Tension modulation, energy — and resolves theory (degrees) into concrete
 * MIDI notes posted to the worklet, which owns the sample clock.
 */

import { useLoomStore, densityModulations } from '../graph/store';
import { computeContext, computeBasePattern, motifForPlayer, ROLE_OCTAVE } from '../graph/session';
import { degreeToMidi } from '../theory/scales';
import { chordMidi, buildJourney, type HarmonicContext } from '../theory/harmony';
import { evolveMelody, type NoteEvent } from '../theory/melody';
import { computeEnergyCurve, energyScalar } from '../theory/energy';
import type { DrumEvent } from '../theory/parts';
import type { ArrangerData, DelayData, ExpressionData, OutData, PlayerData, PlayerKind, ReverbData, SynthData } from '../graph/types';
import type { Edge } from '@xyflow/react';
import type { LoomNode } from '../graph/types';

const PLAYER_KINDS: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];

/** default per-kind FX send levels, applied when the kind's route passes that FX node */
const REV_SEND: Record<PlayerKind, number> = { melody: 0.35, chords: 0.45, bass: 0.1, drums: 0.15, arp: 0.4 };
const DEL_SEND: Record<PlayerKind, number> = { melody: 0.3, chords: 0.15, bass: 0.1, drums: 0.05, arp: 0.35 };

/** Where a player's notes end up (PRD §5: the patch IS the signal flow).
 *  notes-out → (Expression…) → Synth/Kit → signal-out → (FX…) → Out. */
interface Route {
  synth: SynthData | null;
  isKit: boolean;
  expression: ExpressionData | null;
  hasDelay: boolean;
  hasReverb: boolean;
  toOut: boolean;
}

function traceRoute(playerId: string, nodes: LoomNode[], edges: Edge[]): Route {
  const route: Route = { synth: null, isKit: false, expression: null, hasDelay: false, hasReverb: false, toOut: false };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // note path: through expression nodes until an instrument
  let cur = playerId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const edge = edges.find((e) => e.source === cur && e.sourceHandle === 'notes-out');
    if (!edge) return route;
    const node = byId.get(edge.target);
    if (!node) return route;
    if (node.type === 'expression') {
      route.expression = node.data as unknown as ExpressionData;
      cur = node.id;
    } else if (node.type === 'synth' || node.type === 'kit') {
      route.synth = node.type === 'synth' ? (node.data as unknown as SynthData) : null;
      route.isKit = node.type === 'kit';
      cur = node.id;
      break;
    } else {
      return route;
    }
  }
  // signal path: through fx until out
  seen.clear();
  while (!seen.has(cur)) {
    seen.add(cur);
    const edge = edges.find((e) => e.source === cur && e.sourceHandle === 'signal-out');
    if (!edge) return route;
    const node = byId.get(edge.target);
    if (!node) return route;
    if (node.type === 'delay') route.hasDelay = true;
    else if (node.type === 'reverb') route.hasReverb = true;
    else if (node.type === 'out') {
      route.toOut = true;
      return route;
    } else return route;
    cur = node.id;
  }
  return route;
}

interface WireNote {
  step: number;
  midis: number[];
  vel: number;
  lenSteps: number;
}

type WirePatterns = Partial<Record<PlayerKind, WireNote[] | DrumEvent[]>>;

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Scale-locked glissando (Expression node, PRD §5.2): before a leap of 3+
 *  scale degrees, insert quiet grace notes running the scale into the target.
 *  Degrees stay in-scale by construction — the run can never go chromatic. */
function withGlissando(events: NoteEvent[]): NoteEvent[] {
  const occupied = new Set(events.map((e) => e.step));
  const graces: NoteEvent[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    const diff = cur.degree - prev.degree;
    if (Math.abs(diff) < 3) continue;
    const dir = Math.sign(diff);
    for (let g = 1; g <= 2; g++) {
      const step = cur.step - g;
      if (step <= prev.step || occupied.has(step)) continue;
      occupied.add(step);
      graces.push({ step, degree: cur.degree - dir * g, velocity: cur.velocity * 0.5, lengthSteps: 1 });
    }
  }
  return graces.length ? [...events, ...graces].sort((a, b) => a.step - b.step) : events;
}

class WasmEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private patterns = new Map<string, NoteEvent[] | DrumEvent[]>();
  private signatures = new Map<string, string>();
  private journeyIndex = 0;
  private evolveGeneration = 0;
  private hctx: HarmonicContext | null = null;
  private unsubscribe: (() => void) | null = null;
  /** live routing per player kind, derived from the cables */
  private routes = new Map<PlayerKind, Route>();
  private routingSig = '';

  async start() {
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
      await new Promise<void>((resolve) => {
        this.node!.port.onmessage = (e) => {
          if (e.data.type === 'ready') resolve();
          this.onMessage(e.data);
        };
        this.node!.port.postMessage({ type: 'wasm', bytes });
      });
      this.node.port.onmessage = (e) => this.onMessage(e.data);
      this.subscribeStore();
    }
    await this.ctx.resume();

    const store = useLoomStore.getState();
    this.post({ type: 'tempo', bpm: store.conductor.tempo });
    this.post({ type: 'steps', value: Number(store.conductor.steps) || 16 });
    this.syncMix();
    this.syncRouting(true);
    this.refreshLoop(true);
    this.post({ type: 'start' });
    store.setPlaying(true);
  }

  stop() {
    this.post({ type: 'stop' });
    useLoomStore.getState().setPlaying(false);
    useLoomStore.getState().setStep(-1);
  }

  private post(msg: unknown) {
    this.node?.port.postMessage(msg);
  }

  private onMessage(msg: { type: string; step?: number; loop?: number }) {
    if (msg.type === 'debug-nan') {
      console.error('[loom] NaN in worklet output:', JSON.stringify(msg));
      return;
    }
    const store = useLoomStore.getState();
    if (msg.type === 'step' && msg.step !== undefined) {
      store.setStep(msg.step);
    } else if (msg.type === 'loop' && msg.loop !== undefined) {
      store.setLoopCount(msg.loop);
      // compute the NEXT loop's patterns while this one plays (double-buffered)
      this.refreshLoop(false);
    }
  }

  private subscribeStore() {
    this.unsubscribe = useLoomStore.subscribe((state, prev) => {
      if (state.conductor.tempo !== prev.conductor.tempo) {
        this.post({ type: 'tempo', bpm: state.conductor.tempo });
      }
      if (state.conductor.steps !== prev.conductor.steps) {
        this.post({ type: 'steps', value: Number(state.conductor.steps) || 16 });
      }
      if (state.nodes !== prev.nodes) this.syncMix(prev.nodes);
      if (state.nodes !== prev.nodes || state.edges !== prev.edges) this.syncRouting(false);
    });
  }

  private syncMix(prevNodes?: typeof useLoomStore extends never ? never : ReturnType<typeof useLoomStore.getState>['nodes']) {
    for (const node of useLoomStore.getState().nodes) {
      if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
      const prev = prevNodes?.find((n) => n.id === node.id);
      if (!prev || prev.data.volume !== node.data.volume) {
        this.post({ type: 'gain', kind: node.type, value: dbToLinear(Number(node.data.volume)) * 0.4 });
      }
    }
  }

  /** Read the cables and make the DSP obey them: unrouted players are silent,
   *  Synth/Expression/FX/Out node params land on the WASM core. */
  private syncRouting(force: boolean) {
    const { nodes, edges } = useLoomStore.getState();
    const parts: unknown[] = [];
    const next = new Map<PlayerKind, Route>();
    for (const node of nodes) {
      if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
      const kind = node.type as PlayerKind;
      const route = traceRoute(node.id, nodes, edges);
      next.set(kind, route);
      parts.push([kind, node.data.mute, route]);
    }
    const delayNode = nodes.find((n) => n.type === 'delay');
    const reverbNode = nodes.find((n) => n.type === 'reverb');
    const outNode = nodes.find((n) => n.type === 'out');
    parts.push(delayNode?.data, reverbNode?.data, outNode?.data);
    const sig = JSON.stringify(parts);
    if (!force && sig === this.routingSig) return;
    this.routingSig = sig;
    this.routes = next;

    for (const [kind, route] of next) {
      const audible = route.toOut && (route.synth !== null || route.isKit);
      const data = useLoomStore.getState().nodes.find((n) => n.type === kind)?.data;
      this.post({ type: 'mute', kind, value: Boolean(data?.mute) || !audible });
      if (route.synth) {
        const s = route.synth;
        this.post({ type: 'voice', kind, wave: Number(s.wave), attack: Number(s.attack), release: Number(s.release), cutoff: Number(s.cutoff) });
      }
      this.post({
        type: 'sends',
        kind,
        rev: route.hasReverb ? REV_SEND[kind] : 0,
        del: route.hasDelay ? DEL_SEND[kind] : 0,
      });
      this.post({ type: 'glide', kind, seconds: route.expression ? Number(route.expression.portamento) * 0.3 : 0 });
    }
    if (delayNode) {
      const d = delayNode.data as unknown as DelayData;
      this.post({ type: 'delay', division: Number(d.division), feedback: Number(d.feedback), mix: Number(d.mix) });
    }
    if (reverbNode) {
      this.post({ type: 'reverb', mix: Number((reverbNode.data as unknown as ReverbData).mix) });
    }
    if (outNode) {
      this.post({ type: 'master', value: dbToLinear(Number((outNode.data as unknown as OutData).level)) });
    }
  }

  /** The loop brain — identical musical behavior to M0, now feeding the WASM core. */
  private refreshLoop(force: boolean) {
    const store = useLoomStore.getState();
    const { conductor, nodes, edges, loopCount } = store;

    // Arranger (PRD §5.2): generative structure — sections set intensity and
    // advance the Conductor's journey at section boundaries. When enabled it owns the journey.
    const arrangerNode = nodes.find((n) => n.type === 'arranger');
    const arranger = arrangerNode?.data as unknown as ArrangerData | undefined;
    let sectionIntensity = 1;
    let arrangerActive = false;
    if (arranger?.enabled && Array.isArray(arranger.sections) && arranger.sections.length > 0) {
      arrangerActive = true;
      const total = arranger.sections.reduce((a, s) => a + Math.max(1, s.loops), 0);
      let pos = loopCount % total;
      let idx = 0;
      for (let i = 0; i < arranger.sections.length; i++) {
        const len = Math.max(1, arranger.sections[i].loops);
        if (pos < len) {
          idx = i;
          break;
        }
        pos -= len;
      }
      const section = arranger.sections[idx];
      store.setArrangerSection(idx);
      sectionIntensity = section.intensity;
      const journey = buildJourney(conductor.scaleId);
      const stop = section.journeyStop >= 0 ? journey[section.journeyStop % journey.length] : journey[0];
      if (
        conductor.liveKeyIndex !== (((conductor.keyIndex + stop.offset) % 12) + 12) % 12 ||
        conductor.liveScaleId !== stop.scaleId
      ) {
        store.updateConductor({
          liveKeyIndex: (((conductor.keyIndex + stop.offset) % 12) + 12) % 12,
          liveScaleId: stop.scaleId,
          journeyLabel: section.journeyStop >= 0 ? stop.label : 'home',
        } as never);
      }
    } else {
      if (store.arrangerSection !== -1) store.setArrangerSection(-1);
      if (conductor.journeyOn && loopCount > 0 && loopCount % conductor.modEvery === 0) {
        const journey = buildJourney(conductor.scaleId);
        this.journeyIndex = (this.journeyIndex + 1) % journey.length;
        const stop = journey[this.journeyIndex];
        store.updateConductor({
          liveKeyIndex: (((conductor.keyIndex + stop.offset) % 12) + 12) % 12,
          liveScaleId: stop.scaleId,
          journeyLabel: stop.label,
        } as never);
      } else if (!conductor.journeyOn && this.journeyIndex !== 0) {
        this.journeyIndex = 0;
      }
    }

    const fresh = useLoomStore.getState();
    const chordsNode = fresh.nodes.find((n) => n.type === 'chords');
    const ctx = computeContext(fresh.conductor, chordsNode ? Number(chordsNode.data.seed) : 1);
    const mods = densityModulations(nodes, edges);

    // ensemble energy of the previous loop (Tension CV source)
    const pitched: NoteEvent[][] = [];
    let drumEvents: DrumEvent[] | null = null;
    for (const node of fresh.nodes) {
      if (!PLAYER_KINDS.includes(node.type as PlayerKind) || !this.patterns.has(node.id)) continue;
      if (node.type === 'drums') drumEvents = this.patterns.get(node.id) as DrumEvent[];
      else pitched.push(this.patterns.get(node.id) as NoteEvent[]);
    }
    if (this.hctx) {
      const curve = computeEnergyCurve(this.hctx, pitched, drumEvents);
      fresh.publishEnergy(curve);
    }
    const energy = energyScalar(fresh.energyCurve);

    for (const node of fresh.nodes) {
      if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
      const kind = node.type as PlayerKind;
      const data = node.data as unknown as PlayerData;

      let effDensity = data.density;
      const mod = mods.find((m) => m.playerId === node.id);
      if (mod) {
        const source = fresh.nodes.find((n) => n.id === mod.sourceId);
        if (source?.type === 'lfo') {
          effDensity = data.density + Number(source.data.depth) * Math.sin(2 * Math.PI * Number(source.data.rate) * loopCount);
        } else if (source?.type === 'tension') {
          effDensity = data.density + Number(source.data.depth) * (0.5 - energy);
        }
        effDensity = Math.min(1, Math.max(0.05, effDensity));
        fresh.publishEffDensity(node.id, effDensity);
      }
      if (arrangerActive) {
        effDensity = Math.min(1, Math.max(0.05, effDensity * sectionIntensity));
      }

      // frozen (captured) players play their stored take verbatim — outside the generative flow (PRD §5.2)
      if (data.frozen && Array.isArray((node.data as Record<string, unknown>).frozenPattern)) {
        const take = (node.data as Record<string, unknown>).frozenPattern as NoteEvent[] | DrumEvent[];
        this.patterns.set(node.id, take);
        fresh.publishPattern(node.id, take);
        continue;
      }

      const motif = kind === 'melody' ? motifForPlayer(fresh.nodes, edges, node.id) : null;
      const signature = JSON.stringify([kind, data.seed, effDensity, data.adventurousness, data.syncopation, data.register, ctx.keyIndex, ctx.scaleId, ctx.chordAtStep, motif]);
      const changed = signature !== this.signatures.get(node.id);

      if (fresh.conductor.evolveOn && !changed && this.patterns.has(node.id) && (kind === 'melody' || kind === 'arp' || kind === 'bass')) {
        // melody develops thematically (theme grammar variation depth);
        // arp/bass keep the coach-guided single-note mutation
        const evolved =
          kind === 'melody'
            ? (computeBasePattern(kind, ctx, data, { densityOverride: effDensity, motif, generation: ++this.evolveGeneration }) as NoteEvent[])
            : evolveMelody(ctx, this.patterns.get(node.id) as NoteEvent[], Number(data.seed), ++this.evolveGeneration);
        this.patterns.set(node.id, evolved);
        fresh.publishPattern(node.id, evolved);
      } else if (changed || force || !this.patterns.has(node.id)) {
        const pattern = computeBasePattern(kind, ctx, data, { densityOverride: effDensity, motif });
        this.patterns.set(node.id, pattern);
        this.signatures.set(node.id, signature);
        fresh.publishPattern(node.id, pattern);
      }
    }
    this.hctx = ctx;
    this.post({ type: 'patterns', patterns: this.resolve(ctx), immediate: force });
  }

  /** Resolve theory patterns (degrees) into concrete MIDI for the worklet.
   *  Only routed players sound — the cables are the signal flow. */
  private resolve(ctx: HarmonicContext): WirePatterns {
    const out: WirePatterns = {};
    for (const node of useLoomStore.getState().nodes) {
      if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
      const kind = node.type as PlayerKind;
      const pattern = this.patterns.get(node.id);
      if (!pattern) continue;
      const route = this.routes.get(kind);
      if (route && !(route.toOut && (route.synth !== null || route.isKit))) continue;
      if (kind === 'drums') {
        out.drums = (pattern as DrumEvent[]).map((ev) => ({ step: ev.step, lane: ev.lane, vel: ev.velocity })) as never;
      } else {
        const octave = ROLE_OCTAVE[kind] + Number(node.data.register ?? 0);
        let events = [...(pattern as NoteEvent[])].sort((a, b) => a.step - b.step);
        if (route?.expression?.glissando && kind !== 'chords') {
          events = withGlissando(events);
        }
        out[kind] = events.map((ev) => ({
          step: ev.step,
          midis: kind === 'chords' ? chordMidi(ctx, ev.degree, octave) : [degreeToMidi(ctx.keyIndex, ctx.scaleId, ev.degree, octave)],
          vel: ev.velocity,
          lenSteps: ev.lengthSteps,
        }));
      }
    }
    return out;
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

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__loomEngine = engine;
}
