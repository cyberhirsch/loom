import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';
import type { ArrangerData, ArrangerSection } from '../../graph/types';
import { buildJourney } from '../../theory/harmony';

/**
 * Arranger (PRD §5.2) — generative structure: a sequencer of sections.
 * Each section sets an intensity (scales every player's density) and can
 * advance the Conductor's journey at its boundary. The story, not the rules.
 */
function ArrangerNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) as unknown as ArrangerData | undefined;
  const update = useLoomStore((s) => s.updateNodeData);
  const activeSection = useLoomStore((s) => s.arrangerSection);
  const scaleId = useLoomStore((s) => s.conductor.scaleId);
  const playing = useLoomStore((s) => s.playing);

  if (!data) return null;
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const journey = buildJourney(scaleId);

  const patch = (idx: number, p: Partial<ArrangerSection>) =>
    update(id, { sections: sections.map((s, i) => (i === idx ? { ...s, ...p } : s)) });

  return (
    <div className={`loom-node loom-node--player${selected ? ' is-selected' : ''}`} style={{ minWidth: 250 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">▤</span>
        <span>Arranger</span>
        <i className={`node-status${playing && data.enabled ? ' node-status--live' : ''}`} />
      </header>
      <div className="loom-node__body">
        <div className="node-row">
          <button
            className={`node-btn nodrag${data.enabled ? ' on' : ''}`}
            onClick={() => update(id, { enabled: !data.enabled })}
            title="When on, the Arranger owns song structure: sections set intensity and drive the journey"
          >
            {data.enabled ? '▤ conducting' : '▤ enable'}
          </button>
          <button
            className="node-btn nodrag"
            onClick={() =>
              update(id, {
                sections: [...sections, { name: `${String.fromCharCode(65 + sections.length)} · new`, loops: 4, intensity: 1, journeyStop: -1 }],
              })
            }
          >
            + section
          </button>
        </div>
        {sections.map((section, i) => (
          <div className={`arranger-section${i === activeSection && data.enabled ? ' is-active' : ''}`} key={i}>
            <div className="node-row">
              <input
                className="nodrag arranger-name"
                value={section.name}
                onChange={(e) => patch(i, { name: e.target.value })}
              />
              <select
                className="nodrag"
                value={section.loops}
                onChange={(e) => patch(i, { loops: Number(e.target.value) })}
                title="Section length in loops"
                style={{ maxWidth: 58 }}
              >
                {[1, 2, 4, 8].map((n) => (
                  <option key={n} value={n}>{n}×</option>
                ))}
              </select>
              <button
                className="node-btn nodrag"
                onClick={() => update(id, { sections: sections.filter((_, j) => j !== i) })}
                disabled={sections.length <= 1}
                title="Remove section"
              >
                ×
              </button>
            </div>
            <div className="param-row">
              <label>intensity</label>
              <input
                className="nodrag"
                type="range"
                min={0.4}
                max={1.4}
                step={0.05}
                value={section.intensity}
                onChange={(e) => patch(i, { intensity: Number(e.target.value) })}
              />
              <span className="val">{section.intensity.toFixed(2)}</span>
            </div>
            <div className="node-row">
              <select
                className="nodrag"
                value={section.journeyStop}
                onChange={(e) => patch(i, { journeyStop: Number(e.target.value) })}
                title="Harmonic journey stop for this section"
              >
                <option value={-1}>stay home</option>
                {journey.map((stop, j) => (
                  <option key={j} value={j}>{stop.label}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <p className="scale-desc">sections loop in order · intensity scales every player's density</p>
      </div>
    </div>
  );
}

export const ArrangerNode = memo(ArrangerNodeView);
