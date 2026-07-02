import type { Node } from '@xyflow/react';
import type { ScaleId } from '../theory/scales';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';

/** Node categories (PRD §5) — tint source for icons. */
export type NodeCategory = 'player' | 'source' | 'notefx' | 'fx' | 'modulator' | 'io';

export type PlayerKind = 'melody' | 'chords' | 'bass' | 'drums' | 'arp';
export type LoomNodeType =
  | 'conductor'
  | 'arranger'
  | PlayerKind
  | 'lfo'
  | 'tension'
  | 'synth'
  | 'kit'
  | 'expression'
  | 'delay'
  | 'reverb'
  | 'out';

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

/** Synth node (Source, PRD §5.2): notes in → signal out. Timbre of one player's voice bank. */
export interface SynthData extends Record<string, unknown> {
  label: string;
  wave: number; // 0 sine, 1 triangle, 2 square, 3 saw
  attack: number; // seconds
  release: number; // seconds
  cutoff: number; // Hz
}

/** Expression node (Note FX, PRD §5.2): portamento + scale-locked glissando. */
export interface ExpressionData extends Record<string, unknown> {
  portamento: number; // 0..1 → glide time
  glissando: boolean; // scale-run into leaps
}

export interface DelayData extends Record<string, unknown> {
  division: number; // delay time in steps (2 = 1/8, 3 = dotted 1/8, 4 = 1/4)
  feedback: number; // 0..0.85
  mix: number; // wet return 0..0.6
}

export interface ReverbData extends Record<string, unknown> {
  mix: number; // wet return 0..0.6
}

export interface OutData extends Record<string, unknown> {
  level: number; // dB
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
