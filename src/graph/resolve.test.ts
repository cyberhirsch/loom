import { describe, it, expect } from 'vitest';
import { defaultPatch, templatePatch, type Patch } from './templates';
import { renderTimeline, type BarRender, type WireNote } from './timeline';
import { resolveBar } from './resolve';
import { buildMidi } from '../export/midi';
import { buildContext, chordAt, isChangeAt } from '../theory/harmony';
import { generateArp, generateBass, generateChords } from '../theory/parts';
import { generateTheme } from '../theory/motif';
import { SCALE_IDS, SCALES, parentScale, pcOf, scalePcs, type ScaleId } from '../theory/scales';
import type { PlayerKind } from './types';

type Timed = WireNote & { t: number; bar: number };

function patchFor(key: number, scaleId: ScaleId, seed: number, base: Patch = defaultPatch()): Patch {
  const p = JSON.parse(JSON.stringify(base)) as Patch;
  Object.assign(p.conductor, { keyIndex: key, liveKeyIndex: key, scaleId, liveScaleId: scaleId });
  for (const n of p.nodes) if (['melody', 'chords', 'bass', 'drums', 'arp'].includes(n.type as string)) n.data.seed = seed;
  return p;
}

function stream(bars: BarRender[], kind: PlayerKind): Timed[] {
  const out: Timed[] = [];
  let base = 0;
  bars.forEach((b, i) => {
    if (b.audible.includes(kind)) for (const n of (b.patterns[kind] ?? []) as WireNote[]) out.push({ ...n, t: base + n.step, bar: i });
    base += b.steps;
  });
  return out;
}

const at = (notes: Timed[], t: number) => notes.filter((n) => n.t <= t && t < n.t + Math.max(1, Math.ceil(n.lenSteps))).flatMap((n) => n.midis);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

describe('shared resolver: voice-led chords and fixed tessitura (12 keys × 8 scales × 9 seeds)', () => {
  const runs: Array<{ key: number; scaleId: ScaleId; bars: BarRender[] }> = [];
  for (let key = 0; key < 12; key++) for (const scaleId of SCALE_IDS) for (let seed = 1; seed <= 9; seed++) {
    runs.push({ key, scaleId, bars: renderTimeline(patchFor(key, scaleId, seed), 0, 2) });
  }

  it('chords move ≤ 4 semitones per change on average, the top voice ≤ 4 in 95%+ of changes, under the melody 98%+ of the time', () => {
    let changes = 0;
    let motion = 0;
    let smoothTop = 0;
    let both = 0;
    let under = 0;
    for (const { bars } of runs) {
      const ch = stream(bars, 'chords');
      const mel = stream(bars, 'melody');
      for (let i = 1; i < ch.length; i++) {
        const a = [...ch[i - 1].midis].sort((x, y) => x - y);
        const b = [...ch[i].midis].sort((x, y) => x - y);
        if (a.join() === b.join()) continue;
        changes++;
        a.forEach((m, v) => (motion += Math.abs(m - b[v])));
        if (Math.abs(a[a.length - 1] - b[b.length - 1]) <= 4) smoothTop++;
      }
      for (let t = 0; t < 32; t++) {
        const c = at(ch, t);
        const m = at(mel, t);
        if (!c.length || !m.length) continue;
        both++;
        if (Math.max(...c) < Math.min(...m)) under++;
      }
    }
    expect(motion / changes).toBeLessThanOrEqual(4);
    expect(smoothTop / changes).toBeGreaterThanOrEqual(0.95);
    expect(under / both).toBeGreaterThanOrEqual(0.98);
  });

  it('bass in E1..D3, roots on the changes in G1..G2, never at or above the pad', () => {
    for (const { bars } of runs) {
      const bass = stream(bars, 'bass');
      const pad = stream(bars, 'chords');
      for (const n of bass) {
        expect(n.midis[0]).toBeGreaterThanOrEqual(28);
        expect(n.midis[0]).toBeLessThanOrEqual(50);
        const ctx = bars[n.bar].ctx;
        if (isChangeAt(ctx, n.step) && pcOf(n.midis[0]) === chordAt(ctx, n.step).rootPc) {
          expect(n.midis[0]).toBeGreaterThanOrEqual(31);
          expect(n.midis[0]).toBeLessThanOrEqual(43);
        }
      }
      for (let t = 0; t < 32; t++) {
        const b = at(bass, t);
        const c = at(pad, t);
        if (b.length && c.length) expect(Math.max(...b)).toBeLessThan(Math.min(...c));
      }
    }
  });

  it('arp in C5..A6, melody median between E4 and E5 in every key', () => {
    const byKey: number[][] = Array.from({ length: 12 }, () => []);
    for (const { key, bars } of runs) {
      for (const n of stream(bars, 'arp')) expect(n.midis[0] >= 72 && n.midis[0] <= 93).toBe(true);
      byKey[key].push(...stream(bars, 'melody').map((n) => n.midis[0]));
    }
    for (const notes of byKey) {
      expect(median(notes)).toBeGreaterThanOrEqual(64);
      expect(median(notes)).toBeLessThanOrEqual(76);
    }
  });

  it('everything stays in key: the parent mode for chords and bass (bar flagged approach tones), the live scale for melody and arp', () => {
    for (const { key, scaleId, bars } of runs.filter((_, i) => i % 3 === 0)) {
      const live = new Set(scalePcs(key, scaleId));
      const parent = new Set(scalePcs(key, parentScale(scaleId)));
      for (const kind of ['melody', 'arp'] as const) for (const n of stream(bars, kind)) expect(live.has(pcOf(n.midis[0]))).toBe(true);
      for (const n of stream(bars, 'chords')) for (const m of n.midis) expect(parent.has(pcOf(m))).toBe(true);
      for (const n of stream(bars, 'bass')) expect(parent.has(pcOf(n.midis[0]))).toBe(true);
    }
  });

  it('the techno peak keeps its bass roots at G2 or below, in every key', () => {
    for (let key = 0; key < 12; key++) {
      const bars = renderTimeline(patchFor(key, 'minor_pent', 1 + key, templatePatch('techno')), 0, 14);
      const peak = bars.filter((b) => b.sectionId === 2);
      expect(peak.length).toBe(4);
      for (const b of peak) {
        const roots = ((b.patterns.bass ?? []) as WireNote[]).filter((n) => isChangeAt(b.ctx, n.step) && pcOf(n.midis[0]) === chordAt(b.ctx, n.step).rootPc);
        expect(roots.length).toBeGreaterThan(0);
        for (const n of roots) expect(n.midis[0]).toBeLessThanOrEqual(43);
      }
    }
  });
});

describe('arp octaves', () => {
  it('a two-octave run sounds wider than a one-octave run (resolved MIDI), in C5..A7; octaves=1 is the default take in C5..A6', () => {
    let span1 = 0;
    let span2 = 0;
    for (let key = 0; key < 12; key++) {
      for (const scaleId of SCALE_IDS) {
        for (let seed = 1; seed <= 6; seed++) {
          const ctx = buildContext(key, scaleId, 16, seed);
          const one = generateArp(ctx, { seed, density: 0.9, register: 0 });
          expect(generateArp(ctx, { seed, density: 0.9, register: 0, octaves: 1 })).toEqual(one);
          const two = generateArp(ctx, { seed, density: 0.9, register: 0, octaves: 2 });
          const midis1 = resolveBar({ ctx, parts: { arp: one } }).notes.arp!.map((n) => n.midis[0]);
          const midis2 = resolveBar({ ctx, parts: { arp: two }, arpOctaves: 2 }).notes.arp!.map((n) => n.midis[0]);
          for (const m of midis1) expect(m >= 72 && m <= 93).toBe(true);
          for (const m of midis2) expect(m >= 72 && m <= 105).toBe(true);
          span1 += Math.max(...midis1) - Math.min(...midis1);
          span2 += Math.max(...midis2) - Math.min(...midis2);
        }
      }
    }
    expect(span2).toBeGreaterThan(span1 * 1.3);
  });
});

describe('resolveBar', () => {
  const ctx = buildContext(3, 'dorian', 16, 42);
  const parts = {
    melody: generateTheme(ctx, { seed: 1, density: 0.6, adventurousness: 0.4 }),
    chords: generateChords(ctx, { seed: 2, density: 0.5, register: 0 }),
    bass: generateBass(ctx, { seed: 3, density: 0.6, register: 0 }),
    arp: generateArp(ctx, { seed: 4, density: 0.5, register: 0 }),
  };

  it('is pure: same input, same output', () => {
    expect(resolveBar({ ctx, parts })).toEqual(resolveBar({ ctx, parts }));
  });

  it('register moves a role by whole octaves of its window', () => {
    const base = resolveBar({ ctx, parts }).notes;
    const up = resolveBar({ ctx, parts, register: { melody: 1, arp: -1 } }).notes;
    expect(up.melody!.map((n) => n.midis[0] - 12)).toEqual(base.melody!.map((n) => n.midis[0]));
    for (const n of up.arp!) expect(n.midis[0] >= 60 && n.midis[0] <= 81).toBe(true);
  });

  it('the melody keeps its own intervals exactly', () => {
    const m = resolveBar({ ctx, parts }).notes.melody!.map((n) => n.midis[0]);
    const iv = SCALES.dorian.intervals;
    const semis = (d: number) => iv[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    parts.melody.forEach((e, i) => expect(m[i] - m[0]).toBe(semis(e.degree) - semis(parts.melody[0].degree)));
  });

  it('carries its state: a bar of the same phrase continues from where the previous one ended', () => {
    const first = resolveBar({ ctx, parts });
    expect(first.state.chords).toEqual(first.notes.chords![first.notes.chords!.length - 1].midis);
    const next = resolveBar({ ctx, parts, prev: first.state });
    expect(next.state.bassRoot).not.toBeNull();
    expect(next.notes.chords!.length).toBe(first.notes.chords!.length);
  });
});

describe('exports play the resolved timeline', () => {
  it('MIDI notes equal the timeline notes, arranger, journey and arp included', () => {
    const project = templatePatch('techno');
    const bars = renderTimeline(project, 0, 14);
    const bytes = buildMidi(bars, project.conductor.tempo);
    const tracks = new Map<string, number[]>();
    let offset = 14;
    while (offset < bytes.length) {
      const len = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      const end = offset + 8 + len;
      let i = offset + 8;
      let name = '';
      const ons: number[] = [];
      while (i < end) {
        while (bytes[i] & 0x80) i++;
        i++;
        if (bytes[i] === 0xff) {
          if (bytes[i + 1] === 0x03) name = String.fromCharCode(...bytes.slice(i + 3, i + 3 + bytes[i + 2]));
          i += 3 + bytes[i + 2];
        } else {
          if ((bytes[i] & 0xf0) === 0x90) ons.push(bytes[i + 1]);
          i += 3;
        }
      }
      tracks.set(name, ons);
      offset = end;
    }
    for (const kind of ['chords', 'bass', 'arp'] as const) {
      const expected = stream(bars, kind).flatMap((n) => n.midis);
      expect([...tracks.get(kind)!].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
    }
  });
});
