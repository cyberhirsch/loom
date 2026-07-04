import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import type { ConductorState, LoomNode, LoomNodeType, Pattern, PlayerKind } from './types';
import { randomSeed } from '../theory/rng';
import { DEFAULT_PLAYER, parseLoomScript, serializeProject, type LoomProject, type ScriptError } from '../script/loomscript';
import { SINGLETON_TYPES } from './catalog';

/** phrase-length choices (steps per loop) — editable on the Conductor */
export const PHRASE_CHOICES = [8, 16, 32];

interface LoomStore {
  nodes: LoomNode[];
  edges: Edge[];
  conductor: ConductorState;
  playing: boolean;
  currentStep: number;
  loopCount: number;
  /** live (possibly evolved) patterns per player node id, published by the audio engine */
  patterns: Record<string, Pattern>;
  /** effective density per player id after LFO modulation (display) */
  effDensity: Record<string, number>;

  onNodesChange: (changes: NodeChange<LoomNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  updateConductor: (patch: Partial<ConductorState>) => void;
  setPlaying: (playing: boolean) => void;
  setStep: (step: number) => void;
  setLoopCount: (count: number) => void;
  publishPattern: (id: string, pattern: Pattern) => void;
  publishEffDensity: (id: string, value: number) => void;
  rerollSeed: (id: string) => void;
  /** ensemble energy curve of the last loop (0..1 per step) */
  energyCurve: number[];
  /** active arranger section index (display), -1 when arranger off */
  arrangerSection: number;
  setArrangerSection: (idx: number) => void;
  publishEnergy: (curve: number[]) => void;
  /** create any node from the catalog; singletons no-op if already in the patch */
  addNode: (type: LoomNodeType, position?: { x: number; y: number }) => void;
  /** clipboard for copy/cut/paste on the canvas */
  clipboard: { nodes: LoomNode[]; edges: Edge[] } | null;
  copySelection: (extraId?: string) => void;
  cutSelection: (extraId?: string) => void;
  deleteSelection: (extraId?: string) => void;
  pasteClipboard: (position?: { x: number; y: number }) => void;
  resetProject: () => void;
  applyTemplate: (id: TemplateId) => void;
  /** launcher scenes (PRD §6.7): snapshots of the ensemble, launched quantized to the loop */
  scenes: Scene[];
  saveScene: () => void;
  launchScene: (idx: number) => void;
  deleteScene: (idx: number) => void;
  activeScene: number;
  /** LoomScript (docs/LOOMSCRIPT.md): the patch as LLM-editable text */
  scriptText: () => string;
  applyScript: (text: string) => ScriptError[] | null;
}

export type TemplateId = 'ambient' | 'lofi' | 'techno';

export interface Scene {
  name: string;
  players: Record<string, Record<string, unknown>>;
  conductor: Pick<ConductorState, 'keyIndex' | 'scaleId' | 'tempo' | 'evolveOn' | 'journeyOn'>;
}

/** The default patch IS a LoomScript document (docs/LOOMSCRIPT.md) — the same
 *  format the autosave persists and any LLM can read and edit. */
export const DEFAULT_SCRIPT = `# Loom — default ensemble (LoomScript v1)
loom 1

conductor key=C scale=minor_pent tempo=102 phrase=16 evolve=off journey=off every=4 @ 40,140
arranger off @ 40,560
section "A · sparse" loops=4 intensity=0.65
section "B · full" loops=4 intensity=1
section "C · lift" loops=2 intensity=1.2 journey=1

arp    seed=505 density=0.45 register=1 volume=-14 @ 700,-230
melody seed=101 density=0.55 adventure=0.35 volume=-9 @ 700,20
chords seed=202 density=0.5 volume=-16 @ 700,270
bass   seed=303 density=0.5 volume=-10 @ 700,520
drums  seed=404 density=0.6 syncopate=0.3 volume=-8 @ 700,770

lfo1:    lfo rate=0.5 depth=0.35 @ 340,40
expr1:   expression portamento=0.15 glissando=on @ 990,60
pluck:   synth wave=triangle attack=0.002 release=0.25 cutoff=6500 @ 1250,-230
lead:    synth wave=triangle attack=0.004 release=0.5 cutoff=5200 @ 1250,20
pad:     synth wave=sine attack=0.1 release=1.3 cutoff=3400 @ 1250,270
sub:     synth wave=square attack=0.008 release=0.3 cutoff=900 @ 1250,520
kit1:    kit @ 1250,770
delay1:  delay time=1/8d feedback=0.35 mix=0.25 @ 1530,-90
reverb1: reverb mix=0.28 @ 1530,360
out level=0 @ 1790,360

melody -> expr1 -> lead -> delay1 -> reverb1 -> out
arp -> pluck -> delay1
chords -> pad -> reverb1
bass -> sub -> out
drums -> kit1 -> reverb1
lfo1 -> melody.density
`;

const defaultProject = (() => {
  const r = parseLoomScript(DEFAULT_SCRIPT);
  if (!r.ok) throw new Error('default LoomScript is invalid: ' + r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return r.project;
})();

const initialNodes = defaultProject.nodes;
const initialEdges = defaultProject.edges;

/** Project persistence (PRD §6.10): the autosave IS LoomScript text —
 *  one source of truth, readable and editable by any LLM. v3 (script). */
const SAVE_KEY = 'loom-project-v3';

function loadProject(): LoomProject | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const r = parseLoomScript(raw);
    return r.ok ? r.project : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => { nodes: LoomNode[]; edges: Edge[]; conductor: ConductorState; scenes: Scene[] }) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SAVE_KEY, serializeProject(get()));
    } catch {
      /* storage unavailable — nonfatal */
    }
  }, 500);
}

const saved = typeof localStorage !== 'undefined' ? loadProject() : null;

const defaultConductor: ConductorState = defaultProject.conductor;

/** id for a new node: singletons keep their fixed id, others get type+N */
function freshId(type: string, taken: (id: string) => boolean): string {
  if (SINGLETON_TYPES.has(type)) return type;
  let n = 1;
  while (taken(`${type}${n}`)) n++;
  return `${type}${n}`;
}

/** default data for a freshly created node (players get a fresh seed) */
function defaultNodeData(type: LoomNodeType, id: string): Record<string, unknown> {
  switch (type) {
    case 'conductor': return {};
    case 'arranger': return { enabled: false, sections: [{ name: 'A', loops: 4, intensity: 1, journeyStop: -1 }] };
    case 'melody': case 'chords': case 'bass': case 'drums': case 'arp':
      return { ...DEFAULT_PLAYER[type as PlayerKind], seed: randomSeed() };
    case 'lfo': return { rate: 0.5, depth: 0.35 };
    case 'tension': return { depth: 0.4 };
    case 'motif': return { idea: randomSeed(), shape: 'arch' };
    case 'synth': return { label: id, wave: 1, attack: 0.005, release: 0.4, cutoff: 4000 };
    case 'kit': return {};
    case 'expression': return { portamento: 0.15, glissando: true };
    case 'delay': return { division: 3, feedback: 0.35, mix: 0.25 };
    case 'reverb': return { mix: 0.28 };
    case 'out': return { level: 0 };
  }
}

/** the nodes a copy/cut/delete acts on: the selection, or the right-clicked node */
function grabTargets(nodes: LoomNode[], extraId?: string): LoomNode[] {
  const sel = nodes.filter((n) => n.selected);
  if (sel.length) return extraId && !sel.some((n) => n.id === extraId)
    ? [...sel, ...nodes.filter((n) => n.id === extraId)]
    : sel;
  return extraId ? nodes.filter((n) => n.id === extraId) : [];
}

export const useLoomStore = create<LoomStore>((set, get) => ({
  nodes: saved?.nodes ?? initialNodes,
  edges: saved?.edges ?? initialEdges,
  conductor: saved?.conductor ?? defaultConductor,
  playing: false,
  currentStep: -1,
  loopCount: 0,
  patterns: {},
  effDensity: {},

  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  onConnect: (connection) => {
    // typed cables (PRD §5.1): CV → density, Note → note-in, Signal → signal-in, Motif → motif-in
    const { sourceHandle, targetHandle } = connection;
    const ok =
      (sourceHandle === 'cv-out' && targetHandle === 'density-in') ||
      (sourceHandle === 'notes-out' && targetHandle === 'notes-in') ||
      (sourceHandle === 'signal-out' && targetHandle === 'signal-in') ||
      (sourceHandle === 'motif-out' && targetHandle === 'motif-in');
    if (!ok) return;
    const className =
      sourceHandle === 'notes-out' ? 'edge-note' : sourceHandle === 'motif-out' ? 'edge-motif' : 'edge-signal';
    set({ edges: addEdge({ ...connection, className }, get().edges) });
  },
  updateNodeData: (id, patch) =>
    set({
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    }),
  updateConductor: (patch) => {
    const prev = get().conductor;
    const next = { ...prev, ...patch };
    // editing home key/scale re-anchors the live values unless the journey moved them
    if (patch.keyIndex !== undefined || patch.scaleId !== undefined) {
      next.liveKeyIndex = next.keyIndex;
      next.liveScaleId = next.scaleId;
      next.journeyLabel = 'home';
    }
    set({ conductor: next });
  },
  setPlaying: (playing) => set({ playing }),
  setStep: (step) => set({ currentStep: step }),
  setLoopCount: (count) => set({ loopCount: count }),
  publishPattern: (id, pattern) => set({ patterns: { ...get().patterns, [id]: pattern } }),
  publishEffDensity: (id, value) => set({ effDensity: { ...get().effDensity, [id]: value } }),
  rerollSeed: (id) => get().updateNodeData(id, { seed: randomSeed() }),
  energyCurve: [],
  publishEnergy: (curve) => set({ energyCurve: curve }),
  arrangerSection: -1,
  setArrangerSection: (idx) => set({ arrangerSection: idx }),
  resetProject: () => {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    set({ nodes: initialNodes, edges: initialEdges, conductor: defaultConductor, patterns: {}, effDensity: {} });
  },
  addNode: (type, position) => {
    const nodes = get().nodes;
    if (SINGLETON_TYPES.has(type) && nodes.some((n) => n.type === type)) return;
    const id = freshId(type, (candidate) => nodes.some((n) => n.id === candidate));
    const pos = position ?? { x: 340 + Math.random() * 120, y: 240 + Math.random() * 120 };
    set({
      nodes: [
        ...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        { id, type, position: pos, data: defaultNodeData(type, id), selected: true },
      ],
    });
  },
  clipboard: null,
  copySelection: (extraId) => {
    const { nodes, edges } = get();
    const targets = grabTargets(nodes, extraId);
    if (!targets.length) return;
    const ids = new Set(targets.map((n) => n.id));
    const innerEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    set({ clipboard: JSON.parse(JSON.stringify({ nodes: targets, edges: innerEdges })) });
  },
  cutSelection: (extraId) => {
    get().copySelection(extraId);
    get().deleteSelection(extraId);
  },
  deleteSelection: (extraId) => {
    const { nodes, edges } = get();
    const targets = grabTargets(nodes, extraId);
    if (!targets.length) return;
    const ids = new Set(targets.map((n) => n.id));
    set({
      nodes: nodes.filter((n) => !ids.has(n.id)),
      edges: edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
    });
  },
  pasteClipboard: (position) => {
    const clip = get().clipboard;
    if (!clip || !clip.nodes.length) return;
    const existing = get().nodes;
    const idMap = new Map<string, string>();
    const pasted: LoomNode[] = [];
    // paste lands at the given canvas point (or nudged +48 from the original)
    const minX = Math.min(...clip.nodes.map((n) => n.position.x));
    const minY = Math.min(...clip.nodes.map((n) => n.position.y));
    const dx = position ? position.x - minX : 48;
    const dy = position ? position.y - minY : 48;
    for (const n of clip.nodes) {
      const type = n.type as string;
      // singleton roles can't be duplicated — pasting one back only works if the slot is free
      if (SINGLETON_TYPES.has(type) && (existing.some((x) => x.type === type) || pasted.some((x) => x.type === type))) continue;
      const id = freshId(type, (candidate) => existing.some((x) => x.id === candidate) || pasted.some((x) => x.id === candidate));
      idMap.set(n.id, id);
      const clone = JSON.parse(JSON.stringify(n)) as LoomNode;
      pasted.push({ ...clone, id, selected: true, position: { x: n.position.x + dx, y: n.position.y + dy } });
    }
    if (!pasted.length) return;
    const pastedEdges: Edge[] = [];
    for (const e of clip.edges) {
      const source = idMap.get(e.source);
      const target = idMap.get(e.target);
      if (!source || !target) continue;
      const port = e.targetHandle === 'density-in' ? '.density' : e.targetHandle === 'motif-in' ? '.motif' : '';
      pastedEdges.push({ ...e, id: `${source}→${target}${port}`, source, target });
    }
    set({
      nodes: [...existing.map((n) => (n.selected ? { ...n, selected: false } : n)), ...pasted],
      edges: [...get().edges, ...pastedEdges],
    });
  },
  scenes: saved?.scenes ?? [],
  activeScene: -1,
  saveScene: () => {
    const { nodes, conductor, scenes } = get();
    const players: Record<string, Record<string, unknown>> = {};
    for (const n of nodes) {
      if (['melody', 'chords', 'bass', 'drums', 'arp'].includes(n.type as string)) {
        players[n.id] = JSON.parse(JSON.stringify(n.data));
      }
    }
    set({
      scenes: [
        ...scenes,
        {
          name: `scene ${scenes.length + 1}`,
          players,
          conductor: {
            keyIndex: conductor.keyIndex,
            scaleId: conductor.scaleId,
            tempo: conductor.tempo,
            evolveOn: conductor.evolveOn,
            journeyOn: conductor.journeyOn,
          },
        },
      ],
      activeScene: scenes.length,
    });
  },
  launchScene: (idx) => {
    const scene = get().scenes[idx];
    if (!scene) return;
    // param changes land at the next loop boundary (engine refresh) — quantized launch
    set({
      nodes: get().nodes.map((n) => (scene.players[n.id] ? { ...n, data: { ...n.data, ...scene.players[n.id] } } : n)),
      activeScene: idx,
    });
    get().updateConductor(scene.conductor);
  },
  deleteScene: (idx) =>
    set({ scenes: get().scenes.filter((_, i) => i !== idx), activeScene: -1 }),
  scriptText: () => serializeProject(get()),
  applyScript: (text) => {
    const r = parseLoomScript(text);
    if (!r.ok) return r.errors;
    set({
      nodes: r.project.nodes,
      edges: r.project.edges,
      conductor: r.project.conductor,
      scenes: r.project.scenes,
      patterns: {},
      effDensity: {},
      activeScene: -1,
    });
    return null;
  },
  applyTemplate: (id) => {
    const t = TEMPLATES[id];
    if (!t) return;
    const nodes = initialNodes.map((n) => {
      const clone = JSON.parse(JSON.stringify(n)) as LoomNode;
      if (t.players[n.type as string]) clone.data = { ...clone.data, ...t.players[n.type as string] };
      if (n.type === 'arranger' && t.arranger) clone.data = { ...clone.data, ...t.arranger };
      return clone;
    });
    const edges: Edge[] = t.tensionToMelody
      ? [
          ...initialEdges,
          {
            id: 'tension-tpl',
            source: 'tension-tpl-node',
            sourceHandle: 'cv-out',
            target: 'melody',
            targetHandle: 'density-in',
            className: 'edge-signal',
          },
        ]
      : [...initialEdges];
    if (t.tensionToMelody) {
      nodes.push({ id: 'tension-tpl-node', type: 'tension', position: { x: 340, y: 300 }, data: { depth: 0.4 } });
    }
    set({
      nodes,
      edges,
      conductor: { ...defaultConductor, ...t.conductor, liveKeyIndex: t.conductor.keyIndex ?? 0, liveScaleId: t.conductor.scaleId ?? 'minor_pent', journeyLabel: 'home' },
      patterns: {},
      effDensity: {},
    });
  },
}));

/** Ensemble templates (PRD §6.11): open one and a patch is already playing-ready. */
interface Template {
  conductor: Partial<ConductorState>;
  players: Record<string, Record<string, unknown>>;
  arranger?: Record<string, unknown>;
  tensionToMelody?: boolean;
}

const TEMPLATES: Record<TemplateId, Template> = {
  ambient: {
    conductor: { keyIndex: 2, scaleId: 'lydian', tempo: 74, evolveOn: true, journeyOn: false },
    players: {
      melody: { seed: 811, density: 0.3, adventurousness: 0.25, volume: -10 },
      chords: { seed: 812, density: 0.55, volume: -12 },
      bass: { seed: 813, density: 0.25, volume: -14 },
      drums: { seed: 814, density: 0.2, syncopation: 0.1, mute: true },
      arp: { seed: 815, density: 0.35, volume: -18, register: 1 },
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
      bass: { seed: 733, density: 0.75, volume: -8 },
      drums: { seed: 734, density: 0.85, syncopation: 0.5, volume: -6, mute: false },
      arp: { seed: 735, density: 0.8, volume: -13, register: 1, mute: false },
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

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__loomStore = useLoomStore;
}

// autosave: any change to patch or conductor persists (debounced)
useLoomStore.subscribe((state, prev) => {
  if (state.nodes !== prev.nodes || state.edges !== prev.edges || state.conductor !== prev.conductor || state.scenes !== prev.scenes) {
    scheduleSave(() => useLoomStore.getState());
  }
});

/** Player ids whose density input is fed by a modulator (LFO or Tension). */
export function densityModulations(nodes: LoomNode[], edges: Edge[]): Array<{ playerId: string; sourceId: string }> {
  return edges
    .filter((e) => e.targetHandle === 'density-in' && e.sourceHandle === 'cv-out')
    .map((e) => ({ playerId: e.target, sourceId: e.source }));
}
