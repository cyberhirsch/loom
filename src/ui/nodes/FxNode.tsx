import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

const DIVISIONS = [
  { value: 2, label: '1/8' },
  { value: 3, label: '1/8 dotted' },
  { value: 4, label: '1/4' },
];

/** FX processors (PRD §5.2): Delay (tempo-synced ping-pong) and Reverb. */
function FxNodeView({ id, type, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const isDelay = type === 'delay';

  return (
    <div className={`loom-node loom-node--fx${selected ? ' is-selected' : ''}`} style={{ minWidth: 180 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">{isDelay ? '⟲' : '≡'}</span>
        <span>{isDelay ? 'Delay' : 'Reverb'}</span>
      </header>
      <div className="loom-node__body">
        {isDelay && (
          <>
            <div className="node-row">
              <select
                className="nodrag"
                value={Number(data.division ?? 3)}
                onChange={(e) => update(id, { division: Number(e.target.value) })}
                title="Echo time, synced to tempo"
              >
                {DIVISIONS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
            <div className="param-row">
              <label>feedback</label>
              <input
                className="nodrag"
                type="range"
                min={0}
                max={0.85}
                step={0.01}
                value={Number(data.feedback ?? 0.35)}
                onChange={(e) => update(id, { feedback: Number(e.target.value) })}
              />
              <span className="val">{Number(data.feedback ?? 0.35).toFixed(2)}</span>
            </div>
          </>
        )}
        <div className="param-row">
          <label>mix</label>
          <input
            className="nodrag"
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={Number(data.mix ?? 0.25)}
            onChange={(e) => update(id, { mix: Number(e.target.value) })}
          />
          <span className="val">{Number(data.mix ?? 0.25).toFixed(2)}</span>
        </div>
        <p className="scale-desc">{isDelay ? 'ping-pong echo, synced to the loop' : 'shared room — freeverb-lite'}</p>
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--input">
          <Handle type="target" id="signal-in" position={Position.Left} style={{ background: 'var(--cable-signal)' }} />
          <span className="port-symbol" style={{ color: 'var(--cable-signal)' }}>△</span>
          <span>signal</span>
        </div>
        <div className="node-port node-port--output">
          <span>signal</span>
          <span className="port-symbol" style={{ color: 'var(--cable-signal)' }}>△</span>
          <Handle type="source" id="signal-out" position={Position.Right} style={{ background: 'var(--cable-signal)' }} />
        </div>
      </div>
    </div>
  );
}

export const FxNode = memo(FxNodeView);
