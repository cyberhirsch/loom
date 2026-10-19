# LoomScript v2 — a Loom patch as text

LoomScript is the **save format** of [Loom](../README.md): the entire patch — every node, knob, cable, frozen take, and scene — as a line-based text document that any human or LLM can read and edit. The app's **⟨⟩ script** panel shows the live patch as LoomScript, applies edited text back, and saves/loads `.loom` files. Round-trip (`serialize → parse → serialize`) is idempotent by test.

Paste this spec plus a patch to any LLM and it has everything it needs.

## A complete patch

```
# Loom — default ensemble (LoomScript v2)
loom 2

conductor key=C scale=minor_pent tempo=102 phrase=16 evolve=off journey=off every=4
arranger off
section "A · sparse" loops=4 intensity=0.65
section "B · full" loops=4 intensity=1
section "C · lift" loops=2 intensity=1.2 journey=1

arp    seed=505 density=0.45 volume=-14
melody seed=101 density=0.55 adventure=0.35 volume=-9
chords seed=202 density=0.5 volume=-16
bass   seed=303 density=0.5 volume=-10
drums  seed=404 density=0.6 syncopate=0.3 volume=-8

lfo1:    lfo rate=0.5 depth=0.35
expr1:   expression portamento=0.15 glissando=on
pluck:   synth wave=triangle attack=0.002 release=0.25 cutoff=6500
lead:    synth wave=triangle attack=0.004 decay=0.25 sustain=0.45 release=0.12 cutoff=5200
pad:     synth wave=sine attack=0.1 release=0.45 cutoff=3400
sub:     synth wave=square attack=0.004 decay=0.2 sustain=0.5 release=0.06 cutoff=900
kit1:    kit
delay1:  delay time=1/8d feedback=0.35 mix=0.25
reverb1: reverb mix=0.28
out level=0

melody -> expr1 -> lead -> delay1 -> reverb1 -> out
arp -> pluck -> delay1
chords -> pad -> reverb1
bass -> sub -> out
drums -> kit1 -> reverb1
lfo1 -> melody.density
```

## Ground rules

- The first statement is the version header `loom 2`. A document without one is read as the current version; `loom 1` documents are migrated on load (see [Versions](#versions)).
- One statement per line. `#` starts a comment (whole line or trailing). Blank lines are ignored.
- Values: numbers are plain (`0.55`, `-9`); unit suffixes `ms`, `s`, `k` are accepted on input (`4ms` = 0.004, `5.2k` = 5200) but plain numbers are emitted. Booleans are `on`/`off`.
- Every node line may end with an optional position `@ x,y`. **Omit positions when writing by hand** — the parser auto-lays-out anything unplaced. The app writes them back so your layout survives.
- `conductor` and `out` are implicit: if you don't declare them, defaults appear. Everything else must be declared before it's used in a chain.
- **Sound requires routing.** Players emit notes only. A player is audible only if its notes reach an instrument (`synth`/`kit`) whose signal reaches `out`. An unrouted player is silent — this is enforced by the engine, not a convention.

## Nodes

### Players (declared by role name — at most one of each)

```
melody seed=101 density=0.55 adventure=0.35 register=0 volume=-9 mute=off
```

| role | notes |
|---|---|
| `melody` | the lead voice; `adventure` (0..1) = interval daring |
| `chords` | comping pads; its `seed` drives the shared chord progression (harmony-first); `colour` (optional, default `triad`) = how every chord is built on its root: `triad`, `7th` (adds the diatonic 7th) or `quartal` (stacked fourths). The colour shapes the shared harmony: melody and arp aim at the tones the chords actually sound. `spread` (optional, default `close`) = how the pad voices each chord: `close`, `open` (drop-2: the second voice from the top an octave down) or `rootless` (the root left to the bass). Every spread is voice-led: each chord takes the inversion nearest the last one, its top voice under the melody and its lowest voice above the bass |
| `bass` | root on every chord change, locked to the kick; `artic` (0.1..1, optional, default 0.95; lower values are clamped) = note length as a share of the gap to the next note (0.95 legato, 0.5 staccato) |
| `drums` | kick on 1 and snare on 2 & 4 always; `syncopate` (0..1) = off-grid feel |
| `arp` | ornamental arpeggios; `octaves` (optional, `1` or `2`, default 1) = how many octaves the run climbs (`2` opens the arp's window up to A7) |

Common params: `seed` (int — same seed, same music), `density` (0..1, how busy), `register` (-2..2, octaves to shift the role's pitch window), `volume` (dB, ≤0), `mute` (on/off).

Each role sounds in a fixed pitch window, whatever the key, so a key change or a journey stop never drags a part out of its range: melody with its tonic in G3–F#4 (the tune's middle around F4–E5), chords in C3–C5 under the melody, bass in E1–D3 with the chord roots in G1–G2 and always below the pad, arp in C5–A6 (C5–A7 with `octaves=2`). `register` moves the window by whole octaves.

### Frozen takes (capture)

A `take` line right after a player freezes it to an exact pattern (immune to evolve/re-generation; still transposes with the journey):

```
take melody 0:2:0.9:2 4:5:0.75:1 12:0:1:4     # step:degree:velocity:lengthSteps
take drums 0:kick:1 4:snare:0.9 6:hat:0.5     # step:lane:velocity
```

Degrees are scale degrees (0 = tonic; ≥ scale length = next octave; negative = below the tonic). Melody and arp count in the conductor's scale; **bass and chords count in its parent mode** (the key's 7-note collection: `minor_pent` → `aeolian`, `major_pent` → `ionian`, any 7-note mode → itself), because that is where their triads and fifths live. A chords take's degree is the chord's root. Steps are 0–15 in the 16-step loop.

### Conductor (ambient context — key, scale, tempo, loop behaviors)

```
conductor key=C scale=minor_pent tempo=102 phrase=16 evolve=off journey=off every=4
```

`key`: C C# D D# E F F# G G# A A# B · `scale`: `major_pent` `minor_pent` `ionian` (major) `aeolian` (minor) `dorian` `phrygian` `lydian` `mixolydian` (a pentatonic scale keeps the melody and arp on its five notes, while chords and bass play real triads of its parent mode: C `minor_pent` harmonizes with Cm, Eb, Fm, Gm, Ab, Bb) · `phrase`: phrase length in steps (8 half-bar, 16 one-bar, 32 question/answer) · `evolve`: mutate patterns each loop · `journey`: modulate through related keys every `every` loops.

### Arranger (generative structure)

```
arranger on
section "groove" loops=4 intensity=0.8
section "peak" loops=2 intensity=1.35 journey=1
```

When `on`, sections cycle: `intensity` multiplies every player's density; `journey=N` (0..3) moves the key to that journey stop (omit = stay home).

### Instruments, Note FX, FX, Motifs, and Modulators (declared `id: type params`)

```
motif1:  motif idea=924829570 shape=arch
lead:    synth wave=triangle attack=0.004 decay=0.25 sustain=0.45 release=0.12 cutoff=5200
kit1:    kit
expr1:   expression portamento=0.15 glissando=on
delay1:  delay time=1/8d feedback=0.35 mix=0.25
reverb1: reverb mix=0.28
lfo1:    lfo rate=0.5 depth=0.35
tens1:   tension depth=0.4
out level=0
```

| type | params | role |
|---|---|---|
| `motif` | `idea` (seed int), `shape` (arch/rise/fall/wave) | Melodic idea (rhythm cell + contour): patch to `melody.motif` to pin a theme's character |
| `synth` | `wave` (sine/triangle/square/saw), `attack` (s), `decay` (s, optional), `sustain` (0..1, optional), `release` (s, fade to -60 dB from the current level), `cutoff` (Hz) | notes → signal: the instrument. Omitted `decay`/`sustain` use the engine default for the part it plays. Melody and bass voices are monophonic (a new note takes over the voice; with portamento it glides) |
| `kit` | — | the drum instrument |
| `expression` | `portamento` (0..1 → glide time), `glissando` (on/off) | Note FX: sits **in a note path**; portamento glides pitch, glissando inserts scale-locked runs into leaps |
| `delay` | `time` (`1/8`, `1/8d`, `1/4`), `feedback`, `mix` | tempo-synced ping-pong echo |
| `reverb` | `mix` | the shared room |
| `lfo` | `rate` (cycles/loop), `depth` | CV source for `density` |
| `tension` | `depth` | ensemble-energy CV: patch to density and the loop self-balances |
| `out` | `level` (dB) | master output — all sound funnels here |

## Cables (chains)

```
melody -> expr1 -> lead -> delay1 -> reverb1 -> out
lfo1 -> melody.density
motif1 -> melody.motif
```

Arrows chain any number of hops. Cable types are **inferred and checked**:

- **Note cables** (players, expression → expression, synth, kit)
- **Signal cables** (synth, kit, delay, reverb → delay, reverb, out)
- **CV cables** (lfo, tension → a player's `.density` port)
- **Motif cables** (motif → melody's `.motif` port — pins the melody's rhythmic and contour character)

Typed mistakes are rejected with guidance, e.g. `melody -> delay1` → *"melody outputs notes — connect it to a synth, kit, or expression"*.

## Scenes (launcher snapshots)

One line per scene: conductor settings plus any `player.param` overrides, the role params included (`chords.colour`, `chords.spread`, `arp.octaves`, validated like on the player lines).

```
scene "verse" key=C scale=lydian tempo=74 evolve=on journey=off melody.density=0.3 drums.mute=on
```

## Harmony (what the `chords` seed picks)

Every progression opens on the tonic, moves by function (tonic → subdominant → dominant) without repeating a chord back to back, and ends on a cadence of its mode that resolves into the tonic when the loop restarts. Diminished triads are never generated. The cadences per mode: major (`ionian`, `major_pent`) V–I, IV–I, ii–V–I · minor (`aeolian`, `minor_pent`) bVI–bVII–i, bVII–i, iv–i · `dorian` IV–i, bVII–i · `phrygian` bII–i · `lydian` II–I · `mixolydian` bVII–I, IV–I.

## Versions

`loom 2` (current): bass and chords takes count parent-mode degrees, the `chords` line may carry `colour` and `spread`, the `arp` line `octaves`, and `register` shifts a role's pitch window. A `loom 1` document loads with deterministic migrations: over a pentatonic home scale, every bass and chords take degree is rewritten as the parent-mode degree of the same pitch (the frozen bass keeps its notes; a frozen chords take keeps its roots and plays their parent-mode triads); and an arp `register=r` becomes `register=r-1`, on the `arp` line and in every scene's `arp.register` (v1 counted the arp's register on top of an octave the arp already had, so its default `register=1` sat two octaves up; it now lands on the default 0). Everything else in a v1 document reads as is, and the app saves it back as `loom 2`.

## Recipes for LLMs

- **Make it audible**: every player you add needs a chain to `out`, e.g. `melody -> lead -> out` with `lead: synth`.
- **Slides/ornaments**: put an `expression` between a player and its synth: `melody -> expr1 -> lead`, `expr1: expression portamento=0.3 glissando=on`.
- **Echo on a part**: route its synth through `delay1` before `reverb1`/`out`.
- **Breathing dynamics**: `tens1: tension depth=0.4` + `tens1 -> melody.density`.
- **A memorable melody**: `motif1: motif idea=508247 shape=rise` + `motif1 -> melody.motif` (pins the rhythmic cell and contour; melody stays thematic but evolves).
- **Longer song structures**: `phrase=32` in conductor for 8-bar question/answer themes (vs. 16 = 4-bar, 8 = 2-bar).
- **A song arc**: `arranger on` + 3–4 `section` lines with rising then falling `intensity`, a `journey=1` on the peak.
- **Harmonic colour**: `chords … colour=7th` for jazzy/lo-fi sevenths, `colour=quartal` for open stacked-fourth (modal, So-What style) voicings.
- **Pad spacing**: `chords … spread=open` for a wider drop-2 pad, `spread=rootless` to leave the root to the bass (on plain triads that leaves a 3rd–5th dyad; `colour=7th spread=rootless` is the classic 3-5-7 shell).
- **A wider arp**: `arp … octaves=2`; `register=-1`/`1` moves it an octave down/up.
- **New take of one part**: change only that player's `seed`.
- **Same music every time**: don't touch seeds; everything is deterministic.
