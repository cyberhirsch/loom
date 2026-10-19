import { describe, it, expect } from 'vitest';
import { buildMidi } from './midi';
import { defaultPatch, type Patch } from '../graph/templates';
import { renderTimeline, type WireNote } from '../graph/timeline';

const withPlayer = (p: Patch, kind: string, patch: Record<string, unknown>): Patch => ({
  ...p,
  nodes: p.nodes.map((n) => (n.type === kind ? { ...n, data: { ...n.data, ...patch } } : n)),
});

/** walk one MTrk chunk: note-on ticks */
function noteOnTicks(bytes: Uint8Array, track: number): number[] {
  let offset = 14;
  const len = (o: number) => (bytes[o + 4] << 24) | (bytes[o + 5] << 16) | (bytes[o + 6] << 8) | bytes[o + 7];
  for (let t = 0; t < track; t++) offset += 8 + len(offset);
  const end = offset + 8 + len(offset);
  let i = offset + 8;
  let tick = 0;
  const onTicks: number[] = [];
  while (i < end) {
    let delta = 0;
    while (bytes[i] & 0x80) delta = (delta << 7) | (bytes[i++] & 0x7f);
    delta = (delta << 7) | bytes[i++];
    tick += delta;
    const status = bytes[i];
    if (status === 0xff) {
      i += 3 + bytes[i + 2];
    } else {
      if ((status & 0xf0) === 0x90) onTicks.push(tick);
      i += 3;
    }
  }
  return onTicks;
}

describe('MIDI export (PRD §6.10 / M4 slice)', () => {
  it('produces a well-formed type-1 SMF: tempo track + one track per sounding part', () => {
    const bars = renderTimeline(defaultPatch(), 0, 2);
    const bytes = buildMidi(bars, 102);

    // header
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    expect((bytes[8] << 8) | bytes[9]).toBe(1); // format 1
    expect((bytes[10] << 8) | bytes[11]).toBe(1 + bars[0].audible.length); // tempo + parts
    expect((bytes[12] << 8) | bytes[13]).toBe(480); // PPQ

    // walk all track chunks
    let offset = 14;
    let tracks = 0;
    while (offset < bytes.length) {
      expect(String.fromCharCode(...bytes.slice(offset, offset + 4))).toBe('MTrk');
      const len = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      // each track ends with end-of-track meta
      const end = offset + 8 + len;
      expect(bytes[end - 3]).toBe(0xff);
      expect(bytes[end - 2]).toBe(0x2f);
      offset = end;
      tracks++;
    }
    expect(tracks).toBe(1 + bars[0].audible.length);
    expect(offset).toBe(bytes.length);
  });

  it('is deterministic (same project, same file)', () => {
    const a = buildMidi(renderTimeline(defaultPatch(), 0, 4), 120);
    const b = buildMidi(renderTimeline(defaultPatch(), 0, 4), 120);
    expect(a).toEqual(b);
  });

  it('muted parts are left out', () => {
    const muted = withPlayer(defaultPatch(), 'arp', { mute: true });
    const bars = renderTimeline(muted, 0, 1);
    const bytes = buildMidi(bars, 120);
    expect((bytes[10] << 8) | bytes[11]).toBe(1 + bars[0].audible.length);
    expect(bars[0].audible).not.toContain('arp');
  });

  it('fractional bass lengths keep every note-on on the 16th grid', () => {
    for (const articulation of [0.33, 0.77]) {
      const project = withPlayer(withPlayer(defaultPatch(), 'bass', { articulation, density: 0.9, seed: 5 }), 'drums', { seed: 5, density: 0.7, syncopation: 0.5 });
      const bars = renderTimeline(project, 0, 4);
      const bass = bars.map((b) => b.patterns.bass as WireNote[]);
      expect(bass.flat().some((e) => !Number.isInteger(e.lenSteps * 120))).toBe(true);
      const bytes = buildMidi(bars, 120);
      const track = 1 + bars[0].audible.indexOf('bass');
      const expected = bass.flatMap((evs, l) => evs.map((e) => (l * bars[l].steps + e.step) * 120));
      expect(noteOnTicks(bytes, track)).toEqual(expected);
    }
  });

  it('note-ons all have matching note-offs', () => {
    const bytes = buildMidi(renderTimeline(withPlayer(defaultPatch(), 'melody', { seed: 99, density: 0.9, adventurousness: 0.7 }), 0, 1), 102);
    let on = 0;
    let off = 0;
    for (let i = 0; i < bytes.length - 2; i++) {
      if ((bytes[i] & 0xf0) === 0x90 && bytes[i + 2] > 0) on++;
      if ((bytes[i] & 0xf0) === 0x80) off++;
    }
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThanOrEqual(on); // every on has an off (off may over-count from data bytes)
  });
});
