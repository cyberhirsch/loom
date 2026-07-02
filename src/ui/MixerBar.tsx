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
  const scenes = useLoomStore((s) => s.scenes);
  const activeScene = useLoomStore((s) => s.activeScene);
  const saveScene = useLoomStore((s) => s.saveScene);
  const launchScene = useLoomStore((s) => s.launchScene);
  const deleteScene = useLoomStore((s) => s.deleteScene);

  const players = ORDER.map((kind) => nodes.find((n) => n.type === kind)).filter(Boolean);

  return (
    <div className="mixer-bar">
      <div className="scene-strip" title="Launcher scenes (PRD §6.7): snapshots of the whole ensemble, applied at the next loop boundary">
        {scenes.map((scene, i) => (
          <button
            key={i}
            className={`node-btn scene-btn${i === activeScene ? ' on' : ''}`}
            onClick={() => launchScene(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              deleteScene(i);
            }}
            title={`Launch ${scene.name} (right-click to delete)`}
          >
            ▸ {i + 1}
          </button>
        ))}
        <button className="node-btn scene-btn" onClick={saveScene} title="Snapshot the current ensemble as a scene">
          + scene
        </button>
      </div>
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
