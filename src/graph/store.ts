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
import { parseLoomScript, serializeProject, type LoomProject, type ScriptError } from '../script/loomscript';

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
  addModulator: (type: 'lfo' | 'tension' | 'motif') => void;
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
  addModulator: (type) => {
    const id = `${type}${Date.now().toString(36)}`;
    const data =
      type === 'lfo'
        ? { rate: 0.5, depth: 0.35 }
        : type === 'motif'
          ? { idea: randomSeed(), shape: 'arch' }
          : { depth: 0.4 };
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
