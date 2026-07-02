import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

/**
 * Tension — the ensemble's energy curve as a CV source (PRD §5.2/§5.3):
 * the music listens to itself. Patch cv → a player's density and the loop
 * self-regulates (saturated loops breathe out, sparse loops build).
 */
function TensionNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const curve = useLoomStore((s) => s.energyCurve);

  const W = 150;
  const H = 30;
  const pts = curve.length
    ? curve.map((v, i) => `${((i + 0.5) / curve.length) * W},${(1 - v) * (H - 4) + 2}`).join(' ')
    : '';

  return (
    <div className={`loom-node loom-node--modulator${selected ? ' is-selected' : ''}`} style={{ minWidth: 170 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">☄</span>
        <span>Tension</span>
      </header>
      <div className="loom-node__body">
        <svg className="pattern-preview" style={{ height: 34 }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {pts && (
            <>
              <polygon points={`0,${H} ${pts} ${W},${H}`} fill="rgba(210,156,255,0.15)" />
              <polyline points={pts} fill="none" stroke="#d29cff" strokeWidth={1.5} />
            </>
          )}
          {!pts && <text x={W / 2} y={H / 2 + 3} textAnchor="middle" fontSize={8} fill="#4d5258">listens while weaving…</text>}
        </svg>
        <div className="param-row">
          <label>depth</label>
          <input
            className="nodrag"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={Number(data.depth ?? 0.4)}
            onChange={(e) => update(id, { depth: Number(e.target.value) })}
          />
          <span className="val">{Number(data.depth ?? 0.4).toFixed(2)}</span>
        </div>
        <p className="scale-desc">ensemble energy → cv · self-balancing when patched to density</p>
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

export const TensionNode = memo(TensionNodeView);
