import { ReactFlow, Background, Controls, MiniMap, BackgroundVariant } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLoomStore } from '../graph/store';
import { engine } from '../audio/wasmEngine';
import { computeContext, computeBasePattern } from '../graph/session';
import { buildMidi, downloadMidi, type MidiPart } from '../export/midi';
import { bounceWav } from '../export/wav';
import type { PlayerData, PlayerKind } from '../graph/types';
import { ConductorNode } from '../ui/nodes/ConductorNode';
import { ArrangerNode } from '../ui/nodes/ArrangerNode';
import { PlayerNode } from '../ui/nodes/PlayerNode';
import { LfoNode } from '../ui/nodes/LfoNode';
import { TensionNode } from '../ui/nodes/TensionNode';
import { MixerBar } from '../ui/MixerBar';
import { TimelineStrip } from '../ui/TimelineStrip';
import type { TemplateId } from '../graph/store';
import { NOTE_NAMES, SCALES } from '../theory/scales';

const nodeTypes = {
  conductor: ConductorNode,
  arranger: ArrangerNode,
  melody: PlayerNode,
  chords: PlayerNode,
  bass: PlayerNode,
  drums: PlayerNode,
  arp: PlayerNode,
  lfo: LfoNode,
  tension: TensionNode,
};

export function App() {
  const nodes = useLoomStore((s) => s.nodes);
  const edges = useLoomStore((s) => s.edges);
  const onNodesChange = useLoomStore((s) => s.onNodesChange);
  const onEdgesChange = useLoomStore((s) => s.onEdgesChange);
  const onConnect = useLoomStore((s) => s.onConnect);
  const playing = useLoomStore((s) => s.playing);
  const conductor = useLoomStore((s) => s.conductor);
  const addModulator = useLoomStore((s) => s.addModulator);
  const resetProject = useLoomStore((s) => s.resetProject);
  const applyTemplate = useLoomStore((s) => s.applyTemplate);

  const exportMidi = () => {
    const s = useLoomStore.getState();
    const chordsNode = s.nodes.find((n) => n.type === 'chords');
    const ctx = computeContext(s.conductor, chordsNode ? Number(chordsNode.data.seed) : 1);
    const kinds: PlayerKind[] = ['melody', 'chords', 'bass', 'drums', 'arp'];
    const parts: MidiPart[] = [];
    for (const node of s.nodes) {
      if (!kinds.includes(node.type as PlayerKind) || node.data.mute) continue;
      const kind = node.type as PlayerKind;
      const pattern = s.patterns[node.id] ?? computeBasePattern(kind, ctx, node.data as unknown as PlayerData);
      parts.push({ kind, pattern, register: Number(node.data.register ?? 0) });
    }
    downloadMidi(buildMidi(ctx, parts, s.conductor.tempo, 4), 'loom-loop.mid');
  };

  return (
    <div className="app-shell">
      <div className="top-bar">
        <span className="brand">LOOM <em>M0</em></span>
        <button className={`play-btn${playing ? ' on' : ''}`} onClick={() => (playing ? engine.stop() : void engine.start())}>
          {playing ? '■ stop' : '▶ weave'}
        </button>
        <button className="play-btn" onClick={() => addModulator('lfo')} title="Add an LFO modulator">+ lfo</button>
        <button className="play-btn" onClick={() => addModulator('tension')} title="Add a Tension (ensemble energy) CV source">+ tension</button>
        <button className="play-btn" onClick={exportMidi} title="Export the current loop (4 repeats) as a Standard MIDI File">↧ midi</button>
        <button className="play-btn" onClick={() => void bounceWav(4)} title="Bounce the current loop (4 repeats) to WAV — offline render through the WASM DSP, faster than real time">↧ wav</button>
        <button className="play-btn" onClick={resetProject} title="Discard saved project, restore default patch">reset</button>
        <select
          className="template-select"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) applyTemplate(e.target.value as TemplateId);
            e.target.value = '';
          }}
          title="Ensemble templates — a patch already set up to play"
        >
          <option value="" disabled>ensembles…</option>
          <option value="ambient">Ambient garden</option>
          <option value="lofi">Lo-fi trio</option>
          <option value="techno">Techno engine</option>
        </select>
        <div className="top-info">
          <span>
            <b>{NOTE_NAMES[conductor.liveKeyIndex]} {SCALES[conductor.liveScaleId].name}</b> · {conductor.tempo} bpm
          </span>
          <span>theory-aware generative prototype — PRD M0</span>
        </div>
      </div>
      <div className="graph-canvas" style={{ position: 'relative' }}>
        <TimelineStrip />
        <MixerBar />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          minZoom={0.3}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1e2126" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="#26292d" maskColor="rgba(10,11,12,0.7)" />
        </ReactFlow>
      </div>
    </div>
  );
}
