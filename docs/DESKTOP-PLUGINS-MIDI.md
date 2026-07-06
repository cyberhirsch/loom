# Desktop standalone, plugin hosting & MPE MIDI — decisions & takeaways

Status: **decided 2026-07-06**, informed by a read-through of [BespokeSynth](https://github.com/BespokeSynth/BespokeSynth) (GPLv3, JUCE/C++, ~376 modules) as a reference host. This doc records the direction; PRD §6.3/§6.9/§8 and M6 are the home for the formal spec.

## The goal

Loom runs standalone on **macOS and Windows** and hosts third-party instrument/effect plugins in the **VST3 and AU** formats (AU is Mac-only), plus connects **MPE MIDI** controllers (ROLI Seaboard, LinnStrument, Haken Continuum). The web build stays a permanent free tier (WAM-only, no native plugins).

## The load-bearing decision: headless JUCE inside the Tauri sidecar

Loom is web-first (React UI + `loom-dsp` Rust→WASM in an AudioWorklet). VST/AU hosting is impossible in a browser sandbox — it needs a native process. So the **desktop build** (Tauri shell, already launch-verified as `loom-desktop.exe`) grows a **native audio sidecar**, and the sidecar is where plugins live.

**What the sidecar is built on: JUCE — used headless (audio modules only, no `juce_gui`).**

Why JUCE and not the Rust/CLAP-first path we leaned toward before **MPE + AU** entered the requirements:

- **AU hosting is the decider.** AU is Apple-only and realistically requires Apple's AudioUnit/AVFoundation frameworks. There is no mature Rust AU host — doing it from Rust means Objective-C++ glue and a research project. JUCE's `juce::AudioPluginFormatManager::addDefaultFormats()` hosts **VST3 + AU (Mac) + LV2** across all platforms through one API. Bespoke does exactly this (`VSTScanner.cpp`).
- **Cross-platform for free.** One codepath covers Mac + PC for both formats. A Rust sidecar would reimplement, per-format, what JUCE already ships.
- **MPE parsing is included.** JUCE has `MPEInstrument` / `MPEZoneLayout` / `MPESynthesiser` (zone + channel-rotation logic), and routes MPE as multichannel MIDI into VST3/AU — the way those formats consume it in practice.

Trade accepted: a second native audio stack (JUCE) sits beside `loom-dsp`. We keep this coherent by **not** letting JUCE replace the DSP core:

```
Desktop process (Tauri)
├─ React UI            ← unchanged, in the Tauri webview
└─ Audio sidecar (headless JUCE: juce_audio_devices + juce_audio_processors)
   ├─ device I/O (CoreAudio / WASAPI / ASIO)
   ├─ plugin host: VST3 + AU  (+ CLAP optional, via the CLAP SDK — not free from JUCE)
   ├─ MPE MIDI input
   └─ loom-dsp (compiled NATIVE) = Loom's own players/voices/FX as processor nodes
```

`loom-dsp`'s raw C ABI (the seam the PRD §8 guarantee was built around) is what lets the same DSP core run in the AudioWorklet (web) and as native nodes inside the JUCE-hosted graph (desktop). UI↔sidecar talk over IPC/shared memory. **CLAP is demoted to optional** now that the explicit ask is VST+AU; it stays a nice-to-have (cleanest MPE→plugin routing) we can add via the CLAP SDK's host helpers later.

## MPE — Loom already bet on it, so no redesign

Loom's **Note cable is MPE-native by decision** (PRD §5.1: pitch as float/microtonal, per-note pitch-bend/pressure/timbre, sample-stamped), and the **Expression node** was built to exploit it (portamento = per-note pitch curves; "the MPE decision paying off"). An MPE surface plugs into a model the players, cables, and Expression node already speak.

- **MPE input is NOT gated on the sidecar.** The **Web MIDI API** delivers the multichannel MIDI that MPE *is*, in Chromium (Loom's web-beta target). So a **MIDI Input node** with an MPE mode ships on the **web build first**, feeding the same Note cables — no native code. Desktop later adds lower latency + background-tab immunity via the sidecar.
- **This splits MPE and VST into separate milestones**, not one.
- **Concrete DSP task:** `loom-dsp` voices already do per-voice pitch glide (`set_glide`); extend per-voice modulation to **pressure→amplitude** and **timbre(CC74)→cutoff** so built-in voices honor MPE gestures (PRD §5.2 requirement, now testable with real hardware and with the Expression node's generated curves).

## What we salvage from BespokeSynth (design, not code — it's GPLv3)

1. **Out-of-process, crash-safe plugin scanning** (`VSTScanner.h` `CustomPluginScanner` → `juce::ChildProcessCoordinator`/`Worker`, results cached to XML). A plugin that crashes on scan must not take the host down. This is the single most valuable pattern to copy — it's the "crash-guarded scanning + blacklist" of PRD §6.3/§6.12 and is easy to get wrong.
2. **Plugin-as-node wrapper** (`VSTPlugin : IAudioProcessor, INoteReceiver, IDrawableModule`): a hosted plugin is one node that takes a Note cable (instrument) or Signal cable (effect), emits Signal, auto-generates ports from the plugin's bus layout, and opens its GUI in a floating window.
3. **Ableton Link** (permissive lib; Bespoke's `AbletonLink.cpp`) — sync with hardware/other apps. Loom has nothing here; strong later differentiator, not v1-critical.
4. **Rejected:** Bespoke's 8 cable types (Note/Audio/UIControl/Grid/Special/Pulse/Modulator/ValueSetter) and 376 primitive modules. That maximalism is the opposite of Loom's minimal, role-based ethos — we keep unified Signal + expose-on-demand params.

## Licensing to confirm

- **BespokeSynth is GPLv3** — read/learn/reimplement clean-room only; never copy source unless Loom goes GPLv3.
- **JUCE** is dual-licensed (GPLv3 or commercial/JUCE-personal with revenue thresholds & splash requirements). Loom's likely "free web + paid desktop" model (PRD §11 open) must be squared with JUCE's terms before shipping a desktop binary.
- **VST3 SDK**: GPLv3 or Steinberg's proprietary license. **AU**: Apple SDK terms. **VST2**: SDK no longer distributed — skip it, VST3+AU cover the ask.

## Build sequence

1. **MPE parser + MIDI Input node on the web build** (Web MIDI, pure TS parser — unit-testable, no hardware needed to test the parser; no sidecar). ← *first shippable slice, in progress*
2. **`loom-dsp` per-voice expression**: add pressure→amp, timbre→cutoff (verify via Expression node + WAV bounce).
3. **Live-note engine path**: main thread → worklet immediate note-on/off → target voice (so MIDI/MPE actually sounds, unquantized).
4. **JUCE-headless sidecar scaffold**: device I/O + VST3/AU hosting + out-of-process scanner (Bespoke's pattern) + `loom-dsp` native nodes + Tauri IPC.
5. **MPE routing into hosted plugins**; then CLAP as an optional add.
