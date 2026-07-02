import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

/** Out (IO, PRD §5.2): the master output. Only signal that reaches this node sounds. */
function OutNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const playing = useLoomStore((s) => s.playing);
  const update = useLoomStore((s) => s.updateNodeData);

  return (
    <div className={`loom-node loom-node--io${selected ? ' is-selected' : ''}`} style={{ minWidth: 160 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">◎</span>
        <span>Out</span>
        <i className={`node-status${playing ? ' node-status--live' : ''}`} />
      </header>
      <div className="loom-node__body">
        <div className="param-row">
          <label>level</label>
          <input
            className="nodrag"
            type="range"
            min={-24}
            max={0}
            step={1}
            value={Number(data.level ?? 0)}
            onChange={(e) => update(id, { level: Number(e.target.value) })}
          />
          <span className="val">{Number(data.level ?? 0)}dB</span>
        </div>
        <p className="scale-desc">master — soft-clip limiter last in chain</p>
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--input">
          <Handle type="target" id="signal-in" position={Position.Left} style={{ background: 'var(--cable-signal)' }} />
          <span className="port-symbol" style={{ color: 'var(--cable-signal)' }}>△</span>
          <span>signal</span>
        </div>
      </div>
    </div>
  );
}

export const OutNode = memo(OutNodeView);
