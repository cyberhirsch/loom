import { useMemo } from 'react';
import { useLoomStore, STEPS } from '../graph/store';
import { computeContext, computeBasePattern } from '../graph/session';
import type { PlayerData, PlayerKind } from '../graph/types';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';

const W = 192;
const H = 48;

/** Mini pattern grid inside player nodes — live view of what the player is weaving. */
export function PatternPreview({ id, kind }: { id: string; kind: PlayerKind }) {
  const published = useLoomStore((s) => s.patterns[id]);
  const conductor = useLoomStore((s) => s.conductor);
  const chordsSeed = useLoomStore((s) => Number(s.nodes.find((n) => n.type === 'chords')?.data.seed ?? 1));
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) as unknown as PlayerData | undefined;
  const currentStep = useLoomStore((s) => s.currentStep);

  const pattern = useMemo(() => {
    if (data?.frozen && Array.isArray(data.frozenPattern)) return data.frozenPattern;
    if (published) return published;
    if (!data) return [];
    const ctx = computeContext(conductor, chordsSeed);
    return computeBasePattern(kind, ctx, data);
  }, [published, conductor, chordsSeed, data, kind]);

  const cw = W / STEPS;
  const cells: Array<{ x: number; y: number; h: number; v: number }> = [];
  if (kind === 'drums') {
    const laneH = H / 3;
    for (const ev of pattern as DrumEvent[]) {
      cells.push({ x: ev.step * cw, y: ev.lane * laneH, h: laneH - 1, v: ev.velocity });
    }
  } else {
    const events = pattern as NoteEvent[];
    const maxDeg = Math.max(8, ...events.map((e) => e.degree));
    const rowH = H / (maxDeg + 1);
    for (const ev of events) {
      cells.push({ x: ev.step * cw, y: H - (ev.degree + 1) * rowH, h: Math.max(2, rowH - 1), v: ev.velocity });
    }
  }

  return (
    <svg className="pattern-preview" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {Array.from({ length: STEPS / 4 + 1 }, (_, i) => (
        <line key={i} x1={i * 4 * cw} y1={0} x2={i * 4 * cw} y2={H} stroke="#1c1f22" strokeWidth={1} />
      ))}
      {currentStep >= 0 && (
        <rect x={currentStep * cw} y={0} width={cw} height={H} fill="rgba(255,255,255,0.07)" />
      )}
      {cells.map((c, i) => (
        <rect
          key={i}
          x={c.x + 0.5}
          y={c.y}
          width={cw - 1.5}
          height={c.h}
          rx={1}
          fill={kind === 'drums' ? '#8fd0b2' : '#e8b34f'}
          opacity={0.35 + c.v * 0.6}
        />
      ))}
    </svg>
  );
}
