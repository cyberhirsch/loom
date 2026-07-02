import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

/** LFO modulator — Signal output, patch into any player's density (PRD §5.2 modular payoff). */
function LfoNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);

  return (
    <div className={`loom-node loom-node--modulator${selected ? ' is-selected' : ''}`} style={{ minWidth: 170 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">∿</span>
        <span>LFO</span>
      </header>
      <div className="loom-node__body">
        <div className="param-row">
          <label>rate</label>
          <input
            className="nodrag"
            type="range"
            min={0.1}
            max={2}
            step={0.05}
            value={Number(data.rate ?? 0.5)}
            onChange={(e) => update(id, { rate: Number(e.target.value) })}
          />
          <span className="val">{Number(data.rate ?? 0.5).toFixed(2)}</span>
        </div>
        <div className="param-row">
          <label>depth</label>
          <input
            className="nodrag"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={Number(data.depth ?? 0.35)}
            onChange={(e) => update(id, { depth: Number(e.target.value) })}
          />
          <span className="val">{Number(data.depth ?? 0.35).toFixed(2)}</span>
        </div>
        <p className="scale-desc">cycles per loop · evaluated each loop</p>
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--output">
          <span>cv</span>
          <span className="port-symbol" style={{ color: 'var(--cable-signal)' }}>△</span>
          <Handle type="source" id="cv-out" position={Position.Right} style={{ background: 'var(--cable-signal)' }} />
        </div>
      </div>
    </div>
  );
}

export const LfoNode = memo(LfoNodeView);
