/**
 * Web MIDI → Loom's live-note path. Chromium-only (Web MIDI API); the desktop
 * build later replaces this transport with native MIDI in the JUCE shell —
 * the MpeParser and the engine live-note API stay identical.
 *
 * The MIDI Input node's data (device / mode / bend) is watched from the store;
 * this module owns the actual MIDIAccess subscription and feeds the engine.
 */

import { create } from 'zustand';
import { useLoomStore } from '../graph/store';
import { engine } from '../audio/wasmEngine';
import { MpeParser, type MpeEvent } from './mpe';

export interface MidiInputInfo {
  id: string;
  name: string;
}

interface MidiState {
  supported: boolean;
  /** idle → user hasn't enabled; granted/denied after the permission prompt */
  access: 'idle' | 'granted' | 'denied';
  inputs: MidiInputInfo[];
  /** notes currently held (live monitor for the node UI) */
  held: number;
  /** last event, human-readable (node UI) */
  lastEvent: string;
}

export const useMidiStore = create<MidiState>(() => ({
  supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
  access: 'idle',
  inputs: [],
  held: 0,
  lastEvent: '',
}));

let midiAccess: MIDIAccess | null = null;
let parser = new MpeParser();
/** plain-MIDI mode state: held note numbers + the channel-global bend */
const plainHeld = new Map<number, number>(); // note → channel
let plainBend = 0;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[Math.round(n) % 12]}${Math.floor(Math.round(n) / 12) - 1}`;

function nodeConfig(): { device: string; mode: 'mpe' | 'midi'; bend: number } | null {
  const node = useLoomStore.getState().nodes.find((n) => n.type === 'midiin');
  if (!node) return null;
  return {
    device: String(node.data.device ?? ''),
    mode: node.data.mode === 'midi' ? 'midi' : 'mpe',
    bend: Number(node.data.bend) || 48,
  };
}

function publish(patch: Partial<MidiState>) {
  useMidiStore.setState(patch);
}

function onMpeEvents(events: MpeEvent[]) {
  for (const ev of events) {
    const { note } = ev;
    if (ev.type === 'noteOn') {
      engine.liveNoteOn(note.channel, note.pitch, note.velocity);
      publish({ held: parser.notes.length, lastEvent: `${noteName(note.midiNote)} on` });
    } else if (ev.type === 'noteOff') {
      engine.liveNoteOff(note.channel);
      publish({ held: parser.notes.length, lastEvent: `${noteName(note.midiNote)} off` });
    } else {
      engine.liveNoteUpdate(note.channel, note.pitch, note.expression.pressure, note.expression.timbre);
    }
  }
}

/** plain (single-zone, non-MPE) MIDI: polyphony keyed by note number */
function onPlainMessage(status: number, d1: number, d2: number, bendRange: number) {
  const type = status & 0xf0;
  if (type === 0x90 && d2 > 0) {
    plainHeld.set(d1, status & 0x0f);
    engine.liveNoteOn(d1, d1 + plainBend, d2 / 127);
    publish({ held: plainHeld.size, lastEvent: `${noteName(d1)} on` });
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
    plainHeld.delete(d1);
    engine.liveNoteOff(d1);
    publish({ held: plainHeld.size, lastEvent: `${noteName(d1)} off` });
  } else if (type === 0xe0) {
    plainBend = (((d2 << 7) | d1) - 8192) / 8192 * bendRange;
    for (const note of plainHeld.keys()) engine.liveNoteUpdate(note, note + plainBend, 0, 0.5);
  }
}

let currentBend = 48;

export function handleMidiBytes(data: ArrayLike<number>) {
  const cfg = nodeConfig();
  if (!cfg) return;
  if (cfg.mode === 'mpe') {
    if (cfg.bend !== currentBend) {
      currentBend = cfg.bend;
      releaseAll();
      parser = new MpeParser({ bendRange: cfg.bend });
    }
    onMpeEvents(parser.feedBytes(data));
  } else {
    onPlainMessage(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, Math.min(cfg.bend, 12));
  }
}

function releaseAll() {
  engine.liveAllNotesOff();
  parser.reset();
  plainHeld.clear();
  plainBend = 0;
  publish({ held: 0 });
}

function attachInputs() {
  if (!midiAccess) return;
  const cfg = nodeConfig();
  const inputs = [...midiAccess.inputs.values()];
  publish({ inputs: inputs.map((i) => ({ id: i.id, name: i.name ?? i.id })) });
  for (const input of inputs) {
    // one handler per input; the device filter is applied per message so a
    // device change in the node needs no re-subscription
    input.onmidimessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      const c = nodeConfig();
      if (!c) return;
      if (c.device && input.id !== c.device && input.name !== c.device) return;
      handleMidiBytes(e.data);
    };
  }
}

/** User-gesture entry point (node UI button): permission + audio, then attach. */
export async function enableMidi(): Promise<void> {
  await engine.ensureAudio();
  if (!useMidiStore.getState().supported) return;
  if (!midiAccess) {
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      publish({ access: 'denied' });
      return;
    }
    publish({ access: 'granted' });
    midiAccess.onstatechange = () => attachInputs();
  }
  attachInputs();
}

// the node being deleted (or its mode changed) must not leave notes hanging
useLoomStore.subscribe((state, prev) => {
  if (state.nodes === prev.nodes) return;
  const had = prev.nodes.some((n) => n.type === 'midiin');
  const has = state.nodes.some((n) => n.type === 'midiin');
  if (had && !has) releaseAll();
  const prevMode = prev.nodes.find((n) => n.type === 'midiin')?.data.mode;
  const mode = state.nodes.find((n) => n.type === 'midiin')?.data.mode;
  if (had && has && prevMode !== mode) releaseAll();
});

if (import.meta.env.DEV && typeof window !== 'undefined') {
  // preview/testing hook: inject raw MIDI bytes as if a device sent them
  (window as unknown as Record<string, unknown>).__loomMidi = { handleMidiBytes, enableMidi, releaseAll };
}
