/**
 * Standard MIDI File export (PRD §6.10 / M4 capture slice): timeline bars as a
 * type-1 .mid — one track per sounding player, drums on ch10. The notes are the
 * bars' resolved patterns, so the file holds exactly what playback sounds.
 */

import type { PlayerKind } from '../graph/types';
import type { BarRender, WireDrum, WireNote } from '../graph/timeline';

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

export type MidiBar = Pick<BarRender, 'steps' | 'patterns' | 'audible'>;

export function buildMidi(bars: MidiBar[], bpm: number): Uint8Array {
  const kinds: PlayerKind[] = [];
  for (const bar of bars) for (const kind of bar.audible) if (!kinds.includes(kind)) kinds.push(kind);

  const chunks: number[] = [];
  const ntrks = kinds.length + 1;
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
  for (const kind of kinds) {
    const events: RawEvent[] = [];
    const ch = kind === 'drums' ? 9 : channel++;
    if (channel === 9) channel++; // skip GM drum channel for pitched parts
    let base = 0;
    for (const bar of bars) {
      const pattern = bar.audible.includes(kind) ? bar.patterns[kind] : undefined;
      if (kind === 'drums') {
        for (const ev of (pattern ?? []) as WireDrum[]) {
          const tick = base + ev.step * TICKS_PER_STEP;
          const note = GM_DRUM[ev.lane] ?? 42;
          const vel = Math.round(ev.vel * 127) & 0x7f;
          events.push({ tick, order: 1, bytes: [0x90 | ch, note, vel] });
          events.push({ tick: tick + Math.floor(TICKS_PER_STEP / 2), order: 0, bytes: [0x80 | ch, note, 0] });
        }
      } else {
        for (const ev of (pattern ?? []) as WireNote[]) {
          const tick = base + ev.step * TICKS_PER_STEP;
          const vel = Math.round(ev.vel * 127) & 0x7f;
          // lengths can be fractional (bass articulation); SMF deltas are integers
          const durTicks = Math.max(1, Math.round(ev.lenSteps * TICKS_PER_STEP) - 4);
          for (const midi of ev.midis) {
            const clamped = Math.max(0, Math.min(127, midi));
            events.push({ tick, order: 1, bytes: [0x90 | ch, clamped, vel] });
            events.push({ tick: tick + durTicks, order: 0, bytes: [0x80 | ch, clamped, 0] });
          }
        }
      }
      base += bar.steps * TICKS_PER_STEP;
    }
    chunks.push(...trackChunk(events, kind));
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
