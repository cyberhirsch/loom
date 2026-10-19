/**
 * Ensemble templates (PRD §6.11): open one and a patch is already playing-ready.
 * Pure — the store applies them and the score tool renders them, so both hear the same patch.
 */

import type { Edge } from '@xyflow/react';
import type { ConductorState, LoomNode } from './types';
import { parseLoomScript } from '../script/loomscript';
import { DEFAULT_SCRIPT } from './defaultScript';

export type TemplateId = 'ambient' | 'lofi' | 'techno';

interface Template {
  conductor: Partial<ConductorState>;
  players: Record<string, Record<string, unknown>>;
  arranger?: Record<string, unknown>;
  tensionToMelody?: boolean;
}

export const TEMPLATES: Record<TemplateId, Template> = {
  ambient: {
    conductor: { keyIndex: 2, scaleId: 'lydian', tempo: 74, evolveOn: true, journeyOn: false },
    players: {
      melody: { seed: 811, density: 0.3, adventurousness: 0.25, volume: -10 },
      chords: { seed: 812, density: 0.55, volume: -12 },
      bass: { seed: 813, density: 0.25, volume: -14 },
      drums: { seed: 814, density: 0.2, syncopation: 0.1, mute: true },
      arp: { seed: 815, density: 0.35, volume: -18 },
    },
    tensionToMelody: true,
  },
  lofi: {
    conductor: { keyIndex: 9, scaleId: 'dorian', tempo: 84, evolveOn: false, journeyOn: false },
    players: {
      melody: { seed: 921, density: 0.45, adventurousness: 0.4, volume: -10 },
      chords: { seed: 922, density: 0.5, volume: -13 },
      bass: { seed: 923, density: 0.5, volume: -9 },
      drums: { seed: 924, density: 0.55, syncopation: 0.45, volume: -11, mute: false },
      arp: { seed: 925, density: 0.3, volume: -20, mute: true },
    },
  },
  techno: {
    conductor: { keyIndex: 0, scaleId: 'minor_pent', tempo: 128, evolveOn: false, journeyOn: false },
    players: {
      melody: { seed: 731, density: 0.35, adventurousness: 0.5, volume: -14, mute: true },
      chords: { seed: 732, density: 0.3, volume: -18 },
      bass: { seed: 733, density: 0.75, volume: -8, articulation: 0.5 },
      drums: { seed: 734, density: 0.85, syncopation: 0.5, volume: -6, mute: false },
      arp: { seed: 735, density: 0.8, volume: -13, mute: false },
    },
    arranger: {
      enabled: true,
      sections: [
        { name: 'groove', loops: 4, intensity: 0.8, journeyStop: -1 },
        { name: 'build', loops: 4, intensity: 1.1, journeyStop: -1 },
        { name: 'peak', loops: 4, intensity: 1.35, journeyStop: 1 },
        { name: 'breakdown', loops: 2, intensity: 0.5, journeyStop: 2 },
      ],
    },
  },
};

export interface Patch {
  nodes: LoomNode[];
  edges: Edge[];
  conductor: ConductorState;
}

/** The default patch (DEFAULT_SCRIPT), freshly parsed. */
export function defaultPatch(): Patch {
  const r = parseLoomScript(DEFAULT_SCRIPT);
  if (!r.ok) throw new Error('default LoomScript is invalid: ' + r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return { nodes: r.project.nodes, edges: r.project.edges, conductor: r.project.conductor };
}

/** A template applied over the default patch. */
export function templatePatch(id: TemplateId, base: Patch = defaultPatch()): Patch {
  const t = TEMPLATES[id];
  const nodes = base.nodes.map((n) => {
    const clone = JSON.parse(JSON.stringify(n)) as LoomNode;
    if (t.players[n.type as string]) clone.data = { ...clone.data, ...t.players[n.type as string] };
    if (n.type === 'arranger' && t.arranger) clone.data = { ...clone.data, ...t.arranger };
    return clone;
  });
  const edges: Edge[] = t.tensionToMelody
    ? [
        ...base.edges,
        {
          id: 'tension-tpl',
          source: 'tension-tpl-node',
          sourceHandle: 'cv-out',
          target: 'melody',
          targetHandle: 'density-in',
          className: 'edge-signal',
        },
      ]
    : [...base.edges];
  if (t.tensionToMelody) {
    nodes.push({ id: 'tension-tpl-node', type: 'tension', position: { x: 340, y: 300 }, data: { depth: 0.4 } });
  }
  return {
    nodes,
    edges,
    conductor: { ...base.conductor, ...t.conductor, liveKeyIndex: t.conductor.keyIndex ?? 0, liveScaleId: t.conductor.scaleId ?? 'minor_pent', journeyLabel: 'home' },
  };
}
