import type { Node } from '@xyflow/react';
import type { ScaleId } from '../theory/scales';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';

/** Node categories (PRD §5) — tint source for icons. */
export type NodeCategory = 'player' | 'modulator' | 'io';

export type PlayerKind = 'melody' | 'chords' | 'bass' | 'drums' | 'arp';
export type LoomNodeType = 'conductor' | 'arranger' | PlayerKind | 'lfo' | 'tension';

/** Arranger (PRD §5.2): generative structure — a sequencer of sections. */
export interface ArrangerSection {
  name: string;
  loops: number; // how many loops this section lasts
  intensity: number; // multiplies every player's density (0.4..1.4)
  journeyStop: number; // -1 = stay, 0..3 = index into the Conductor's journey
}

export interface ArrangerData extends Record<string, unknown> {
  enabled: boolean;
  sections: ArrangerSection[];
}

/** Cable types (PRD §5.1) — port colors. */
export type CableType = 'signal' | 'note' | 'transport';

export interface PlayerData extends Record<string, unknown> {
  seed: number;
  density: number; // 0..1
  adventurousness: number; // 0..1 (melody)
  syncopation: number; // 0..1 (drums)
  register: number; // octave offset from role default
  mute: boolean;
  volume: number; // dB
  /** capture/freeze (PRD §5.2): when true, frozenPattern plays verbatim, outside the generative flow */
  frozen?: boolean;
  frozenPattern?: Pattern;
}

export interface LfoData extends Record<string, unknown> {
  rate: number; // cycles per loop
  depth: number; // 0..1
}

export type LoomNode = Node<Record<string, unknown>, string>;

export interface ConductorState {
  keyIndex: number;
  scaleId: ScaleId;
  tempo: number;
  evolveOn: boolean;
  journeyOn: boolean;
  modEvery: number; // loops between journey moves
  /** live journey position (display) */
  journeyLabel: string;
  /** effective key/scale after journey (what actually sounds) */
  liveKeyIndex: number;
  liveScaleId: ScaleId;
}

export type Pattern = NoteEvent[] | DrumEvent[];
