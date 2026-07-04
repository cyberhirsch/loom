import type { LoomNodeType, NodeCategory } from './types';

/** The node catalog — every creatable node, grouped by category (PRD §5).
 *  Single source of truth for the top-bar add menus and the canvas
 *  right-click menu. `singleton` nodes exist at most once per patch. */
export interface CatalogItem {
  type: LoomNodeType;
  label: string;
  icon: string;
  /** plain-language hint shown as tooltip */
  hint: string;
  singleton?: boolean;
}

export interface CatalogCategory {
  id: NodeCategory | 'player';
  label: string;
  items: CatalogItem[];
}

export const NODE_CATALOG: CatalogCategory[] = [
  {
    id: 'player',
    label: 'player',
    items: [
      { type: 'conductor', label: 'Conductor', icon: '◈', hint: 'the rules of the room — key, scale, tempo, phrase length', singleton: true },
      { type: 'arranger', label: 'Arranger', icon: '▤', hint: 'the song’s story — sections with intensity over time', singleton: true },
      { type: 'melody', label: 'Melody', icon: '♪', hint: 'the lead voice — phrases, cadences, themes', singleton: true },
      { type: 'chords', label: 'Chords', icon: '♬', hint: 'comping pads — its seed drives the shared progression', singleton: true },
      { type: 'bass', label: 'Bass', icon: '𝄢', hint: 'root-driven low end', singleton: true },
      { type: 'drums', label: 'Drums', icon: '▦', hint: 'kick anchors, snare answers, hats fill', singleton: true },
      { type: 'arp', label: 'Arp', icon: '≋', hint: 'ornamental arpeggios over the current chord', singleton: true },
    ],
  },
  {
    id: 'source',
    label: 'instrument',
    items: [
      { type: 'synth', label: 'Synth', icon: '◈', hint: 'turns notes into sound — wave, attack, release, cutoff' },
      { type: 'kit', label: 'Kit', icon: '◇', hint: 'the drum instrument — kick, snare, hat' },
    ],
  },
  {
    id: 'fx',
    label: 'fx',
    items: [
      { type: 'expression', label: 'Expression', icon: '〜', hint: 'note fx — portamento glides + scale-locked glissando runs' },
      { type: 'delay', label: 'Delay', icon: '⟲', hint: 'tempo-synced ping-pong echo' },
      { type: 'reverb', label: 'Reverb', icon: '≡', hint: 'the shared room' },
      { type: 'out', label: 'Out', icon: '◎', hint: 'master output — all sound funnels here', singleton: true },
    ],
  },
  {
    id: 'modulator',
    label: 'mod',
    items: [
      { type: 'motif', label: 'Motif', icon: '✎', hint: 'the melodic idea — patch into Melody’s motif input' },
      { type: 'lfo', label: 'LFO', icon: '∿', hint: 'a slow wave that wiggles a player’s density' },
      { type: 'tension', label: 'Tension', icon: '☄', hint: 'the ensemble’s energy as a control signal — self-balancing loops' },
    ],
  },
];

/** Node types that exist at most once per patch. */
export const SINGLETON_TYPES = new Set<string>(
  NODE_CATALOG.flatMap((c) => c.items.filter((i) => i.singleton).map((i) => i.type)),
);
