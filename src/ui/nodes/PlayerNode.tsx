import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';
import { computeContext, computeBasePattern } from '../../graph/session';
import type { PlayerData, PlayerKind } from '../../graph/types';
import { PatternPreview } from '../PatternPreview';

const META: Record<PlayerKind, { icon: string; label: string }> = {
  melody: { icon: '♪', label: 'Melody' },
  chords: { icon: '♬', label: 'Chords' },
  bass: { icon: '𝄢', label: 'Bass' },
  drums: { icon: '▦', label: 'Drums' },
  arp: { icon: '≋', label: 'Arp' },
};

function Slider({
  id,
  field,
  label,
  min = 0,
  max = 1,
  step = 0.01,
  format = (v: number) => v.toFixed(2),
  modulated = false,
}: {
  id: string;
  field: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  modulated?: boolean;
}) {
  const value = useLoomStore((s) => Number(s.nodes.find((n) => n.id === id)?.data[field] ?? 0));
  const update = useLoomStore((s) => s.updateNodeData);
  return (
    <div className={`param-row${modulated ? ' is-modulated' : ''}`}>
      <label>{label}</label>
      <input
        className="nodrag"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => update(id, { [field]: Number(e.target.value) })}
      />
      <span className="val">{format(value)}</span>
    </div>
  );
}

function PlayerNodeView({ id, type, selected }: NodeProps) {
  const kind = type as PlayerKind;
  const meta = META[kind];
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const playing = useLoomStore((s) => s.playing);
  const update = useLoomStore((s) => s.updateNodeData);
  const reroll = useLoomStore((s) => s.rerollSeed);
  const effDensity = useLoomStore((s) => s.effDensity[id]);
  const densityModulated = useLoomStore((s) =>
    s.edges.some((e) => e.target === id && e.targetHandle === 'density-in'),
  );

  return (
    <div className={`loom-node loom-node--player${selected ? ' is-selected' : ''}`}>
      <header className="loom-node__header">
        <span className="loom-node__icon">{meta.icon}</span>
        <span>{meta.label}</span>
        <i className={`node-status${playing && !data.mute ? ' node-status--live' : ''}`} />
      </header>
      <div className="loom-node__body">
        <PatternPreview id={id} kind={kind} />
        <div className="node-row">
          <span className="seed-chip" title="Seed — same seed, same music">seed {String(data.seed)}</span>
          <button className="node-btn nodrag" onClick={() => reroll(id)} title="New seed, new take" disabled={Boolean(data.frozen)}>
            ↻ re-roll
          </button>
          <button
            className={`node-btn nodrag${data.frozen ? ' on' : ''}`}
            onClick={() => {
              if (data.frozen) {
                update(id, { frozen: false });
              } else {
                const s = useLoomStore.getState();
                const chordsSeed = Number(s.nodes.find((n) => n.type === 'chords')?.data.seed ?? 1);
                const take =
                  s.patterns[id] ??
                  computeBasePattern(kind, computeContext(s.conductor, chordsSeed), data as unknown as PlayerData);
                update(id, { frozen: true, frozenPattern: take });
              }
            }}
            title="Capture this take: frozen players keep their exact pattern, immune to evolve/re-generation (still transposes with the journey)"
          >
            {data.frozen ? '❄ frozen' : '❄ freeze'}
          </button>
          <button
            className={`node-btn nodrag${data.mute ? ' on' : ''}`}
            onClick={() => update(id, { mute: !data.mute })}
          >
            {data.mute ? 'muted' : 'mute'}
          </button>
        </div>
        <Slider
          id={id}
          field="density"
          label={densityModulated && effDensity !== undefined ? `density ⟿ ${effDensity.toFixed(2)}` : 'density'}
          modulated={densityModulated}
        />
        {kind === 'melody' && <Slider id={id} field="adventurousness" label="adventure" />}
        {kind === 'drums' && <Slider id={id} field="syncopation" label="syncopate" />}
        {kind !== 'drums' && (
          <Slider id={id} field="register" label="register" min={-2} max={2} step={1} format={(v) => (v > 0 ? `+${v}` : String(v))} />
        )}
        <Slider id={id} field="volume" label="volume" min={-32} max={0} step={1} format={(v) => `${v}dB`} />
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--input">
          <Handle type="target" id="density-in" position={Position.Left} style={{ background: 'var(--cable-signal)' }} />
          <span className="port-symbol" style={{ color: 'var(--cable-signal)' }}>△</span>
          <span>density</span>
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

export const PlayerNode = memo(PlayerNodeView);
