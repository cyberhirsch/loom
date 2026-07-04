/**
 * Loom AudioWorklet host (PRD §8): thin JS shim around the Rust/WASM DSP core.
 * Owns the sample clock and step sequencing; all synthesis happens in WASM.
 * The same WASM core will later be hosted natively by the Tauri sidecar.
 */

const KIND_INDEX = { melody: 0, chords: 1, bass: 2, arp: 3, drums: 4 };

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
    this.pending = null;
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
        if (msg.immediate || !this.playing) this.patterns = msg.patterns;
        else this.pending = msg.patterns;
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
        if (this.wasm) this.wasm.set_voice(KIND_INDEX[msg.kind], msg.wave, msg.attack, msg.release, msg.cutoff);
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
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        break;
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
          if (this.pending) {
            this.patterns = this.pending;
            this.pending = null;
          }
          this.loop += 1;
          this.port.postMessage({ type: 'loop', loop: this.loop });
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
