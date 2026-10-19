/**
 * The loop brain as a pure timeline (one renderer for the engine, previews,
 * score tool and exports): `renderBar(project, absBar)` is everything bar
 * `absBar` plays — arranger section, journey key, LFO/Tension modulation,
 * evolve, frozen takes, glissando and routing — resolved to the MIDI the
 * worklet receives. Same project, same bar → identical output.
 *
 * Until bar-based time lands, one "bar" is one loop of `conductor.steps`.
 */

import type { Edge } from '@xyflow/react';
import { buildJourney, roleContext, roleScale, type HarmonicContext, type PitchedRole } from '../theory/harmony';
import { evolveMelody, withGlissando, type NoteEvent } from '../theory/melody';
import { computeEnergyCurve, energyScalar, type PitchedPart } from '../theory/energy';
import type { DrumEvent } from '../theory/parts';
import type { ScaleId } from '../theory/scales';
import { computeBasePattern, computeContext, kickStepsOf, motifForPlayer } from './session';
import { resolveBar, type WireNote } from './resolve';
import { CHORD_SPREADS, type ChordSpread } from '../theory/voicing';
import { isRouted, PLAYER_KINDS, traceRoute, type Route } from './routing';
import type { ArrangerData, ArrangerSection, ConductorState, LoomNode, Pattern, PlayerData, PlayerKind } from './types';

export interface TimelineProject {
  nodes: LoomNode[];
  edges: Edge[];
  conductor: ConductorState;
}

export type { WireNote } from './resolve';

export interface WireDrum {
  step: number;
  lane: number;
  vel: number;
}

export type WirePatterns = Partial<Record<PlayerKind, WireNote[] | WireDrum[]>>;

export interface BarRender {
  absBar: number;
  steps: number;
  /** the key that sounds (home moved by the journey or the arranger) */
  keyIndex: number;
  scaleId: ScaleId;
  journeyLabel: string;
  /** arranger section index, -1 with the arranger off */
  sectionId: number;
  phraseIndex: number;
  barInPhrase: number;
  ctx: HarmonicContext;
  /** theory pattern per player node id (degrees, before resolve) */
  parts: Record<string, Pattern>;
  /** density each player generated at (modulation and arranger intensity applied) */
  effDensity: Record<string, number>;
  /** the modulated density of players with a CV cable (before arranger intensity) */
  modDensity: Record<string, number>;
  /** this bar's ensemble energy curve (the Tension CV of the next bar) */
  energy: number[];
  /** routed parts resolved to MIDI: exactly what the worklet plays */
  patterns: WirePatterns;
  /** kinds that sound: routed and unmuted */
  audible: PlayerKind[];
}

/** Player ids whose density input is fed by a modulator (LFO or Tension). */
export function densityModulations(nodes: LoomNode[], edges: Edge[]): Array<{ playerId: string; sourceId: string }> {
  return edges
    .filter((e) => e.targetHandle === 'density-in' && e.sourceHandle === 'cv-out')
    .map((e) => ({ playerId: e.target, sourceId: e.source }));
}

/** The arranger's sections when it is enabled, else null. */
export function activeSections(nodes: LoomNode[]): ArrangerSection[] | null {
  const arranger = nodes.find((n) => n.type === 'arranger')?.data as unknown as ArrangerData | undefined;
  return arranger?.enabled && Array.isArray(arranger.sections) && arranger.sections.length > 0 ? arranger.sections : null;
}

/** Where `absBar` falls in the arranger's repeating cycle of sections. */
export function arrangerPosition(sections: ArrangerSection[], absBar: number) {
  const cycleBars = sections.reduce((a, s) => a + Math.max(1, s.loops), 0);
  const cycleBar = ((absBar % cycleBars) + cycleBars) % cycleBars;
  let pos = cycleBar;
  let section = 0;
  for (let i = 0; i < sections.length; i++) {
    const len = Math.max(1, sections[i].loops);
    if (pos < len) {
      section = i;
      break;
    }
    pos -= len;
  }
  return { section, barInSection: pos, cycleBar, cycleBars };
}

const clampDensity = (d: number) => Math.min(1, Math.max(0.05, d));

/** Cross-bar state: evolve develops the previous bar's take, Tension listens to the previous bar. */
interface Carry {
  patterns: Map<string, Pattern>;
  signatures: Map<string, string>;
  generation: number;
  energy: number[];
}

const freshCarry = (): Carry => ({ patterns: new Map(), signatures: new Map(), generation: 0, energy: [] });

/** Fields that never change what is played: sound design and mixer volume. */
const SOUND_ONLY = new Set(['synth', 'kit', 'delay', 'reverb', 'out', 'midiin']);

/** Everything a render depends on, as a string: equal signatures render identical timelines. */
export function musicalSignature(project: TimelineProject): string {
  const c = project.conductor;
  return JSON.stringify([
    [c.keyIndex, c.scaleId, Number(c.steps) || 16, c.evolveOn, c.journeyOn, c.modEvery],
    project.nodes.map((n) => {
      if (SOUND_ONLY.has(n.type as string)) return [n.id, n.type];
      if (!PLAYER_KINDS.includes(n.type as PlayerKind)) return [n.id, n.type, n.data];
      const { volume: _volume, ...data } = n.data;
      return [n.id, n.type, data];
    }),
    project.edges.map((e) => [e.source, e.sourceHandle ?? null, e.target, e.targetHandle ?? null]),
  ]);
}

const KEEP = 128;

export class Timeline {
  readonly signature: string;
  /** bars depend on the bars before them (evolve or Tension): rendered in order from bar 0 */
  readonly sequential: boolean;
  private readonly project: TimelineProject;
  private readonly routes: Map<string, Route>;
  private readonly renders = new Map<number, BarRender>();
  private carry = freshCarry();
  private carried = 0;

  constructor(project: TimelineProject, signature = musicalSignature(project)) {
    this.project = project;
    this.signature = signature;
    this.routes = new Map(
      project.nodes.filter((n) => PLAYER_KINDS.includes(n.type as PlayerKind)).map((n) => [n.id, traceRoute(n.id, project.nodes, project.edges)]),
    );
    const tension = new Set(project.nodes.filter((n) => n.type === 'tension').map((n) => n.id));
    this.sequential =
      Boolean(project.conductor.evolveOn) || densityModulations(project.nodes, project.edges).some((m) => tension.has(m.sourceId));
  }

  renderBar(absBar: number): BarRender {
    const n = Math.max(0, Math.floor(absBar));
    const hit = this.renders.get(n);
    if (hit) return hit;
    if (!this.sequential) return this.remember(this.step(n, freshCarry()));
    if (n < this.carried) {
      this.carry = freshCarry();
      this.carried = 0;
    }
    let r: BarRender | undefined;
    while (this.carried <= n) r = this.remember(this.step(this.carried++, this.carry));
    return r!;
  }

  private remember(r: BarRender): BarRender {
    this.renders.set(r.absBar, r);
    while (this.renders.size > KEEP) this.renders.delete(this.renders.keys().next().value!);
    return r;
  }

  /** Where the bar sits in the form: section, key and intensity. */
  private place(absBar: number) {
    const { conductor, nodes } = this.project;
    const journey = buildJourney(conductor.scaleId);
    const home = { keyIndex: conductor.keyIndex, scaleId: conductor.scaleId, journeyLabel: 'home', sectionId: -1, intensity: null as number | null };
    const at = (offset: number) => (((conductor.keyIndex + offset) % 12) + 12) % 12;
    const sections = activeSections(nodes);
    if (sections) {
      // the arranger owns the journey: each section names its stop
      const { section } = arrangerPosition(sections, absBar);
      const s = sections[section];
      const stop = s.journeyStop >= 0 ? journey[s.journeyStop % journey.length] : journey[0];
      return { keyIndex: at(stop.offset), scaleId: stop.scaleId, journeyLabel: s.journeyStop >= 0 ? stop.label : 'home', sectionId: section, intensity: s.intensity };
    }
    if (conductor.journeyOn) {
      const stop = journey[Math.floor(absBar / Math.max(1, conductor.modEvery)) % journey.length];
      return { ...home, keyIndex: at(stop.offset), scaleId: stop.scaleId, journeyLabel: stop.label };
    }
    return home;
  }

  private step(absBar: number, carry: Carry): BarRender {
    const { conductor, nodes, edges } = this.project;
    const place = this.place(absBar);
    const chordsNode = nodes.find((n) => n.type === 'chords');
    const ctx = computeContext(
      { ...conductor, liveKeyIndex: place.keyIndex, liveScaleId: place.scaleId },
      chordsNode ? Number(chordsNode.data.seed) : 1,
      chordsNode?.data.colour,
    );
    const mods = densityModulations(nodes, edges);
    const energy = energyScalar(carry.energy);

    const parts: Record<string, Pattern> = {};
    const effDensity: Record<string, number> = {};
    const modDensity: Record<string, number> = {};
    // drums first: the bass locks to the kicks they play this bar
    const players = nodes.filter((n) => PLAYER_KINDS.includes(n.type as PlayerKind));
    players.sort((a, b) => Number(b.type === 'drums') - Number(a.type === 'drums'));
    let kicks: number[] | undefined;
    for (const node of players) {
      const kind = node.type as PlayerKind;
      const data = node.data as unknown as PlayerData;

      let eff = data.density;
      const mod = mods.find((m) => m.playerId === node.id);
      if (mod) {
        const source = nodes.find((n) => n.id === mod.sourceId);
        if (source?.type === 'lfo') {
          eff = data.density + Number(source.data.depth) * Math.sin(2 * Math.PI * Number(source.data.rate) * absBar);
        } else if (source?.type === 'tension') {
          eff = data.density + Number(source.data.depth) * (0.5 - energy);
        }
        eff = clampDensity(eff);
        modDensity[node.id] = eff;
      }
      if (place.intensity !== null) eff = clampDensity(eff * place.intensity);
      effDensity[node.id] = eff;

      // frozen (captured) players play their stored take verbatim — outside the generative flow (PRD §5.2)
      if (data.frozen && Array.isArray(data.frozenPattern)) {
        const take = data.frozenPattern as Pattern;
        carry.patterns.set(node.id, take);
        parts[node.id] = take;
        if (kind === 'drums' && !kicks) kicks = kickStepsOf(take as DrumEvent[]);
        continue;
      }

      const motif = kind === 'melody' ? motifForPlayer(nodes, edges, node.id) : null;
      const kickSteps = kind === 'bass' ? kicks : undefined;
      const signature = JSON.stringify([kind, data.seed, eff, data.adventurousness, data.syncopation, data.register, data.articulation, data.octaves, ctx.keyIndex, ctx.scaleId, ctx.colour, ctx.chords.map((c) => c.degree), ctx.chordIdxAtStep, motif, kickSteps]);
      const changed = signature !== carry.signatures.get(node.id);
      const prev = carry.patterns.get(node.id);

      if (conductor.evolveOn && !changed && prev && (kind === 'melody' || kind === 'arp' || kind === 'bass')) {
        // melody develops thematically (theme grammar variation depth);
        // arp/bass keep the coach-guided single-note mutation
        carry.patterns.set(
          node.id,
          kind === 'melody'
            ? computeBasePattern(kind, ctx, data, { densityOverride: eff, motif, generation: ++carry.generation })
            : evolveMelody(roleContext(ctx, kind), prev as NoteEvent[], Number(data.seed), ++carry.generation),
        );
      } else if (changed || !prev) {
        carry.patterns.set(node.id, computeBasePattern(kind, ctx, data, { densityOverride: eff, motif, kickSteps }));
        carry.signatures.set(node.id, signature);
      }
      parts[node.id] = carry.patterns.get(node.id)!;
      if (kind === 'drums' && !kicks) kicks = kickStepsOf(parts[node.id] as DrumEvent[]);
    }

    // this bar's ensemble energy, in patch order
    const pitched: PitchedPart[] = [];
    let drumEvents: DrumEvent[] | null = null;
    for (const node of nodes) {
      const pattern = parts[node.id];
      if (!pattern) continue;
      if (node.type === 'drums') drumEvents = pattern as DrumEvent[];
      else pitched.push({ role: node.type as Exclude<PlayerKind, 'drums'>, events: pattern as NoteEvent[] });
    }
    carry.energy = computeEnergyCurve(ctx, pitched, drumEvents);

    // resolve degrees to MIDI through the shared resolver — only routed players sound (the cables are the signal flow)
    const pitchedNodes = new Map<PitchedRole, LoomNode>();
    for (const node of nodes) {
      const kind = node.type as PlayerKind;
      if (!parts[node.id] || kind === 'drums' || !PLAYER_KINDS.includes(kind)) continue;
      // the routed node of a kind is the one that sounds; an unrouted one still voices the others
      if (!pitchedNodes.has(kind) || isRouted(this.routes.get(node.id)!)) pitchedNodes.set(kind, node);
    }
    const resolveParts: Partial<Record<PitchedRole, NoteEvent[]>> = {};
    const register: Partial<Record<PitchedRole, number>> = {};
    for (const [kind, node] of pitchedNodes) {
      let events = [...(parts[node.id] as NoteEvent[])].sort((a, b) => a.step - b.step);
      if (this.routes.get(node.id)!.expression?.glissando && kind !== 'chords') events = withGlissando(events, roleScale(ctx, kind));
      resolveParts[kind] = events;
      register[kind] = Number(node.data.register ?? 0);
    }
    const spread = pitchedNodes.get('chords')?.data.spread;
    const resolved = resolveBar({
      ctx,
      parts: resolveParts,
      register,
      spread: CHORD_SPREADS.includes(spread as ChordSpread) ? (spread as ChordSpread) : 'close',
      arpOctaves: pitchedNodes.get('arp')?.data.octaves === 2 ? 2 : 1,
      prev: null, // every bar starts a phrase until bar-based phrases land
    }).notes;

    const patterns: WirePatterns = {};
    const audible: PlayerKind[] = [];
    for (const node of nodes) {
      const pattern = parts[node.id];
      const route = this.routes.get(node.id);
      if (!pattern || !route || !isRouted(route)) continue;
      const kind = node.type as PlayerKind;
      if (!node.data.mute) audible.push(kind);
      if (kind === 'drums') {
        patterns.drums = (pattern as DrumEvent[]).map((ev) => ({ step: ev.step, lane: ev.lane, vel: ev.velocity }));
        continue;
      }
      if (pitchedNodes.get(kind) === node) patterns[kind] = resolved[kind] ?? [];
    }

    return {
      absBar,
      steps: ctx.steps,
      keyIndex: place.keyIndex,
      scaleId: place.scaleId,
      journeyLabel: place.journeyLabel,
      sectionId: place.sectionId,
      phraseIndex: absBar,
      barInPhrase: 0,
      ctx,
      parts,
      effDensity,
      modDensity,
      energy: carry.energy,
      patterns,
      audible,
    };
  }
}

const timelines: Timeline[] = [];

/** The (cached) timeline of a project: callers with musically equal projects share it. */
export function timelineFor(project: TimelineProject): Timeline {
  const signature = musicalSignature(project);
  const i = timelines.findIndex((t) => t.signature === signature);
  if (i >= 0) {
    const [t] = timelines.splice(i, 1);
    timelines.unshift(t);
    return t;
  }
  const t = new Timeline(project, signature);
  timelines.unshift(t);
  timelines.length = Math.min(timelines.length, 4);
  return t;
}

export function renderBar(project: TimelineProject, absBar: number): BarRender {
  return timelineFor(project).renderBar(absBar);
}

export function renderTimeline(project: TimelineProject, fromBar: number, nBars: number): BarRender[] {
  const t = timelineFor(project);
  return Array.from({ length: Math.max(0, nBars) }, (_, i) => t.renderBar(fromBar + i));
}
