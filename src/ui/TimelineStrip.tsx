import { useLoomStore } from '../graph/store';
import type { ArrangerData } from '../graph/types';

/**
 * Timeline view (PRD §6.6): a view over the structure node — renders the
 * Arranger's sections across time with the live song position. Not a separate
 * authority: editing structure happens on the Arranger node it visualizes.
 */
export function TimelineStrip() {
  const arranger = useLoomStore((s) => s.nodes.find((n) => n.type === 'arranger')?.data) as unknown as ArrangerData | undefined;
  const activeSection = useLoomStore((s) => s.arrangerSection);
  const loopCount = useLoomStore((s) => s.loopCount);
  const currentStep = useLoomStore((s) => s.currentStep);
  const playing = useLoomStore((s) => s.playing);
  const steps = useLoomStore((s) => Number(s.conductor.steps) || 16);

  const enabled = Boolean(arranger?.enabled) && Array.isArray(arranger?.sections) && arranger!.sections.length > 0;
  const sections = enabled ? arranger!.sections : [{ name: 'loop', loops: 1, intensity: 1, journeyStop: -1 }];
  const total = sections.reduce((a, s) => a + Math.max(1, s.loops), 0);

  // song position 0..1 across the section cycle (audible position, not the
  // engine's double-buffered lookahead)
  let pos = 0;
  let audibleSection = activeSection;
  if (playing && loopCount > 0) {
    const loopInCycle = (loopCount - 1) % total;
    pos = (loopInCycle + Math.max(0, currentStep) / steps) / total;
    let acc = 0;
    for (let i = 0; i < sections.length; i++) {
      acc += Math.max(1, sections[i].loops);
      if (loopInCycle < acc) {
        audibleSection = i;
        break;
      }
    }
  }

  return (
    <div className="timeline-strip" title="Timeline — a view over the Arranger's structure (PRD §6.6)">
      {sections.map((s, i) => (
        <div
          key={i}
          className={`timeline-block${enabled && i === (playing ? audibleSection : activeSection) ? ' is-active' : ''}`}
          style={{ flexGrow: Math.max(1, s.loops) }}
        >
          <span>{s.name}</span>
          <span className="timeline-loops">{s.loops}×</span>
        </div>
      ))}
      {playing && <div className="timeline-playhead" style={{ left: `${(pos * 100).toFixed(2)}%` }} />}
    </div>
  );
}
