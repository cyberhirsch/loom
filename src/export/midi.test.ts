import { describe, it, expect } from 'vitest';
import { buildMidi } from './midi';
import { buildContext, type HarmonicContext } from '../theory/harmony';
import { generateMelody } from '../theory/melody';
import { generateBass, generateDrums } from '../theory/parts';

function ctx(): HarmonicContext {
  return buildContext(0, 'ionian', 16, 42);
}

describe('MIDI export (PRD §6.10 / M4 slice)', () => {
  it('produces a well-formed type-1 SMF', () => {
    const c = ctx();
    const melody = generateMelody(c, { seed: 42, density: 0.6, adventurousness: 0.3, register: 0 });
    const drums = generateDrums(c, { seed: 42, density: 0.6, syncopation: 0.3 });
    const bytes = buildMidi(c, [
      { kind: 'melody', pattern: melody, register: 0 },
      { kind: 'drums', pattern: drums, register: 0 },
    ], 102, 2);

    // header
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    expect((bytes[8] << 8) | bytes[9]).toBe(1); // format 1
    expect((bytes[10] << 8) | bytes[11]).toBe(3); // tempo + 2 parts
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
    expect(tracks).toBe(3);
    expect(offset).toBe(bytes.length);
  });

  it('is deterministic (same seed, same file)', () => {
    const c = ctx();
    const melody = generateMelody(c, { seed: 7, density: 0.5, adventurousness: 0.4, register: 0 });
    const a = buildMidi(c, [{ kind: 'melody', pattern: melody, register: 0 }], 120);
    const b = buildMidi(c, [{ kind: 'melody', pattern: melody, register: 0 }], 120);
    expect(a).toEqual(b);
  });

  it('fractional bass lengths keep every note-on on the 16th grid', () => {
    const c = ctx();
    const kickSteps = generateDrums(c, { seed: 5, density: 0.7, syncopation: 0.5 }).filter((e) => e.lane === 0).map((e) => e.step);
    for (const articulation of [0.33, 0.77]) {
      const bass = generateBass(c, { seed: 5, density: 0.9, register: 0, kickSteps, articulation });
      expect(bass.some((e) => !Number.isInteger(e.lengthSteps * 120))).toBe(true);
      const loops = 4;
      const bytes = buildMidi(c, [{ kind: 'bass', pattern: bass, register: 0 }], 120, loops);
      // second MTrk = bass track; walk its events summing deltas
      let offset = 14;
      offset += 8 + ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]);
      const end = offset + 8 + ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]);
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
      const expected = Array.from({ length: loops }, (_, l) => bass.map((e) => (l * c.steps + e.step) * 120)).flat();
      expect(onTicks).toEqual(expected);
    }
  });

  it('note-ons all have matching note-offs', () => {
    const c = ctx();
    const melody = generateMelody(c, { seed: 99, density: 0.9, adventurousness: 0.7, register: 0 });
    const bytes = buildMidi(c, [{ kind: 'melody', pattern: melody, register: 0 }], 102);
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
