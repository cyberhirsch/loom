/**
 * LoomScript (v1) — the whole patch as text (PRD prerequisite, 2026-07-02):
 * a line-based DSL readable and editable by humans and any LLM. This IS the
 * save format: the store persists script text and parses it back, so
 * round-trip fidelity is guaranteed by construction (and by tests).
 *
 * Grammar: see docs/LOOMSCRIPT.md (the canonical spec).
 */

import type { Edge } from '@xyflow/react';
import type { ConductorState, LoomNode, PlayerKind } from '../graph/types';
import type { Scene } from '../graph/store';
import { NOTE_NAMES, SCALES, type ScaleId } from '../theory/scales';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';

export interface LoomProject {
  nodes: LoomNode[];
  edges: Edge[];
  conductor: ConductorState;
  scenes: Scene[];
}

export interface ScriptError {
  line: number; // 1-based; 0 = whole document
  message: string;
}

export type ParseResult = { ok: true; project: LoomProject } | { ok: false; errors: ScriptError[] };

const PLAYER_KINDS: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];
const WAVES = ['sine', 'triangle', 'square', 'saw'];
const DRUM_LANES = ['kick', 'snare', 'hat'];
const DIVISION_NAMES: Record<number, string> = { 2: '1/8', 3: '1/8d', 4: '1/4' };

/** player param name ↔ data field (script names are the friendlier ones) */
const PLAYER_PARAMS: Record<string, string> = {
  seed: 'seed',
  density: 'density',
  adventure: 'adventurousness',
  syncopate: 'syncopation',
  register: 'register',
  volume: 'volume',
  mute: 'mute',
};
const PLAYER_FIELD_TO_PARAM = Object.fromEntries(Object.entries(PLAYER_PARAMS).map(([k, v]) => [v, k]));

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

const round = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
const onOff = (v: unknown) => (v ? 'on' : 'off');
const pos = (n: LoomNode) => ` @ ${Math.round(n.position.x)},${Math.round(n.position.y)}`;

function playerLine(n: LoomNode): string {
  const d = n.data;
  const parts = [n.type as string];
  for (const [param, field] of Object.entries(PLAYER_PARAMS)) {
    if (field === 'mute') {
      if (d.mute) parts.push('mute=on');
      continue;
    }
    if (param === 'adventure' && n.type !== 'melody') continue;
    if (param === 'syncopate' && n.type !== 'drums') continue;
    if (d[field] !== undefined) parts.push(`${param}=${round(Number(d[field]))}`);
  }
  return parts.join(' ') + pos(n);
}

function takeLine(n: LoomNode): string | null {
  if (!n.data.frozen || !Array.isArray(n.data.frozenPattern)) return null;
  const evs = n.data.frozenPattern as Array<Record<string, number>>;
  const body =
    n.type === 'drums'
      ? (evs as unknown as DrumEvent[]).map((e) => `${e.step}:${DRUM_LANES[e.lane]}:${round(e.velocity)}`)
      : (evs as unknown as NoteEvent[]).map((e) => `${e.step}:${e.degree}:${round(e.velocity)}:${round(e.lengthSteps)}`);
  return `take ${n.type} ${body.join(' ')}`;
}

function nodeLine(n: LoomNode): string {
  const d = n.data;
  switch (n.type) {
    case 'expression':
      return `${n.id}: expression portamento=${round(Number(d.portamento ?? 0))} glissando=${onOff(d.glissando)}${pos(n)}`;
    case 'synth':
      return `${n.id}: synth wave=${WAVES[Number(d.wave ?? 0)] ?? 'sine'} attack=${round(Number(d.attack ?? 0.005))} release=${round(Number(d.release ?? 0.4))} cutoff=${round(Number(d.cutoff ?? 4000))}${pos(n)}`;
    case 'kit':
      return `${n.id}: kit${pos(n)}`;
    case 'delay':
      return `${n.id}: delay time=${DIVISION_NAMES[Number(d.division ?? 3)] ?? '1/8d'} feedback=${round(Number(d.feedback ?? 0.35))} mix=${round(Number(d.mix ?? 0.25))}${pos(n)}`;
    case 'reverb':
      return `${n.id}: reverb mix=${round(Number(d.mix ?? 0.28))}${pos(n)}`;
    case 'motif':
      return `${n.id}: motif idea=${Math.round(Number(d.idea ?? 1))} shape=${String(d.shape ?? 'arch')}${pos(n)}`;
    case 'lfo':
      return `${n.id}: lfo rate=${round(Number(d.rate ?? 0.5))} depth=${round(Number(d.depth ?? 0.35))}${pos(n)}`;
    case 'tension':
      return `${n.id}: tension depth=${round(Number(d.depth ?? 0.4))}${pos(n)}`;
    default:
      return `# (unserializable node ${n.id}: ${n.type})`;
  }
}

/** Which cable family a node emits / accepts (chain inference). */
const EMITS: Record<string, 'notes' | 'signal' | 'cv' | 'motif' | undefined> = {
  melody: 'notes', chords: 'notes', bass: 'notes', drums: 'notes', arp: 'notes',
  expression: 'notes',
  synth: 'signal', kit: 'signal', delay: 'signal', reverb: 'signal',
  lfo: 'cv', tension: 'cv',
  motif: 'motif',
};
const ACCEPTS_NOTES = new Set(['expression', 'synth', 'kit']);
const ACCEPTS_SIGNAL = new Set(['delay', 'reverb', 'out']);

export function serializeProject(p: { nodes: LoomNode[]; edges: Edge[]; conductor: ConductorState; scenes: Scene[] }): string {
  const { nodes, edges, conductor: c, scenes } = p;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: string[] = ['# Loom patch — LoomScript v1 (spec: docs/LOOMSCRIPT.md)', 'loom 1', ''];

  const conductorNode = nodes.find((n) => n.type === 'conductor');
  lines.push(
    `conductor key=${NOTE_NAMES[c.keyIndex]} scale=${c.scaleId} tempo=${c.tempo} phrase=${c.steps || 16} evolve=${onOff(c.evolveOn)} journey=${onOff(c.journeyOn)} every=${c.modEvery}` +
      (conductorNode ? pos(conductorNode) : ''),
  );
  const arrangerNode = nodes.find((n) => n.type === 'arranger');
  if (arrangerNode) {
    lines.push(`arranger ${onOff(arrangerNode.data.enabled)}${pos(arrangerNode)}`);
    const sections = (arrangerNode.data.sections ?? []) as Array<Record<string, unknown>>;
    for (const s of sections) {
      let line = `section "${s.name}" loops=${s.loops} intensity=${round(Number(s.intensity))}`;
      if (Number(s.journeyStop) >= 0) line += ` journey=${s.journeyStop}`;
      lines.push(line);
    }
  }
  lines.push('');

  // players (fixed roles, declared by kind), with frozen takes
  for (const n of nodes) {
    if (!PLAYER_KINDS.includes(n.type as PlayerKind)) continue;
    lines.push(playerLine(n));
    const take = takeLine(n);
    if (take) lines.push(take);
  }
  lines.push('');

  // instruments, note fx, fx, modulators
  for (const n of nodes) {
    if (['conductor', 'arranger', 'out', ...PLAYER_KINDS].includes(n.type as string)) continue;
    lines.push(nodeLine(n));
  }
  const outNode = nodes.find((n) => n.type === 'out');
  if (outNode) lines.push(`out level=${round(Number(outNode.data.level ?? 0))}${pos(outNode)}`);
  lines.push('');

  // cables as chains: walk note/signal flow from each player; leftovers as single arrows
  const emitted = new Set<string>();
  const flowEdge = (from: string) =>
    edges.find((e) => e.source === from && (e.sourceHandle === 'notes-out' || e.sourceHandle === 'signal-out') && !emitted.has(e.id));
  for (const n of nodes) {
    if (!PLAYER_KINDS.includes(n.type as PlayerKind)) continue;
    const path = [n.id];
    let cur = n.id;
    for (;;) {
      const e = flowEdge(cur);
      if (!e) break;
      emitted.add(e.id);
      path.push(e.target);
      cur = e.target;
    }
    if (path.length > 1) lines.push(path.join(' -> '));
  }
  for (const e of edges) {
    if (emitted.has(e.id)) continue;
    emitted.add(e.id);
    if (e.targetHandle === 'density-in') lines.push(`${e.source} -> ${e.target}.density`);
    else if (e.targetHandle === 'motif-in') lines.push(`${e.source} -> ${e.target}.motif`);
    else lines.push(`${e.source} -> ${e.target}`);
  }

  // scenes: knob snapshots (frozen takes are not part of scenes)
  if (scenes.length) {
    lines.push('');
    for (const sc of scenes) {
      const parts = [
        `scene "${sc.name}"`,
        `key=${NOTE_NAMES[sc.conductor.keyIndex]}`,
        `scale=${sc.conductor.scaleId}`,
        `tempo=${sc.conductor.tempo}`,
        `evolve=${onOff(sc.conductor.evolveOn)}`,
        `journey=${onOff(sc.conductor.journeyOn)}`,
      ];
      for (const [id, data] of Object.entries(sc.players)) {
        const kind = byId.get(id)?.type ?? id;
        for (const [field, value] of Object.entries(data)) {
          const param = PLAYER_FIELD_TO_PARAM[field];
          if (!param) continue; // skips frozen/frozenPattern and unknowns
          parts.push(`${kind}.${param}=${field === 'mute' ? onOff(value) : round(Number(value))}`);
        }
      }
      lines.push(parts.join(' '));
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

/** number with optional unit suffix: 12ms → 0.012, 5.2k → 5200, 0.5s → 0.5 */
function parseNum(raw: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|k|hz)?$/i.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'ms') return v / 1000;
  if (unit === 'k') return v * 1000;
  return v;
}

function parseBool(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  return null;
}

function parseDivision(raw: string): number | null {
  const named: Record<string, number> = { '1/8': 2, '1/8d': 3, '1/8.': 3, '1/4': 4 };
  if (named[raw] !== undefined) return named[raw];
  const n = parseNum(raw);
  return n !== null && n >= 1 && n <= 8 ? Math.round(n) : null;
}

/** split a line into tokens, keeping "quoted strings" intact */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push(m[1] !== undefined ? `"${m[1]}"` : m[2]);
  return tokens;
}

interface KV {
  key: string;
  value: string;
}

function splitParams(tokens: string[], lineNo: number, errors: ScriptError[]): { kvs: KV[]; at: { x: number; y: number } | null } {
  const kvs: KV[] = [];
  let at: { x: number; y: number } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '@') {
      const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(tokens[i + 1] ?? '');
      if (m) {
        at = { x: Number(m[1]), y: Number(m[2]) };
        i++;
      } else errors.push({ line: lineNo, message: `expected "@ x,y" position, got "@ ${tokens[i + 1] ?? ''}"` });
      continue;
    }
    const eq = t.indexOf('=');
    if (eq === -1) {
      errors.push({ line: lineNo, message: `expected key=value, got "${t}"` });
      continue;
    }
    kvs.push({ key: t.slice(0, eq), value: t.slice(eq + 1).replace(/^"|"$/g, '') });
  }
  return { kvs, at };
}

const DEFAULT_PLAYER: Record<PlayerKind, Record<string, unknown>> = {
  melody: { seed: 101, density: 0.55, adventurousness: 0.35, syncopation: 0.3, register: 0, mute: false, volume: -9 },
  chords: { seed: 202, density: 0.5, adventurousness: 0.35, syncopation: 0.3, register: 0, mute: false, volume: -16 },
  bass: { seed: 303, density: 0.5, adventurousness: 0.35, syncopation: 0.3, register: 0, mute: false, volume: -10 },
  drums: { seed: 404, density: 0.6, adventurousness: 0.35, syncopation: 0.3, register: 0, mute: false, volume: -8 },
  arp: { seed: 505, density: 0.45, adventurousness: 0.35, syncopation: 0.3, register: 1, mute: false, volume: -14 },
};

/** auto-layout columns for nodes declared without @ x,y */
const LAYOUT: Record<string, { x: number; y0: number }> = {
  conductor: { x: 40, y0: 140 },
  arranger: { x: 40, y0: 560 },
  lfo: { x: 340, y0: 40 },
  tension: { x: 340, y0: 40 },
  motif: { x: 340, y0: 40 },
  melody: { x: 700, y0: -230 },
  chords: { x: 700, y0: -230 },
  bass: { x: 700, y0: -230 },
  drums: { x: 700, y0: -230 },
  arp: { x: 700, y0: -230 },
  expression: { x: 990, y0: 60 },
  synth: { x: 1250, y0: -230 },
  kit: { x: 1250, y0: -230 },
  delay: { x: 1530, y0: -90 },
  reverb: { x: 1530, y0: -90 },
  out: { x: 1790, y0: 360 },
};
const LAYOUT_GROUP: Record<string, string> = {
  melody: 'players', chords: 'players', bass: 'players', drums: 'players', arp: 'players',
  synth: 'instruments', kit: 'instruments',
  delay: 'fx', reverb: 'fx',
  lfo: 'mods', tension: 'mods', motif: 'mods',
};

export function parseLoomScript(text: string): ParseResult {
  const errors: ScriptError[] = [];
  const nodes: LoomNode[] = [];
  const edges: Edge[] = [];
  const scenes: Scene[] = [];
  const ids = new Map<string, LoomNode>();
  const layoutCursor: Record<string, number> = {};

  const conductor: ConductorState = {
    keyIndex: 0,
    scaleId: 'minor_pent',
    tempo: 102,
    steps: 16,
    evolveOn: false,
    journeyOn: false,
    modEvery: 4,
    journeyLabel: 'home',
    liveKeyIndex: 0,
    liveScaleId: 'minor_pent',
  };

  const place = (type: string, at: { x: number; y: number } | null) => {
    if (at) return at;
    const group = LAYOUT_GROUP[type] ?? type;
    const base = LAYOUT[type] ?? { x: 340, y0: 300 };
    const idx = layoutCursor[group] ?? 0;
    layoutCursor[group] = idx + 1;
    return { x: base.x, y: base.y0 + idx * 250 };
  };

  const addNode = (id: string, type: string, data: Record<string, unknown>, at: { x: number; y: number } | null, lineNo: number) => {
    if (ids.has(id)) {
      errors.push({ line: lineNo, message: `duplicate id "${id}"` });
      return;
    }
    const node: LoomNode = { id, type, position: place(type, at), data };
    ids.set(id, node);
    nodes.push(node);
  };

  let arrangerNode: LoomNode | null = null;
  const chainLines: Array<{ lineNo: number; text: string }> = [];

  const rawLines = text.split(/\r?\n/);
  for (let li = 0; li < rawLines.length; li++) {
    const lineNo = li + 1;
    const line = rawLines[li].replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.includes('->')) {
      chainLines.push({ lineNo, text: line });
      continue;
    }
    const tokens = tokenize(line);
    const head = tokens[0];

    if (head === 'loom') continue; // version header

    // conductor / arranger / section / out / take / scene / players / id: type
    if (head === 'conductor') {
      const { kvs, at } = splitParams(tokens.slice(1), lineNo, errors);
      for (const { key, value } of kvs) {
        if (key === 'key') {
          const idx = NOTE_NAMES.indexOf(value.toUpperCase().replace('♯', '#'));
          if (idx === -1) errors.push({ line: lineNo, message: `unknown key "${value}" (use ${NOTE_NAMES.join(' ')})` });
          else conductor.keyIndex = idx;
        } else if (key === 'scale') {
          if (!(value in SCALES)) errors.push({ line: lineNo, message: `unknown scale "${value}" (use ${Object.keys(SCALES).join(', ')})` });
          else conductor.scaleId = value as ScaleId;
        } else if (key === 'tempo') {
          const n = parseNum(value);
          if (n === null || n < 30 || n > 260) errors.push({ line: lineNo, message: `tempo must be 30..260, got "${value}"` });
          else conductor.tempo = Math.round(n);
        } else if (key === 'phrase') {
          const n = parseNum(value);
          if (n === null || ![8, 16, 32].includes(Math.round(n)))
            errors.push({ line: lineNo, message: `phrase must be 8, 16, or 32 steps, got "${value}"` });
          else conductor.steps = Math.round(n);
        } else if (key === 'evolve' || key === 'journey') {
          const b = parseBool(value);
          if (b === null) errors.push({ line: lineNo, message: `${key} must be on/off, got "${value}"` });
          else if (key === 'evolve') conductor.evolveOn = b;
          else conductor.journeyOn = b;
        } else if (key === 'every') {
          const n = parseNum(value);
          if (n === null || n < 1) errors.push({ line: lineNo, message: `every must be a positive loop count` });
          else conductor.modEvery = Math.round(n);
        } else errors.push({ line: lineNo, message: `conductor has no param "${key}"` });
      }
      addNode('conductor', 'conductor', {}, at, lineNo);
      continue;
    }

    if (head === 'arranger') {
      const enabled = parseBool(tokens[1] ?? 'off');
      if (enabled === null) errors.push({ line: lineNo, message: `arranger must be "arranger on" or "arranger off"` });
      const { at } = splitParams(tokens.slice(2), lineNo, errors);
      arrangerNode = { id: 'arranger', type: 'arranger', position: place('arranger', at), data: { enabled: enabled ?? false, sections: [] } };
      ids.set('arranger', arrangerNode);
      nodes.push(arrangerNode);
      continue;
    }

    if (head === 'section') {
      if (!arrangerNode) {
        arrangerNode = { id: 'arranger', type: 'arranger', position: place('arranger', null), data: { enabled: false, sections: [] } };
        ids.set('arranger', arrangerNode);
        nodes.push(arrangerNode);
      }
      const name = tokens[1]?.startsWith('"') ? tokens[1].slice(1, -1) : tokens[1];
      if (!name) {
        errors.push({ line: lineNo, message: `section needs a name: section "groove" loops=4 intensity=0.8` });
        continue;
      }
      const section = { name, loops: 4, intensity: 1, journeyStop: -1 };
      const { kvs } = splitParams(tokens.slice(2), lineNo, errors);
      for (const { key, value } of kvs) {
        const n = parseNum(value);
        if (key === 'loops' && n !== null) section.loops = Math.max(1, Math.round(n));
        else if (key === 'intensity' && n !== null) section.intensity = n;
        else if (key === 'journey' && n !== null) section.journeyStop = Math.round(n);
        else errors.push({ line: lineNo, message: `section has no param "${key}" (loops, intensity, journey)` });
      }
      (arrangerNode.data.sections as unknown[]).push(section);
      continue;
    }

    if (head === 'out') {
      const { kvs, at } = splitParams(tokens.slice(1), lineNo, errors);
      const data: Record<string, unknown> = { level: 0 };
      for (const { key, value } of kvs) {
        const n = parseNum(value);
        if (key === 'level' && n !== null) data.level = Math.max(-48, Math.min(6, n));
        else errors.push({ line: lineNo, message: `out has no param "${key}" (level)` });
      }
      addNode('out', 'out', data, at, lineNo);
      continue;
    }

    if (head === 'take') {
      const kind = tokens[1] as PlayerKind;
      const player = ids.get(kind);
      if (!player || !PLAYER_KINDS.includes(kind)) {
        errors.push({ line: lineNo, message: `take needs a declared player: take melody 0:2:0.9:2 …` });
        continue;
      }
      const events: unknown[] = [];
      let bad = false;
      for (const t of tokens.slice(2)) {
        const parts = t.split(':');
        if (kind === 'drums') {
          const lane = DRUM_LANES.indexOf(parts[1]);
          const step = parseNum(parts[0] ?? '');
          const vel = parseNum(parts[2] ?? '');
          if (parts.length !== 3 || lane === -1 || step === null || vel === null) bad = true;
          else events.push({ step: Math.round(step), lane, velocity: vel });
        } else {
          const [step, degree, vel, len] = parts.map((x) => parseNum(x ?? ''));
          if (parts.length !== 4 || step === null || degree === null || vel === null || len === null) bad = true;
          else events.push({ step: Math.round(step), degree: Math.round(degree), velocity: vel, lengthSteps: len });
        }
      }
      if (bad)
        errors.push({
          line: lineNo,
          message: kind === 'drums' ? `drum take events are step:lane:vel with lane kick|snare|hat` : `take events are step:degree:vel:len`,
        });
      else {
        player.data.frozen = true;
        player.data.frozenPattern = events;
      }
      continue;
    }

    if (head === 'scene') {
      const name = tokens[1]?.startsWith('"') ? tokens[1].slice(1, -1) : (tokens[1] ?? 'scene');
      const scene: Scene = {
        name,
        players: {},
        conductor: { keyIndex: conductor.keyIndex, scaleId: conductor.scaleId, tempo: conductor.tempo, evolveOn: false, journeyOn: false },
      };
      const { kvs } = splitParams(tokens.slice(2), lineNo, errors);
      for (const { key, value } of kvs) {
        const dot = key.indexOf('.');
        if (dot !== -1) {
          const kind = key.slice(0, dot) as PlayerKind;
          const param = key.slice(dot + 1);
          const field = PLAYER_PARAMS[param];
          if (!PLAYER_KINDS.includes(kind) || !field) {
            errors.push({ line: lineNo, message: `scene has no param "${key}"` });
            continue;
          }
          scene.players[kind] ??= {};
          scene.players[kind][field] = field === 'mute' ? parseBool(value) ?? false : parseNum(value) ?? 0;
        } else if (key === 'key') {
          const idx = NOTE_NAMES.indexOf(value.toUpperCase());
          if (idx !== -1) scene.conductor.keyIndex = idx;
        } else if (key === 'scale' && value in SCALES) scene.conductor.scaleId = value as ScaleId;
        else if (key === 'tempo') scene.conductor.tempo = Math.round(parseNum(value) ?? conductor.tempo);
        else if (key === 'evolve') scene.conductor.evolveOn = parseBool(value) ?? false;
        else if (key === 'journey') scene.conductor.journeyOn = parseBool(value) ?? false;
        else errors.push({ line: lineNo, message: `scene has no param "${key}"` });
      }
      scenes.push(scene);
      continue;
    }

    if (PLAYER_KINDS.includes(head as PlayerKind)) {
      const kind = head as PlayerKind;
      const data: Record<string, unknown> = { ...DEFAULT_PLAYER[kind] };
      const { kvs, at } = splitParams(tokens.slice(1), lineNo, errors);
      for (const { key, value } of kvs) {
        const field = PLAYER_PARAMS[key];
        if (!field) {
          errors.push({ line: lineNo, message: `${kind} has no param "${key}" (${Object.keys(PLAYER_PARAMS).join(', ')})` });
          continue;
        }
        if (field === 'mute') {
          const b = parseBool(value);
          if (b === null) errors.push({ line: lineNo, message: `mute must be on/off` });
          else data.mute = b;
        } else {
          const n = parseNum(value);
          if (n === null) errors.push({ line: lineNo, message: `${key} must be a number, got "${value}"` });
          else data[field] = field === 'seed' || field === 'register' ? Math.round(n) : n;
        }
      }
      addNode(kind, kind, data, at, lineNo);
      continue;
    }

    // id: type params
    if (head.endsWith(':')) {
      const id = head.slice(0, -1);
      const type = tokens[1];
      const { kvs, at } = splitParams(tokens.slice(2), lineNo, errors);
      const kv = (key: string) => kvs.find((x) => x.key === key)?.value;
      const num = (key: string, fallback: number) => {
        const v = kv(key);
        if (v === undefined) return fallback;
        const n = parseNum(v);
        if (n === null) {
          errors.push({ line: lineNo, message: `${key} must be a number, got "${v}"` });
          return fallback;
        }
        return n;
      };
      const known: Record<string, string[]> = {
        expression: ['portamento', 'glissando'],
        synth: ['wave', 'attack', 'release', 'cutoff'],
        kit: [],
        delay: ['time', 'feedback', 'mix'],
        reverb: ['mix'],
        lfo: ['rate', 'depth'],
        tension: ['depth'],
        motif: ['idea', 'shape'],
      };
      if (!(type in known)) {
        errors.push({ line: lineNo, message: `unknown node type "${type ?? ''}" (${Object.keys(known).join(', ')})` });
        continue;
      }
      for (const { key } of kvs) {
        if (!known[type].includes(key)) errors.push({ line: lineNo, message: `${type} has no param "${key}" (${known[type].join(', ') || 'none'})` });
      }
      let data: Record<string, unknown> = {};
      if (type === 'expression') data = { portamento: num('portamento', 0), glissando: parseBool(kv('glissando') ?? 'off') ?? false };
      else if (type === 'synth') {
        let wave = WAVES.indexOf((kv('wave') ?? 'sine').toLowerCase());
        if (wave === -1) {
          const n = parseNum(kv('wave') ?? '');
          if (n !== null && n >= 0 && n <= 3) wave = Math.round(n);
          else {
            errors.push({ line: lineNo, message: `wave must be ${WAVES.join('|')}` });
            wave = 0;
          }
        }
        data = { label: id, wave, attack: num('attack', 0.005), release: num('release', 0.4), cutoff: num('cutoff', 4000) };
      } else if (type === 'kit') data = {};
      else if (type === 'delay') {
        const div = parseDivision(kv('time') ?? '1/8d');
        if (div === null) errors.push({ line: lineNo, message: `time must be 1/8, 1/8d, or 1/4` });
        data = { division: div ?? 3, feedback: num('feedback', 0.35), mix: num('mix', 0.25) };
      } else if (type === 'reverb') data = { mix: num('mix', 0.28) };
      else if (type === 'lfo') data = { rate: num('rate', 0.5), depth: num('depth', 0.35) };
      else if (type === 'tension') data = { depth: num('depth', 0.4) };
      else if (type === 'motif') {
        const shape = (kv('shape') ?? 'arch').toLowerCase();
        if (!['arch', 'rise', 'fall', 'wave'].includes(shape))
          errors.push({ line: lineNo, message: `shape must be arch|rise|fall|wave, got "${shape}"` });
        data = { idea: Math.round(num('idea', 1)), shape: ['arch', 'rise', 'fall', 'wave'].includes(shape) ? shape : 'arch' };
      }
      addNode(id, type, data, at, lineNo);
      continue;
    }

    errors.push({ line: lineNo, message: `cannot read "${head}" — expected a node declaration, a chain (a -> b), take, scene, or section` });
  }

  // implicit nodes so minimal scripts work
  if (!ids.has('conductor')) addNode('conductor', 'conductor', {}, null, 0);
  if (!ids.has('out')) addNode('out', 'out', { level: 0 }, null, 0);

  // chains → edges
  for (const { lineNo, text: chain } of chainLines) {
    const hops = chain.split('->').map((s) => s.trim());
    for (let i = 0; i < hops.length - 1; i++) {
      const srcId = hops[i];
      let tgtId = hops[i + 1];
      let port: string | null = null;
      const dot = tgtId.indexOf('.');
      if (dot !== -1) {
        port = tgtId.slice(dot + 1);
        tgtId = tgtId.slice(0, dot);
      }
      const src = ids.get(srcId);
      const tgt = ids.get(tgtId);
      if (!src || !tgt) {
        errors.push({ line: lineNo, message: `unknown node "${!src ? srcId : tgtId}" in chain` });
        continue;
      }
      const family = EMITS[src.type as string];
      if (!family) {
        errors.push({ line: lineNo, message: `${srcId} (${src.type}) has no output to connect` });
        continue;
      }
      let sourceHandle: string, targetHandle: string, className: string;
      if (family === 'motif' || port === 'motif') {
        if (family !== 'motif') {
          errors.push({ line: lineNo, message: `only a motif node can feed ${tgtId}.motif` });
          continue;
        }
        if (tgt.type !== 'melody' || (port && port !== 'motif')) {
          errors.push({ line: lineNo, message: `${srcId} outputs a motif — patch it into the melody: ${srcId} -> melody.motif` });
          continue;
        }
        sourceHandle = 'motif-out';
        targetHandle = 'motif-in';
        className = 'edge-motif';
      } else if (family === 'cv' || port === 'density') {
        if (family !== 'cv') {
          errors.push({ line: lineNo, message: `only lfo/tension can drive ${tgtId}.density` });
          continue;
        }
        if (!PLAYER_KINDS.includes(tgt.type as PlayerKind) || (port && port !== 'density')) {
          errors.push({ line: lineNo, message: `${srcId} outputs CV — connect it to a player's density: ${srcId} -> melody.density` });
          continue;
        }
        sourceHandle = 'cv-out';
        targetHandle = 'density-in';
        className = 'edge-signal';
      } else if (family === 'notes') {
        if (!ACCEPTS_NOTES.has(tgt.type as string)) {
          errors.push({ line: lineNo, message: `${srcId} outputs notes — connect it to a synth, kit, or expression (not ${tgtId}: ${tgt.type})` });
          continue;
        }
        sourceHandle = 'notes-out';
        targetHandle = 'notes-in';
        className = 'edge-note';
      } else {
        if (!ACCEPTS_SIGNAL.has(tgt.type as string)) {
          errors.push({ line: lineNo, message: `${srcId} outputs signal — connect it to delay, reverb, or out (not ${tgtId}: ${tgt.type})` });
          continue;
        }
        sourceHandle = 'signal-out';
        targetHandle = 'signal-in';
        className = 'edge-signal';
      }
      const id = `${srcId}→${tgtId}${port ? '.' + port : ''}`;
      if (!edges.some((e) => e.id === id)) edges.push({ id, source: srcId, sourceHandle, target: tgtId, targetHandle, className });
    }
  }

  if (errors.length) return { ok: false, errors };
  conductor.liveKeyIndex = conductor.keyIndex;
  conductor.liveScaleId = conductor.scaleId;
  conductor.journeyLabel = 'home';
  return { ok: true, project: { nodes, edges, conductor, scenes } };
}
