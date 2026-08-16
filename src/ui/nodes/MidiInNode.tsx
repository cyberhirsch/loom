import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useLoomStore } from '../../graph/store';
import { enableMidi, useMidiStore } from '../../midi/midiInput';

/** MIDI Input node (PRD §6.9): a hardware MIDI/MPE controller playing into the
 *  graph's note flow. Same law as players — silent until cabled to a synth. */
function MidiInNodeView({ id, selected }: NodeProps) {
  const data = useLoomStore((s) => s.nodes.find((n) => n.id === id)?.data) ?? {};
  const update = useLoomStore((s) => s.updateNodeData);
  const supported = useMidiStore((s) => s.supported);
  const access = useMidiStore((s) => s.access);
  const inputs = useMidiStore((s) => s.inputs);
  const held = useMidiStore((s) => s.held);
  const lastEvent = useMidiStore((s) => s.lastEvent);
  const mode = data.mode === 'midi' ? 'midi' : 'mpe';

  return (
    <div className={`loom-node loom-node--player${selected ? ' is-selected' : ''}`} style={{ minWidth: 200 }}>
      <header className="loom-node__header">
        <span className="loom-node__icon" style={{ color: 'var(--cat-io)' }}>⌨</span>
        <span>MIDI In</span>
        <i className={`node-status${held > 0 ? ' node-status--live' : ''}`} />
      </header>
      <div className="loom-node__body">
        {!supported && <p className="scale-desc">this browser has no Web MIDI — use Chrome or Edge</p>}
        {supported && access !== 'granted' && (
          <div className="node-row">
            <button className="node-btn nodrag" onClick={() => void enableMidi()}>
              {access === 'denied' ? 'midi blocked — retry' : '◉ enable midi'}
            </button>
          </div>
        )}
        {access === 'granted' && (
          <>
            <div className="node-row">
              <select
                className="nodrag"
                value={String(data.device ?? '')}
                onChange={(e) => update(id, { device: e.target.value })}
                aria-label="MIDI device"
                title="Which input feeds this node — or all of them"
              >
                <option value="">all devices</option>
                {inputs.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </div>
            <div className="node-row">
              <select
                className="nodrag"
                value={mode}
                onChange={(e) => update(id, { mode: e.target.value })}
                aria-label="MIDI mode"
                title="MPE: per-note channels with glide/pressure/timbre (Seaboard, LinnStrument). MIDI: a plain keyboard."
              >
                <option value="mpe">MPE · per-note expression</option>
                <option value="midi">MIDI · plain keyboard</option>
              </select>
            </div>
            {mode === 'mpe' && (
              <div className="node-row">
                <label style={{ fontSize: 10 }}>bend range</label>
                <select
                  className="nodrag"
                  value={String(Number(data.bend) || 48)}
                  onChange={(e) => update(id, { bend: Number(e.target.value) })}
                  aria-label="Pitch-bend range"
                  title="Per-note pitch-bend range in semitones — 48 is the MPE default; match your device"
                >
                  {[2, 12, 24, 48, 96].map((b) => (
                    <option key={b} value={b}>±{b} st</option>
                  ))}
                </select>
              </div>
            )}
            <p className="scale-desc">
              {held > 0 ? `${held} note${held === 1 ? '' : 's'} held · ${lastEvent}` : lastEvent || 'waiting for notes'}
              {' · cable to a synth to sound'}
            </p>
          </>
        )}
      </div>
      <div className="loom-node__ports">
        <div className="node-port node-port--output">
          <span>notes</span>
          <span className="port-symbol" style={{ color: 'var(--cable-note)' }}>△</span>
          <Handle type="source" id="notes-out" position={Position.Right} style={{ background: 'var(--cable-note)' }} />
        </div>
      </div>
    </div>
  );
}

export const MidiInNode = memo(MidiInNodeView);
