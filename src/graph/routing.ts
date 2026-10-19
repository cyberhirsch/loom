/**
 * Engine-enforced routing (PRD §5: the patch IS the signal flow) and the DSP
 * messages it implies. Pure: the live engine and the offline WAV bounce post
 * exactly these messages, and the timeline uses the same routes to decide which
 * parts sound and which get glissando.
 */

import type { Edge } from '@xyflow/react';
import type { DelayData, ExpressionData, LoomNode, OutData, PlayerKind, ReverbData, SynthData } from './types';

export const PLAYER_KINDS: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];

/** default per-kind FX send levels, applied when the kind's route passes that FX node */
const REV_SEND: Record<PlayerKind, number> = { melody: 0.35, chords: 0.45, bass: 0.1, drums: 0.15, arp: 0.4 };
const DEL_SEND: Record<PlayerKind, number> = { melody: 0.3, chords: 0.15, bass: 0.1, drums: 0.05, arp: 0.35 };

/** Where a player's notes end up: notes-out → (Expression…) → Synth/Kit → signal-out → (FX…) → Out. */
export interface Route {
  synth: SynthData | null;
  isKit: boolean;
  expression: ExpressionData | null;
  hasDelay: boolean;
  hasReverb: boolean;
  toOut: boolean;
}

export function traceRoute(playerId: string, nodes: LoomNode[], edges: Edge[]): Route {
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

/** A routed part reaches Out through an instrument; anything else stays silent. */
export const isRouted = (route: Route) => route.toOut && (route.synth !== null || route.isKit);

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export type DspMessage = { type: string } & Record<string, unknown>;

/** Synth node → worklet 'voice' message; decay/sustain left off the node (-1) keep the DSP's per-kind default */
function voiceMessage(kind: PlayerKind | 'live', s: SynthData): DspMessage {
  const opt = (v: unknown) => (v === undefined || v === null || v === '' ? -1 : Number(v));
  return {
    type: 'voice', kind, wave: Number(s.wave), attack: Number(s.attack), decay: opt(s.decay), sustain: opt(s.sustain),
    release: Number(s.release), cutoff: Number(s.cutoff),
  };
}

/** Player volume → per-kind gain. With `prevNodes`, only the players whose volume changed. */
export function mixMessages(nodes: LoomNode[], prevNodes?: LoomNode[]): DspMessage[] {
  const out: DspMessage[] = [];
  for (const node of nodes) {
    if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
    const prev = prevNodes?.find((n) => n.id === node.id);
    if (!prev || prev.data.volume !== node.data.volume) {
      out.push({ type: 'gain', kind: node.type as string, value: dbToLinear(Number(node.data.volume)) * 0.4 });
    }
  }
  return out;
}

/** What the cables mean for the DSP: unrouted or muted parts are silent, and the Synth,
 *  Expression, FX and Out node params land on the WASM core. `signature` changes exactly
 *  when the messages would. */
export function routingMessages(nodes: LoomNode[], edges: Edge[]): { messages: DspMessage[]; signature: string } {
  const parts: unknown[] = [];
  const routes: Array<[PlayerKind, Route]> = [];
  for (const node of nodes) {
    if (!PLAYER_KINDS.includes(node.type as PlayerKind)) continue;
    const kind = node.type as PlayerKind;
    const route = traceRoute(node.id, nodes, edges);
    routes.push([kind, route]);
    parts.push([kind, node.data.mute, route]);
  }
  // MIDI Input node: same law as players — its live notes only sound if its
  // cable chain reaches a synth whose signal reaches Out
  const midiNode = nodes.find((n) => n.type === 'midiin');
  const liveRoute = midiNode ? traceRoute(midiNode.id, nodes, edges) : null;
  parts.push(liveRoute);
  const delayNode = nodes.find((n) => n.type === 'delay');
  const reverbNode = nodes.find((n) => n.type === 'reverb');
  const outNode = nodes.find((n) => n.type === 'out');
  parts.push(delayNode?.data, reverbNode?.data, outNode?.data);

  const messages: DspMessage[] = [];
  if (liveRoute) {
    const audible = liveRoute.toOut && liveRoute.synth !== null;
    messages.push({ type: 'mute', kind: 'live', value: !audible });
    if (liveRoute.synth) messages.push(voiceMessage('live', liveRoute.synth));
    messages.push({ type: 'sends', kind: 'live', rev: liveRoute.hasReverb ? 0.3 : 0, del: liveRoute.hasDelay ? 0.25 : 0 });
  } else {
    messages.push({ type: 'mute', kind: 'live', value: true });
  }

  for (const [kind, route] of routes) {
    const data = nodes.find((n) => n.type === kind)?.data;
    messages.push({ type: 'mute', kind, value: Boolean(data?.mute) || !isRouted(route) });
    if (route.synth) messages.push(voiceMessage(kind, route.synth));
    messages.push({ type: 'sends', kind, rev: route.hasReverb ? REV_SEND[kind] : 0, del: route.hasDelay ? DEL_SEND[kind] : 0 });
    messages.push({ type: 'glide', kind, seconds: route.expression ? Number(route.expression.portamento) * 0.3 : 0 });
  }
  if (delayNode) {
    const d = delayNode.data as unknown as DelayData;
    messages.push({ type: 'delay', division: Number(d.division), feedback: Number(d.feedback), mix: Number(d.mix) });
  }
  if (reverbNode) {
    messages.push({ type: 'reverb', mix: Number((reverbNode.data as unknown as ReverbData).mix) });
  }
  if (outNode) {
    messages.push({ type: 'master', value: dbToLinear(Number((outNode.data as unknown as OutData).level)) });
  }
  return { messages, signature: JSON.stringify(parts) };
}
