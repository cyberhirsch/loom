import { describe, it, expect } from 'vitest';
import { DEFAULT_SCRIPT } from './defaultScript';
import { parseLoomScript } from '../script/loomscript';
import { defaultPatch, templatePatch, type Patch } from './templates';
import { renderTimeline, Timeline, type TimelineProject } from './timeline';
import { useLoomStore } from './store';
import { WasmEngine, type EnginePort } from '../audio/wasmEngine';
import { mixMessages, routingMessages } from './routing';

// node:fs without @types/node in the app tsconfig
const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (p: URL, enc: string) => string };

interface Golden {
  setup: Array<Record<string, unknown>>;
  bars: string[];
  head: unknown[];
}
/** First recorded from the pre-timeline WasmEngine (refreshLoop) driven headless for 64 loops; re-recorded
 *  when the shared resolver moved every role into its pitch window (rhythms, velocities and lengths unchanged). */
const GOLDEN = JSON.parse(readFileSync(new URL('./__fixtures__/timeline-golden.json', import.meta.url), 'utf8')) as Record<string, Golden>;

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v);

function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const hashBar = (patterns: unknown) => cyrb53(canonical(patterns));

function scriptPatch(text: string): Patch {
  const r = parseLoomScript(text);
  if (!r.ok) throw new Error('bad script');
  return { nodes: r.project.nodes, edges: r.project.edges, conductor: r.project.conductor };
}

const SCENARIOS: Record<string, () => Patch> = {
  default: () => defaultPatch(),
  ambient: () => templatePatch('ambient'),
  lofi: () => templatePatch('lofi'),
  techno: () => templatePatch('techno'),
  'default-evolve-journey': () => scriptPatch(DEFAULT_SCRIPT.replace('evolve=off journey=off', 'evolve=on journey=on')),
  'default-32-evolve': () => scriptPatch(DEFAULT_SCRIPT.replace('phrase=16 evolve=off', 'phrase=32 evolve=on')),
};

const BARS = 64;

/** A headless engine fed the worklet's loop echoes: every message it posts. */
function liveMessages(project: TimelineProject, bars: number): Array<Record<string, unknown>> {
  useLoomStore.setState({ nodes: project.nodes, edges: project.edges, conductor: project.conductor, patterns: {}, effDensity: {} });
  const msgs: Array<Record<string, unknown>> = [];
  const port: EnginePort = { postMessage: (m) => msgs.push(JSON.parse(JSON.stringify(m))), onmessage: null };
  const engine = new WasmEngine();
  engine.connectPort(port);
  engine.startTransport();
  for (let b = 0; b < bars - 1; b++) port.onmessage!({ data: { type: 'loop', loop: b + 1, absBar: b } });
  return msgs;
}

describe('timeline golden: renderTimeline equals the recorded engine output, event for event', () => {
  for (const [name, make] of Object.entries(SCENARIOS)) {
    it(`${name}: ${BARS} bars`, () => {
      const golden = GOLDEN[name];
      const bars = renderTimeline(make(), 0, BARS);
      expect(bars.slice(0, golden.head.length).map((b) => b.patterns)).toEqual(golden.head);
      expect(bars.map((b) => hashBar(b.patterns))).toEqual(golden.bars);
    });

    it(`${name}: the live engine posts the same bars and the same routing`, () => {
      const golden = GOLDEN[name];
      const project = make();
      const msgs = liveMessages(project, BARS);
      const bars = msgs.filter((m) => m.type === 'patterns');
      expect(bars.map((m) => m.absBar)).toEqual(Array.from({ length: BARS }, (_, i) => i));
      expect(bars.map((m) => hashBar(m.patterns))).toEqual(golden.bars);
      // the old engine's start sent its mix + routing; the transport start now sends tempo/steps first
      const setup = msgs.slice(0, msgs.findIndex((m) => m.type === 'patterns'));
      expect(setup.slice(0, 2).map((m) => m.type)).toEqual(['tempo', 'steps']);
      expect(setup.slice(2)).toEqual(golden.setup);
      expect([...mixMessages(project.nodes), ...routingMessages(project.nodes, project.edges).messages]).toEqual(golden.setup);
    });
  }
});

describe('timeline determinism', () => {
  it('random access equals sequential playback (stateful and stateless timelines)', () => {
    for (const make of Object.values(SCENARIOS)) {
      const seq = renderTimeline(make(), 0, 40).map((b) => hashBar(b.patterns));
      const t = new Timeline(make());
      for (const n of [37, 3, 39, 0, 12, 12, 25]) expect(hashBar(t.renderBar(n).patterns)).toBe(seq[n]);
    }
  });

  it('same project, same output; moving nodes or changing volumes does not re-render', () => {
    const a = templatePatch('ambient');
    const b = templatePatch('ambient');
    b.nodes = b.nodes.map((n) => ({ ...n, position: { x: n.position.x + 10, y: 0 }, data: n.type === 'bass' ? { ...n.data, volume: -3 } : n.data }));
    expect(new Timeline(a).signature).toBe(new Timeline(b).signature);
    expect(renderTimeline(a, 0, 8).map((x) => hashBar(x.patterns))).toEqual(new Array(8).fill(0).map((_, i) => hashBar(new Timeline(b).renderBar(i).patterns)));
  });

  it('a musical edit is a different timeline', () => {
    const a = defaultPatch();
    const b = defaultPatch();
    b.nodes = b.nodes.map((n) => (n.type === 'melody' ? { ...n, data: { ...n.data, seed: 9 } } : n));
    expect(new Timeline(a).signature).not.toBe(new Timeline(b).signature);
  });

  it('bar facts: the arranger section and journey key belong to the bar', () => {
    const techno = renderTimeline(templatePatch('techno'), 0, 14);
    expect(techno.map((b) => b.sectionId)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    // peak sits on journey stop 1 (the bright fifth: G major pentatonic), breakdown on stop 2
    expect(techno[8].keyIndex).toBe(7);
    expect(techno[8].scaleId).toBe('major_pent');
    expect(techno[12].keyIndex).toBe(9);
    const journey = renderTimeline(SCENARIOS['default-evolve-journey'](), 0, 9);
    expect(journey.map((b) => b.keyIndex)).toEqual([0, 0, 0, 0, 7, 7, 7, 7, 9]);
    expect(journey.every((b) => b.sectionId === -1)).toBe(true);
  });

  it('unrouted parts stay out of the bar; muted parts are posted but not audible', () => {
    const p = templatePatch('lofi');
    const bar = renderTimeline(p, 0, 1)[0];
    expect(bar.patterns.arp).toBeDefined();
    expect(bar.audible).not.toContain('arp');
    const cut = { ...p, edges: p.edges.filter((e) => !(e.source === 'bass')) };
    const bar2 = renderTimeline(cut, 0, 1)[0];
    expect(bar2.patterns.bass).toBeUndefined();
    expect(bar2.parts.bass).toBeDefined();
  });

  it('glissando grace notes are part of the rendered melody', () => {
    const bars = renderTimeline(defaultPatch(), 0, 1);
    const graced = bars[0].patterns.melody as Array<{ vel: number }>;
    const theory = bars[0].parts.melody;
    expect(graced.length).toBeGreaterThan(theory.length);
  });
});
