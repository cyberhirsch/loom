# Loom — theory-aware generative music on a node canvas

**▶ Live: https://cyberhirsch.github.io/loom/**

Compose by directing an ensemble of theory-aware players instead of placing notes. Rust→WASM DSP in an AudioWorklet, React Flow canvas, seeded & deterministic. See [PRD.md](PRD.md) for the full product design and milestone status.

## Run it

```
npm install
npm run dev        # → http://localhost:5175
npm test           # theory-engine property tests
npm run build      # production build
npm run build:dsp  # rebuild the Rust DSP core → public/loom-dsp.wasm (needs rustup wasm32 target)
```

Press **▶ weave**. The ensemble is already patched and starts making music in C Minor Pentatonic.

## What's here

- **Node canvas** (React Flow, Voxelbox visual style — PRD §7.1): dark technical aesthetic, port color = cable type (Signal blue / Note gold), icon tint = category (Player gold / Modulator purple).
- **Conductor** — ambient "rules of the room" (PRD §5.2): key, scale/mode (8 scales with emotional descriptions), tempo. Hosts the loop behaviors:
  - **✶ Evolve** — coach-guided mutation on every loop boundary (add/move/remove notes, anchors protected).
  - **⇅ Journey** — modulates through related keys every N loops (home → bright fifth → relative minor → warm fourth).
- **Players** — Melody, Chords, Bass, Drums, Arp. Theory baked in: harmony-first generation against a seeded progression; the Coach's voice-leading rules (stepwise motion, leap recovery, chord-tone pull, question/answer phrases, half & perfect cadences); role-aware drums (kick anchors, snare answers, hats fill).
- **Seeds** — visible on every player; same seed = same music (verified by test). **↻ re-roll** = new take.
- **LFO node** — patch its Signal output into any player's **density** input; evaluated at loop boundaries (the modulated value shows live on the player, in blue).
- **Tension node** — the ensemble's energy curve as a CV source (the music listening to itself, PRD §5.2). Patch cv → density and the loop self-balances: saturated loops breathe out, sparse loops build. Add more modulators from the top bar (**+ lfo**, **+ tension**).
- **The audio path is nodes** (PRD §5: the patch IS the signal flow) — players emit **notes only**; nothing sounds until the notes reach an instrument whose signal reaches **Out**. Cut a cable and that player goes silent (engine-enforced, not cosmetic).
  - **Synth nodes** (Source) — notes in → signal out: waveform, attack, release, filter cutoff per instrument (lead / pad / sub / pluck presets in the default patch).
  - **Kit node** — the synthesized drum instrument (swept-sine kick, noise snare & hat).
  - **Expression node** (Note FX, PRD §5.2) — sits in a note path: **portamento** (pitch glides between notes, in the Rust DSP) and **scale-locked glissando** (quiet scale-run grace notes into leaps of 3+ degrees — can never leave the key).
  - **Delay node** — tempo-synced ping-pong echo (1/8 · dotted 1/8 · 1/4, feedback, mix); **Reverb node** — the shared room (freeverb-lite); **Out node** — master level + soft-clip limiter. Which FX a player's signal passes through determines its sends.
- **Live pattern previews** in every player node, with playhead.
- **Autosave** — the patch (nodes, cables, conductor, seeds) persists across reloads (localStorage); **reset** in the top bar restores the default ensemble.
- **↧ midi** — export the current loop (4 repeats) as a Standard MIDI File: one track per player, drums on GM channel 10. Deterministic (same seed = same file, by test) — open it in any DAW.
- **❄ freeze** (capture, PRD §5.2) — capture a player's current take: frozen players play it verbatim, immune to evolve/re-generation (it still transposes with the journey), and the take persists across reloads. Unfreeze to rejoin the generative flow.
- **↧ wav** (PRD §6.10 offline bounce) — renders the loop through the same WASM DSP in an `OfflineAudioContext`, ~30× faster than real time, to a 16-bit stereo WAV.
- **Mixer bar** (PRD §6.8) — channel strips derived from the graph; strips and node knobs edit the same store, so they're bidirectional by construction.
- **Arranger node** (PRD §5.2 generative structure) — a sequencer of sections (name, length in loops, intensity, journey stop). When *conducting*, sections scale every player's density and advance the Conductor's journey at boundaries: songs get shape (sparse → full → lift) without placing a single note.
- **Ensemble templates** (PRD §6.11) — *Ambient garden* (Lydian, tension-fed melody, evolving), *Lo-fi trio* (Dorian, swung kit), *Techno engine* (128 bpm, Arranger conducting groove/build/peak/breakdown). Pick one from the top bar and press weave.
- **Launcher scenes** (PRD §6.7) — snapshot the whole ensemble (+ scene in the mixer bar), launch scenes quantized at loop boundaries; right-click deletes. Persisted with the project.
- **Timeline strip** (PRD §6.6) — the Arranger's sections rendered across time with a live playhead: the timeline as a *view over structure nodes*, exactly as the PRD resolves it.
- **Desktop build** (PRD §8/M6) — `npx tauri build --no-bundle` produces `src-tauri/target/release/loom-desktop.exe`, the same app in a native window (launch-verified). The CLAP sidecar will live in this process; `loom-dsp`'s C ABI is the seam.
- **Deploy** (M7) — pushing to a GitHub remote auto-deploys the web beta via `.github/workflows/deploy.yml` (build + tests + Pages).

## Architecture

```
loom-dsp/      Rust DSP core → WASM: voices, ADSR, one-pole filters,
               synth kit (kick/snare/hat), tempo-synced ping-pong delay,
               freeverb-lite, soft limiter.
               Raw C ABI (no wasm-bindgen) — the same crate compiles for the
               future Tauri sidecar (PRD §8 migration guarantee, honored).
public/
  loom-dsp.wasm     compiled DSP core
  loom-worklet.js   AudioWorklet host: owns the sample clock & step sequencer,
                    double-buffers per-loop patterns, posts step/loop events
src/theory/    pure, seeded, deterministic — the crown jewel (PRD M1)
  rng.ts         mulberry32 PRNG
  scales.ts      8 scales/modes, degree→MIDI
  harmony.ts     chord cycles, progressions, journeys
  melody.ts      Coach scoring engine + Evolve
  parts.ts       bass / chords / arp / drums generators
  energy.ts      ensemble tension curve (CV source)
  theory.test.ts property tests: determinism, scale-lock, cadences
src/audio/     wasmEngine.ts — main-thread controller: the "loop brain"
               (journey / evolve / LFO / tension), resolves theory → MIDI,
               talks to the worklet over its port
src/graph/     zustand store, session helpers (ctx shared by engine & previews)
src/ui/        React Flow nodes (Conductor / Player / LFO / Tension), previews
```

**Engine data flow:** theory (main thread, pure TS) → concrete MIDI patterns → worklet (sample-accurate step clock) → Rust/WASM `render()` → speakers. Each loop's patterns are computed while the previous one plays (double-buffered). Tone.js is gone entirely — the PRD §8 rule ("never build the production engine on Web Audio nodes") is now enforced by the codebase itself.

## M0 exit test (PRD §10)

> A stranger makes a loop they'd keep in <5 min; we still like the output after an hour of listening.

Verified working: play/stop, all five players generating in-key, evolve, journey (live key modulation confirmed), LFO→density modulation, re-roll, per-player mute/volume/register/density knobs. The listening half of the exit test needs human ears — that's you.
