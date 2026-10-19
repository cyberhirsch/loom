/**
 * Shared session helpers: harmonic context + base pattern computation,
 * composed into bars by the timeline (src/graph/timeline.ts).
 * Harmony-first (PRD §5.2): the Chords player's seed drives the progression.
 */

import { buildContext, CHORD_COLOURS, type ChordColour, type HarmonicContext } from '../theory/harmony';
import type { NoteEvent } from '../theory/melody';
import { generateTheme, type Shape } from '../theory/motif';
import { generateArp, generateBass, generateChords, generateDrums, type DrumEvent } from '../theory/parts';
import type { ConductorState, LoomNode, MotifData, PlayerData, PlayerKind } from './types';
import type { Edge } from '@xyflow/react';

export function computeContext(conductor: ConductorState, chordsSeed: number, colour?: unknown): HarmonicContext {
  const steps = Number(conductor.steps) || 16;
  return buildContext(conductor.liveKeyIndex, conductor.liveScaleId, steps, chordsSeed, chordColourOf(colour));
}

/** A Chords node's colour, falling back to plain triads for absent or unknown values. */
export function chordColourOf(colour: unknown): ChordColour {
  return CHORD_COLOURS.includes(colour as ChordColour) ? (colour as ChordColour) : 'triad';
}

/** The Motif node feeding a player's motif input, if any (PRD §5.2 expose-on-demand). */
export function motifForPlayer(nodes: LoomNode[], edges: Edge[], playerId: string): MotifData | null {
  const edge = edges.find((e) => e.target === playerId && e.targetHandle === 'motif-in');
  if (!edge) return null;
  const node = nodes.find((n) => n.id === edge.source && n.type === 'motif');
  return node ? (node.data as unknown as MotifData) : null;
}

export interface PatternOpts {
  densityOverride?: number;
  /** patched Motif node — pins the idea independent of the take seed */
  motif?: MotifData | null;
  /** evolve depth for the theme grammar (melody) */
  generation?: number;
  /** the drum part's kick steps, which the bass locks to — generate drums first */
  kickSteps?: readonly number[];
}

export function kickStepsOf(drums: readonly DrumEvent[]): number[] {
  return drums.filter((e) => e.lane === 0).map((e) => e.step);
}

export function computeBasePattern(
  kind: PlayerKind,
  ctx: HarmonicContext,
  data: PlayerData,
  opts: PatternOpts = {},
): NoteEvent[] | DrumEvent[] {
  const density = opts.densityOverride ?? data.density;
  switch (kind) {
    case 'melody':
      return generateTheme(ctx, {
        seed: data.seed,
        density,
        adventurousness: data.adventurousness,
        ideaSeed: opts.motif ? Number(opts.motif.idea) : undefined,
        shape: opts.motif ? (opts.motif.shape as Shape) : undefined,
        generation: opts.generation ?? 0,
      });
    case 'chords':
      return generateChords(ctx, { seed: data.seed, density, register: data.register });
    case 'bass':
      return generateBass(ctx, {
        seed: data.seed,
        density,
        register: data.register,
        kickSteps: opts.kickSteps,
        articulation: data.articulation,
      });
    case 'arp':
      return generateArp(ctx, { seed: data.seed, density, register: data.register, octaves: data.octaves });
    case 'drums':
      return generateDrums(ctx, { seed: data.seed, density, syncopation: data.syncopation });
  }
}
