/**
 * Shared session helpers: harmonic context + base pattern computation.
 * Used by both the audio engine and node previews so they always agree.
 * Harmony-first (PRD §5.2): the Chords player's seed drives the progression.
 */

import { generateProgression, progressionToSteps, type HarmonicContext } from '../theory/harmony';
import { generateMelody, type NoteEvent } from '../theory/melody';
import { generateArp, generateBass, generateChords, generateDrums, type DrumEvent } from '../theory/parts';
import type { ConductorState, PlayerData, PlayerKind } from './types';
import { STEPS } from './store';

export function computeContext(conductor: ConductorState, chordsSeed: number): HarmonicContext {
  const prog = generateProgression(chordsSeed, conductor.liveScaleId);
  return {
    keyIndex: conductor.liveKeyIndex,
    scaleId: conductor.liveScaleId,
    steps: STEPS,
    chordAtStep: progressionToSteps(prog, STEPS),
  };
}

export function computeBasePattern(
  kind: PlayerKind,
  ctx: HarmonicContext,
  data: PlayerData,
  densityOverride?: number,
): NoteEvent[] | DrumEvent[] {
  const density = densityOverride ?? data.density;
  switch (kind) {
    case 'melody':
      return generateMelody(ctx, {
        seed: data.seed,
        density,
        adventurousness: data.adventurousness,
        register: data.register,
      });
    case 'chords':
      return generateChords(ctx, { seed: data.seed, density, register: data.register });
    case 'bass':
      return generateBass(ctx, { seed: data.seed, density, register: data.register });
    case 'arp':
      return generateArp(ctx, { seed: data.seed, density, register: data.register });
    case 'drums':
      return generateDrums(ctx, { seed: data.seed, density, syncopation: data.syncopation });
  }
}

/** Role octave defaults (PRD §5.3 layers & voicing). */
export const ROLE_OCTAVE: Record<PlayerKind, number> = {
  melody: 0,
  chords: -1,
  bass: -2,
  arp: 1,
  drums: 0,
};
