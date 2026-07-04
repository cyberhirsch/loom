---
name: loomscript
description: Read, write, and edit Loom patches as LoomScript text — the DSL that saves the whole node graph (players, synths, FX, cables, scenes). Use when the user asks to create or modify a Loom patch, ensemble, or .loom file, or wants music changes expressed as script edits.
---

# LoomScript — editing Loom patches as text

LoomScript is Loom's save format: the entire patch as a line-based DSL. The canonical grammar spec is [docs/LOOMSCRIPT.md](../../../docs/LOOMSCRIPT.md) — **read it first**, then write or edit the script. The default ensemble (a complete, working example) is the `DEFAULT_SCRIPT` constant in [src/graph/store.ts](../../../src/graph/store.ts).

## How the user runs your script

1. In the Loom app, the **⟨⟩ script** button opens the panel showing the live patch as text; the user pastes your script and hits **apply** (errors come back with line numbers).
2. Or save your output as a `.loom` file and the user loads it via **↥ load**.

## Rules that matter most

- **Nothing sounds unless routed to `out`.** Every player needs a chain: `player -> [expression ->] synth/kit -> [fx ->] out`. The engine enforces this — an unrouted player is silent.
- Cable types are checked: players/expression emit **notes** (valid targets: expression, synth, kit); synth/kit/fx emit **signal** (valid targets: delay, reverb, out); lfo/tension emit **CV** (valid target: `player.density`); **motif** emits theme shape (valid target: `melody.motif`).
- Players are singletons declared by role name (`melody`, `chords`, `bass`, `drums`, `arp`). Everything else is `id: type params`.
- Omit `@ x,y` positions — the parser auto-lays-out the canvas.
- Determinism: same seeds = same music. To change one part's take, change only its `seed`.
- `chords.seed` drives the shared chord progression (harmony-first) — changing it re-harmonizes everyone.
- Motifs drive melody quality: `motif1: motif idea=INT shape=SHAPE` + `motif1 -> melody.motif` pins the rhythm cell and contour. Without a motif, melody is random; with one, it's thematic.

## Musical guidance

- **Phrase length**: `phrase=8` for tight 2-bar loops, `phrase=16` for standard 4-bar phrases (default), `phrase=32` for 8-bar question/answer structures.
- **Melody themes**: always add `motif1: motif` and `motif1 -> melody.motif` for memorable melodies. Shapes: `arch` (peak early), `rise` (climb), `fall` (descent), `wave` (swell twice).
- Densities: sparse 0.2–0.35, normal 0.45–0.6, driving 0.7–0.9. Mixing levels: melody ≈ -9, pad ≈ -16, bass ≈ -10, drums ≈ -8, arp ≈ -14 dB.
- Mood via scale: `lydian` floating/hopeful, `dorian` warm minor, `aeolian` sad/cinematic, `minor_pent` bluesy/safe, `phrygian` dark/tense.
- Give a patch shape with `arranger on` + sections (intensity 0.5 → 1.3 arc, `journey=1` on the peak section).
- Slides: `expression` node with `portamento` (glide) and `glissando=on` (scale-locked runs into leaps of 3+ degrees).
- Verify your edit round-trips: `npm test` runs the LoomScript parser/serializer suite (`src/script/script.test.ts`).
