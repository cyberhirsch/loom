import { describe, it, expect } from 'vitest';
import { buildContext, CHORD_COLOURS } from './harmony';
import { SCALE_IDS, pcOf } from './scales';
import {
  ARP_WINDOW, BASS_ROOT_WINDOW, CHORD_SPREADS, CHORD_WINDOW, MELODY_TONIC, chordCandidates, foldInto, melodyTonic,
  motionCost, placeArpRun, placeBassNote, placeBassRoot, placements, voiceChords, type ChordSlot,
} from './voicing';

const slotsOf = (key: number, scaleId: (typeof SCALE_IDS)[number], seed: number, colour: (typeof CHORD_COLOURS)[number] = 'triad'): ChordSlot[] =>
  buildContext(key, scaleId, 16, seed, colour).chords.map((c) => ({ pcs: [...c.pcs, ...(c.ext ?? [])], rootPc: c.rootPc, quartal: colour === 'quartal' }));

describe('voicing: fixed pitch windows', () => {
  it('the melody tonic sits in G3..F#4 on its own pitch class, in every key', () => {
    for (let k = 0; k < 12; k++) {
      const t = melodyTonic(k);
      expect(t).toBeGreaterThanOrEqual(MELODY_TONIC.lo);
      expect(t).toBeLessThanOrEqual(MELODY_TONIC.hi);
      expect(pcOf(t)).toBe(k);
    }
  });

  it('placements and folding stay inside the window on the right pitch class', () => {
    for (let pc = 0; pc < 12; pc++) {
      for (const w of [ARP_WINDOW, BASS_ROOT_WINDOW, CHORD_WINDOW]) {
        const ps = placements(pc, w);
        expect(ps.length).toBeGreaterThan(0);
        for (const m of ps) expect(m >= w.lo && m <= w.hi && pcOf(m) === pc).toBe(true);
      }
      for (let m = 0; m < 128; m++) {
        const f = foldInto(m, ARP_WINDOW);
        expect(f >= ARP_WINDOW.lo && f <= ARP_WINDOW.hi && pcOf(f) === pcOf(m)).toBe(true);
      }
    }
  });

  it('chord candidates are the chord (and only the chord), every inversion, inside floor..top', () => {
    for (const scaleId of SCALE_IDS) {
      for (const colour of CHORD_COLOURS) {
        for (const spread of CHORD_SPREADS) {
          for (const slot of slotsOf(5, scaleId, 77, colour)) {
            const cands = chordCandidates(slot, CHORD_WINDOW, spread, 44);
            expect(cands.length).toBeGreaterThan(0);
            const tones = new Set(slot.pcs);
            const bottoms = new Set<number>();
            for (const v of cands) {
              expect(v[0]).toBeGreaterThanOrEqual(44);
              expect(v[v.length - 1]).toBeLessThanOrEqual(CHORD_WINDOW.hi);
              for (const m of v) expect(tones.has(pcOf(m))).toBe(true);
              if (spread === 'rootless' && !slot.quartal) expect(v.some((m) => pcOf(m) === slot.rootPc)).toBe(false);
              bottoms.add(pcOf(v[0]));
            }
            if (spread === 'close') expect(bottoms.size).toBe(tones.size);
          }
        }
      }
    }
  });

  it('voice leading: deterministic, under each ceiling, and far smoother than root position', () => {
    let led = 0;
    let rootPos = 0;
    for (const scaleId of SCALE_IDS) {
      for (let seed = 1; seed <= 20; seed++) {
        const slots = slotsOf(seed % 12, scaleId, seed).map((s, i) => ({ ...s, ceil: 62 + ((seed + i) % 5) }));
        const v = voiceChords(slots, { window: CHORD_WINDOW, cyclic: true, bassHasRoot: true });
        expect(voiceChords(slots, { window: CHORD_WINDOW, cyclic: true, bassHasRoot: true })).toEqual(v);
        v.forEach((notes, i) => expect(Math.max(...notes)).toBeLessThanOrEqual(slots[i].ceil!));
        const root = slots.map((s) => {
          const r = 48 + pcOf(s.rootPc - 48);
          return [...new Set(s.pcs)].map((p) => r + pcOf(p - s.rootPc));
        });
        for (let i = 0; i < v.length; i++) {
          const j = (i + 1) % v.length;
          led += motionCost(v[i], v[j]);
          rootPos += motionCost(root[i], root[j]);
        }
      }
    }
    expect(led).toBeLessThan(rootPos * 0.5);
  });

  it('a phrase that carries on starts from the previous voicing', () => {
    const slots = slotsOf(0, 'aeolian', 9);
    const first = voiceChords(slots, { window: CHORD_WINDOW, cyclic: true });
    const prev = first[first.length - 1];
    const next = voiceChords(slots, { window: CHORD_WINDOW, cyclic: true, prev });
    const fresh = voiceChords(slots, { window: CHORD_WINDOW, cyclic: false });
    expect(motionCost(prev, next[0])).toBeLessThanOrEqual(motionCost(prev, fresh[0]));
  });

  it('bass roots stay in G1..G2 and arp runs in C5..A6', () => {
    for (let pc = 0; pc < 12; pc++) {
      for (const prev of [null, 31, 36, 43]) {
        const r = placeBassRoot(pc, prev);
        expect(r >= BASS_ROOT_WINDOW.lo && r <= BASS_ROOT_WINDOW.hi && pcOf(r) === pc).toBe(true);
      }
      const n = placeBassNote(pc, 60, { below: 48, near: [36] });
      expect(n).toBeLessThan(48);
      expect(pcOf(n)).toBe(pc);
      const run = placeArpRun([60 + pc, 64 + pc, 67 + pc, 72 + pc, 76 + pc], null);
      for (const m of run) expect(m >= ARP_WINDOW.lo && m <= ARP_WINDOW.hi).toBe(true);
    }
  });
});
