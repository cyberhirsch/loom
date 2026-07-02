import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';

const WAVES = ['sine', 'triangle', 'square', 'saw'];

/** Synth / Kit (Source, PRD §5.2): the instrument — notes in, signal out.
 *  Players make notes; nothing sounds until they reach one of these. */
function SynthNodeView({ id, type, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const isKit = type === 'kit';

  return (
    <div className={`loom-node loom-node--source${selected ? ' is-selected' : ''}`} style={{ minWidth: 180 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon">{isKit ? '◇' : '◈'}</span>
        <span>{isKit ? 'Kit' : `Synth · ${String(data.label ?? '')}`}</span>
      </header>
      <div className="loom-node__body">
        {isKit ? (
          <p className="scale-desc">synthesized drum kit — swept-sine kick, noise snare &amp; hat</p>
        ) : (
          <>
            <div className="node-row">
              <select
                className="nodrag"
                value={Number(data.wave ?? 0)}
                onChange={(e) => update(id, { wave: Number(e.target.value) })}
                title="Oscillator waveform"
              >
                {WAVES.map((w, i) => (
                  <option key={w} value={i}>{w}</option>
                ))}
              </select>
            </div>
            <div className="param-row">
              <label>attack</label>
              <input
                className="nodrag"
                type="range"
                min={0.001}
                max={0.3}
                step={0.001}
                value={Number(data.attack ?? 0.005)}
                onChange={(e) => update(id, { attack: Number(e.target.value) })}
              />
              <span className="val">{(Number(data.attack ?? 0.005) * 1000).toFixed(0)}ms</span>
            </div>
            <div className="param-row">
              <label>release</label>
              <input
                className="nodrag"
                type="range"
                min={0.05}
                max={2}
                step={0.01}
                value={Number(data.release ?? 0.4)}
                onChange={(e) => update(id, { release: Number(e.target.value) })}
              />
              <span className="val">{Number(data.release ?? 0.4).toFixed(2)}s</span>
            </div>
            <div className="param-row">
              <label>cutoff</label>
              <input
                className="nodrag"
                type="range"
                min={200}
                max={8000}
                step={50}
                value={Number(data.cutoff ?? 4000)}
                onChange={(e) => update(id, { cutoff: Number(e.target.value) })}
              />
              <span className="val">{(Number(data.cutoff ?? 4000) / 1000).toFixed(1)}k</span>
            </div>
          </>
        )}
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--input">
          <Handle type="target" id="notes-in" position={Position.Left} style={{ background: 'var(--cable-note)' }} />
          <span className="port-symbol" style={{ color: 'var(--cable-note)' }}>△</span>
          <span>notes</span>
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

export const SynthNode = memo(SynthNodeView);
