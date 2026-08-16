# Desktop standalone, plugin hosting & MPE MIDI — decisions & takeaways

Status: **decided 2026-07-06, amended 2026-08-16** (shell shape revised: single JUCE app embedding the web UI, replacing the Tauri + sidecar split — ratified by the user). Informed by a read-through of [BespokeSynth](https://github.com/BespokeSynth/BespokeSynth) (GPLv3, JUCE/C++, ~376 modules) as a reference host. This doc records the direction; PRD §6.3/§6.9/§8 and M6 are the home for the formal spec.

## The goal

Loom runs standalone on **macOS and Windows** and hosts third-party instrument/effect plugins in the **VST3 and AU** formats (AU is Mac-only), plus connects **MPE MIDI** controllers (ROLI Seaboard, LinnStrument, Haken Continuum). The web build stays a permanent free tier (WAM-only, no native plugins).

## The load-bearing decision: one JUCE app embedding the web UI

Loom is web-first (React UI + `loom-dsp` Rust→WASM in an AudioWorklet). VST/AU hosting is impossible in a browser sandbox — it needs a native process. So the **desktop build** becomes a **single JUCE application** that embeds the existing React UI in a webview (JUCE 8 `WebBrowserComponent`: WebView2 on Windows, WKWebView on Mac, with a built-in JS↔C++ bridge). **This replaces the earlier Tauri + separate-headless-sidecar shape** (amended 2026-08-16): two processes meant plugin editor windows living in the wrong process (cross-process z-order/focus pain), two build systems, and an IPC protocol for every knob turn — while the only real prize, crash isolation, is covered by out-of-process *scanning* anyway.

Why JUCE and not the Rust/CLAP-first path we leaned toward before **MPE + AU** entered the requirements:

- **AU hosting is the decider.** AU is Apple-only and realistically requires Apple's AudioUnit/AVFoundation frameworks. There is no mature Rust AU host — doing it from Rust means Objective-C++ glue and a research project. JUCE's `juce::AudioPluginFormatManager::addDefaultFormats()` hosts **VST3 + AU (Mac) + LV2** across all platforms through one API. Bespoke does exactly this (`VSTScanner.cpp`).
- **Cross-platform for free.** One codepath covers Mac + PC for both formats. A Rust sidecar would reimplement, per-format, what JUCE already ships.
- **MPE parsing is included.** JUCE has `MPEInstrument` / `MPEZoneLayout` / `MPESynthesiser` (zone + channel-rotation logic), and routes MPE as multichannel MIDI into VST3/AU — the way those formats consume it in practice.
- **JUCE's `AudioPluginHost` example is a node-graph plugin host** — a maintained skeleton of most of M6, including the out-of-process scanner wiring.
- **Loom-as-a-plugin becomes a build target.** JUCE builds standalone *and* VST3/AU targets from one codebase — Loom running as a generative instrument/MIDI-FX inside Ableton/Logic is unlocked by this shape and by no other.

Trade accepted: a second native audio stack (JUCE) sits beside `loom-dsp`. We keep this coherent by **not** letting JUCE replace the DSP core, and by keeping the native side **dumb** — the theory engine stays in TypeScript in the UI layer, exactly as with the worklet today (UI computes patterns; the native side is a sample-accurate player):

```
Desktop app (one JUCE process, Mac + PC)
├─ React UI            ← unchanged, in a JUCE 8 WebBrowserComponent (JS bridge)
└─ Audio engine (juce_audio_devices + juce_audio_processors)
   ├─ device I/O (CoreAudio / WASAPI / ASIO)
   ├─ plugin host: VST3 + AU — editor windows are ordinary child windows
   ├─ MPE MIDI input
   └─ loom-dsp (compiled NATIVE) = Loom's own players/voices/FX as processor nodes
```

`loom-dsp`'s raw C ABI (the seam the PRD §8 guarantee was built around) is what lets the same DSP core run in the AudioWorklet (web) and as native nodes inside the JUCE-hosted graph (desktop). The Tauri shell is retired for desktop (it cost ~a day; sunk cost noted and dismissed). **CLAP is demoted to optional** now that the explicit ask is VST+AU; it stays a nice-to-have (cleanest MPE→plugin routing) we can add via the CLAP SDK's host helpers later.

**Licensing direction: GPLv3 for the desktop build** (repo is already public; with GPLv3, JUCE and the VST3 SDK are free and Bespoke patterns/code become usable). A LICENSE file has not been added yet — that final, legally binding step awaits explicit sign-off, together with the note that the repo currently has *no* license at all ("all rights reserved" by default).

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

1. **MPE parser on the web build** (pure TS, unit-testable without hardware) — ✅ done (`src/midi/mpe.ts`, 10 tests).
2. **Live-note engine path + per-voice expression**: `loom-dsp` gains held live voices (no fixed duration) with per-voice pitch/pressure→amp/timbre→cutoff; worklet gets immediate live note messages outside the step clock.
3. **MIDI Input node** (web, Web MIDI API): device pick, MPE + plain-MIDI modes, feeding the live path through the node graph's routing (must be cabled to a synth to sound — same law as players).
4. **JUCE app scaffold** (from the `AudioPluginHost` example): webview UI + device I/O + VST3/AU hosting + out-of-process scanner (Bespoke's pattern) + `loom-dsp` native nodes.
5. **MPE routing into hosted plugins**; then CLAP as an optional add; then the Loom-as-plugin build target.
