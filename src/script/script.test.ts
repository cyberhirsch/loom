import { describe, it, expect } from 'vitest';
import { parseLoomScript, serializeProject } from './loomscript';
import { DEFAULT_SCRIPT } from '../graph/store';

function parseOrThrow(text: string) {
  const r = parseLoomScript(text);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return r.project;
}

describe('LoomScript (the save format — PRD prerequisite)', () => {
  it('parses the default patch and round-trips losslessly', () => {
    const p1 = parseOrThrow(DEFAULT_SCRIPT);
    const text1 = serializeProject(p1);
    const p2 = parseOrThrow(text1);
    const text2 = serializeProject(p2);
    // serialize∘parse is idempotent: the script is a fixed point
    expect(text2).toBe(text1);
    // and semantically lossless (edge order may normalize)
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(p2.nodes).toEqual(p1.nodes);
    expect([...p2.edges].sort(byId)).toEqual([...p1.edges].sort(byId));
    expect(p2.conductor).toEqual(p1.conductor);
  });

  it('keeps every node and cable of the default ensemble', () => {
    const p = parseOrThrow(DEFAULT_SCRIPT);
    const types = p.nodes.map((n) => n.type).sort();
    expect(types).toEqual(
      ['arp', 'arranger', 'bass', 'chords', 'conductor', 'delay', 'drums', 'expression', 'kit', 'lfo', 'melody', 'out', 'reverb', 'synth', 'synth', 'synth', 'synth'].sort(),
    );
    expect(p.edges).toHaveLength(14);
    const lfoEdge = p.edges.find((e) => e.targetHandle === 'density-in');
    expect(lfoEdge?.source).toBe('lfo1');
    expect(lfoEdge?.target).toBe('melody');
  });

  it('round-trips frozen takes (melody and drums)', () => {
    const script = `
melody seed=7 density=0.5
take melody 0:2:0.9:2 4:5:0.75:1 12:0:1:4
drums seed=9
take drums 0:kick:1 4:snare:0.9 6:hat:0.5
lead: synth
kit1: kit
melody -> lead -> out
drums -> kit1 -> out
`;
    const p1 = parseOrThrow(script);
    const melody = p1.nodes.find((n) => n.type === 'melody')!;
    expect(melody.data.frozen).toBe(true);
    expect(melody.data.frozenPattern).toEqual([
      { step: 0, degree: 2, velocity: 0.9, lengthSteps: 2 },
      { step: 4, degree: 5, velocity: 0.75, lengthSteps: 1 },
      { step: 12, degree: 0, velocity: 1, lengthSteps: 4 },
    ]);
    const drums = p1.nodes.find((n) => n.type === 'drums')!;
    expect(drums.data.frozenPattern).toEqual([
      { step: 0, lane: 0, velocity: 1 },
      { step: 4, lane: 1, velocity: 0.9 },
      { step: 6, lane: 2, velocity: 0.5 },
    ]);
    // survives serialize → parse
    const p2 = parseOrThrow(serializeProject(p1));
    expect(p2.nodes.find((n) => n.type === 'melody')!.data.frozenPattern).toEqual(melody.data.frozenPattern);
    expect(p2.nodes.find((n) => n.type === 'drums')!.data.frozenPattern).toEqual(drums.data.frozenPattern);
  });

  it('round-trips scenes', () => {
    const p1 = parseOrThrow(DEFAULT_SCRIPT);
    p1.scenes.push({
      name: 'verse',
      players: { melody: { density: 0.3, mute: false, seed: 101 }, drums: { density: 0.8, mute: true } },
      conductor: { keyIndex: 2, scaleId: 'lydian', tempo: 74, evolveOn: true, journeyOn: false },
    });
    const p2 = parseOrThrow(serializeProject(p1));
    expect(p2.scenes).toHaveLength(1);
    expect(p2.scenes[0].name).toBe('verse');
    expect(p2.scenes[0].conductor).toEqual(p1.scenes[0].conductor);
    expect(p2.scenes[0].players.melody).toEqual({ density: 0.3, mute: false, seed: 101 });
    expect(p2.scenes[0].players.drums).toEqual({ density: 0.8, mute: true });
  });

  it('a minimal LLM-written script works: positions auto-laid-out, defaults filled', () => {
    const p = parseOrThrow(`
conductor key=D scale=dorian tempo=90
melody seed=42
lead: synth wave=saw
melody -> lead -> out
`);
    expect(p.conductor.keyIndex).toBe(2);
    expect(p.conductor.scaleId).toBe('dorian');
    const melody = p.nodes.find((n) => n.type === 'melody')!;
    expect(melody.data.density).toBe(0.55); // role default
    expect(Number.isFinite(melody.position.x)).toBe(true);
    const lead = p.nodes.find((n) => n.type === 'synth')!;
    expect(lead.data.wave).toBe(3);
    expect(p.nodes.some((n) => n.type === 'out')).toBe(true); // implicit
    expect(p.edges).toHaveLength(2);
    expect(p.edges[0]).toMatchObject({ source: 'melody', target: 'lead', sourceHandle: 'notes-out', targetHandle: 'notes-in' });
    expect(p.edges[1]).toMatchObject({ source: 'lead', target: 'out', sourceHandle: 'signal-out', targetHandle: 'signal-in' });
  });

  it('accepts unit suffixes: 4ms, 5.2k', () => {
    const p = parseOrThrow(`
lead: synth attack=4ms cutoff=5.2k
`);
    const lead = p.nodes.find((n) => n.type === 'synth')!;
    expect(lead.data.attack).toBeCloseTo(0.004);
    expect(lead.data.cutoff).toBe(5200);
  });

  it('reports typed-cable mistakes with line numbers and guidance', () => {
    const r = parseLoomScript(`melody seed=1
delay1: delay
melody -> delay1
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].line).toBe(3);
      expect(r.errors[0].message).toContain('outputs notes');
      expect(r.errors[0].message).toContain('synth');
    }
  });

  it('rejects unknown nodes in chains, duplicate ids, unknown params', () => {
    const bad1 = parseLoomScript(`melody -> ghost`);
    expect(bad1.ok).toBe(false);
    const bad2 = parseLoomScript(`lead: synth\nlead: synth`);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.errors[0].message).toContain('duplicate');
    const bad3 = parseLoomScript(`melody speed=9`);
    expect(bad3.ok).toBe(false);
    if (!bad3.ok) expect(bad3.errors[0].message).toContain('no param "speed"');
  });

  it('arranger sections and journey stops survive the trip', () => {
    const p1 = parseOrThrow(`
arranger on
section "groove" loops=4 intensity=0.8
section "peak" loops=2 intensity=1.3 journey=1
melody seed=1
lead: synth
melody -> lead -> out
`);
    const arr = p1.nodes.find((n) => n.type === 'arranger')!;
    expect(arr.data.enabled).toBe(true);
    const p2 = parseOrThrow(serializeProject(p1));
    expect(p2.nodes.find((n) => n.type === 'arranger')!.data.sections).toEqual([
      { name: 'groove', loops: 4, intensity: 0.8, journeyStop: -1 },
      { name: 'peak', loops: 2, intensity: 1.3, journeyStop: 1 },
    ]);
  });
});
