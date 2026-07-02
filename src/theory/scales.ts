/** Tonal material — scales/modes with emotional descriptions (PRD §5.3, from the LOOM prototype). */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface Scale {
  id: ScaleId;
  name: string;
  intervals: number[]; // semitones from root
  desc: string;
}

export type ScaleId =
  | 'major_pent'
  | 'minor_pent'
  | 'ionian'
  | 'aeolian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian';

export const SCALES: Record<ScaleId, Scale> = {
  major_pent: {
    id: 'major_pent',
    name: 'Major Pentatonic',
    intervals: [0, 2, 4, 7, 9],
    desc: 'Five notes, zero wrong answers. Bright and cheerful.',
  },
  minor_pent: {
    id: 'minor_pent',
    name: 'Minor Pentatonic',
    intervals: [0, 3, 5, 7, 10],
    desc: 'Five notes, zero wrong answers. Soulful and bluesy.',
  },
  ionian: {
    id: 'ionian',
    name: 'Major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    desc: 'Bright, happy, fully resolved. The sound of pop choruses.',
  },
  aeolian: {
    id: 'aeolian',
    name: 'Minor',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    desc: 'Sad, serious, cinematic. The classic emotional minor.',
  },
  dorian: {
    id: 'dorian',
    name: 'Dorian',
    intervals: [0, 2, 3, 5, 7, 9, 10],
    desc: 'Minor with a hopeful lift. Jazzy, groovy, mysterious.',
  },
  phrygian: {
    id: 'phrygian',
    name: 'Phrygian',
    intervals: [0, 1, 3, 5, 7, 8, 10],
    desc: 'Dark and Spanish-tinged, a dramatic flamenco edge.',
  },
  lydian: {
    id: 'lydian',
    name: 'Lydian',
    intervals: [0, 2, 4, 6, 7, 9, 11],
    desc: 'Floaty and dreamlike — wonder, magic, open skies.',
  },
  mixolydian: {
    id: 'mixolydian',
    name: 'Mixolydian',
    intervals: [0, 2, 4, 5, 7, 9, 10],
    desc: 'Warm and bluesy. Major with a relaxed rock swagger.',
  },
};

export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

/** Scale degree (0-based) + octave offset -> MIDI note. Root C4 = 60 when keyIndex 0. */
export function degreeToMidi(keyIndex: number, scaleId: ScaleId, degree: number, octave = 0): number {
  const iv = SCALES[scaleId].intervals;
  const len = iv.length;
  const idx = ((degree % len) + len) % len;
  const octFromDegree = Math.floor(degree / len);
  return 60 + keyIndex + iv[idx] + 12 * (octFromDegree + octave);
}

/** True if the scale degree is a chord tone of the triad on `chordDegree` (root/3rd/5th stacked in scale thirds). */
export function isChordTone(degree: number, chordDegree: number, scaleLen: number): boolean {
  const rel = (((degree - chordDegree) % scaleLen) + scaleLen) % scaleLen;
  return rel === 0 || rel === 2 || rel === 4;
}
