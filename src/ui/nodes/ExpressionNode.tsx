import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

/** Expression (Note FX, PRD §5.2): shapes notes on their way to an instrument.
 *  Portamento glides pitch between notes; glissando runs the scale into leaps
 *  (scale-locked — the run can never leave the key). */
function ExpressionNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const portamento = Number(data.portamento ?? 0);

  return (
    <div className={`loom-node loom-node--notefx${selected ? ' is-selected' : ''}`} style={{ minWidth: 180 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">〜</span>
        <span>Expression</span>
      </header>
      <div className="loom-node__body">
        <div className="param-row">
          <label>portamento</label>
          <input
            className="nodrag"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={portamento}
            onChange={(e) => update(id, { portamento: Number(e.target.value) })}
          />
          <span className="val">{portamento === 0 ? 'off' : `${(portamento * 300).toFixed(0)}ms`}</span>
        </div>
        <div className="node-row">
          <button
            className={`node-btn nodrag${data.glissando ? ' on' : ''}`}
            onClick={() => update(id, { glissando: !data.glissando })}
            title="Run the scale into leaps of 3+ degrees — always in key"
          >
            {data.glissando ? '≋ glissando on' : '≋ glissando'}
          </button>
        </div>
        <p className="scale-desc">portamento glides pitch · glissando runs the scale into leaps</p>
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--input">
          <Handle type="target" id="notes-in" position={Position.Left} style={{ background: 'var(--cable-note)' }} />
          <span className="port-symbol" style={{ color: 'var(--cable-note)' }}>△</span>
          <span>notes</span>
        </div>
        <div className="node-port node-port--output">
          <span>notes</span>
          <span className="port-symbol" style={{ color: 'var(--cable-note)' }}>△</span>
          <Handle type="source" id="notes-out" position={Position.Right} style={{ background: 'var(--cable-note)' }} />
        </div>
      </div>
    </div>
  );
}

export const ExpressionNode = memo(ExpressionNodeView);
