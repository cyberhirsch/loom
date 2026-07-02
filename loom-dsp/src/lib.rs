//! Loom DSP core (PRD §8): portable Rust compiled to WASM, hosted by an
//! AudioWorklet on the web and (later) natively by the Tauri sidecar.
//! Raw C ABI — no wasm-bindgen — so the same crate compiles anywhere.
//! Zero allocation in the render path.

#![allow(static_mut_refs)]

const BLOCK: usize = 128;
const MAX_VOICES: usize = 48;

// player kinds
const K_MELODY: u32 = 0;
const K_CHORDS: u32 = 1;
const K_BASS: u32 = 2;
const K_ARP: u32 = 3;
const K_DRUMS: u32 = 4;
const NUM_KINDS: usize = 5;

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Off,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy)]
struct VoiceParams {
    attack: f32,  // seconds
    decay: f32,
    sustain: f32, // level 0..1
    release: f32,
    cutoff: f32,  // one-pole lowpass cutoff Hz
    wave: u32,    // 0 sine, 1 triangle, 2 square, 3 saw
    send: f32,    // reverb send
}

const fn params_for(kind: u32) -> VoiceParams {
    match kind {
        K_MELODY => VoiceParams { attack: 0.004, decay: 0.32, sustain: 0.06, release: 0.5, cutoff: 5200.0, wave: 1, send: 0.35 },
        K_CHORDS => VoiceParams { attack: 0.10, decay: 0.40, sustain: 0.55, release: 1.3, cutoff: 3400.0, wave: 0, send: 0.45 },
        K_BASS => VoiceParams { attack: 0.008, decay: 0.30, sustain: 0.30, release: 0.30, cutoff: 900.0, wave: 2, send: 0.06 },
        _ => VoiceParams { attack: 0.002, decay: 0.14, sustain: 0.02, release: 0.25, cutoff: 6500.0, wave: 1, send: 0.40 },
    }
}

/// delay send per kind (ping-pong echo — melody & arp mostly)
const fn delay_send(kind: u32) -> f32 {
    match kind {
        K_MELODY => 0.30,
        K_ARP => 0.35,
        _ => 0.0,
    }
}

const MAX_DELAY: usize = 96000; // 2s @ 48k

struct Delay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    idx: usize,
    samples: usize,
    feedback: f32,
    mix: f32,
}

#[derive(Clone, Copy)]
struct Voice {
    stage: Stage,
    kind: u32,
    phase: f32,
    freq: f32,
    freq_target: f32,
    glide_coef: f32, // per-sample freq multiplier; 1.0 = no glide
    level: f32,
    vel: f32,
    remaining: i64, // samples until release
    lp: f32,
    pan: f32,
}

impl Voice {
    const fn new() -> Self {
        Voice { stage: Stage::Off, kind: 0, phase: 0.0, freq: 440.0, freq_target: 440.0, glide_coef: 1.0, level: 0.0, vel: 1.0, remaining: 0, lp: 0.0, pan: 0.0 }
    }
}

struct Kick {
    phase: f32,
    freq: f32,
    level: f32,
    active: bool,
    vel: f32,
}

struct NoiseHit {
    level: f32,
    active: bool,
    vel: f32,
    decay_per_sample: f32,
    hp_last_in: f32,
    hp_last_out: f32,
    hp_coef: f32,
    lp: f32,
    lp_coef: f32,
}

// Freeverb-style comb + allpass (fixed sizes scaled at init for sample rate)
const COMBS: [usize; 4] = [1116, 1188, 1277, 1356];
const MAX_COMB: usize = 2048;
const AP_LEN: usize = 556;
const MAX_AP: usize = 1024;

struct Comb {
    buf: [f32; MAX_COMB],
    len: usize,
    idx: usize,
    filt: f32,
}

struct Allpass {
    buf: [f32; MAX_AP],
    len: usize,
    idx: usize,
}

struct Engine {
    sr: f32,
    voices: [Voice; MAX_VOICES],
    kick: Kick,
    snare: NoiseHit,
    hat: NoiseHit,
    gains: [f32; NUM_KINDS],
    mutes: [bool; NUM_KINDS],
    // per-kind voice/routing state, set by the host from the node graph
    voice_params: [VoiceParams; NUM_KINDS],
    rev_sends: [f32; NUM_KINDS],
    delay_sends: [f32; NUM_KINDS],
    glide_samples: [f32; NUM_KINDS],
    last_midi: [f32; NUM_KINDS],
    reverb_out: f32,
    master: f32,
    combs_l: [Comb; 4],
    combs_r: [Comb; 4],
    ap_l: Allpass,
    ap_r: Allpass,
    delay: Delay,
    noise: u32,
    rr: usize, // round-robin voice cursor
}

static mut OUT_L: [f32; BLOCK] = [0.0; BLOCK];
static mut OUT_R: [f32; BLOCK] = [0.0; BLOCK];
static mut ENGINE: Option<Engine> = None;

fn soft_clip(x: f32) -> f32 {
    let x = if x > 2.5 { 2.5 } else if x < -2.5 { -2.5 } else { x };
    x * (27.0 + x * x) / (27.0 + 9.0 * x * x)
}

impl Engine {
    fn new(sr: f32) -> Self {
        let scale = sr / 44100.0;
        let mk_comb = |base: usize, offset: usize| Comb {
            buf: [0.0; MAX_COMB],
            len: (((base + offset) as f32) * scale) as usize % MAX_COMB,
            idx: 0,
            filt: 0.0,
        };
        Engine {
            sr,
            voices: [Voice::new(); MAX_VOICES],
            kick: Kick { phase: 0.0, freq: 150.0, level: 0.0, active: false, vel: 1.0 },
            snare: NoiseHit {
                level: 0.0, active: false, vel: 1.0,
                decay_per_sample: 1.0 / (0.16 * sr),
                hp_last_in: 0.0, hp_last_out: 0.0,
                hp_coef: 0.95,
                lp: 0.0, lp_coef: 0.35,
            },
            hat: NoiseHit {
                level: 0.0, active: false, vel: 1.0,
                decay_per_sample: 1.0 / (0.05 * sr),
                hp_last_in: 0.0, hp_last_out: 0.0,
                hp_coef: 0.75,
                lp: 0.0, lp_coef: 0.9,
            },
            gains: [0.35, 0.16, 0.32, 0.2, 0.4],
            mutes: [false; NUM_KINDS],
            voice_params: [params_for(0), params_for(1), params_for(2), params_for(3), params_for(4)],
            rev_sends: [
                params_for(0).send,
                params_for(1).send,
                params_for(2).send,
                params_for(3).send,
                params_for(4).send,
            ],
            delay_sends: [delay_send(0), delay_send(1), delay_send(2), delay_send(3), delay_send(4)],
            glide_samples: [0.0; NUM_KINDS],
            last_midi: [0.0; NUM_KINDS],
            reverb_out: 0.28,
            master: 1.0,
            combs_l: [mk_comb(COMBS[0], 0), mk_comb(COMBS[1], 0), mk_comb(COMBS[2], 0), mk_comb(COMBS[3], 0)],
            combs_r: [mk_comb(COMBS[0], 23), mk_comb(COMBS[1], 23), mk_comb(COMBS[2], 23), mk_comb(COMBS[3], 23)],
            ap_l: Allpass { buf: [0.0; MAX_AP], len: (AP_LEN as f32 * scale) as usize % MAX_AP, idx: 0 },
            ap_r: Allpass { buf: [0.0; MAX_AP], len: ((AP_LEN + 19) as f32 * scale) as usize % MAX_AP, idx: 0 },
            delay: Delay {
                buf_l: vec![0.0; MAX_DELAY],
                buf_r: vec![0.0; MAX_DELAY],
                idx: 0,
                samples: (sr * 0.42) as usize % MAX_DELAY,
                feedback: 0.35,
                mix: 0.25,
            },
            noise: 0x2545_f491,
            rr: 0,
        }
    }

    fn noise(&mut self) -> f32 {
        // xorshift32 → -1..1
        let mut x = self.noise;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.noise = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn note_on(&mut self, kind: u32, midi: f32, vel: f32, dur_samples: u32, pan: f32) {
        // steal: first Off, else quietest
        let mut slot = 0;
        let mut best = f32::MAX;
        for (i, v) in self.voices.iter().enumerate() {
            let i2 = (i + self.rr) % MAX_VOICES;
            if self.voices[i2].stage == Stage::Off {
                slot = i2;
                best = -1.0;
                break;
            }
            if v.level < best {
                best = v.level;
                slot = i;
            }
        }
        self.rr = (self.rr + 1) % MAX_VOICES;
        let target = 440.0 * f32::powf(2.0, (midi - 69.0) / 12.0);
        // portamento (Expression node): start at the previous note's pitch and
        // glide exponentially to the target over glide_samples
        let gs = self.glide_samples[kind as usize];
        let last = self.last_midi[kind as usize];
        let (freq, coef) = if gs > 1.0 && last > 0.0 && (last - midi).abs() > 0.01 {
            let start = 440.0 * f32::powf(2.0, (last - 69.0) / 12.0);
            (start, f32::powf(target / start, 1.0 / gs))
        } else {
            (target, 1.0)
        };
        self.last_midi[kind as usize] = midi;
        self.voices[slot] = Voice {
            stage: Stage::Attack,
            kind,
            phase: 0.0,
            freq,
            freq_target: target,
            glide_coef: coef,
            level: 0.0,
            vel,
            remaining: dur_samples as i64,
            lp: 0.0,
            pan,
        };
    }

    fn drum(&mut self, lane: u32, vel: f32) {
        match lane {
            0 => {
                self.kick = Kick { phase: 0.0, freq: 160.0, level: 1.0, active: true, vel };
            }
            1 => {
                self.snare.level = 1.0;
                self.snare.active = true;
                self.snare.vel = vel;
            }
            _ => {
                self.hat.level = 1.0;
                self.hat.active = true;
                self.hat.vel = vel;
            }
        }
    }

    fn render(&mut self) {
        let inv_sr = 1.0 / self.sr;
        unsafe {
            for i in 0..BLOCK {
                let mut dry_l = 0.0f32;
                let mut dry_r = 0.0f32;
                let mut wet_in = 0.0f32;
                let mut del_in = 0.0f32;

                // pitched voices
                for v in self.voices.iter_mut() {
                    if v.stage == Stage::Off {
                        continue;
                    }
                    let p = self.voice_params[v.kind as usize];
                    // envelope
                    match v.stage {
                        Stage::Attack => {
                            v.level += inv_sr / p.attack;
                            if v.level >= 1.0 {
                                v.level = 1.0;
                                v.stage = Stage::Decay;
                            }
                        }
                        Stage::Decay => {
                            v.level -= (1.0 - p.sustain) * inv_sr / p.decay;
                            if v.level <= p.sustain {
                                v.level = p.sustain;
                                v.stage = Stage::Sustain;
                            }
                        }
                        Stage::Sustain => {}
                        Stage::Release => {
                            v.level -= inv_sr / p.release * p.sustain.max(0.08);
                            if v.level <= 0.0 {
                                v.level = 0.0;
                                v.stage = Stage::Off;
                                continue;
                            }
                        }
                        Stage::Off => continue,
                    }
                    v.remaining -= 1;
                    if v.remaining <= 0 && v.stage != Stage::Release {
                        v.stage = Stage::Release;
                    }
                    // portamento glide toward the target pitch
                    if v.glide_coef != 1.0 {
                        v.freq *= v.glide_coef;
                        if (v.glide_coef > 1.0 && v.freq >= v.freq_target)
                            || (v.glide_coef < 1.0 && v.freq <= v.freq_target)
                        {
                            v.freq = v.freq_target;
                            v.glide_coef = 1.0;
                        }
                    }
                    // oscillator
                    v.phase += v.freq * inv_sr;
                    if v.phase >= 1.0 {
                        v.phase -= 1.0;
                    }
                    let raw = match p.wave {
                        0 => (v.phase * core::f32::consts::TAU).sin(),
                        1 => 4.0 * (v.phase - 0.5).abs() - 1.0,
                        2 => if v.phase < 0.5 { 0.9 } else { -0.9 },
                        _ => 2.0 * v.phase - 1.0,
                    };
                    // one-pole lowpass
                    let a = (p.cutoff * inv_sr * core::f32::consts::TAU).min(0.99);
                    v.lp += a * (raw - v.lp);
                    let s = v.lp * v.level * v.vel;
                    let g = if self.mutes[v.kind as usize] { 0.0 } else { self.gains[v.kind as usize] };
                    let l = s * g * (1.0 - v.pan * 0.5);
                    let r = s * g * (1.0 + v.pan * 0.5);
                    dry_l += l;
                    dry_r += r;
                    wet_in += s * g * self.rev_sends[v.kind as usize];
                    del_in += s * g * self.delay_sends[v.kind as usize];
                }

                // drums
                let dg = if self.mutes[K_DRUMS as usize] { 0.0 } else { self.gains[K_DRUMS as usize] };
                if self.kick.active {
                    self.kick.freq += (45.0 - self.kick.freq) * 28.0 * inv_sr;
                    self.kick.phase += self.kick.freq * inv_sr;
                    if self.kick.phase >= 1.0 {
                        self.kick.phase -= 1.0;
                    }
                    self.kick.level -= inv_sr / 0.32;
                    if self.kick.level <= 0.0 {
                        self.kick.active = false;
                    } else {
                        let s = (self.kick.phase * core::f32::consts::TAU).sin() * self.kick.level * self.kick.vel * 1.5;
                        dry_l += s * dg;
                        dry_r += s * dg;
                        wet_in += s * dg * 0.05;
                    }
                }
                if self.snare.active {
                    let n = {
                        let mut x = self.noise;
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        self.noise = x;
                        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
                    };
                    self.snare.lp += self.snare.lp_coef * (n - self.snare.lp);
                    let hp = self.snare.lp - self.snare.hp_last_out * self.snare.hp_coef;
                    self.snare.hp_last_out = self.snare.lp;
                    self.snare.level -= self.snare.decay_per_sample;
                    if self.snare.level <= 0.0 {
                        self.snare.active = false;
                    } else {
                        let s = hp * self.snare.level * self.snare.vel * 1.6;
                        dry_l += s * dg * 0.9;
                        dry_r += s * dg;
                        wet_in += s * dg * 0.12;
                    }
                }
                if self.hat.active {
                    let n = {
                        let mut x = self.noise;
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        self.noise = x;
                        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
                    };
                    let hp = n - self.hat.hp_last_in * self.hat.hp_coef;
                    self.hat.hp_last_in = n;
                    self.hat.level -= self.hat.decay_per_sample;
                    if self.hat.level <= 0.0 {
                        self.hat.active = false;
                    } else {
                        let s = hp * self.hat.level * self.hat.vel * 0.5;
                        dry_l += s * dg * 1.05;
                        dry_r += s * dg * 0.95;
                    }
                }

                // ping-pong delay (tempo-synced from host)
                let d = &mut self.delay;
                let tap_l = d.buf_l[d.idx];
                let tap_r = d.buf_r[d.idx];
                d.buf_l[d.idx] = del_in + tap_r * d.feedback;
                d.buf_r[d.idx] = tap_l * d.feedback;
                d.idx = (d.idx + 1) % d.samples.max(1);
                dry_l += tap_l * d.mix;
                dry_r += tap_r * d.mix;
                wet_in += (tap_l + tap_r) * d.mix * 0.3; // echoes feed the reverb a little

                // reverb (freeverb-lite)
                let mut rev_l = 0.0f32;
                let mut rev_r = 0.0f32;
                for c in self.combs_l.iter_mut() {
                    let out = c.buf[c.idx];
                    c.filt += 0.25 * (out - c.filt);
                    c.buf[c.idx] = wet_in + c.filt * 0.78;
                    c.idx = (c.idx + 1) % c.len.max(1);
                    rev_l += out;
                }
                for c in self.combs_r.iter_mut() {
                    let out = c.buf[c.idx];
                    c.filt += 0.25 * (out - c.filt);
                    c.buf[c.idx] = wet_in + c.filt * 0.78;
                    c.idx = (c.idx + 1) % c.len.max(1);
                    rev_r += out;
                }
                let ap = &mut self.ap_l;
                let b = ap.buf[ap.idx];
                let out_l_ap = -rev_l + b;
                ap.buf[ap.idx] = rev_l + b * 0.5;
                ap.idx = (ap.idx + 1) % ap.len.max(1);
                let ap = &mut self.ap_r;
                let b = ap.buf[ap.idx];
                let out_r_ap = -rev_r + b;
                ap.buf[ap.idx] = rev_r + b * 0.5;
                ap.idx = (ap.idx + 1) % ap.len.max(1);

                OUT_L[i] = soft_clip((dry_l + out_l_ap * self.reverb_out) * self.master);
                OUT_R[i] = soft_clip((dry_r + out_r_ap * self.reverb_out) * self.master);
            }
        }
    }
}

// ---------- C ABI ----------

#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    unsafe {
        ENGINE = Some(Engine::new(sample_rate));
    }
}

#[no_mangle]
pub extern "C" fn out_l_ptr() -> *const f32 {
    unsafe { OUT_L.as_ptr() }
}

#[no_mangle]
pub extern "C" fn out_r_ptr() -> *const f32 {
    unsafe { OUT_R.as_ptr() }
}

#[no_mangle]
pub extern "C" fn render() {
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.render();
        }
    }
}

#[no_mangle]
pub extern "C" fn note_on(kind: u32, midi: f32, vel: f32, dur_samples: u32, pan: f32) {
    // guard: a single NaN input would poison feedback buffers forever
    if !midi.is_finite() || !vel.is_finite() || !pan.is_finite() || kind as usize >= NUM_KINDS {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.note_on(kind, midi, vel.clamp(0.0, 1.5), dur_samples, pan.clamp(-1.0, 1.0));
        }
    }
}

#[no_mangle]
pub extern "C" fn drum(lane: u32, vel: f32) {
    if !vel.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.drum(lane, vel.clamp(0.0, 1.5));
        }
    }
}

#[no_mangle]
pub extern "C" fn set_gain(kind: u32, linear: f32) {
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            if (kind as usize) < NUM_KINDS {
                e.gains[kind as usize] = linear;
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn set_delay(samples: u32, feedback: f32, mix: f32) {
    if !feedback.is_finite() || !mix.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.delay.samples = (samples as usize).clamp(1, MAX_DELAY - 1);
            e.delay.feedback = feedback.clamp(0.0, 0.9);
            e.delay.mix = mix.clamp(0.0, 1.0);
        }
    }
}

/// Synth node → per-kind voice timbre (wave 0..3, envelope, filter cutoff).
#[no_mangle]
pub extern "C" fn set_voice(kind: u32, wave: u32, attack: f32, release: f32, cutoff: f32) {
    if !attack.is_finite() || !release.is_finite() || !cutoff.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            if (kind as usize) < NUM_KINDS {
                let p = &mut e.voice_params[kind as usize];
                p.wave = wave.min(3);
                p.attack = attack.clamp(0.0005, 2.0);
                p.release = release.clamp(0.02, 4.0);
                p.cutoff = cutoff.clamp(80.0, 12000.0);
            }
        }
    }
}

/// FX routing from the node graph: how much of a kind feeds reverb / delay.
#[no_mangle]
pub extern "C" fn set_sends(kind: u32, rev: f32, del: f32) {
    if !rev.is_finite() || !del.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            if (kind as usize) < NUM_KINDS {
                e.rev_sends[kind as usize] = rev.clamp(0.0, 1.0);
                e.delay_sends[kind as usize] = del.clamp(0.0, 1.0);
            }
        }
    }
}

/// Expression node portamento: glide time in samples (0 = off).
#[no_mangle]
pub extern "C" fn set_glide(kind: u32, samples: f32) {
    if !samples.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            if (kind as usize) < NUM_KINDS {
                e.glide_samples[kind as usize] = samples.clamp(0.0, 96000.0);
                if samples <= 0.0 {
                    e.last_midi[kind as usize] = 0.0;
                }
            }
        }
    }
}

/// Reverb node: wet return level.
#[no_mangle]
pub extern "C" fn set_reverb(mix: f32) {
    if !mix.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.reverb_out = mix.clamp(0.0, 0.7);
        }
    }
}

/// Out node: master level (linear).
#[no_mangle]
pub extern "C" fn set_master(level: f32) {
    if !level.is_finite() {
        return;
    }
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            e.master = level.clamp(0.0, 1.5);
        }
    }
}

#[no_mangle]
pub extern "C" fn set_mute(kind: u32, muted: u32) {
    unsafe {
        if let Some(e) = ENGINE.as_mut() {
            if (kind as usize) < NUM_KINDS {
                e.mutes[kind as usize] = muted != 0;
            }
        }
    }
}
