/**
 * Standard MIDI File export (PRD §6.10 / M4 capture slice): the current loop's
 * generated patterns as a type-1 .mid — one track per player, drums on ch10.
 */

import type { HarmonicContext } from '../theory/harmony';
import { chordMidi } from '../theory/harmony';
import { degreeToMidi } from '../theory/scales';
import type { NoteEvent } from '../theory/melody';
import type { DrumEvent } from '../theory/parts';
import type { PlayerKind } from '../graph/types';
import { ROLE_OCTAVE } from '../graph/session';

const PPQ = 480;
const TICKS_PER_STEP = PPQ / 4; // 16th notes

const GM_DRUM: Record<number, number> = { 0: 36, 1: 38, 2: 42 }; // kick, snare, closed hat

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function str(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

interface RawEvent {
  tick: number;
  bytes: number[];
  order: number; // note-offs before note-ons at same tick
}

function trackChunk(events: RawEvent[], name: string): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [...vlq(0), 0xff, 0x03, name.length, ...str(name)];
  let last = 0;
  for (const ev of events) {
    body.push(...vlq(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  const len = body.length;
  return [...str('MTrk'), (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...body];
}

export interface MidiPart {
  kind: PlayerKind;
  pattern: NoteEvent[] | DrumEvent[];
  register: number;
}

export function buildMidi(ctx: HarmonicContext, parts: MidiPart[], bpm: number, loops = 1): Uint8Array {
  const chunks: number[] = [];
  const ntrks = parts.length + 1;
  chunks.push(...str('MThd'), 0, 0, 0, 6, 0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff);

  // tempo track
  const usPerQuarter = Math.round(60_000_000 / bpm);
  chunks.push(
    ...trackChunk(
      [{ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] }],
      'Loom',
    ),
  );

  let channel = 0;
  for (const part of parts) {
    const events: RawEvent[] = [];
    const ch = part.kind === 'drums' ? 9 : channel++;
    if (channel === 9) channel++; // skip GM drum channel for pitched parts
    for (let loop = 0; loop < loops; loop++) {
      const base = loop * ctx.steps * TICKS_PER_STEP;
      if (part.kind === 'drums') {
        for (const ev of part.pattern as DrumEvent[]) {
          const tick = base + ev.step * TICKS_PER_STEP;
          const note = GM_DRUM[ev.lane] ?? 42;
          const vel = Math.round(ev.velocity * 127) & 0x7f;
          events.push({ tick, order: 1, bytes: [0x90 | ch, note, vel] });
          events.push({ tick: tick + Math.floor(TICKS_PER_STEP / 2), order: 0, bytes: [0x80 | ch, note, 0] });
        }
      } else {
        const octave = ROLE_OCTAVE[part.kind] + part.register;
        for (const ev of part.pattern as NoteEvent[]) {
          const tick = base + ev.step * TICKS_PER_STEP;
          const midis =
            part.kind === 'chords'
              ? chordMidi(ctx, ev.degree, octave)
              : [degreeToMidi(ctx.keyIndex, ctx.scaleId, ev.degree, octave)];
          const vel = Math.round(ev.velocity * 127) & 0x7f;
          const durTicks = Math.max(1, ev.lengthSteps) * TICKS_PER_STEP - 4;
          for (const midi of midis) {
            const clamped = Math.max(0, Math.min(127, midi));
            events.push({ tick, order: 1, bytes: [0x90 | ch, clamped, vel] });
            events.push({ tick: tick + durTicks, order: 0, bytes: [0x80 | ch, clamped, 0] });
          }
        }
      }
    }
    chunks.push(...trackChunk(events, part.kind));
  }
  return new Uint8Array(chunks);
}

export function downloadMidi(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
