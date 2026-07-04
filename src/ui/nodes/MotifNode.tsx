import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';
import { randomSeed } from '../../theory/rng';

const SHAPES = [
  { id: 'arch', label: 'arch', hint: 'rise to one peak, then settle' },
  { id: 'rise', label: 'rise', hint: 'climb toward the end' },
  { id: 'fall', label: 'fall', hint: 'open high, sink home' },
  { id: 'wave', label: 'wave', hint: 'swell and release, twice' },
];

/** Motif — the melodic IDEA as a patchable node (PRD §5.2 expose-on-demand):
 *  idea seed (the cell) + contour shape. Patch its output into Melody's motif
 *  input; re-rolling the player then changes the TAKE but keeps the idea. */
function MotifNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const shape = String(data.shape ?? 'arch');

  return (
    <div className={`loom-node loom-node--player${selected ? ' is-selected' : ''}`} style={{ minWidth: 180 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">✎</span>
        <span>Motif</span>
      </header>
      <div className="loom-node__body">
        <div className="node-row">
          <span className="seed-chip" title="The idea — same idea, same motif">idea {String(data.idea)}</span>
          <button className="node-btn nodrag" onClick={() => update(id, { idea: randomSeed() })} title="New idea — new rhythm cell and pitch cell">
            ↻ new idea
          </button>
        </div>
        <div className="node-row">
          <select
            className="nodrag"
            value={shape}
            onChange={(e) => update(id, { shape: e.target.value })}
            aria-label="Contour shape"
            title="The theme's overall contour — where it breathes and peaks"
          >
            {SHAPES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <p className="scale-desc">{SHAPES.find((s) => s.id === shape)?.hint} · unpatched players invent their own idea</p>
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--output">
          <span>motif</span>
          <span className="port-symbol" style={{ color: 'var(--cat-player)' }}>△</span>
          <Handle type="source" id="motif-out" position={Position.Right} style={{ background: 'var(--cat-player)' }} />
        </div>
      </div>
    </div>
  );
}

export const MotifNode = memo(MotifNodeView);
