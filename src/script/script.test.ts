import { describe, it, expect } from 'vitest';
import { LOOMSCRIPT_VERSION, parseLoomScript, serializeProject } from './loomscript';
import { degreeToMidi, parentScale, SCALE_IDS } from '../theory/scales';
import { DEFAULT_SCRIPT } from '../graph/store';
import { renderTimeline, type WireNote } from '../graph/timeline';

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

  it('synth decay/sustain are optional: old lines stay byte-identical, new keys round-trip', () => {
    const oldLine = 'pad: synth wave=sine attack=0.1 release=1.3 cutoff=3400 @ 1250,270';
    const pOld = parseOrThrow(oldLine);
    const pad = pOld.nodes.find((n) => n.type === 'synth')!;
    expect('decay' in pad.data).toBe(false);
    expect('sustain' in pad.data).toBe(false);
    expect(serializeProject(pOld).split('\n')).toContain(oldLine);

    const newLine = 'lead: synth wave=triangle attack=0.004 decay=0.25 sustain=0.45 release=0.12 cutoff=5200 @ 1250,20';
    const pNew = parseOrThrow(newLine);
    const lead = pNew.nodes.find((n) => n.type === 'synth')!;
    expect(lead.data).toMatchObject({ attack: 0.004, decay: 0.25, sustain: 0.45, release: 0.12 });
    const text = serializeProject(pNew);
    expect(text.split('\n')).toContain(newLine);
    expect(parseOrThrow(text).nodes.find((n) => n.type === 'synth')!.data).toEqual(lead.data);

    // one key without the other, in any order, with units
    const pHalf = parseOrThrow('sub: synth release=60ms sustain=0.5 @ 0,0');
    const sub = pHalf.nodes.find((n) => n.type === 'synth')!;
    expect(sub.data.sustain).toBe(0.5);
    expect(sub.data.release).toBeCloseTo(0.06);
    expect('decay' in sub.data).toBe(false);
    expect(parseOrThrow(serializeProject(pHalf)).nodes.find((n) => n.type === 'synth')!.data).toEqual(sub.data);
  });

  it('bass artic is optional: old bass lines stay byte-identical, the new key round-trips', () => {
    const oldLine = 'bass seed=303 density=0.5 register=0 volume=-10 @ 700,520';
    const pOld = parseOrThrow(oldLine);
    expect('articulation' in pOld.nodes[0].data).toBe(false);
    expect(serializeProject(pOld).split('\n')).toContain(oldLine);

    const newLine = 'bass seed=733 density=0.75 artic=0.5 register=0 volume=-8 @ 700,520';
    const pNew = parseOrThrow(newLine);
    expect(pNew.nodes[0].data.articulation).toBe(0.5);
    const text = serializeProject(pNew);
    expect(text.split('\n')).toContain(newLine);
    expect(parseOrThrow(text).nodes.find((n) => n.type === 'bass')!.data).toEqual(pNew.nodes[0].data);
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

  it('midiin round-trips: device with spaces, mode, bend, and its note chain', () => {
    const p1 = parseOrThrow(`
midiin device="Seaboard RISE 2" mode=mpe bend=48
lead: synth wave=triangle
midiin -> lead -> out
`);
    const midi = p1.nodes.find((n) => n.type === 'midiin')!;
    expect(midi.data).toEqual({ device: 'Seaboard RISE 2', mode: 'mpe', bend: 48 });
    const chain = p1.edges.find((e) => e.source === 'midiin')!;
    expect(chain.sourceHandle).toBe('notes-out');
    expect(chain.target).toBe('lead');
    const p2 = parseOrThrow(serializeProject(p1));
    expect(p2.nodes.find((n) => n.type === 'midiin')!.data).toEqual(midi.data);
    expect(p2.edges.some((e) => e.source === 'midiin' && e.target === 'lead')).toBe(true);
    // typed cable law still holds: midiin emits notes, not signal
    const bad = parseLoomScript(`midiin\nmidiin -> out`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].message).toContain('outputs notes');
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


  it('chords colour is optional: old chords lines stay byte-identical, the new key round-trips, bad values are rejected', () => {
    const oldLine = 'chords seed=202 density=0.5 register=0 volume=-16 @ 700,270';
    const pOld = parseOrThrow(oldLine);
    expect('colour' in pOld.nodes[0].data).toBe(false);
    expect(serializeProject(pOld).split('\n')).toContain(oldLine);
    for (const colour of ['triad', '7th', 'quartal']) {
      const line = `chords seed=202 density=0.5 register=0 volume=-16 colour=${colour} @ 700,270`;
      const p = parseOrThrow(line);
      expect(p.nodes[0].data.colour).toBe(colour);
      expect(serializeProject(p).split('\n')).toContain(line);
    }
    const bad = parseLoomScript('chords colour=jazz');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].message).toContain('triad|7th|quartal');
    expect(parseLoomScript('melody colour=quartal').ok).toBe(false);
  });

  it(`writes LoomScript v${LOOMSCRIPT_VERSION}, refuses newer documents, and v2 parse∘serialize is the identity`, () => {
    const text = serializeProject(parseOrThrow(DEFAULT_SCRIPT));
    expect(text.split('\n')[1]).toBe(`loom ${LOOMSCRIPT_VERSION}`);
    const v2 = [
      'loom 2',
      'conductor key=C scale=minor_pent tempo=102 phrase=16',
      'bass seed=303',
      'take bass 0:0:0.95:4 4:5:0.7:2 8:-1:0.8:4',
      'chords seed=202 colour=quartal',
      'take chords 0:0:0.8:4 4:5:0.8:4',
      'sub: synth',
      'pad: synth',
      'bass -> sub -> out',
      'chords -> pad -> out',
    ].join('\n');
    const once = serializeProject(parseOrThrow(v2));
    expect(serializeProject(parseOrThrow(once))).toBe(once);
    // v2 takes are read verbatim (no migration)
    expect(parseOrThrow(v2).nodes.find((n) => n.type === 'bass')!.data.frozenPattern).toEqual([
      { step: 0, degree: 0, velocity: 0.95, lengthSteps: 4 },
      { step: 4, degree: 5, velocity: 0.7, lengthSteps: 2 },
      { step: 8, degree: -1, velocity: 0.8, lengthSteps: 4 },
    ]);
    const newer = parseLoomScript(`loom ${LOOMSCRIPT_VERSION + 1}\nmelody seed=1`);
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.errors[0].message).toContain(`v${LOOMSCRIPT_VERSION + 1}`);
  });

  it('v1 migration: pentatonic bass/chords takes move to parent-mode degrees of the same pitches, deterministically', () => {
    for (const scaleId of SCALE_IDS) {
      const v1 = [
        'loom 1',
        `conductor key=D scale=${scaleId} tempo=90 phrase=16`,
        'melody seed=1',
        'take melody 0:2:0.9:2 4:4:0.7:2',
        'bass seed=3',
        'take bass 0:0:0.95:3 3:-1:0.7:1 4:2:0.8:4 8:4:0.8:4 12:7:0.8:4',
        'chords seed=2',
        'take chords 0:0:0.8:4 4:3:0.8:4 8:4:0.8:8',
        'lead: synth',
        'sub: synth',
        'pad: synth',
        'melody -> lead -> out',
        'bass -> sub -> out',
        'chords -> pad -> out',
      ].join('\n');
      const a = parseOrThrow(v1);
      expect(parseOrThrow(v1)).toEqual(a);
      const parent = parentScale(scaleId);
      const unmigrated = parseOrThrow(v1.replace('loom 1', 'loom 2'));
      for (const kind of ['bass', 'chords']) {
        const before = unmigrated.nodes.find((n) => n.type === kind)!.data.frozenPattern as Array<{ degree: number }>;
        const after = a.nodes.find((n) => n.type === kind)!.data.frozenPattern as Array<{ degree: number }>;
        after.forEach((e, i) => expect(degreeToMidi(2, parent, e.degree)).toBe(degreeToMidi(2, scaleId, before[i].degree)));
        if (parent === scaleId) expect(after).toEqual(before);
      }
      // the melody's live-scale degrees are untouched
      expect(a.nodes.find((n) => n.type === 'melody')!.data.frozenPattern).toEqual(
        unmigrated.nodes.find((n) => n.type === 'melody')!.data.frozenPattern,
      );
      // a migrated document is written as v2 and is then a fixed point
      const text = serializeProject(a);
      expect(text.split('\n')[1]).toBe('loom 2');
      expect(serializeProject(parseOrThrow(text))).toBe(text);
      expect(parseOrThrow(text).nodes).toEqual(a.nodes);
    }
  });

  it('chords spread and arp octaves are optional keys that round-trip; bad values are rejected', () => {
    for (const spread of ['close', 'open', 'rootless']) {
      const line = `chords seed=202 density=0.5 register=0 volume=-16 spread=${spread} @ 700,270`;
      const p = parseOrThrow(line);
      expect(p.nodes[0].data.spread).toBe(spread);
      expect(serializeProject(p).split('\n')).toContain(line);
    }
    for (const octaves of [1, 2]) {
      const line = `arp seed=505 density=0.45 register=0 volume=-14 octaves=${octaves} @ 700,-230`;
      const p = parseOrThrow(line);
      expect(p.nodes[0].data.octaves).toBe(octaves);
      expect(serializeProject(p).split('\n')).toContain(line);
    }
    expect('octaves' in parseOrThrow('arp seed=5').nodes[0].data).toBe(false);
    expect(parseLoomScript('chords spread=wide').ok).toBe(false);
    expect(parseLoomScript('arp octaves=3').ok).toBe(false);
    expect(parseLoomScript('melody spread=open').ok).toBe(false);
    expect(parseLoomScript('bass octaves=2').ok).toBe(false);
  });

  it('v1 migration: the arp register drops by one (the v1 default 1 becomes 0); v2 registers read verbatim', () => {
    const arpOf = (text: string) => parseOrThrow(text).nodes.find((n) => n.type === 'arp')!.data.register;
    expect(arpOf('loom 1\narp seed=5')).toBe(0);
    expect(arpOf('loom 1\narp seed=5 register=1')).toBe(0);
    expect(arpOf('loom 1\narp seed=5 register=2')).toBe(1);
    expect(arpOf('loom 1\narp seed=5 register=0')).toBe(-1);
    expect(arpOf('loom 1\narp seed=5 register=-2')).toBe(-2);
    expect(parseOrThrow('loom 1\nmelody seed=1 register=1').nodes[0].data.register).toBe(1);
    expect(arpOf('loom 2\narp seed=5 register=1')).toBe(1);
    expect(arpOf('arp seed=5')).toBe(0);
    const v1 = 'loom 1\narp seed=5 register=2 volume=-14 @ 700,-230';
    expect(parseOrThrow(v1)).toEqual(parseOrThrow(v1));
    const text = serializeProject(parseOrThrow(v1));
    expect(text).toContain('arp seed=5 density=0.45 register=1 volume=-14 @ 700,-230');
    expect(serializeProject(parseOrThrow(text))).toBe(text);
  });

  it('v1 migration reaches scenes: a scene arp register drops by one, and launching it keeps the arp in C5..A6', () => {
    const v1 = DEFAULT_SCRIPT.replace('loom 2', 'loom 1').replace('arp    seed=505', 'arp    seed=505 register=1') +
      'scene "s1" key=C scale=minor_pent tempo=100 evolve=off journey=off arp.register=1 arp.density=0.9\n' +
      'scene "s2" key=C scale=minor_pent tempo=100 evolve=off journey=off arp.register=2 melody.density=0.3\n' +
      'scene "s3" key=C scale=minor_pent tempo=100 evolve=off journey=off melody.density=0.3\n';
    const p = parseOrThrow(v1);
    expect(p.nodes.find((n) => n.type === 'arp')!.data.register).toBe(0);
    expect(p.scenes.map((s) => s.players.arp?.register)).toEqual([0, 1, undefined]);
    expect(parseOrThrow(v1)).toEqual(p);
    // launch s1 the way the store does: merge the scene's player fields into the node
    const launched = { ...p, nodes: p.nodes.map((n) => (p.scenes[0].players[n.id] ? { ...n, data: { ...n.data, ...p.scenes[0].players[n.id] } } : n)) };
    const arp = renderTimeline(launched, 0, 4).flatMap((b) => (b.audible.includes('arp') ? ((b.patterns.arp ?? []) as WireNote[]) : []));
    expect(arp.length).toBeGreaterThan(0);
    for (const n of arp) expect(n.midis[0] >= 72 && n.midis[0] <= 93).toBe(true);
    // saved back as v2, the migrated scenes read verbatim
    const text = serializeProject(p);
    expect(text).toContain('arp.register=0 arp.density=0.9');
    expect(serializeProject(parseOrThrow(text))).toBe(text);
    expect(parseOrThrow(text).scenes).toEqual(p.scenes);
  });

  it('scenes carry chords colour/spread and arp octaves, validated, and round-trip', () => {
    const line = 'scene "wide" key=D scale=dorian tempo=90 evolve=on journey=off chords.colour=7th chords.spread=open chords.density=0.4 arp.octaves=2';
    const p = parseOrThrow(`chords seed=1\narp seed=2\n${line}`);
    expect(p.scenes[0].players).toEqual({ chords: { colour: '7th', spread: 'open', density: 0.4 }, arp: { octaves: 2 } });
    expect(serializeProject(p).split('\n')).toContain(line);
    expect(serializeProject(parseOrThrow(serializeProject(p)))).toBe(serializeProject(p));
    expect(parseLoomScript('scene "x" chords.spread=wide').ok).toBe(false);
    expect(parseLoomScript('scene "x" arp.octaves=3').ok).toBe(false);
    expect(parseLoomScript('scene "x" melody.colour=7th').ok).toBe(false);
    // a scene snapshot taken in the app holds the full node data: role params survive a save and reload
    const snap = { ...p, scenes: [{ ...p.scenes[0], players: { chords: { seed: 1, colour: 'quartal', spread: 'rootless', label: 'x' }, arp: { seed: 2, octaves: 1 } } }] };
    expect(parseOrThrow(serializeProject(snap)).scenes[0].players).toEqual({ chords: { seed: 1, colour: 'quartal', spread: 'rootless' }, arp: { seed: 2, octaves: 1 } });
  });
});
