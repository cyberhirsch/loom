import { describe, it, expect } from 'vitest';
import { MpeParser } from './mpe';

/** MIDI status byte helpers (channel is 0-based here) */
const noteOn = (ch: number, note: number, vel: number) => [0x90 | ch, note, vel] as const;
const noteOff = (ch: number, note: number) => [0x80 | ch, note, 0] as const;
const bend = (ch: number, value14: number) => [0xe0 | ch, value14 & 0x7f, (value14 >> 7) & 0x7f] as const;
const pressure = (ch: number, v: number) => [0xd0 | ch, v, 0] as const;
const cc = (ch: number, num: number, v: number) => [0xb0 | ch, num, v] as const;

describe('MpeParser', () => {
  it('opens and closes a note on its member channel', () => {
    const p = new MpeParser();
    const on = p.feedBytes(noteOn(1, 60, 100));
    expect(on).toHaveLength(1);
    expect(on[0].type).toBe('noteOn');
    expect(on[0].note.midiNote).toBe(60);
    expect(on[0].note.velocity).toBeCloseTo(100 / 127);
    expect(p.notes).toHaveLength(1);

    const off = p.feedBytes(noteOff(1, 60));
    expect(off[0].type).toBe('noteOff');
    expect(p.notes).toHaveLength(0);
  });

  it('treats note-on with velocity 0 as note-off', () => {
    const p = new MpeParser();
    p.feedBytes(noteOn(2, 64, 90));
    const off = p.feedBytes(noteOn(2, 64, 0));
    expect(off[0].type).toBe('noteOff');
    expect(p.notes).toHaveLength(0);
  });

  it('per-note pitch bend glides only that channel’s note (microtonal float pitch)', () => {
    const p = new MpeParser({ bendRange: 48 });
    p.feedBytes(noteOn(1, 60, 100));
    p.feedBytes(noteOn(2, 67, 100));
    // full upward bend on channel 1 only
    const ev = p.feedBytes(bend(1, 16383));
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe('update');
    expect(ev[0].note.channel).toBe(1);
    // +48 semitones at the top of the range (within one LSB)
    expect(ev[0].note.expression.bendSemitones).toBeCloseTo(48, 1);
    expect(ev[0].note.pitch).toBeCloseTo(108, 1);
    // channel 2's note is untouched
    const other = p.notes.find((n) => n.channel === 2)!;
    expect(other.expression.bendSemitones).toBe(0);
    expect(other.pitch).toBe(67);
  });

  it('centre bend is zero; bend range scales', () => {
    const p = new MpeParser({ bendRange: 2 });
    p.feedBytes(noteOn(1, 60, 100));
    p.feedBytes(bend(1, 8192)); // centre
    expect(p.notes[0].expression.bendSemitones).toBeCloseTo(0, 5);
    p.feedBytes(bend(1, 0)); // full down
    expect(p.notes[0].expression.bendSemitones).toBeCloseTo(-2, 3);
  });

  it('channel pressure → Z and CC74 → timbre, per note', () => {
    const p = new MpeParser();
    p.feedBytes(noteOn(3, 62, 80));
    p.feedBytes(pressure(3, 127));
    p.feedBytes(cc(3, 74, 64));
    const note = p.notes[0];
    expect(note.expression.pressure).toBeCloseTo(1);
    expect(note.expression.timbre).toBeCloseTo(64 / 127);
  });

  it('ignores CCs that are not the timbre controller', () => {
    const p = new MpeParser();
    p.feedBytes(noteOn(1, 60, 100));
    const ev = p.feedBytes(cc(1, 1, 127)); // mod wheel, not CC74
    expect(ev).toHaveLength(0);
    expect(p.notes[0].expression.timbre).toBe(0);
  });

  it('master-channel messages apply to every note in the zone', () => {
    const p = new MpeParser({ zone: 'lower' }); // master channel = 0
    p.feedBytes(noteOn(1, 60, 100));
    p.feedBytes(noteOn(2, 64, 100));
    p.feedBytes(noteOn(3, 67, 100));
    const ev = p.feedBytes(pressure(0, 100)); // master pressure
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.type === 'update')).toBe(true);
    expect(p.notes.every((n) => n.expression.pressure > 0)).toBe(true);
  });

  it('a fresh note-on resets its channel’s expression (no bleed from a prior note)', () => {
    const p = new MpeParser();
    p.feedBytes(noteOn(1, 60, 100));
    p.feedBytes(bend(1, 16383));
    p.feedBytes(noteOff(1, 60));
    p.feedBytes(noteOn(1, 72, 100)); // reuse channel 1
    expect(p.notes[0].expression.bendSemitones).toBe(0);
    expect(p.notes[0].pitch).toBe(72);
  });

  it('expression on an unheld channel produces nothing', () => {
    const p = new MpeParser();
    expect(p.feedBytes(bend(5, 16383))).toHaveLength(0);
    expect(p.feedBytes(pressure(5, 127))).toHaveLength(0);
  });

  it('is deterministic and hardware-free — a fixed gesture yields a fixed pitch', () => {
    const gesture = (p: MpeParser) => {
      p.feedBytes(noteOn(1, 60, 100));
      p.feedBytes(bend(1, 12288)); // half of the upper half → +24 st at range 48
      return p.notes[0].pitch;
    };
    expect(gesture(new MpeParser())).toBeCloseTo(gesture(new MpeParser()), 6);
    expect(gesture(new MpeParser())).toBeCloseTo(84, 1);
  });
});
