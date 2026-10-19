/**
 * Loom AudioWorklet host (PRD §8): thin JS shim around the Rust/WASM DSP core.
 * Owns the sample clock and step sequencing; all synthesis happens in WASM.
 * The same WASM core will later be hosted natively by the Tauri sidecar.
 */

const KIND_INDEX = { melody: 0, chords: 1, bass: 2, arp: 3, drums: 4, live: 5 };

class LoomProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.outL = null;
    this.outR = null;
    this.playing = false;
    this.tempo = 102;
    this.steps = 16;
    this.sampleCursor = 0;
    this.step = -1;
    this.loop = 0;
    this.patterns = null; // { kind: [{step, midis[], vel, lenSteps}] } + drums [{step,lane,vel}]
    this.absBar = 0; // timeline bar of `patterns`, echoed when it starts sounding
    this.queue = []; // upcoming bars [{absBar, patterns}], ascending
    this.fresh = false; // the first downbeat after 'start' plays the current bar
    this.pendingSteps = null;
    this.delayCfg = { division: 3, feedback: 0.35, mix: 0.25 }; // division in steps (3 = dotted 8th)
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'wasm': {
        const { instance } = await WebAssembly.instantiate(msg.bytes, {});
        this.wasm = instance.exports;
        this.wasm.init(sampleRate);
        this.refreshViews();
        this.syncDelay();
        this.port.postMessage({ type: 'ready' });
        break;
      }
      case 'patterns':
        // immediate: play now (transport start); otherwise queue the bar for its downbeat
        if (msg.immediate) {
          this.patterns = msg.patterns;
          this.absBar = msg.absBar ?? 0;
          this.queue = [];
        } else {
          this.queue = this.queue.filter((b) => b.absBar !== msg.absBar);
          this.queue.push({ absBar: msg.absBar, patterns: msg.patterns });
          this.queue.sort((a, b) => a.absBar - b.absBar);
        }
        break;
      case 'tempo':
        this.tempo = msg.bpm;
        this.syncDelay();
        break;
      case 'steps':
        // phrase length (8/16/32) — applied at the next loop boundary while playing
        if (this.playing) this.pendingSteps = msg.value;
        else this.steps = msg.value;
        break;
      case 'gain':
        if (this.wasm) this.wasm.set_gain(KIND_INDEX[msg.kind], msg.value);
        break;
      case 'mute':
        if (this.wasm) this.wasm.set_mute(KIND_INDEX[msg.kind], msg.value ? 1 : 0);
        break;
      case 'voice':
        if (this.wasm) this.wasm.set_voice(KIND_INDEX[msg.kind], msg.wave, msg.attack, msg.decay ?? -1, msg.sustain ?? -1, msg.release, msg.cutoff);
        break;
      case 'sends':
        if (this.wasm) this.wasm.set_sends(KIND_INDEX[msg.kind], msg.rev, msg.del);
        break;
      case 'glide':
        if (this.wasm) this.wasm.set_glide(KIND_INDEX[msg.kind], msg.seconds * sampleRate);
        break;
      case 'reverb':
        if (this.wasm) this.wasm.set_reverb(msg.mix);
        break;
      case 'master':
        if (this.wasm) this.wasm.set_master(msg.value);
        break;
      case 'delay':
        this.delayCfg = { division: msg.division, feedback: msg.feedback, mix: msg.mix };
        this.syncDelay();
        break;
      case 'start':
        this.sampleCursor = 0;
        this.step = -1;
        this.loop = 0;
        this.fresh = true;
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        break;
      // live MIDI/MPE input (MIDI Input node) — immediate, outside the step clock,
      // and independent of the transport (render always runs)
      case 'liveOn':
        if (this.wasm) this.wasm.live_note_on(msg.id, msg.midi, msg.vel, msg.pan ?? 0);
        break;
      case 'liveOff':
        if (this.wasm) this.wasm.live_note_off(msg.id);
        break;
      case 'liveUpd':
        if (this.wasm) this.wasm.live_note_update(msg.id, msg.midi, msg.pressure, msg.timbre);
        break;
    }
  }

  /** double-buffered swap at the bar line; a late bar repeats the current one */
  nextBar() {
    while (this.queue.length && this.queue[0].absBar <= this.absBar) this.queue.shift();
    const next = this.queue.shift();
    if (next) {
      this.patterns = next.patterns;
      this.absBar = next.absBar;
    }
  }

  refreshViews() {
    this.outL = new Float32Array(this.wasm.memory.buffer, this.wasm.out_l_ptr(), 128);
    this.outR = new Float32Array(this.wasm.memory.buffer, this.wasm.out_r_ptr(), 128);
  }

  syncDelay() {
    // tempo-synced ping-pong; division/feedback/mix come from the Delay node
    const d = this.delayCfg;
    if (this.wasm?.set_delay) this.wasm.set_delay(Math.floor(this.samplesPerStep() * d.division), d.feedback, d.mix);
  }

  samplesPerStep() {
    return (sampleRate * 60) / (this.tempo * 4);
  }

  triggerStep(step) {
    if (!this.patterns || !this.wasm) return;
    const sps = this.samplesPerStep();
    for (const kind of ['melody', 'chords', 'bass', 'arp']) {
      const events = this.patterns[kind];
      if (!events) continue;
      for (const ev of events) {
        if (ev.step !== step) continue;
        // the previous pad chord gives way within half of the new chord's length
        if (kind === 'chords') this.wasm.choke_kind(KIND_INDEX.chords, ((0.5 * ev.lenSteps * sps) / sampleRate) * 1000);
        for (let i = 0; i < ev.midis.length; i++) {
          const pan = ev.midis.length > 1 ? (i / (ev.midis.length - 1) - 0.5) * 0.6 : 0;
          this.wasm.note_on(KIND_INDEX[kind], ev.midis[i], ev.vel, Math.floor(ev.lenSteps * sps * 0.95), pan);
        }
      }
    }
    const drums = this.patterns.drums;
    if (drums) {
      for (const ev of drums) {
        if (ev.step === step) this.wasm.drum(ev.lane, ev.vel);
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.wasm || !out || out.length < 2) return true;
    if (this.wasm.memory.buffer !== this.outL?.buffer) this.refreshViews();

    if (this.playing) {
      const sps = this.samplesPerStep();
      const stepNow = Math.floor(this.sampleCursor / sps) % this.steps;
      if (stepNow !== this.step) {
        this.step = stepNow;
        if (stepNow === 0) {
          if (this.pendingSteps) {
            this.steps = this.pendingSteps;
            this.pendingSteps = null;
            this.sampleCursor = 0;
          }
          if (this.fresh) this.fresh = false;
          else this.nextBar();
          this.loop += 1;
          this.port.postMessage({ type: 'loop', loop: this.loop, absBar: this.absBar });
        }
        this.triggerStep(stepNow);
        this.port.postMessage({ type: 'step', step: stepNow });
      }
      this.sampleCursor += 128;
    }

    this.wasm.render();
    out[0].set(this.outL);
    out[1].set(this.outR);
    if (!this.nanReported && Number.isNaN(out[0][0])) {
      this.nanReported = true;
      this.port.postMessage({
        type: 'debug-nan',
        playing: this.playing,
        step: this.step,
        memBytes: this.wasm.memory.buffer.byteLength,
        viewOk: this.outL.buffer === this.wasm.memory.buffer,
        viewLen: this.outL.length,
        ptr: this.wasm.out_l_ptr(),
        raw: [this.outL[0], this.outL[1], this.outL[2]],
      });
    }
    return true;
  }
}

registerProcessor('loom-engine', LoomProcessor);
