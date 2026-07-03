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
import { SynthNode } from '../ui/nodes/SynthNode';
import { ExpressionNode } from '../ui/nodes/ExpressionNode';
import { FxNode } from '../ui/nodes/FxNode';
import { OutNode } from '../ui/nodes/OutNode';
import { MixerBar } from '../ui/MixerBar';
import { TimelineStrip } from '../ui/TimelineStrip';
import { ScriptPanel } from '../ui/ScriptPanel';
import { useState } from 'react';
import type { TemplateId } from '../graph/store';
import { NOTE_NAMES, SCALES } from '../theory/scales';
import { forgetFileHandle, openLoomFile, saveLoomFile, supportsFileSystemAccess } from '../io/fileIO';

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
  synth: SynthNode,
  kit: SynthNode,
  expression: ExpressionNode,
  delay: FxNode,
  reverb: FxNode,
  out: OutNode,
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
  const scriptText = useLoomStore((s) => s.scriptText);
  const applyScript = useLoomStore((s) => s.applyScript);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [fileStatus, setFileStatus] = useState('');

  const flash = (msg: string) => {
    setFileStatus(msg);
    setTimeout(() => setFileStatus(''), 2000);
  };

  const handleSave = async () => {
    const result = await saveLoomFile(scriptText());
    if (result === 'saved') flash('saved ✓');
  };

  const handleLoad = async () => {
    const picked = await openLoomFile();
    if (!picked) return;
    const errors = applyScript(picked.text);
    if (errors) flash(`${picked.name}: line ${errors[0].line} — ${errors[0].message}`);
    else flash(`loaded ${picked.name} ✓`);
  };

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
        <span className="brand">Loom</span>
        <button className={`play-btn${playing ? ' on' : ''}`} onClick={() => (playing ? engine.stop() : void engine.start())}>
          {playing ? '■ stop' : '▶ weave'}
        </button>
        <button className="play-btn" onClick={() => addModulator('lfo')} title="Add an LFO modulator">+ lfo</button>
        <button className="play-btn" onClick={() => addModulator('tension')} title="Add a Tension (ensemble energy) CV source">+ tension</button>
        <button className="play-btn" onClick={exportMidi} title="Export the current loop (4 repeats) as a Standard MIDI File">↧ midi</button>
        <button className="play-btn" onClick={() => void bounceWav(4)} title="Bounce the current loop (4 repeats) to WAV — offline render through the WASM DSP, faster than real time">↧ wav</button>
        <button
          className="play-btn"
          onClick={() => void handleSave()}
          title={`Save the patch as a .loom file (LoomScript)${supportsFileSystemAccess ? ' — pick where, re-save overwrites it' : ' — downloads (this browser lacks the File System Access API)'}`}
        >
          ↧ save
        </button>
        <button className="play-btn" onClick={() => void handleLoad()} title="Open a .loom file and load it as the patch">↥ load</button>
        <button
          className="play-btn"
          onClick={() => {
            forgetFileHandle();
            resetProject();
          }}
          title="Discard saved project, restore default patch"
        >
          reset
        </button>
        <button
          className={`play-btn${scriptOpen ? ' on' : ''}`}
          onClick={() => setScriptOpen(!scriptOpen)}
          title="The whole patch as LoomScript text — readable and editable by you or any LLM"
        >
          ⟨⟩ script
        </button>
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
          {fileStatus && <span className="file-status">{fileStatus}</span>}
          <span>
            <b>{NOTE_NAMES[conductor.liveKeyIndex]} {SCALES[conductor.liveScaleId].name}</b> · {conductor.tempo} bpm
          </span>
          <span>theory-aware generative music</span>
        </div>
      </div>
      <div className="graph-canvas" style={{ position: 'relative' }}>
        <TimelineStrip />
        <MixerBar />
        {scriptOpen && <ScriptPanel onClose={() => setScriptOpen(false)} />}
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
