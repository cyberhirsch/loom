import { useLoomStore } from '../graph/store';
import type { PlayerKind } from '../graph/types';

const ORDER: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];
const ICON: Record<PlayerKind, string> = { melody: '♪', chords: '♬', bass: '𝄢', drums: '▦', arp: '≋' };

/**
 * Mixer view (PRD §6.8): channel strips derived from the graph — one strip per
 * player node, editing the same store the canvas edits (bidirectional by construction).
 */
export function MixerBar() {
  const nodes = useLoomStore((s) => s.nodes);
  const update = useLoomStore((s) => s.updateNodeData);
  const playing = useLoomStore((s) => s.playing);

  const players = ORDER.map((kind) => nodes.find((n) => n.type === kind)).filter(Boolean);

  return (
    <div className="mixer-bar">
      {players.map((node) => {
        const kind = node!.type as PlayerKind;
        const data = node!.data;
        return (
          <div className={`mixer-strip${data.mute ? ' is-muted' : ''}`} key={node!.id}>
            <span className="mixer-strip__name">
              <i className={`node-status${playing && !data.mute ? ' node-status--live' : ''}`} />
              {ICON[kind]} {kind}
              {data.frozen ? ' ❄' : ''}
            </span>
            <input
              type="range"
              min={-32}
              max={0}
              step={1}
              value={Number(data.volume ?? -8)}
              onChange={(e) => update(node!.id, { volume: Number(e.target.value) })}
              title={`${data.volume} dB`}
            />
            <button
              className={`node-btn${data.mute ? ' on' : ''}`}
              onClick={() => update(node!.id, { mute: !data.mute })}
            >
              M
            </button>
          </div>
        );
      })}
    </div>
  );
}
