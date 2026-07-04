import { describe, it, expect, beforeEach } from 'vitest';
import { useLoomStore, DEFAULT_SCRIPT } from './store';
import { parseLoomScript, serializeProject } from '../script/loomscript';

const s = () => useLoomStore.getState();

beforeEach(() => {
  useLoomStore.getState().applyScript(DEFAULT_SCRIPT);
  useLoomStore.setState({ clipboard: null });
});

describe('addNode (catalog factory)', () => {
  it('creates non-singleton nodes with unique sequential ids', () => {
    s().addNode('synth', { x: 0, y: 0 });
    s().addNode('synth', { x: 10, y: 10 });
    const ids = s().nodes.filter((n) => n.type === 'synth').map((n) => n.id);
    expect(ids).toContain('synth1');
    expect(ids).toContain('synth2');
  });

  it('singletons no-op when the role already exists', () => {
    const before = s().nodes.length;
    s().addNode('melody', { x: 0, y: 0 }); // melody is already in the default patch
    s().addNode('out', { x: 0, y: 0 });
    expect(s().nodes.length).toBe(before);
  });

  it('every created node survives a LoomScript round-trip', () => {
    for (const type of ['synth', 'kit', 'expression', 'delay', 'reverb', 'lfo', 'tension', 'motif'] as const) {
      s().addNode(type, { x: 50, y: 50 });
    }
    const text = serializeProject(s());
    const r = parseLoomScript(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.nodes.length).toBe(s().nodes.length);
  });
});

describe('copy / cut / paste', () => {
  it('copies the selection and pastes clones with remapped inner edges', () => {
    // select the lead synth and delay1 (they are wired lead -> delay1)
    useLoomStore.setState({
      nodes: s().nodes.map((n) => (n.id === 'lead' || n.id === 'delay1' ? { ...n, selected: true } : n)),
    });
    s().copySelection();
    const before = s().nodes.length;
    s().pasteClipboard({ x: 2000, y: 0 });
    expect(s().nodes.length).toBe(before + 2);
    const pastedSynth = s().nodes.find((n) => n.id === 'synth1');
    const pastedDelay = s().nodes.find((n) => n.id === 'delay2');
    expect(pastedSynth).toBeDefined();
    expect(pastedDelay).toBeDefined();
    // the lead -> delay1 cable was cloned between the new ids
    expect(s().edges.some((e) => e.source === 'synth1' && e.target === 'delay2')).toBe(true);
    // originals untouched
    expect(s().edges.some((e) => e.source === 'lead' && e.target === 'delay1')).toBe(true);
  });

  it('cut removes nodes plus touching cables; pasting a singleton back keeps its role id', () => {
    useLoomStore.setState({
      nodes: s().nodes.map((n) => (n.id === 'melody' ? { ...n, selected: true } : n)),
    });
    s().cutSelection();
    expect(s().nodes.some((n) => n.id === 'melody')).toBe(false);
    expect(s().edges.some((e) => e.source === 'melody' || e.target === 'melody')).toBe(false);
    s().pasteClipboard();
    expect(s().nodes.some((n) => n.id === 'melody')).toBe(true);
    // but pasting again is a no-op for the singleton role
    const count = s().nodes.length;
    s().pasteClipboard();
    expect(s().nodes.length).toBe(count);
  });

  it('right-clicked node id acts as the target when nothing is selected', () => {
    s().copySelection('reverb1');
    expect(s().clipboard?.nodes.map((n) => n.id)).toEqual(['reverb1']);
    s().deleteSelection('reverb1');
    expect(s().nodes.some((n) => n.id === 'reverb1')).toBe(false);
    expect(s().edges.some((e) => e.source === 'reverb1' || e.target === 'reverb1')).toBe(false);
  });
});
