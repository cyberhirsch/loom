/** The default patch IS a LoomScript document (docs/LOOMSCRIPT.md) — the same
 *  format the autosave persists and any LLM can read and edit. Kept free of
 *  store/browser imports so node tools (scripts/score.ts) can read it. */
export const DEFAULT_SCRIPT = `# Loom — default ensemble (LoomScript v2)
loom 2

conductor key=C scale=minor_pent tempo=102 phrase=16 evolve=off journey=off every=4 @ 40,140
arranger off @ 40,560
section "A · sparse" loops=4 intensity=0.65
section "B · full" loops=4 intensity=1
section "C · lift" loops=2 intensity=1.2 journey=1

arp    seed=505 density=0.45 volume=-14 @ 700,-230
melody seed=101 density=0.55 adventure=0.35 volume=-9 @ 700,20
chords seed=202 density=0.5 volume=-16 @ 700,270
bass   seed=303 density=0.5 volume=-10 @ 700,520
drums  seed=404 density=0.6 syncopate=0.3 volume=-8 @ 700,770

lfo1:    lfo rate=0.5 depth=0.35 @ 340,40
expr1:   expression portamento=0.15 glissando=on @ 990,60
pluck:   synth wave=triangle attack=0.002 release=0.25 cutoff=6500 @ 1250,-230
lead:    synth wave=triangle attack=0.004 decay=0.25 sustain=0.45 release=0.12 cutoff=5200 @ 1250,20
pad:     synth wave=sine attack=0.1 release=0.45 cutoff=3400 @ 1250,270
sub:     synth wave=square attack=0.004 decay=0.2 sustain=0.5 release=0.06 cutoff=900 @ 1250,520
kit1:    kit @ 1250,770
delay1:  delay time=1/8d feedback=0.35 mix=0.25 @ 1530,-90
reverb1: reverb mix=0.28 @ 1530,360
out level=0 @ 1790,360

melody -> expr1 -> lead -> delay1 -> reverb1 -> out
arp -> pluck -> delay1
chords -> pad -> reverb1
bass -> sub -> out
drums -> kit1 -> reverb1
lfo1 -> melody.density
`;
