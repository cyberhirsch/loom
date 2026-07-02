/**
 * Energy/tension curve (PRD §5.3): descriptive contour of the loop —
 * register height, chord-tone stability, chords add body, decay between hits.
 * In Loom it is a CV source, not just a display (PRD §5.2 modular payoff).
 */

import { SCALES, isChordTone } from './scales';
import type { HarmonicContext } from './harmony';
import type { NoteEvent } from './melody';
import type { DrumEvent } from './parts';

export function computeEnergyCurve(
  ctx: HarmonicContext,
  pitched: NoteEvent[][],
  drums: DrumEvent[] | null,
): number[] {
  const scaleLen = SCALES[ctx.scaleId].intervals.length;
  const curve = new Array<number>(ctx.steps).fill(0);
  let carry = 0;
  for (let s = 0; s < ctx.steps; s++) {
    let v = 0;
    let hit = false;
    for (const events of pitched) {
      for (const ev of events) {
        if (ev.step !== s) continue;
        hit = true;
        const height = Math.min(1, ev.degree / (scaleLen * 1.5));
        const stable = isChordTone(ev.degree, ctx.chordAtStep[s], scaleLen);
        v += 0.4 + height * 0.6 + (stable ? 0.1 : 0.5);
      }
    }
    if (drums) {
      for (const ev of drums) {
        if (ev.step === s) {
          hit = true;
          v += ev.lane === 0 ? 0.5 : ev.lane === 1 ? 0.4 : 0.15;
        }
      }
    }
    carry = hit ? v : carry * 0.6;
    curve[s] = Math.max(0, carry);
  }
  const max = Math.max(1, ...curve);
  return curve.map((x) => x / max);
}

/** Collapse a curve to one scalar per loop (for loop-boundary CV). */
export function energyScalar(curve: number[]): number {
  if (!curve.length) return 0;
  return curve.reduce((a, b) => a + b, 0) / curve.length;
}
