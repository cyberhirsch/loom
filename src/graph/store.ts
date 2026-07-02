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
import type { ConductorState, LoomNode, Pattern } from './types';
import { randomSeed } from '../theory/rng';

export const STEPS = 16;

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
  addModulator: (type: 'lfo' | 'tension') => void;
  resetProject: () => void;
  applyTemplate: (id: TemplateId) => void;
  /** launcher scenes (PRD §6.7): snapshots of the ensemble, launched quantized to the loop */
  scenes: Scene[];
  saveScene: () => void;
  launchScene: (idx: number) => void;
  deleteScene: (idx: number) => void;
  activeScene: number;
}

export type TemplateId = 'ambient' | 'lofi' | 'techno';

export interface Scene {
  name: string;
  players: Record<string, Record<string, unknown>>;
  conductor: Pick<ConductorState, 'keyIndex' | 'scaleId' | 'tempo' | 'evolveOn' | 'journeyOn'>;
}

const defaultPlayer = (seed: number) => ({
  seed,
  density: 0.55,
  adventurousness: 0.35,
  syncopation: 0.3,
  register: 0,
  mute: false,
  volume: -8,
});

const initialNodes: LoomNode[] = [
  { id: 'conductor', type: 'conductor', position: { x: 40, y: 200 }, data: {} },
  {
    id: 'arranger',
    type: 'arranger',
    position: { x: 40, y: 520 },
    data: {
      enabled: false,
      sections: [
        { name: 'A · sparse', loops: 4, intensity: 0.65, journeyStop: -1 },
        { name: 'B · full', loops: 4, intensity: 1.0, journeyStop: -1 },
        { name: 'C · lift', loops: 2, intensity: 1.2, journeyStop: 1 },
      ],
    },
  },
  { id: 'melody', type: 'melody', position: { x: 700, y: 20 }, data: { ...defaultPlayer(101), volume: -9 } },
  { id: 'chords', type: 'chords', position: { x: 700, y: 250 }, data: { ...defaultPlayer(202), density: 0.5, volume: -16 } },
  { id: 'bass', type: 'bass', position: { x: 700, y: 480 }, data: { ...defaultPlayer(303), density: 0.5, volume: -10 } },
  { id: 'drums', type: 'drums', position: { x: 340, y: 480 }, data: { ...defaultPlayer(404), density: 0.6, volume: -8 } },
  { id: 'arp', type: 'arp', position: { x: 1060, y: 250 }, data: { ...defaultPlayer(505), density: 0.45, volume: -14, register: 1 } },
  { id: 'lfo1', type: 'lfo', position: { x: 340, y: 60 }, data: { rate: 0.5, depth: 0.35 } },
];

const initialEdges: Edge[] = [
  {
    id: 'lfo1-melody',
    source: 'lfo1',
    sourceHandle: 'cv-out',
    target: 'melody',
    targetHandle: 'density-in',
    className: 'edge-signal',
  },
];

/** Project persistence (PRD §6.10 seed): autosave patch + conductor to localStorage. */
const SAVE_KEY = 'loom-project-v1';

interface SavedProject {
  nodes: LoomNode[];
  edges: Edge[];
  conductor: ConductorState;
  scenes?: Scene[];
}

function loadProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedProject;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges) || !parsed.conductor) return null;
    // migration: projects saved before the Arranger existed get the default one
    if (!parsed.nodes.some((n) => n.type === 'arranger')) {
      const template = initialNodes.find((n) => n.type === 'arranger');
      if (template) parsed.nodes.push(JSON.parse(JSON.stringify(template)));
    }
    return parsed;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => { nodes: LoomNode[]; edges: Edge[]; conductor: ConductorState }) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { nodes, edges, conductor, scenes } = get() as unknown as SavedProject & { scenes: Scene[] };
      localStorage.setItem(SAVE_KEY, JSON.stringify({ nodes, edges, conductor, scenes }));
    } catch {
      /* storage unavailable — nonfatal */
    }
  }, 500);
}

const saved = typeof localStorage !== 'undefined' ? loadProject() : null;

const defaultConductor: ConductorState = {
  keyIndex: 0,
  scaleId: 'minor_pent',
  tempo: 102,
  evolveOn: false,
  journeyOn: false,
  modEvery: 4,
  journeyLabel: 'home',
  liveKeyIndex: 0,
  liveScaleId: 'minor_pent',
};

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
    // Only Signal cables exist as patchable edges in M0: LFO cv-out -> density-in
    if (connection.sourceHandle !== 'cv-out' || connection.targetHandle !== 'density-in') return;
    set({ edges: addEdge({ ...connection, className: 'edge-signal' }, get().edges) });
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
  addModulator: (type) => {
    const id = `${type}${Date.now().toString(36)}`;
    const data = type === 'lfo' ? { rate: 0.5, depth: 0.35 } : { depth: 0.4 };
    set({
      nodes: [
        ...get().nodes,
        { id, type, position: { x: 340 + Math.random() * 120, y: 240 + Math.random() * 120 }, data },
      ],
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
