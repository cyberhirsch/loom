# LoomScript v1 — a Loom patch as text

LoomScript is the **save format** of [Loom](../README.md): the entire patch — every node, knob, cable, frozen take, and scene — as a line-based text document that any human or LLM can read and edit. The app's **⟨⟩ script** panel shows the live patch as LoomScript, applies edited text back, and saves/loads `.loom` files. Round-trip (`serialize → parse → serialize`) is idempotent by test.

Paste this spec plus a patch to any LLM and it has everything it needs.

## A complete patch

```
# Loom — default ensemble (LoomScript v1)
loom 1

conductor key=C scale=minor_pent tempo=102 evolve=off journey=off every=4
arranger off
section "A · sparse" loops=4 intensity=0.65
section "B · full" loops=4 intensity=1
section "C · lift" loops=2 intensity=1.2 journey=1

arp    seed=505 density=0.45 register=1 volume=-14
melody seed=101 density=0.55 adventure=0.35 volume=-9
chords seed=202 density=0.5 volume=-16
bass   seed=303 density=0.5 volume=-10
drums  seed=404 density=0.6 syncopate=0.3 volume=-8

lfo1:    lfo rate=0.5 depth=0.35
expr1:   expression portamento=0.15 glissando=on
pluck:   synth wave=triangle attack=0.002 release=0.25 cutoff=6500
lead:    synth wave=triangle attack=0.004 release=0.5 cutoff=5200
pad:     synth wave=sine attack=0.1 release=1.3 cutoff=3400
sub:     synth wave=square attack=0.008 release=0.3 cutoff=900
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
| `chords` | comping pads; its `seed` drives the shared chord progression (harmony-first) |
| `bass` | root-driven low end |
| `drums` | kick/snare/hat; `syncopate` (0..1) = off-grid feel |
| `arp` | ornamental arpeggios |

Common params: `seed` (int — same seed, same music), `density` (0..1, how busy), `register` (-2..2 octave offset), `volume` (dB, ≤0), `mute` (on/off).

### Frozen takes (capture)

A `take` line right after a player freezes it to an exact pattern (immune to evolve/re-generation; still transposes with the journey):

```
take melody 0:2:0.9:2 4:5:0.75:1 12:0:1:4     # step:degree:velocity:lengthSteps
take drums 0:kick:1 4:snare:0.9 6:hat:0.5     # step:lane:velocity
```

Degrees are scale degrees (0 = tonic; ≥ scale length = next octave). Steps are 0–15 in the 16-step loop.

### Conductor (ambient context — key, scale, tempo, loop behaviors)

```
conductor key=C scale=minor_pent tempo=102 evolve=off journey=off every=4
```

`key`: C C# D D# E F F# G G# A A# B · `scale`: `major_pent` `minor_pent` `ionian` (major) `aeolian` (minor) `dorian` `phrygian` `lydian` `mixolydian` · `evolve`: mutate patterns each loop · `journey`: modulate through related keys every `every` loops.

### Arranger (generative structure)

```
arranger on
section "groove" loops=4 intensity=0.8
section "peak" loops=2 intensity=1.35 journey=1
```

When `on`, sections cycle: `intensity` multiplies every player's density; `journey=N` (0..3) moves the key to that journey stop (omit = stay home).

### Instruments, Note FX, FX, modulators (declared `id: type params`)

```
lead:    synth wave=triangle attack=0.004 release=0.5 cutoff=5200
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
| `synth` | `wave` (sine/triangle/square/saw), `attack` (s), `release` (s), `cutoff` (Hz) | notes → signal: the instrument |
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
```

Arrows chain any number of hops. Cable types are **inferred and checked**:

- **Note cables** (players, expression → expression, synth, kit)
- **Signal cables** (synth, kit, delay, reverb → delay, reverb, out)
- **CV cables** (lfo, tension → a player's `.density` port)

Typed mistakes are rejected with guidance, e.g. `melody -> delay1` → *"melody outputs notes — connect it to a synth, kit, or expression"*.

## Scenes (launcher snapshots)

One line per scene: conductor settings plus any `player.param` overrides.

```
scene "verse" key=C scale=lydian tempo=74 evolve=on journey=off melody.density=0.3 drums.mute=on
```

## Recipes for LLMs

- **Make it audible**: every player you add needs a chain to `out`, e.g. `melody -> lead -> out` with `lead: synth`.
- **Slides/ornaments**: put an `expression` between a player and its synth: `melody -> expr1 -> lead`, `expr1: expression portamento=0.3 glissando=on`.
- **Echo on a part**: route its synth through `delay1` before `reverb1`/`out`.
- **Breathing dynamics**: `tens1: tension depth=0.4` + `tens1 -> melody.density`.
- **A song arc**: `arranger on` + 3–4 `section` lines with rising then falling `intensity`, a `journey=1` on the peak.
- **New take of one part**: change only that player's `seed`.
- **Same music every time**: don't touch seeds; everything is deterministic.
