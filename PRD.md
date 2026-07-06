# Loom — Product Requirements Document

**A node-based digital audio workstation**

| | |
|---|---|
| **Status** | Draft v0.2 — **M0 prototype built & running** (see README.md) |
| **Author** | cyberhirsch |
| **Last updated** | 2026-07-02 |
| **Target platforms** | Web (free tier) + macOS/Windows/Linux desktop via Tauri — one web codebase, two shells (§8) |

---

## 1. Summary

Loom is a node-based environment for **theory-aware generative music**. Its signature feature — and the reason to build it — is a small set of role-based "player" nodes (**Conductor, Melody, Chords, Bass, Drums, Arp**) with music theory baked in: you compose by *directing musicians* rather than placing every note, and everything generated already sounds right (§5.2). The players are living, tweakable systems — loops that evolve, modulate through keys, and respond to modulation like any other node.

The vehicle for this is a **directed graph of nodes** on an infinite canvas: players, instruments, effects, modulators, and routing are all nodes and edges. The graph makes the flow of audio, note events, and control data explicit, visible, and editable — and it is what turns the generative engine from a toy into an instrument: any knob on any player can be driven by any modulator, and the music's own tension curve can feed back into the patch.

The thesis: **the graph *is* the project**, and **directing beats note-entry.** Where pure modular environments (Max/MSP, VCV Rack, Reaktor) expose a graph but know nothing about music, Loom's nodes know keys, chords, phrases, and cadences. Where mainstream DAWs know music, they hide routing and treat generativity as an afterthought. Loom is the tool for weaving living music.

## 2. Problem & motivation

1. **Making music that sounds right requires theory most people don't have.** Every DAW hands you a blank piano roll and assumes you know which notes work. Scale-highlighting and arpeggiators are band-aids; nothing generates *coherent parts* — melody, chords, bass, drums that agree with each other.
2. **Generative tools are either toys or engineering projects.** Phone apps that generate ambient noodles offer no control or growth; Max/Pd/VCV can build any generative system but demand you implement the music theory yourself, from raw math.
3. **Modulation and routing are second-class in conventional DAWs.** A generative system is only alive if everything can drive everything — and mainstream DAWs make cross-modulation and creative routing awkward or impossible. (This is why Loom is node-based.)

Loom targets people who want to *grow* music — set up a small ensemble of intelligent players, shape them while they play, and capture what emerges — with as much or as little theory knowledge as they bring.

## 2.1 Scope note (v0.2 revision)

Earlier drafts framed Loom as a general-purpose professional DAW. The document is now re-centered on the generative core: **players → instruments → effects → output, plus recording, arranging, and exporting what the system makes.** Heavy production features (plugin sandboxing/bridging, comping/take lanes, audio warping, control-surface profiles, broadcast-grade metering) are explicitly deferred — see §6.12.

## 3. Goals & non-goals

### Goals
- Make **theory-aware generative music** the headline: role-based player nodes that generate coherent, in-key parts, so directing beats note-entry (§5.2).
- **Blank project → a loop you'd keep in under 5 minutes**, with zero theory knowledge required.
- Represent the whole system — players, instruments, effects, routing, modulation — as one editable node graph where **anything can modulate anything**.
- Make generated music **reproducible** (seeds — see §5.2) and **capturable** (record player output into clips; arrange and export it).
- Host **third-party plugins** (CLAP first; VST3/AU after) so players can drive real instruments early.
- A stable, real-time-safe audio engine — but sized for generative composition, not live tracking (relaxed latency targets; see §9).

### Non-goals (v1)
- Being a general-purpose professional DAW (recording studio workflows, mixing/mastering depth) — see §6.12 deferred list.
- Notation/score editing.
- Video scoring / SMPTE workflows.
- Cloud collaboration / real-time co-editing (design for it later; don't build it now).
- Mobile clients. *(Web is a first-class shipping tier — see §8 — not a non-goal; only mobile is out.)*
- A built-in sample marketplace or content store.

## 4. Target users

| Persona | Description | Primary need |
|---|---|---|
| **Generative / ambient musician** *(primary)* | Wants living, evolving music; tinkers with systems; Eno-style "gardener of music" | Players that stay musical unattended; evolve/modulate/journey; everything modulatable |
| **Learner** *(primary)* | Little or no theory; wants to make music that sounds right, and understand why | Scale-locking, the Coach's plain-language reasons, sensible defaults, instant sound |
| **Electronic producer** | Writes and arranges tracks end-to-end; uses generators as a starting point | Capture-to-clip, seeds/re-roll, timeline & export; players as idea machines |
| **Sound designer / patcher** | Builds textures and systems; comes from modular | Deep routing, feedback, CV everywhere; players as pattern sources for hand-built patches |

## 5. Core concepts

- **Node** — a processing unit with typed input/output ports. Categories: ***Player*** (Conductor, Arranger, Melody, Chords, Bass, Drums, Arp — the theory-aware generators, §5.2), *Source* (oscillator, sampler, plugin instrument), *Processor* (filter, EQ, dynamics, plugin FX), ***Note FX*** (processors on Note cables — Expression, transpose, arpeggiate; §5.2), *Router* (mixer, splitter, send, matrix), *Modulator* (LFO, envelope, sequencer, macro), *IO* (audio in/out, MIDI in/out).
- **Port & edge** — typed connection points. See §5.1 for the decided connection & signal model.
- **Graph** — the canvas of nodes and edges. Supports **subgraphs** (a group of nodes collapsed into a single reusable node with exposed ports) for reuse and legibility.
- **Clip** — a container of note events or audio that plays into a node. Clips live on the **timeline** or in the **launcher grid**; they are also what player output is **captured** into (§5.2).
- **Timeline** — linear arrangement of clips against a tempo/meter grid; the "song."
- **Launcher** — a scene/clip matrix for non-linear performance (Ableton Session-view analog).
- **Transport** — global play/stop/loop/record, tempo, and a sample-accurate clock distributed to all time-aware nodes.
- **Macro / parameter** — any node parameter can be exposed, mapped to a modulator edge, MIDI-learned, or automated.

## 5.1 Connection & signal model (decided)

The design of what nodes exchange, resolved with the following decisions:

### Cable types (v1)
Four typed cable kinds ship in v1:

| Cable | Carries | Notes |
|---|---|---|
| **Signal** (Audio + CV) | Continuous stream of numbers | *Hybrid model:* audio and CV/modulation are the **same cable type** — the difference is intent (heard vs. controls a parameter). Any Signal output can drive any Signal input, including parameter ports. |
| **Note** | Structured musical events | MPE + microtonal: pitch as float (microtonal), velocity, channel, plus **per-note continuous expression** (pitch-bend / pressure / timbre). Sample-stamped. |
| **Transport / clock** | Song-time | **Ambient global** — every node implicitly knows tempo, bar/beat position, play state, and sync ticks. Not a patchable cable in v1. |

*(Note & Transport are distinct typed cables; Audio & CV are unified. Data/buffer and arbitrary-message cables are post-v1.)*

### Rate
- **Signal cables are per-port rate.** Each connection is **audio-rate** (updated every sample — smooth, needed for FM/audio-rate modulation) or **control-rate** (updated once per block — cheap). The node/port declares which; the scheduler handles both.

### Channels
- **Bundled edges.** A single Signal cable carries an **N-channel bundle** (mono, stereo, surround…). Channel count is **negotiated at connect time**. Keeps the canvas clean vs. one-cable-per-channel.

### Connection rules
- **Fan-out:** one output → many inputs, freely (signal is split to all destinations).
- **Fan-in with auto-combine:** many outputs → one input is allowed. Audio/CV inputs **auto-sum**; Note inputs **merge** the event streams. No explicit mixer node required for basic summing.
- **Type safety:** connections between incompatible cable types (e.g. Note → Signal) are rejected at connect time, with a reason. Meaningful conversions are done by explicit adapter nodes (see open questions).

### Polyphony
- **Voices inside nodes.** An instrument node manages its own pool of N simultaneous voices internally; **cables carry a single (bundled) signal**, not per-voice fan-out. DAW-like and efficient. MPE per-note expression from the Note cable is distributed by the instrument to its own voices. *(Per-voice graph expansion / poly-cables are explicitly out of scope for v1.)*

### Feedback
- Feedback loops are permitted; the engine inserts a single-sample delay to keep the graph stable and notifies the user (carried over from §6.1).

### Adapters (Note ↔ Signal conversion)
- **Explicit adapter nodes.** Bridging cable types is always a visible node — e.g. **Note→Pitch/Gate** (extract pitch-CV and gate from a Note stream to drive hand-built synths), **Envelope Follower** (audio → CV), **Pitch→Note**, etc. Types stay honest; conversion is never silent. Prebuilt instruments consume Note directly, so casual users rarely need these.

### Value & pitch conventions
- **Pitch = 1.0 per octave** on Signal cables (software analog of 1V/oct; transposition is simple addition).
- **CV is bipolar** (−1…+1); **audio is ±1** nominal (internal summing is 64-bit float and may exceed ±1 between nodes).

### Parameter ports
- **Expose-on-demand.** Node parameters are plain knobs until the user chooses to modulate one, which reveals a patchable Signal input port for it. Keeps nodes visually clean; modulating is one deliberate step.

### Port arity
- **Dynamic ports where it makes sense.** Combining/routing nodes (mixers, merges, multi-input utilities) can grow/shrink their port count; most nodes have fixed ports.

## 5.2 Signature feature: theory-aware generative music

Loom's defining capability and reason to exist: **music theory is baked into a small set of role-based generator nodes**, so you compose by directing "players" rather than placing every note — and everything generated is already in key. Reverse-engineered and generalized from the LOOM prototype (see §5.3 for the reference behaviors).

### Design philosophy — musicians, not theory primitives
The theory lives *inside* a few "player" nodes rather than being exposed as atomic operations (scale-quantize, cadence logic, third-stacking) you wire yourself. You don't build voice-leading; you drop a **Melody** node that already knows it. Guiding rule: **as few nodes as necessary.**

### The nodes
- **Conductor** *(one per song)* — the ambient **"rules of the room"**: key, scale/mode, current chord/progression, tempo, and groove/swing feel. Read implicitly by everyone (§5.1 ambient-global). It holds the *rules*, not the *story* — form lives in the Arranger.
- **Arranger** — the **generative structure/story** node (see *Structure & arrangement* below): a sequencer of sections (intro / build / drop / breakdown) and intensity over time; drives players on what to be doing, and advances the Conductor's harmonic journey at section boundaries.
- **Melody** — the lead line: phrase structure (question/answer), cadences, leap recovery, chord-tone targeting.
- **Chords** — polyphonic backing/comping with diatonic voicings.
- **Bass** — monophonic, root-driven backing.
- **Drums** — kick/snare/hat pattern generation (role-aware: kick anchors, snare answers, hats fill); density/syncopation/humanize knobs; follows the Conductor's meter, groove, and form so fills land at section boundaries.
- **Arp / Ornament** — decorative line derived from the current harmony.

The pitched players share **one internal generative engine** (Drums shares the rhythm/groove layer) but all ship as distinct, self-explanatory role nodes (a node called *Bass* beats *Part (role: bass)*). Typical canvas: one Conductor + 2–5 players.

### Instant sound — a pre-wired patch, not hidden voices
Players emit **Note** cables and are otherwise silent — there is no invisible default voice (decided 2026-07-02: "why am I hearing music? there are no instruments yet, just notes"). Sound requires the audible chain to exist as nodes: player → *(Note FX)* → **Synth/Kit** → *(FX)* → **Out**, and the engine enforces it — an unrouted player makes no sound. Instant gratification comes from the **default patch and ensemble templates shipping fully wired** instead: open Loom and the whole chain is already on the canvas, visible and re-patchable.

### Note FX — the Expression node
The first of the **Note FX** family (nodes that sit on a Note cable and transform events): a single **Expression** node providing both slide behaviors, patchable after any player, hand-played MIDI input, or clip:

- **Portamento (continuous glide):** rendered as **per-note pitch-expression curves** on the Note stream (the MPE decision in §5.1 paying off — no special engine support needed, and chords glide per-voice). Knobs: glide **time**, **amount/probability** (every note vs. occasional expressive scoops), **legato-only** (classic mono-synth behavior).
- **Glissando (discrete runs):** sweeps into target notes across steps that are **scale-locked by default** via the ambient Conductor context — a harp run that is always in key ("nothing sounds wrong" extended to ornaments; chromatic available as an option). Covers runs, grace notes, and slides into notes.

Requirement this creates: built-in default voices and instruments must honor per-note pitch expression. Later Note FX (transpose, arpeggiate, humanize, echo) join the same family.

### Seeds & determinism
Every player has a **visible seed**: same seed + same settings + same Conductor = **the same music, every time**. This makes generation reproducible ("I can get that take back"), makes **re-roll** a one-click gesture (new seed → new take), and makes projects portable. Live mutation (Evolve) advances deterministically from the seed so even "living" loops can be replayed.

### Capture — from generator to arrangement
Any player's output can be **captured into an ordinary note clip** (record live, or render N bars offline). Captured clips are freely editable and arrangeable like any other clip — the bridge from "living system" to "finished song." Both modes coexist: leave players running forever (ambient/generative use) or capture takes and arrange them (producer use).

### Coherence — how the parts agree
All players read the **same Conductor** (same key, scale, and current chord) — that shared context is what keeps them in agreement. Additionally, a player may **follow another player**: Bass locks to Chords' roots; Arp plays the Chords' current chord; Melody leaves space where Bass is busy. Leader-follower flow, like a real rhythm section.

### Driving force — harmony-first (default), invertible by routing
By default **harmony leads**: `Conductor → Chords → Melody / Bass / Arp`, all generating against the current chord. Rationale: a progression is a better shared anchor than a single melodic line, and harmony→melody is reliable where melody→harmony is ambiguous. Chord tones act as a **strong pull, not a cage** — parts land on chord tones at strong beats/cadences but move through passing/tension notes elsewhere.

**Direction is expressed by routing.** An advanced user can rewire melody-first (`Melody → Harmonizer → Chords`) to write a hook and harmonize under it. Harmony-first is the default; the graph allows inversion.

### The modular payoff
Each player exposes modulatable musical knobs — **density, complexity/adventurousness, register, syncopation, humanize**. These are ordinary CV targets, so any modulator drives them. LOOM's read-only **energy/tension curve becomes a CV output** you can patch into a player's adventurousness (self-building loops) or into any audio parameter (cutoff, reverb). Theory nodes *generate*; modulation nodes *shape* them over time.

### Structure & arrangement — both mechanisms are nodes (decided; Arranger **built**)
Song structure has two providers, and **both are nodes** — so a project chooses its structure model by *how it's patched* (authority = routing, the same principle as harmony-first vs melody-first):

- **Arranger node** — *generative* structure. A sequencer of sections + intensity; top-down "storyboard" that tells players what to do as the piece moves.
- **Timeline / Clip node** — *explicit* structure. Blocks of music placed on lanes at specific bars; bottom-up.

Three project shapes fall out, with no conflict of authority:
- **Pure generative:** Conductor + Arranger → players (the beginner default: one section, looping).
- **Pure DAW:** Timeline node → instruments; no Arranger.
- **Hybrid:** Arranger drives live players → a **Capture** step freezes a section into clips in the Timeline node → hand-edit those clips; because they now come from the Timeline node, the generator no longer touches them. "Freeze a region" = reroute it from the clip node instead of the live player — per-section, by routing.

Consistency: the **Timeline is a *view* over Timeline/Clip node(s)**, exactly as the Mixer is a view over router nodes (§6.8). Three windows (graph, mixer, timeline) onto one graph — "the timeline as a node" costs nothing in the familiar timeline UI. Progressive disclosure keeps beginners from seeing all three structure concepts at once (Timeline node + Capture appear only when committing to concrete arrangement).

### Harmonic-context propagation (decided)
The Conductor's context (key, scale, current chord, groove) is **ambient-global**, like transport: every player reads it implicitly with no wiring — consistent with the transport decision in §5.1 and the "as few cables as necessary" instinct. A patchable Harmony override (per-branch polytonality) is a possible post-v1 addition, not a v1 feature.

### Live vs. baked generation (decided)
**Both**, as described under *Capture*: players mutate live on loop boundaries (Evolve/Modulate), and any player can be captured/rendered to an editable clip. Determinism via seeds keeps the live path reproducible.

## 5.3 Reference: LOOM prototype (theory to encode)

The `loom.html` prototype defines the concrete musical behaviors the player nodes must reproduce:

- **Tonality:** 12 chromatic roots; scales/modes each with an emotional description — Major Pentatonic `[0,2,4,7,9]`, Minor Pentatonic `[0,3,5,7,10]`, Ionian/Major `[0,2,4,5,7,9,11]`, Aeolian/Minor `[0,2,3,5,7,8,10]`, Dorian, Phrygian, Lydian, Mixolydian (extensible).
- **Scale-locking:** all generated/edited pitches are in-scale — "nothing can sound wrong."
- **Diatonic chords:** triads by stacking scale-thirds (degree, +2, +4); chord cycle adapts to 5-note (`[0,2,3]`) vs 7-note (`[0,3,4,5,1]`) scales; chords labeled.
- **Coach scoring (melody):** stepwise motion > small leap (third) > repetition > big leap; chord-tone consonance bonus; **leap recovery** (step back after a jump); **phrase roles** (open / question-body / question-end / answer-body / answer-end, split at the loop midpoint); **half-cadence on the 5th** ("asks"), **perfect cadence on the root** ("resolves"); tension via non-chord tones on higher difficulty. Every suggestion carries a **plain-language reason** — keep as an optional "explain" surface.
- **Difficulty → adventurousness:** beginner/intermediate/advanced change how many/which moves are offered and the explanation depth.
- **Inspire:** one-shot full arrangement across melody + chords + bass.
- **Evolve:** live, coach-guided mutation on loop boundaries (add / move / remove notes), **protecting anchor notes** (opening home, final cadence); action probabilities driven by fill density.
- **Modulate:** harmonic **journey** through related keys/modes over time (home → V → vi → IV …), with distinct journeys for penta vs 7-note scales.
- **Energy meter:** descriptive tension/contour curve over the loop (height in register, chord tones, chords add body, decay between hits) — becomes a **CV source**, not just a display.
- **Layers & voicing:** parts at octave offsets (melody 0, chords −1, bass −2); per-part sound, volume, mute.

## 6. Key features & requirements

*The signature feature — the player-node generative system — is specified in §5.2 and is the top-priority feature of the product. The sections below cover the surrounding environment.*

### 6.1 Node graph editor
- Infinite, pannable, zoomable canvas with minimap.
- Add nodes via search palette (fuzzy, keyboard-first), drag from browser, or right-click menu.
- Drag-to-connect ports; edges show live signal type by color; invalid connections rejected with reason.
- Multi-select, box-select, copy/paste, duplicate, align, and **group into subgraph**.
- **Feedback loops permitted** with an automatic single-sample delay node inserted to keep the graph stable; user is notified.
- Per-node inline meters (level/activity) so signal flow is visible at a glance.
- Comment/annotation nodes and colored regions for organizing large patches.

### 6.2 Audio engine
- Sample-accurate, block-based processing with a **topologically-sorted graph scheduler**.
- Real-time-safe audio thread: no locks, no allocation, no I/O on the audio callback; lock-free FIFO for messages from UI/worker threads.
- Multi-core rendering: independent graph branches processed on a worker pool.
- Sample rates 44.1–192 kHz; buffer sizes 32–2048; 64-bit float internal summing.
- **Plugin delay compensation (PDC)** computed across the whole graph.
- Denormal protection; graceful CPU-overload behavior (drop-out reporting, not crash).

### 6.3 Plugin hosting
- **Web build:** **WAM (Web Audio Modules)** only — native plugins can't load in a browser sandbox (§8).
- **Tauri desktop build (Mac + PC):** native hosting via a **headless-JUCE audio sidecar** — **VST3 + AU** are the primary targets (`juce::AudioPluginFormatManager::addDefaultFormats()` covers both across Mac/PC in one API; **AU hosting is the decision-maker** since it realistically needs Apple's frameworks, which rules out a Rust-only host). CLAP is an optional later add via the CLAP SDK. `loom-dsp` compiles native and runs as processor nodes *inside* the JUCE-hosted graph, so the DSP core is not forked (§8 seam honored). **Out-of-process, crash-safe scanning + blacklist** (pattern reused from BespokeSynth's `CustomPluginScanner`). See [DESKTOP-PLUGINS-MIDI.md](docs/DESKTOP-PLUGINS-MIDI.md) for the full decision record.
- Either way, plugins appear as nodes with auto-generated ports; GUIs open in floating windows; parameters exposed as node ports so players and modulators can drive plugin instruments like any native node.

### 6.4 Instruments & effects (built-in)
- **Priority 1 — the default voices** (§5.2): a small, good-sounding set covering the players out of the box (mallet/keys/pad/bell-style poly synth, simple bass voice, drum kit).
- **Priority 2 — one flexible synth + one sampler** as patchable nodes, and a core FX set: EQ, compressor, reverb, delay, chorus, distortion/saturation, limiter, utility (gain/pan/width). *(Multiband dynamics, slicing, advanced FX: deferred.)*
- All built-ins are native nodes with fully modulatable ports.

### 6.5 Modulation & CV
- LFOs, envelopes (ADSR + multi-stage), step sequencers, random/noise, math/logic nodes (add, scale, sample-hold, quantize, comparator), and **macro knobs**.
- Any modulator output connects to any parameter port; **poly-modulation** supported (per-voice modulation on polyphonic sources).
- Sample-accurate CV so modulation is click-free and tight.

### 6.6 Timeline (arrangement)
- The timeline is a **view over Timeline/Clip node(s)** (§5.2 *Structure & arrangement*), just as the mixer is a view over router nodes — not a separate authority. Explicit structure is one of two providers; the Arranger node is the generative one.
- Multi-lane timeline; each lane routes its clips to a chosen node input.
- Note clips (including captured player takes, §5.2) and audio clips; fades, clip gain, quantize. *(Audio warping/time-stretch and comping/take lanes: deferred, §6.12.)*
- **Capture/freeze:** capturing a live player region lands it as editable clips here; those clips are thereafter owned by the timeline, not the generator.
- **Automation lanes** for any exposed parameter, in addition to graph-based modulation.
- Arrangement loop, markers, locators, tempo/meter changes.

### 6.7 Clip launcher (session)
- Scene/track grid of clips; quantized launch; scene follow-actions.
- Record from launcher into arrangement.
- Clips trigger nodes in the same graph the timeline uses — one project, two views.

### 6.8 Mixer view
- Auto-generated channel-strip view **derived from the graph** (mixer/router nodes render as strips) — a familiar surface over the underlying topology.
- Faders, pan, inserts, sends, meters, mute/solo; changes here mutate the graph and vice-versa.
- Metering: peak/RMS per strip; spectrum on master. *(LUFS/true-peak/correlation broadcast metering: deferred, §6.12.)*

### 6.9 Recording & I/O
- Audio recording from hardware inputs (ASIO/CoreAudio/WASAPI/JACK/ALSA) — enough to record a vocal or instrument over the generated bed.
- MIDI in/out with **MPE** support; **MIDI learn** for mapping knobs to player parameters. *(Named control-surface profiles: deferred, §6.12.)*
- **MPE is not gated on the sidecar:** the Web MIDI API delivers the multichannel MIDI that MPE is, so a **MIDI Input node** (MPE parsing mode) ships on the **web build first**, feeding the same MPE-native Note cables (§5.1) the Expression node already drives. Desktop adds lower latency via the sidecar. The MPE parser is pure/tested TS (`src/midi/mpe.ts`). Built-in voices must honor per-note pitch/pressure/timbre (`loom-dsp` has per-voice glide; pressure→amp + timbre→cutoff to follow). See [DESKTOP-PLUGINS-MIDI.md](docs/DESKTOP-PLUGINS-MIDI.md).

### 6.10 Project & file management
- Single project file referencing an asset folder; **self-contained "collect and save."**
- Non-destructive edits; **unlimited undo/redo** across graph, timeline, and mixer.
- Autosave + crash recovery.
- Import: WAV/AIFF/FLAC/MP3, MIDI files, stems. Export: WAV/AIFF/FLAC/MP3, stems, MIDI.
- **Offline (faster-than-real-time) bounce** and real-time bounce (for external gear).

### 6.11 Presets & templates
- Node presets, subgraph presets, and full project templates.
- **Ensemble templates** as the primary onboarding: open a template ("Ambient garden," "Lo-fi trio," "Techno engine") and a Conductor + players patch is already playing — tweak from there.
- Starter templates that present a simple layered view for newcomers, revealing the raw graph when they want it.

### 6.12 Deferred (post-v1, explicitly out of scope for now)
Professional-DAW depth that earlier drafts included, parked to protect the generative core:
- Out-of-process plugin sandboxing; architecture bridging.
- Audio warping/time-stretch; comping/take lanes; groove extraction.
- Control-surface profiles.
- LUFS/true-peak/correlation metering; multiband dynamics.
- Multi-track studio recording workflows; loopback/resample of external gear.
- Patchable per-branch Harmony override (polytonality); per-voice poly cables; scripting/DSP node; third-party node SDK.

## 7. UX principles
- **Progressive disclosure.** Beginners see tracks and a mixer; the graph is there when they want it. Experts live on the canvas.
- **Keyboard-first.** Every frequent action has a shortcut; a command palette drives everything.
- **Legibility over density.** Signal type is always color-coded; active signal is always visible; the graph should read like a diagram.
- **No dead ends.** Any parameter can be modulated, automated, mapped, or exposed — no artificial "this can't be automated" walls.
- **Consistency across views.** Graph, timeline, launcher, and mixer are four windows onto one model; edits in any propagate everywhere.

## 7.1 Visual style

The node canvas — and the app overall — adopts the **Voxelbox visual language**: a dense, dark, technical aesthetic (Blender/Houdini family), applied consistently everywhere (no separate beginner skin).

- **Palette:** layered near-black greys (`#0d0e10`→`#26292d`), hairline borders (~`#292c30`), Inter typeface, small (~11px) labels. Muted and precise.
- **Nodes:** dark body, ~4px radius, a compact header bar with **icon + label + status dot**; inputs on the left, outputs on the right in a two-column port grid; small rotated-triangle port glyphs.
- **Two-level color coding:**
  - **Port color = cable type** (§5.1): Signal, Note, Transport each get a consistent color.
  - **Node icon tint = category** (§5): Player, Source, Processor, Note FX, Router, Modulator, IO.
- Players get a distinct, slightly richer treatment within the same system (they are the stars) without breaking the technical look.
- Warmth and approachability come from **content** — ensemble templates already playing, the Coach's plain-language reasons — not from a different skin.

## 8. Architecture (high level)

**Decision: web-first codebase, shipped in two shells.** One web app is the whole product; a Tauri wrapper turns it into the desktop build. This maximizes reach, keeps a single codebase, and builds directly on the two existing prototypes (LOOM = web/Tone.js audio; Voxelbox = web/React-Flow node editor).

- **UI layer:** React + **React Flow (`@xyflow/react`)** for the node canvas (proven in Voxelbox), in the Voxelbox visual language (§7.1). Zustand-style store; retained rendering; live inline port meters.
- **Generative engine:** pure TypeScript library — scales, progressions, Coach scoring, phrase/cadence logic, seeds/determinism, groove. **Platform-agnostic and the crown jewel;** testable with zero audio dependencies (this is what M1 hardens).
- **Audio engine:** Web Audio + **AudioWorklet** for the real-time thread; heavy/custom DSP in **WASM (SIMD)**. Block-based, seeded, note-level deterministic. Latency sized for generative composition, not live tracking (§9).
- **Two shells:**
  - **Web build** — free/demo tier. Instant, shareable link, no install. Plugins limited to **WAM (Web Audio Modules)**; audio I/O and filesystem limited to what the browser exposes (File System Access API, as Voxelbox already uses).
  - **Tauri desktop build** — same UI, plus a **native (Rust/C++) sidecar** that unlocks **native plugin hosting (CLAP-first)**, better audio-device access, and a real project filesystem. Tauri's Rust backend is also the natural home for a future high-performance audio core.
- **Known browser limits (accepted):** no native plugins in the pure-web build (Tauri solves it); higher/less-controllable latency (acceptable per §9); background-tab throttling; note-level (not sample-exact) determinism.
- **Migration-path guarantee (the load-bearing constraint):** adding native plugin hosting (VST3/CLAP) later must never require a rewrite. This holds *if and only if* the real DSP is written as **portable WASM (Rust/C++) behind a clean audio-engine interface** — so the same DSP core runs in an AudioWorklet (web) and natively in the Tauri sidecar (desktop), with native plugins slotting into the native graph. **Do not build the production engine out of Tone.js / Web Audio built-in nodes** — that DSP would be browser-only and force a re-implementation. Web stays a permanent free tier; desktop is additive, not a replacement. *(M0 may use Tone.js precisely because it is throwaway; the discipline begins at M2.)*
- **Project format:** human-diffable serialized graph (versioned schema) + asset sidecar; forward/backward-compat migration.
- **Extensibility (post-v1):** node SDK; scripting/DSP node.

## 9. Success metrics
- **The headline metric:** median time from blank project to a loop the user *keeps* (plays >3 times or captures/exports) — **target: under 5 minutes**, with zero theory knowledge.
- **Generative engagement:** % of sessions using player nodes; % of generated material kept vs. cleared; % of users who modulate a player knob (the modular payoff landing).
- **Musical quality (pre-launch):** blind listening panels rate player output "sounds intentional" at a target approval rate; the Coach's suggestions preferred over random in-scale placement.
- **Reproducibility:** re-opening a project with the same seeds reproduces the same music, bit-for-bit at the note level (verified in CI).
- **Performance:** stable playback of a reference ensemble (Conductor + 5 players + FX) well under one core; engine sized for generative composition — latency targets relaxed vs. tracking DAWs (< 30 ms acceptable; zero audio-thread allocations still verified in CI).
- **Stability:** plugin crash rate contained by crash-guarded scanning; crash-free session rate > 99.5%.
- **Adoption:** % of new users who complete a first export; retention at 30/90 days.

## 10. Milestones (proposed)

**Principle: prove the music first, harden the engine second.** The generative engine is pure logic — it can be validated on a throwaway stack (even web/Tone.js) before any real-time engine exists. Earlier drafts built a year of infrastructure before the signature feature; this ordering inverts that.

| Phase | Scope | Exit test |
|---|---|---|
| **M0 — Generative prototype** ✅ **built** | Conductor + Melody + Chords + Bass + Drums (+ Arp) on a React-Flow canvas (Voxelbox style) with sound via **Tone.js in the browser** (throwaway — that's the point). Seeds, Evolve, Modulate/Journey, LFO→density modulation, **Tension node** (ensemble energy as CV — the §5.2 payoff) — all verified running. Theory engine already pure & property-tested (head start on M1). | A stranger makes a loop they'd keep in <5 min; we still like the output after an hour of listening — *human listening pass pending* |
| **M1 — Theory engine hardened** 🟡 **motif grammar + audition built** | Extract the player engine as a pure, tested TS library (the product's crown jewel): scales, progressions, Coach scoring, phrase/cadence logic, seeds/determinism, Drums groove layer. **Status: Melody now generates via Schoenberg-style sentence grammar (statement/restatement/contrast/cadence) + one-climax contour rules + auditioned takes (best of 6 candidates by Coach score). Variable phrase lengths (8/16/32 steps). Motif node (patchable idea seed + shape) pins the theme's rhythmic and contour character. 31 property tests: determinism, scale-lock, motif repetition, cadence landing.** | Deterministic across browsers; property-tested (always in scale, cadences land, motif repeats); listening-panel pass |
| **M2 — Real audio engine + graph** 🟡 **core built** | **Production engine as portable WASM DSP behind a clean interface, running in AudioWorklet** (§8 migration guarantee); graph scheduler; canvas editor with the §5.1 signal model; players run on it with default voices. Web build shippable. **Status: Rust→WASM DSP core (voices/kit/reverb/limiter, raw C ABI) + AudioWorklet host built & verified sounding; Tone.js removed. Language question resolved: Rust.** Remaining: full §5.1 graph scheduler generality, richer voices. | The M0 patch rebuilt on the real engine, sounding identical (same seeds) ✅ *(same theory engine drives both — deterministic by test)*; runs as a shareable web link |
| **M3 — Instruments, FX & WAM** 🟡 **FX growing** | Built-in synth/sampler/kit, core FX set (all portable DSP); WAM plugin hosting in the web build; players drive them. **Status: instruments & FX are now explicit nodes — Synth (wave/attack/release/cutoff) ×4 + Kit + Expression (portamento in DSP, scale-locked glissando) + Delay + Reverb + Out, engine-enforced routing (unrouted = silent), all DSP in the Rust core. Remaining: sampler, EQ/compressor, WAM hosting.** | An ensemble template sounds *good*, not demo-good |
| **M4 — Capture, timeline & modulation** 🟡 **capture + export + timeline view built** | Capture-to-clip, arrangement view, automation lanes, full modulator node set, macros. **Status: (1) deterministic Standard-MIDI-File export; (2) capture/freeze (§5.2 'freeze a region out of the generative flow', working); (3) timeline strip — a live view over the Arranger's sections with audible-position playhead (§6.6 'timeline is a view over structure nodes', working).** Remaining: automation lanes, clip-level editing. | Generate → capture → arrange → a finished 2-min piece, entirely in Loom |
| **M5 — Launcher, mixer & polish** 🟡 **launcher + mixer + templates built** | Session/launcher view, graph-derived mixer, ensemble templates, export/stems, crash recovery. **Status: launcher scenes shipped (§6.7 — ensemble snapshots, launched quantized at loop boundaries, persisted; verified save/launch/restore); graph-derived mixer bar; offline WAV bounce (~30× real time); 3 ensemble templates.** Remaining: per-clip scene grid, stems export. | A performable live set from launcher scenes |
| **M6 — Desktop + native plugins** 🟡 **shell built; plugin path decided** | **Tauri shell + headless-JUCE audio sidecar hosting VST3 + AU (Mac + PC)** — `loom-dsp` compiled native as nodes inside the JUCE graph (§8 seam), out-of-process crash-safe scanning, better audio I/O & filesystem; CLAP optional later. **Status: Tauri desktop shell built & launch-verified on Windows (`loom-desktop.exe`, 8.3 MB, real window). Plugin-hosting + MPE direction decided (JUCE-headless, AU-driven) — see [DESKTOP-PLUGINS-MIDI.md](docs/DESKTOP-PLUGINS-MIDI.md). MPE parser (`src/midi/mpe.ts`) built & tested. Remaining: MIDI Input node + live-note engine path, then the JUCE sidecar.** | The same project runs identically in web and desktop; a VST3/AU plugin loads as a node; an MPE controller plays it |
| **M7 — Beta** ✅ **web beta LIVE** | Performance tuning, docs, onboarding. **Status: public web beta deployed and verified serving at https://cyberhirsch.github.io/loom/ (CI: install → tests → build → Pages on every push to main). Desktop beta distribution + onboarding polish remain.** | Public beta (web + desktop) — *web: shipped* |

## 11. Risks & open questions

### Resolved
- **Who arranges the song?** — **Both structure mechanisms are nodes; authority = routing** (§5.2 *Structure & arrangement*). Arranger (generative) and Timeline/Clip (explicit) are peers; projects are pure-generative / pure-DAW / hybrid by patching; Capture freezes regions into the timeline. Remaining detail for M4: exact Capture/freeze rules and playback of blended live+clip regions.

### Risks
- **The music isn't good enough.** The whole product stands on player output being musical for hours, not minutes. *Mitigation:* M0/M1 ordering — prove the music before building infrastructure; listening panels as a release gate.
- **Generic-ness.** Harmony-locked generation can drift toward wallpaper. *Mitigation:* tension/adventurousness knobs, the Coach's non-chord-tone logic, Evolve's anchor protection; test against "sounds intentional" panel metric.
- **Complexity vs. approachability.** The graph could overwhelm the primary personas. *Mitigation:* ensemble templates that are already playing on open; progressive disclosure; validate with theory-free users early.
- **Feedback & latency semantics.** Auto-inserted delay in feedback loops must be predictable and documented.
- **Plugin hosting depth.** Even CLAP-only hosting has edge cases; in-process hosting means plugin crashes can take the app down in v1. *Mitigation:* crash-guarded scanning, autosave, sandboxing on the §6.12 list.
- **GPU UI on Linux** across drivers/compositors is a known pain point.

### Open
- Licensing model — likely **free web tier + paid desktop** (native plugins) and/or paid ensembles; to confirm.
- How much graph is hidden in the beginner-facing templates?
- ~~WASM DSP language for the M2 engine (Rust vs. C++)~~ — **resolved: Rust** (toolchain present; `loom-dsp` crate built and running in production path).

---

*Draft v0.2 — re-centered on the generative core (see §2.1). The connection model (§5.1) and generative design (§5.2–5.3) are decided; the Conductor-vs-timeline question (§11) is the next design session. M0 — the playable generative prototype — is the next build step.*
