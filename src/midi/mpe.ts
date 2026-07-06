/**
 * MPE parser — raw MIDI bytes → live per-note events with expression.
 *
 * MPE (MIDI Polyphonic Expression) gives every sounding note its own MIDI
 * channel so three continuous dimensions can be per-note instead of global:
 *   - X = pitch bend on the note's member channel → glide (Loom's "pitch as float")
 *   - Y = CC 74 on the member channel            → timbre / slide
 *   - Z = channel pressure on the member channel → pressure
 * This is exactly the Note-cable model Loom decided on (PRD §5.1) and the
 * Expression node already produces — so MPE input feeds the same path.
 *
 * Zones: a Lower Zone uses master channel 1 with member channels 2..N; an
 * Upper Zone uses master channel 16 with members counting down. Most devices
 * default to the Lower Zone. Master-channel messages apply to every active
 * note in the zone; member-channel messages apply to that channel's note.
 *
 * Pure and deterministic: feed() returns the events a message produced, so the
 * whole parser is unit-testable without any hardware.
 */

/** MPE's three continuous per-note dimensions, normalized. */
export interface MpeExpression {
  /** pitch bend in semitones (member pitch-bend × bend range) */
  bendSemitones: number;
  /** CC 74 "slide" / timbre, 0..1 */
  timbre: number;
  /** channel pressure "Z", 0..1 */
  pressure: number;
}

export interface MpeNote {
  /** the member channel that owns this note for its lifetime (0-based) */
  channel: number;
  /** MIDI note number of the key struck */
  midiNote: number;
  /** attack velocity, 0..1 */
  velocity: number;
  expression: MpeExpression;
  /** absolute sounding pitch as a float: midiNote + bendSemitones (microtonal) */
  readonly pitch: number;
}

export type MpeEvent =
  | { type: 'noteOn'; note: MpeNote }
  | { type: 'noteOff'; note: MpeNote }
  | { type: 'update'; note: MpeNote }; // expression changed on a held note

export interface MpeConfig {
  /** which zone this parser listens to */
  zone?: 'lower' | 'upper';
  /** per-note pitch-bend range in semitones (MPE default is 48) */
  bendRange?: number;
}

const CC_TIMBRE = 74;

function makePitch(note: Omit<MpeNote, 'pitch'>): MpeNote {
  return Object.defineProperty(note as MpeNote, 'pitch', {
    get(this: MpeNote) {
      return this.midiNote + this.expression.bendSemitones;
    },
    enumerable: true,
  });
}

export class MpeParser {
  private zone: 'lower' | 'upper';
  private bendRange: number;
  /** the master channel (0-based) whose messages apply to every note in the zone */
  private masterChannel: number;
  /** active notes keyed by member channel (0-based) */
  private active = new Map<number, MpeNote>();

  constructor(config: MpeConfig = {}) {
    this.zone = config.zone ?? 'lower';
    this.bendRange = config.bendRange ?? 48;
    this.masterChannel = this.zone === 'lower' ? 0 : 15;
  }

  /** notes currently held down (for a live monitor / voice allocator) */
  get notes(): MpeNote[] {
    return [...this.active.values()];
  }

  reset(): void {
    this.active.clear();
  }

  /** feed one MIDI message (status + up to two data bytes). Returns any events. */
  feed(status: number, d1 = 0, d2 = 0): MpeEvent[] {
    const type = status & 0xf0;
    const channel = status & 0x0f;

    if (type === 0x90 && d2 > 0) return this.noteOn(channel, d1, d2);
    if (type === 0x80 || (type === 0x90 && d2 === 0)) return this.noteOff(channel, d1);
    if (type === 0xe0) return this.pitchBend(channel, d1, d2);
    if (type === 0xd0) return this.channelPressure(channel, d1);
    if (type === 0xb0 && d1 === CC_TIMBRE) return this.timbre(channel, d2);
    return [];
  }

  /** feed a raw MIDI byte array (e.g. a Web MIDI `MIDIMessageEvent.data`). */
  feedBytes(data: ArrayLike<number>): MpeEvent[] {
    return this.feed(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0);
  }

  private noteOn(channel: number, midiNote: number, velocity: number): MpeEvent[] {
    // a fresh note on a member channel resets that channel's expression
    const note = makePitch({
      channel,
      midiNote,
      velocity: velocity / 127,
      expression: { bendSemitones: 0, timbre: 0, pressure: 0 },
    });
    this.active.set(channel, note);
    return [{ type: 'noteOn', note }];
  }

  private noteOff(channel: number, _midiNote: number): MpeEvent[] {
    const note = this.active.get(channel);
    if (!note) return [];
    this.active.delete(channel);
    return [{ type: 'noteOff', note }];
  }

  /** member pitch bend → per-note glide; on the master channel it bends the whole zone. */
  private pitchBend(channel: number, lsb: number, msb: number): MpeEvent[] {
    const value14 = (msb << 7) | lsb; // 0..16383, centre 8192
    const semis = ((value14 - 8192) / 8192) * this.bendRange;
    if (channel === this.masterChannel) {
      const events: MpeEvent[] = [];
      for (const note of this.active.values()) {
        note.expression.bendSemitones = semis;
        events.push({ type: 'update', note });
      }
      return events;
    }
    const note = this.active.get(channel);
    if (!note) return [];
    note.expression.bendSemitones = semis;
    return [{ type: 'update', note }];
  }

  private channelPressure(channel: number, value: number): MpeEvent[] {
    return this.applyToChannel(channel, (n) => (n.expression.pressure = value / 127));
  }

  private timbre(channel: number, value: number): MpeEvent[] {
    return this.applyToChannel(channel, (n) => (n.expression.timbre = value / 127));
  }

  private applyToChannel(channel: number, mutate: (n: MpeNote) => void): MpeEvent[] {
    if (channel === this.masterChannel) {
      const events: MpeEvent[] = [];
      for (const note of this.active.values()) {
        mutate(note);
        events.push({ type: 'update', note });
      }
      return events;
    }
    const note = this.active.get(channel);
    if (!note) return [];
    mutate(note);
    return [{ type: 'update', note }];
  }
}
