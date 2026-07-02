import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';
import { NOTE_NAMES, SCALES, SCALE_IDS, type ScaleId } from '../../theory/scales';

/**
 * Conductor — the ambient "rules of the room" (PRD §5.2): key, scale, tempo, groove.
 * No cables: every player reads it implicitly (§5.1 ambient-global).
 * M0 also hosts the Evolve/Journey loop behaviors here.
 */
function ConductorNodeView({ selected }: NodeProps) {
  const conductor = useLoomStore((s) => s.conductor);
  const update = useLoomStore((s) => s.updateConductor);
  const playing = useLoomStore((s) => s.playing);
  const loopCount = useLoomStore((s) => s.loopCount);

  return (
    <div className={`loom-node loom-node--player${selected ? ' is-selected' : ''}`} style={{ minWidth: 230 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">◈</span>
        <span>Conductor</span>
        <i className={`node-status${playing ? ' node-status--live' : ''}`} />
      </header>
      <div className="loom-node__body">
        <div className="node-row">
          <select
            className="nodrag"
            value={conductor.keyIndex}
            onChange={(e) => update({ keyIndex: Number(e.target.value) })}
            aria-label="Key"
            style={{ maxWidth: 64 }}
          >
            {NOTE_NAMES.map((n, i) => (
              <option key={n} value={i}>{n}</option>
            ))}
          </select>
          <select
            className="nodrag"
            value={conductor.scaleId}
            onChange={(e) => update({ scaleId: e.target.value as ScaleId })}
            aria-label="Scale"
          >
            {SCALE_IDS.map((sid) => (
              <option key={sid} value={sid}>{SCALES[sid].name}</option>
            ))}
          </select>
        </div>
        <p className="scale-desc">{SCALES[conductor.scaleId].desc}</p>
        <div className="param-row">
          <label>tempo</label>
          <input
            className="nodrag"
            type="range"
            min={60}
            max={170}
            step={1}
            value={conductor.tempo}
            onChange={(e) => update({ tempo: Number(e.target.value) })}
          />
          <span className="val">{conductor.tempo}</span>
        </div>
        <div className="node-row">
          <button
            className={`node-btn nodrag${conductor.evolveOn ? ' on' : ''}`}
            onClick={() => update({ evolveOn: !conductor.evolveOn })}
            title="Coach-guided mutation on every loop"
          >
            ✶ evolve
          </button>
          <button
            className={`node-btn nodrag${conductor.journeyOn ? ' on' : ''}`}
            onClick={() => update({ journeyOn: !conductor.journeyOn })}
            title="Travel through related keys over time"
          >
            ⇅ journey
          </button>
          <select
            className="nodrag"
            value={conductor.modEvery}
            onChange={(e) => update({ modEvery: Number(e.target.value) })}
            aria-label="Journey every N loops"
            style={{ maxWidth: 82 }}
          >
            {[2, 4, 8].map((n) => (
              <option key={n} value={n}>every {n}</option>
            ))}
          </select>
        </div>
        <div className="node-row" style={{ justifyContent: 'space-between' }}>
          <span className="journey-label">
            {NOTE_NAMES[conductor.liveKeyIndex]} {SCALES[conductor.liveScaleId].name} — {conductor.journeyLabel}
          </span>
          <span className="val">loop {loopCount}</span>
        </div>
      </div>
    </div>
  );
}

export const ConductorNode = memo(ConductorNodeView);
