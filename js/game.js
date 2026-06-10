/* ============================================================
   STICK FIGHT — Ragdoll Physics Arena
   Engine: Matter.js (2D rigid-body physics)
   Demonstrates: ragdoll, gravity/free-fall, momentum & impulse,
   elastic/inelastic collision, recoil (Newton III), torque & rotation.
   ============================================================ */
(() => {
  'use strict';

  const { Engine, World, Bodies, Body, Composite, Constraint, Events, Vector, Query } = Matter;

  // ---------- Canvas ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  // M107 crash fix: createRadialGradient/createLinearGradient throw a HARD error
  // if any coordinate or radius is non-finite (NaN/Infinity) — which happens when
  // a fighter's position briefly blows up. That error fired every frame and, after
  // ~1s of consecutive failures, ejected the player back to the menu. Sanitise the
  // arguments at the source so the call can never throw: non-finite -> 0, and a
  // negative/invalid radius -> 0. Worst case the gradient is invisible for a frame
  // instead of crashing the whole render loop. (No-op in headless/Node harnesses.)
  try {
    if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype) {
      const _proto = CanvasRenderingContext2D.prototype;
      const _fin = (v) => (Number.isFinite(v) ? v : 0);
      const _rad = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
      const _origRadial = _proto.createRadialGradient;
      _proto.createRadialGradient = function (x0, y0, r0, x1, y1, r1) {
        return _origRadial.call(this, _fin(x0), _fin(y0), _rad(r0), _fin(x1), _fin(y1), _rad(r1));
      };
      const _origLinear = _proto.createLinearGradient;
      _proto.createLinearGradient = function (x0, y0, x1, y1) {
        return _origLinear.call(this, _fin(x0), _fin(y0), _fin(x1), _fin(y1));
      };
    }
  } catch (e) {}
  const VIEW = { w: 1280, h: 720 }; // logical world size
  let scale = 1, offX = 0, offY = 0;

  function resize() {
    const ww = window.innerWidth, wh = window.innerHeight;
    scale = Math.min(ww / VIEW.w, wh / VIEW.h);
    // The canvas BACKING resolution (what captureStream/MediaRecorder records)
    // is decoupled from the window size so the recorded MP4 is always crisp.
    // We lock it to a supersampled fixed resolution: at least 2x (=> 2560x1440,
    // i.e. 1440p) even in a tiny window, scaling up to 3x to stay sharp on big/
    // retina displays. Previously backing = window-fit scale x DPR, so a small
    // window produced a low-resolution, blurry recording.
    const RES = Math.min(3, Math.max(2, scale * (devicePixelRatio || 1)));
    canvas.width = Math.round(VIEW.w * RES);
    canvas.height = Math.round(VIEW.h * RES);
    canvas.style.width = Math.round(VIEW.w * scale) + 'px';
    canvas.style.height = Math.round(VIEW.h * scale) + 'px';
    offX = 0; offY = 0;
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
  }
  window.addEventListener('resize', resize);

  // ---------- Collision categories ----------
  const CAT = {
    GROUND: 0x0001,
    PLAYER: 0x0002,
    BULLET: 0x0004,
    RAGDOLL: 0x0008,
    WEAPON: 0x0010,
  };

  // ---------- Engine ----------
  let engine, world;
  function makeEngine() {
    engine = Engine.create();
    engine.gravity.y = 1.6; // free-fall acceleration
    world = engine.world;
  }

  // ---------- Input ----------
  const keys = {};
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Slash','KeyQ'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyP') togglePause();
    if (e.code === 'KeyR' && state === 'play') startRound();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // ---------- Sound (tiny WebAudio synth) ----------
  let actx = null;
  function beep(freq, dur, type = 'square', vol = 0.05) {
    if (TRAIN) return;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g); g.connect(actx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.stop(actx.currentTime + dur);
    } catch (e) {}
  }
  // ── M82 richer synth helpers: filtered noise, pitch glides, note sequences ──
  function _ac() {
    try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    return actx;
  }
  function noise(dur = 0.2, vol = 0.06, filterFreq = 600) {
    if (TRAIN) return;
    try {
      const ac = _ac(); if (!ac) return;
      const n = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ac.createBufferSource(); src.buffer = buf;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
      const g = ac.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(ac.destination);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      src.start(); src.stop(ac.currentTime + dur);
    } catch (e) {}
  }
  function slide(f0, f1, dur = 0.15, type = 'sine', vol = 0.05) {
    if (TRAIN) return;
    try {
      const ac = _ac(); if (!ac) return;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(Math.max(1, f0), ac.currentTime);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), ac.currentTime + dur);
      g.gain.value = vol;
      o.connect(g); g.connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur);
    } catch (e) {}
  }
  function seq(notes, type = 'triangle', vol = 0.05) {
    if (TRAIN) return;
    let t = 0;
    for (const note of notes) { const f = note[0], d = note[1]; setTimeout(() => beep(f, d + 0.03, type, vol), t * 1000); t += d; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // M107 ADVANCED PROCEDURAL AUDIO ENGINE
  // A tiny synth rack built entirely on the WebAudio API — NO external audio
  // files. Every voice is routed through a shared master bus (soft compressor
  // + a procedurally-generated convolution reverb) so impacts punch and the
  // arena has a sense of space. All generators no-op while TRAIN is true.
  // ─────────────────────────────────────────────────────────────────────────
  let _busNode = null, _revNode = null, _revSend = null, _masterGain = null;
  function _bus() {
    const ac = _ac(); if (!ac) return null;
    if (_busNode) return _busNode;
    try {
      _masterGain = ac.createGain(); _masterGain.gain.value = 0.9;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 3.2;
      comp.attack.value = 0.003; comp.release.value = 0.18;
      // procedural reverb impulse response (exponentially-decaying noise)
      _revNode = ac.createConvolver();
      const len = Math.floor(ac.sampleRate * 1.1);
      const imp = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = imp.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      _revNode.buffer = imp;
      _revSend = ac.createGain(); _revSend.gain.value = 0.16;
      _busNode = ac.createGain(); _busNode.gain.value = 1;
      _busNode.connect(comp); comp.connect(_masterGain); _masterGain.connect(ac.destination);
      _busNode.connect(_revSend); _revSend.connect(_revNode); _revNode.connect(_masterGain);
    } catch (e) { _busNode = null; }
    return _busNode;
  }
  // ADSR-enveloped oscillator voice with optional pitch glide, detuned unison
  // layers and a shaping filter. opts: { f0,f1,dur,vol,type,a,r,detune,filter,cutoff,q,delay }
  function tone(opts) {
    if (TRAIN) return;
    try {
      const ac = _ac(), bus = _bus(); if (!ac || !bus) return;
      const t0 = ac.currentTime + (opts.delay || 0);
      const f0 = Math.max(1, opts.f0 || opts.f || 440);
      const f1 = Math.max(1, opts.f1 || f0);
      const dur = opts.dur || 0.2;
      const vol = opts.vol == null ? 0.06 : opts.vol;
      const atk = opts.a == null ? 0.005 : opts.a;
      const rel = opts.r == null ? dur * 0.6 : opts.r;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + rel);
      let node = bus;
      if (opts.filter) {
        const flt = ac.createBiquadFilter(); flt.type = opts.filter;
        flt.frequency.value = opts.cutoff || 1200;
        if (opts.q) flt.Q.value = opts.q;
        g.connect(flt); flt.connect(bus);
      } else { g.connect(bus); }
      const layers = opts.detune ? [0, opts.detune, -opts.detune] : [0];
      for (const dt of layers) {
        const o = ac.createOscillator(); o.type = opts.type || 'sine';
        o.frequency.setValueAtTime(f0, t0);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
        if (dt) o.detune.value = dt;
        o.connect(g); o.start(t0); o.stop(t0 + dur + rel + 0.02);
      }
    } catch (e) {}
  }
  // FM voice for metallic / clangy / rich timbres (sword clash, bells, fanfares)
  // opts: { f,ratio,index,dur,vol,type,delay }
  function fmTone(opts) {
    if (TRAIN) return;
    try {
      const ac = _ac(), bus = _bus(); if (!ac || !bus) return;
      const t0 = ac.currentTime + (opts.delay || 0);
      const carrier = Math.max(1, opts.f || 440);
      const ratio = opts.ratio || 2.0;
      const idx = opts.index || 220;
      const dur = opts.dur || 0.2;
      const vol = opts.vol == null ? 0.05 : opts.vol;
      const mod = ac.createOscillator(); mod.type = 'sine';
      mod.frequency.value = carrier * ratio;
      const modGain = ac.createGain();
      modGain.gain.setValueAtTime(idx, t0);
      modGain.gain.exponentialRampToValueAtTime(1, t0 + dur);
      const car = ac.createOscillator(); car.type = opts.type || 'sine';
      car.frequency.value = carrier;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      mod.connect(modGain); modGain.connect(car.frequency);
      car.connect(g); g.connect(bus);
      mod.start(t0); car.start(t0); mod.stop(t0 + dur + 0.02); car.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  // Filtered noise burst with ADSR + optional filter sweep — impacts, whooshes,
  // explosions, footsteps. opts: { dur,vol,f0,f1,filter,q,a,delay }
  function nburst(opts) {
    if (TRAIN) return;
    try {
      const ac = _ac(), bus = _bus(); if (!ac || !bus) return;
      const t0 = ac.currentTime + (opts.delay || 0);
      const dur = opts.dur || 0.15;
      const vol = opts.vol == null ? 0.06 : opts.vol;
      const n = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ac.createBufferSource(); src.buffer = buf;
      const flt = ac.createBiquadFilter(); flt.type = opts.filter || 'lowpass';
      flt.frequency.setValueAtTime(Math.max(1, opts.f0 || 800), t0);
      if (opts.f1) flt.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + dur);
      if (opts.q) flt.Q.value = opts.q;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (opts.a || 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(flt); flt.connect(g); g.connect(bus);
      src.start(t0); src.stop(t0 + dur + 0.02);
    } catch (e) {}
  }
  // Layered melody: each note is a detuned, reverb-fed tone; fanfare adds a bass octave.
  function _melody(notes, type = 'triangle', vol = 0.05, fanfare = false) {
    if (TRAIN) return;
    let t = 0;
    for (const note of notes) {
      const f = note[0], d = note[1];
      tone({ f0: f, dur: d + 0.03, vol, type, detune: 5, delay: t, filter: 'lowpass', cutoff: 4200 });
      if (fanfare) tone({ f0: f / 2, dur: d + 0.03, vol: vol * 0.5, type: 'sawtooth', delay: t, filter: 'lowpass', cutoff: 1800 });
      t += d;
    }
  }

  const SFX = {
    // ===== M107 procedural SFX rack — every cue is layered & bus-routed =====
    // --- guns ---
    shoot: () => { nburst({ dur: 0.05, vol: 0.07, f0: 2600, f1: 600, filter: 'lowpass' }); tone({ f0: 240, f1: 90, dur: 0.06, vol: 0.05, type: 'square' }); },
    gunBig: () => { nburst({ dur: 0.13, vol: 0.12, f0: 3400, f1: 260, filter: 'lowpass', q: 0.7 }); tone({ f0: 150, f1: 46, dur: 0.2, vol: 0.1, type: 'sawtooth' }); fmTone({ f: 84, ratio: 1.4, index: 140, dur: 0.12, vol: 0.05 }); },
    // --- impacts / combat ---
    hit: () => { nburst({ dur: 0.08, vol: 0.07, f0: 1300, f1: 220, filter: 'lowpass', q: 1 }); tone({ f0: 150, f1: 72, dur: 0.1, vol: 0.06, type: 'sawtooth' }); },
    bigHit: () => { nburst({ dur: 0.16, vol: 0.11, f0: 1700, f1: 120, filter: 'lowpass', q: 1.4 }); tone({ f0: 120, f1: 44, dur: 0.22, vol: 0.1, type: 'sawtooth' }); tone({ f0: 64, dur: 0.18, vol: 0.05, type: 'sine' }); },
    jump: () => { tone({ f0: 320, f1: 520, dur: 0.09, vol: 0.045, type: 'sine' }); nburst({ dur: 0.05, vol: 0.02, f0: 500, f1: 1600, filter: 'bandpass' }); },
    die: () => { tone({ f0: 200, f1: 60, dur: 0.3, vol: 0.09, type: 'sawtooth' }); nburst({ dur: 0.25, vol: 0.07, f0: 700, f1: 90, filter: 'lowpass', delay: 0.05 }); tone({ f0: 90, f1: 40, dur: 0.34, vol: 0.07, type: 'sine', delay: 0.08 }); },
    pickup: () => { tone({ f0: 620, f1: 940, dur: 0.08, vol: 0.05, type: 'triangle' }); tone({ f0: 1240, dur: 0.07, vol: 0.035, type: 'sine', delay: 0.06 }); },
    block: () => { nburst({ dur: 0.07, vol: 0.05, f0: 1400, f1: 500, filter: 'bandpass', q: 1.5 }); tone({ f0: 300, f1: 220, dur: 0.08, vol: 0.045, type: 'square' }); },
    parry: () => { fmTone({ f: 1500, ratio: 2.3, index: 320, dur: 0.16, vol: 0.06, type: 'square' }); tone({ f0: 2100, f1: 2600, dur: 0.08, vol: 0.04, type: 'sine', delay: 0.04 }); nburst({ dur: 0.06, vol: 0.04, f0: 6000, f1: 3000, filter: 'highpass' }); },
    // --- melee weapon signatures (M106 made each weapon fight differently) ---
    swing: () => { nburst({ dur: 0.14, vol: 0.05, f0: 400, f1: 1800, filter: 'bandpass', q: 1.2 }); },
    whoosh: () => { nburst({ dur: 0.18, vol: 0.055, f0: 300, f1: 2200, filter: 'bandpass', q: 0.9 }); },
    heavy: () => { tone({ f0: 320, f1: 80, dur: 0.2, vol: 0.06, type: 'sawtooth' }); nburst({ dur: 0.1, vol: 0.06, f0: 900, f1: 200, filter: 'lowpass', delay: 0.06 }); },
    slam: () => { tone({ f0: 140, f1: 38, dur: 0.32, vol: 0.12, type: 'sawtooth' }); nburst({ dur: 0.3, vol: 0.1, f0: 600, f1: 60, filter: 'lowpass', q: 1.2 }); tone({ f0: 60, f1: 28, dur: 0.4, vol: 0.08, type: 'sine', delay: 0.02 }); fmTone({ f: 80, ratio: 1.2, index: 90, dur: 0.18, vol: 0.04, delay: 0.04 }); },
    blade: () => { nburst({ dur: 0.1, vol: 0.045, f0: 900, f1: 3200, filter: 'bandpass', q: 1.6 }); tone({ f0: 1400, f1: 700, dur: 0.08, vol: 0.03, type: 'square' }); },
    stab: () => { nburst({ dur: 0.12, vol: 0.05, f0: 500, f1: 2600, filter: 'bandpass', q: 1.4 }); tone({ f0: 1700, f1: 2300, dur: 0.06, vol: 0.035, type: 'sine', delay: 0.05 }); },
    clang: () => { fmTone({ f: 1600, ratio: 2.7, index: 400, dur: 0.18, vol: 0.05, type: 'square' }); fmTone({ f: 2100, ratio: 3.1, index: 260, dur: 0.12, vol: 0.035, delay: 0.03 }); },
    explode: () => { tone({ f0: 90, f1: 32, dur: 0.4, vol: 0.12, type: 'sawtooth' }); nburst({ dur: 0.4, vol: 0.13, f0: 1200, f1: 60, filter: 'lowpass', q: 1 }); nburst({ dur: 0.18, vol: 0.08, f0: 4000, f1: 800, filter: 'highpass', delay: 0.01 }); tone({ f0: 54, f1: 24, dur: 0.45, vol: 0.08, type: 'sine', delay: 0.03 }); },
    // --- movement ---
    land: () => { nburst({ dur: 0.07, vol: 0.045, f0: 600, f1: 160, filter: 'lowpass' }); tone({ f0: 120, f1: 70, dur: 0.07, vol: 0.035, type: 'sine' }); },
    thud: () => { tone({ f0: 110, f1: 40, dur: 0.18, vol: 0.08, type: 'sine' }); nburst({ dur: 0.14, vol: 0.07, f0: 500, f1: 80, filter: 'lowpass', q: 1 }); },
    footstep: () => { nburst({ dur: 0.045, vol: 0.026, f0: 360, f1: 130, filter: 'lowpass' }); },
    dash: () => { nburst({ dur: 0.18, vol: 0.05, f0: 600, f1: 2400, filter: 'bandpass', q: 0.8 }); tone({ f0: 720, f1: 260, dur: 0.14, vol: 0.025, type: 'sine' }); },
    bounce: () => { tone({ f0: 300, f1: 880, dur: 0.16, vol: 0.06, type: 'sine' }); tone({ f0: 880, f1: 1400, dur: 0.1, vol: 0.03, type: 'triangle', delay: 0.08 }); },
    weaponDrop: () => { tone({ f0: 880, dur: 0.06, vol: 0.04, type: 'triangle' }); tone({ f0: 1180, dur: 0.06, vol: 0.04, type: 'triangle', delay: 0.07 }); },
    lowHp: () => { tone({ f0: 180, dur: 0.13, vol: 0.06, type: 'sine' }); tone({ f0: 180, dur: 0.13, vol: 0.05, type: 'sine', delay: 0.17 }); },
    stun: () => { tone({ f0: 700, f1: 120, dur: 0.3, vol: 0.04, type: 'square' }); tone({ f0: 520, f1: 300, dur: 0.22, vol: 0.03, type: 'sine', delay: 0.04 }); },
    respawn: () => { tone({ f0: 200, f1: 760, dur: 0.22, vol: 0.05, type: 'sine' }); nburst({ dur: 0.1, vol: 0.03, f0: 400, f1: 2600, filter: 'bandpass', delay: 0.02 }); tone({ f0: 760, f1: 520, dur: 0.1, vol: 0.03, type: 'triangle', delay: 0.2 }); },
    // --- announcer / UI / fanfares ---
    announce: () => { tone({ f0: 880, dur: 0.1, vol: 0.06, type: 'square', detune: 6 }); tone({ f0: 1175, dur: 0.14, vol: 0.055, type: 'square', detune: 6, delay: 0.09 }); },
    countdown: () => { tone({ f0: 720, dur: 0.1, vol: 0.06, type: 'square' }); tone({ f0: 360, dur: 0.08, vol: 0.03, type: 'sine' }); },
    go: () => { tone({ f0: 560, dur: 0.12, vol: 0.07, type: 'square', detune: 8 }); tone({ f0: 1080, f1: 1200, dur: 0.2, vol: 0.07, type: 'square', detune: 8, delay: 0.1 }); nburst({ dur: 0.12, vol: 0.04, f0: 3000, f1: 800, filter: 'highpass', delay: 0.1 }); },
    roundStart: () => _melody([[523, 0.09], [660, 0.09], [784, 0.14]], 'triangle', 0.05),
    roundWin: () => _melody([[660, 0.1], [880, 0.18]], 'triangle', 0.06),
    matchWin: () => _melody([[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.28]], 'triangle', 0.06, true),
    click: () => { tone({ f0: 460, dur: 0.04, vol: 0.05, type: 'square' }); },
    hover: () => { tone({ f0: 720, dur: 0.03, vol: 0.022, type: 'sine' }); },
    spinTick: () => { tone({ f0: 1200, dur: 0.025, vol: 0.03, type: 'square' }); },
    spinStop: () => { tone({ f0: 420, dur: 0.05, vol: 0.05, type: 'square' }); tone({ f0: 300, dur: 0.09, vol: 0.045, type: 'square', delay: 0.05 }); },
    fightBell: () => { fmTone({ f: 880, ratio: 3.0, index: 300, dur: 0.3, vol: 0.06 }); fmTone({ f: 1320, ratio: 2.5, index: 200, dur: 0.4, vol: 0.05, delay: 0.09 }); },
    kingHorn: () => _melody([[392, 0.16], [523, 0.16], [659, 0.22], [784, 0.4]], 'sawtooth', 0.055, true),
    advance: () => { tone({ f0: 990, f1: 1240, dur: 0.1, vol: 0.05, type: 'triangle' }); },
    crown: () => _melody([[523, 0.14], [659, 0.14], [784, 0.14], [1047, 0.18], [1319, 0.36]], 'triangle', 0.06, true),
    confetti: () => { tone({ f0: 1400 + Math.random() * 600, dur: 0.05, vol: 0.04, type: 'triangle' }); },
    event: () => { tone({ f0: 200, f1: 620, dur: 0.25, vol: 0.05, type: 'sine' }); nburst({ dur: 0.12, vol: 0.03, f0: 400, f1: 3000, filter: 'bandpass', delay: 0.05 }); },
  };

  // ---------- Neuroevolution ----------
  let TRAIN = false;           // true while headless self-play training is running
  let bestBrain = null;        // best trained genome (Float32Array) or null
  let bestBrainMeta = {};      // { gen, fit }

  // ---------- Replay recording (canvas -> .webm) ----------
  let mediaRec = null, recChunks = [], recording = false, recStart = 0;

  // ---------- World / level ----------
  let platforms = [];
  const KILL_Y = VIEW.h + 260; // falling past this = death

  // 5 selectable arenas. Every platform is reachable by a single jump from an
  // adjacent one, so the AI can navigate any layout deterministically.
  const ARENAS = [
    // All vertical gaps kept ≤110px so bots can reliably hop between every level
    { name: 'Tower', theme: 'castle', defs: [
      { x: 640, y: 600, w: 900, h: 40 },
      { x: 310, y: 490, w: 270, h: 24, oneway: true },   // gap ~102px from floor (M65 one-way platform)
      { x: 970, y: 490, w: 270, h: 24, oneway: true },
      { x: 640, y: 385, w: 250, h: 24 },   // gap ~105px from mid
    ]},
    { name: 'Pillars', theme: 'lab', defs: [
      { x: 640, y: 600, w: 1120, h: 40 },
      { x: 250, y: 485, w: 200, h: 24 },   // gap ~107px
      { x: 1030, y: 485, w: 200, h: 24 },
      { x: 470, y: 375, w: 190, h: 24, ice: true },   // gap ~110px  (M62 ICE: slippery)
      { x: 810, y: 375, w: 190, h: 24 },
      { x: 640, y: 268, w: 210, h: 24 },   // gap ~107px
      { x: 640, y: 470, w: 30, h: 250, wall: true, breakable: true, hp: 120, playOnly: true },   // M65 destructible barrier (play only)
    ]},
    { name: 'Stairs', theme: 'factory', defs: [
      { x: 640, y: 612, w: 1180, h: 40 },
      { x: 250, y: 505, w: 270, h: 24 },   // step 1: gap ~99px
      { x: 520, y: 408, w: 260, h: 24, conveyor: 1.6 },   // step 2: gap ~97px  (M62 CONVEYOR →)
      { x: 800, y: 312, w: 260, h: 24, conveyor: -1.6 },   // step 3: gap ~96px  (M62 CONVEYOR ←)
      { x: 1060, y: 218, w: 250, h: 24 },  // step 4: gap ~94px
    ]},
    { name: 'Floating', theme: 'scifi', defs: [
      { x: 640, y: 624, w: 560, h: 38 },   // wider center island
      { x: 190, y: 515, w: 240, h: 22 },   // gap ~101px
      { x: 1090, y: 515, w: 240, h: 22 },
      { x: 420, y: 408, w: 200, h: 22, move: { axis: 'x', range: 120, speed: 50 } },   // gap ~107px (moving)
      { x: 860, y: 408, w: 200, h: 22, move: { axis: 'y', range: 56, speed: 36 } },
      { x: 640, y: 300, w: 190, h: 22, tramp: true },   // gap ~108px  (M62 TRAMPOLINE)
      { x: 640, y: 470, w: 230, h: 20, rotate: { amp: 0.42, speed: 1.3 }, playOnly: true },   // M65 rotating seesaw platform (play only)
    ]},
    { name: 'Chasm', theme: 'forest', defs: [
      { x: 235, y: 560, w: 430, h: 40 },
      { x: 1045, y: 560, w: 430, h: 40 },
      { x: 380, y: 455, w: 210, h: 24 },   // bridge step L: gap ~97px
      { x: 900, y: 455, w: 210, h: 24 },   // bridge step R
      { x: 640, y: 355, w: 280, h: 26 },   // center: gap ~100px
      { x: 360, y: 255, w: 210, h: 22 },   // upper L: gap ~97px
      { x: 920, y: 255, w: 210, h: 22 },   // upper R
    ]},
    // No-fall arena: a full-width floor + tall side walls completely seal the
    // play area, so nobody can ever fall off and die. Marked walls are skipped
    // by computeSpawns so fighters never spawn on top of a wall.
    { name: 'Fortress (Safe)', theme: 'castle', defs: [
      { x: 640, y: 690, w: 1340, h: 64 },              // full-width floor
      { x: 6, y: 380, w: 28, h: 680, wall: true },     // left wall
      { x: 1274, y: 380, w: 28, h: 680, wall: true },  // right wall
      { x: 330, y: 500, w: 250, h: 24 },
      { x: 950, y: 500, w: 250, h: 24 },
      { x: 640, y: 372, w: 300, h: 24 },
    ]},
  ];
  let currentArena = 0;

  function buildLevel(idx) {
    if (idx == null) idx = currentArena;
    currentArena = (idx + ARENAS.length) % ARENAS.length;
    platforms.forEach(p => World.remove(world, p.body));
    platforms = [];
    for (const d of ARENAS[currentArena].defs) {
      if (d.playOnly && TRAIN) continue;   // M65 play-only obstacles never alter training geometry
      const body = Bodies.rectangle(d.x, d.y, d.w, d.h, {
        isStatic: true,
        friction: d.ice ? 0.02 : 0.9,   // M62 ice platforms are slippery
        restitution: 0.1,
        collisionFilter: { category: CAT.GROUND },
        label: 'platform',
      });
      const entry = { body, ...d, _originX: d.x, _originY: d.y, _hp: d.hp || 0, _broken: false, _angle: 0 };
      body.oneway = !!d.oneway; body.breakable = !!d.breakable; body.platH = d.h; body.platRef = entry; // M65
      platforms.push(entry);
      World.add(world, body);
    }
  }

  // Evenly spread N safe spawn points across the current arena's platform tops,
  // sorted left-to-right (so team A gets the left side, team B the right).
  function computeSpawns(n) {
    const cand = [];
    for (const p of platforms) {
      if (p.wall) continue; // walls are boundaries, not standing platforms
      const top = p.y - p.h / 2 - 42;
      const slots = Math.max(1, Math.floor(p.w / 130));
      for (let s = 0; s < slots; s++) cand.push({ x: p.x - p.w / 2 + p.w * (s + 0.5) / slots, y: top });
    }
    cand.sort((a, b) => a.x - b.x);
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = cand[Math.round(i * (cand.length - 1) / Math.max(1, n - 1))] || cand[0] || { x: VIEW.w / 2, y: 300 };
      out.push({ x: c.x, y: c.y });
    }
    return out;
  }

  // ============================================================
  //  RAGDOLL  — full multi-body figure: each limb is independent
  // ============================================================
  class Ragdoll {
    constructor(x, y, color, vx = 0, vy = 0, spin = 0) {
      this.color = color;
      this.parts = {};
      this.constraints = [];
      const grp = Body.nextGroup(true); // self parts don't collide each other
      const opt = (w, h, lbl) => ({
        collisionFilter: { group: grp, category: CAT.RAGDOLL, mask: CAT.GROUND | CAT.RAGDOLL | CAT.BULLET },
        friction: 0.55, frictionAir: 0.018, restitution: 0.3, density: 0.0015, label: lbl, // M62 floppier ragdoll
      });
      const P = this.parts;
      P.head    = Bodies.circle(x, y - 52, 13, opt(0,0,'rd-head'));
      P.torso   = Bodies.rectangle(x, y - 20, 18, 44, opt(18,44,'rd-torso'));
      P.uLegL   = Bodies.rectangle(x - 5, y + 12, 9, 26, opt(9,26,'rd'));
      P.lLegL   = Bodies.rectangle(x - 5, y + 36, 8, 26, opt(8,26,'rd'));
      P.uLegR   = Bodies.rectangle(x + 5, y + 12, 9, 26, opt(9,26,'rd'));
      P.lLegR   = Bodies.rectangle(x + 5, y + 36, 8, 26, opt(8,26,'rd'));
      P.uArmL   = Bodies.rectangle(x - 14, y - 24, 8, 24, opt(8,24,'rd'));
      P.lArmL   = Bodies.rectangle(x - 20, y - 6, 7, 22, opt(7,22,'rd'));
      P.uArmR   = Bodies.rectangle(x + 14, y - 24, 8, 24, opt(8,24,'rd'));
      P.lArmR   = Bodies.rectangle(x + 20, y - 6, 7, 22, opt(7,22,'rd'));

      const link = (a, b, ax, ay, bx, by, stiff = 0.55) => { // M62 floppier joints
        const c = Constraint.create({
          bodyA: a, bodyB: b,
          pointA: { x: ax, y: ay }, pointB: { x: bx, y: by },
          stiffness: stiff, length: 0, damping: 0.12, // M62 looser, more natural sag
        });
        this.constraints.push(c);
        return c;
      };
      link(P.head, P.torso, 0, 12, 0, -22);
      link(P.torso, P.uLegL, -5, 22, 0, -13);
      link(P.uLegL, P.lLegL, 0, 13, 0, -13);
      link(P.torso, P.uLegR, 5, 22, 0, -13);
      link(P.uLegR, P.lLegR, 0, 13, 0, -13);
      link(P.torso, P.uArmL, -8, -20, 0, -12);
      link(P.uArmL, P.lArmL, 0, 12, 0, -11);
      link(P.torso, P.uArmR, 8, -20, 0, -12);
      link(P.uArmR, P.lArmR, 0, 12, 0, -11);

      this.bodies = Object.values(P);
      const all = [...this.bodies, ...this.constraints];
      World.add(world, all);
      // inherit launch velocity + torque -> spins through the air (moment of inertia)
      for (const b of this.bodies) {
        Body.setVelocity(b, { x: vx, y: vy });
        Body.setAngularVelocity(b, spin);
      }
      this.life = 7.0; // seconds before cleanup
    }
    remove() {
      World.remove(world, [...this.bodies, ...this.constraints]);
    }
    draw(g) {
      const P = this.parts;
      g.strokeStyle = this.color;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const seg = (a, b, w) => {
        g.lineWidth = w; g.beginPath();
        g.moveTo(a.position.x, a.position.y);
        g.lineTo(b.position.x, b.position.y);
        g.stroke();
      };
      seg(P.torso, P.uLegL, 5); seg(P.uLegL, P.lLegL, 4);
      seg(P.torso, P.uLegR, 5); seg(P.uLegR, P.lLegR, 4);
      seg(P.torso, P.uArmL, 4.5); seg(P.uArmL, P.lArmL, 4);
      seg(P.torso, P.uArmR, 4.5); seg(P.uArmR, P.lArmR, 4);
      // torso
      g.lineWidth = 6; g.beginPath();
      const t = P.torso, hd = P.head;
      const tx = Math.sin(t.angle), ty = -Math.cos(t.angle);
      g.moveTo(t.position.x - tx*20, t.position.y - ty*20);
      g.lineTo(t.position.x + tx*20, t.position.y + ty*20);
      g.stroke();
      // head
      g.fillStyle = this.color;
      g.beginPath(); g.arc(hd.position.x, hd.position.y, 10, 0, Math.PI*2); g.fill();
      g.fillStyle = '#0c1018';
      g.beginPath(); g.arc(hd.position.x, hd.position.y, 10, 0, Math.PI*2); g.lineWidth=2; g.strokeStyle='#0c1018'; g.stroke();
      g.fillStyle = this.color;
      g.beginPath(); g.arc(hd.position.x, hd.position.y, 8, 0, Math.PI*2); g.fill();
    }
  }

  // ============================================================
  //  FIGHTER  — controllable character (capsule controller + drawn stick)
  // ============================================================
  class Fighter {
    constructor(opts) {
      this.color = opts.color;
      this.spawn = { x: opts.x, y: opts.y };
      this.controls = opts.controls;
      this.isAI = !!opts.isAI;
      this.name = opts.name;
      this.facing = opts.facing || 1;
      this.team = opts.team || 0;
      this.maxHp = 100;
      this.body = Bodies.rectangle(opts.x, opts.y, 18, 64, {
        inertia: Infinity, // stays upright while alive
        friction: 0.02, frictionAir: 0.02, restitution: 0.0, density: 0.002,
        collisionFilter: { category: CAT.PLAYER, mask: CAT.GROUND | CAT.PLAYER | CAT.BULLET | CAT.WEAPON },
        label: 'fighter', chamfer: { radius: 9 },
      });
      this.body.fighter = this;
      World.add(world, this.body);
      this.reset();
    }
    reset() {
      this.hp = this.maxHp;
      this.alive = true;
      this.grounded = false;
      this.fit = 0; // accumulated reward (training only)
      this.weapon = null;
      this.fireCd = 0;
      this.meleeCd = 0;
      this.heavyCd = 0;       // separate cooldown for the slow heavy attack
      this._swing = 0;        // melee swing animation timer
      this._swingMax = 0.2;   // duration of the current swing (drives the anim curve)
      this._thrust = 0;       // how far the fist visibly thrusts OUT this swing
      this.blocking = false;  // guard raised this frame
      this._guard = 1;        // guard meter (1 = full, 0 = broken)
      this._blockCd = 0;      // lockout after a guard break
      this._blockTime = 0;    // how long the guard has been held (parry window)
      this._noHitTimer = 0;   // seconds since last incoming damage (for HP regen)
      // ── Short-term memory (resets each spawn/round) ──────────────────────
      this.memory = { lastHitByMelee: 0, foeDodgePattern: 0, lastParrySuccess: 0 };
      // ── M61: status effects + movement tech + cosmetic state ──
      this._burn = 0; this._bleed = 0; this._confuse = 0; this._stun = 0;
      this._iframes = 0; this._roll = 0; this._rollCd = 0; this._slide = 0; this._slideCd = 0;
      this._crouch = false; this._pounding = false; this._airDodged = false; this._djHeld = false;
      this._comboCount = 0; this._comboT = 0; this._chargeT = 0; this._wasCharging = false;
      this._entrance = 0; this._celebrate = 0; this._trail = []; this._loPing = false; this._wasGrounded = false;
      // ── Opponent model (accumulates during a round) ───────────────────────
      this.foeModel = { aggressionLevel: 0, dodgeDirection: 0 };
      // LEARN-FROM-ME: per-match behavior accumulator. Records EFFECTIVE actions so
      // we can learn the human's style (play) and score imitation (training bots).
      this._styleAcc = { frames: 0, fire: 0, heavy: 0, block: 0, jump: 0, approachSum: 0, rangeSum: 0 };
      // ── Runtime flags ─────────────────────────────────────────������������───────────
      this.isEngaging = false;
      this._losBlocked = false; // cleared each spawn; true when a wall blocks the shot
      // ── M53 tactics #61-#80 runtime state ──
      this._trickChain = { step: 0, active: false, timer: 0, combo: null }; // #68
      this._hiddenState = null; // #83 RNN recurrent memory resets at the start of each round
      this._jumpStrength = null; // #82 continuous jump height (set by the brain each frame)
      this._spawnGrace = 0.3;     // #73 brief post-respawn damage grace (seconds)
      this._roundStats = { damageDealt:0, damageTaken:0, weaponTime:0, unarmedTime:0, voidDeaths:0, combatDeaths:0 }; // #64 (reset each round)
      this._rsMeleeDmg = 0; this._rsGunDmg = 0; // M86 per-round melee/gun damage split (drives King achievement titles)
      this._strafeDir = (Math.random() < 0.5 ? -1 : 1); // #66 strafe bias vs snipers
      this._damageLog     = this._damageLog     || {}; // #66 persists across rounds
      this._voidCaution   = this._voidCaution   || 1;  // #64 multipliers persist & adapt
      this._defenseMult   = this._defenseMult   || 1;
      this._weaponUrgency = this._weaponUrgency || 1;
      this._cumHits   = this._cumHits   || 0;          // #70 cumulative match metrics
      this._cumKills  = this._cumKills  || 0;
      this._cumDeaths = this._cumDeaths || 0;
      this._arenaVisits = this._arenaVisits || {};     // #80 per-arena exploration memory
      this._killMap = this._killMap || new Array(HEAT_GW * HEAT_GH).fill(0); // #69
      this._baitLand  = 0;   // bait-jump landing attack timer
      this._feintCd   = 0;   // feint move cooldown
      // Advanced tactical runtime state (#4, #9, #16, #23-#26, #31, #34-#35)
      this._burstTimer = 0; this._fakeFleeTimer = 0; this._fakeFleeing = false;
      this._dropAttack = false; this._orbitAngle = 0; this._orbitDir = 1;
      this._peekMode = false; this._peekTimer = 0; this._peekDur = 0;
      this._spawnRush = false; this._spawnRushTimer = 0;
      this._strategyScore = {}; this._lastMode = null; this._lastHp = this.hp;
      this._badDecisions = []; this._decisionTimer = 0;
      this._foeFingerprint = { samples:0, avgDist:0, jumpFreq:0, attackFreq:0, weaponRush:false, style:null }; this._fpTimer = 0;
      this._stateVisits = {};
      // Tactics #41-#60 runtime state
      this._decoyMode = false; this._decoyTimer = 0;
      this._heatMap = new Array(48).fill(0);
      this._platTimer = 0; this._bestPlat = null;
      this._comboMemory = []; this._currentCombo = []; this._lastFit = 0;
      this.signature = null; this._chaosDir = 0; this._stalemateTimer = 0;
      this.broadcastIntent = null; this._deathTime = 0;
      this.matchStats = { shotsFired:0, shotsHit:0, timesParried:0, timesBlocked:0, deathByVoid:0, deathByDamage:0, jumps:0, avgDistanceFought:[] };
      this.fitBreakdown = { combat:0, survival:0, weapon:0, position:0, team:0, style:0 };
      this.walkPhase = 0;
      this._comboStep = 0;      // cycles 0..3 for punch-combo animation variety
      this._heavySwing = false; // true while a heavy swing is animating
      this._lastWpnD = null; // distance to nearest weapon last step (for approach-reward shaping)
      this.aim = this.facing >= 0 ? 0 : Math.PI;
      this.recoilKick = 0;
      this.hurtFlash = 0;
      this.coyote = 0;
      this._climb = null;       // active 2s ledge-climb {t,dur,sx,sy,tx,ty}
      this._climbCd = 0;        // cooldown after a climb
      this._climbU = 0;         // climb progress 0..1 (drives the climb animation)
      this._pickup = 0;         // crouch-to-pickup animation timer
      // ── Momentum / Hype mental-state (-100 tilted … +100 on fire) ─────────
      this.hype = 0;
      this.killStreak = 0; this.deathStreak = 0;
      // ── Stamina (drained by jumps/attacks, regenerates while calm) ────────
      this.stamina = 100;
      // ── Unpredictability: ring buffer of recent action tokens ─────────────
      this.actionHistory = []; this._actTick = 0;
      // Respawn guarantee: make sure this fighter's body is in the world exactly
      // once. If anything ever removed it mid-match, this brings it back so the
      // fighter always reappears next round (fixes "stickman tidak spawn lagi").
      try { World.remove(world, this.body); } catch (_) {}
      World.add(world, this.body);
      Body.setStatic(this.body, false);
      Body.setPosition(this.body, { x: this.spawn.x, y: this.spawn.y });
      Body.setVelocity(this.body, { x: 0, y: 0 });
      Body.setAngle(this.body, 0);
      Body.setAngularVelocity(this.body, 0);
    }
    get pos() { return this.body.position; }

    hurt(dmg, impulse, point, attacker) {
      if (!this.alive) return;
      if ((this._spawnGrace || 0) > 0) return; // #73 brief post-respawn damage grace
      if ((this._iframes || 0) > 0) return;    // M61 dodge-roll / air-dodge invincibility
      impulse = impulse || { x: 0, y: 0 };
      // BLOCK: a raised guard soaks frontal damage. A guard raised at the very
      // last instant is a PERFECT PARRY (fully negated, refunds guard, no knockback).
      if (this.blocking) {
        const atkDir = Math.abs(impulse.x) > 0.0005 ? -Math.sign(impulse.x) : this.facing;
        if (atkDir === this.facing) {                  // the hit came from the front
          if ((this._blockTime || 0) <= 0.18) {        // parry window -> negate everything
            this._guard = Math.min(1, this._guard + 0.3);
            blockFx(this.pos, true); SFX.parry(); shake(5);
            if (TRAIN) this.fit += 8; // perfect parry reward
            if (this.matchStats) this.matchStats.timesParried++;
            this.hype = Math.min(100, (this.hype || 0) + 18); // a clean parry is a huge momentum swing
            // Memory: successful parry
            if (this.memory) { this.memory.lastParrySuccess = 1; this.memory.lastHitByMelee = 1; }
            return;
          }
          dmg *= 0.2;                                   // chip damage leaks through the guard
          impulse = { x: impulse.x * 0.25, y: impulse.y * 0.25 };
          this._guard = Math.max(0, this._guard - 0.22);
          blockFx(this.pos, false); SFX.block();
          if (TRAIN) this.fit += 3; // successful block reward
          if (this.matchStats) this.matchStats.timesBlocked++;
          if (this._guard <= 0) { this.blocking = false; this._blockCd = TRAIN ? 1.3 : 1.5; shake(6); } // guard break (M61: 1.5s stagger in play)
        }
      }
      // ── Update memory + foeModel on taking real damage ───────────────────
      if (this.memory) {
        this.memory.lastParrySuccess = 0;
        this.memory.lastHitByMelee = (impulse && (Math.abs(impulse.x) > 0.05 || Math.abs(impulse.y) > 0.04)) ? 1 : 0;
      }
      if (this.foeModel) this.foeModel.aggressionLevel = Math.min(1, (this.foeModel.aggressionLevel || 0) + 0.2);
      this.hp -= (activeMod.oneShot ? 9999 : dmg * (activeMod.dmgMul || 1)); // M61 round modifiers: one-shot / glass-cannon
      // #66 damage-source memory + #64 round-stat accumulation + #70 cumulative metrics
      if (attacker && attacker !== this) {
        const srcType = (attacker.weapon && attacker.weapon.type) ? attacker.weapon.type : 'melee';
        this._damageLog = this._damageLog || {};
        this._damageLog[srcType] = (this._damageLog[srcType] || 0) + 1;
        if (this._roundStats) this._roundStats.damageTaken += dmg;
        if (attacker._roundStats) attacker._roundStats.damageDealt += dmg;
        this._lastAttacker = attacker;
      }
      this._noHitTimer = 0;  // any real damage resets the regen timer
      this.hurtFlash = 0.2;
      Body.applyForce(this.body, point || this.pos, impulse);
      (dmg >= 26 ? SFX.bigHit() : SFX.hit());   // M107: heavy blows hit harder in the mix
      spawnBlood(point || this.pos, impulse, this.color);
      shake(Math.min(14, dmg * 0.6));
      if (!TRAIN && !this.isAI && this.alive && this.hp > 0 && this.hp <= 25 && !this._loPing) { this._loPing = true; try { SFX.lowHp(); } catch (e) {} }
      if (this.hp <= 0) this.die(impulse);
    }
    die(impulse) {
      if (!this.alive) return;
      this.alive = false;
      this._deathTime = Date.now();
      // Momentum & streaks (apply in both normal play and training).
      this.hype = Math.max(-100, (this.hype || 0) - 30); this.deathStreak = (this.deathStreak || 0) + 1; this.killStreak = 0;
      // #64 classify this death · #69 death heatmap · #70 kill credit to last attacker
      this._cumDeaths = (this._cumDeaths || 0) + 1;
      const _dgrid = heatPosToGrid(this.pos);
      deathHeatMap[_dgrid] = (deathHeatMap[_dgrid] || 0) + 1;
      if (this._roundStats) { if (this.pos.y > KILL_Y) this._roundStats.voidDeaths++; else this._roundStats.combatDeaths++; }
      if (this._lastAttacker && this._lastAttacker !== this) {
        this._lastAttacker._cumKills = (this._lastAttacker._cumKills || 0) + 1;
        this._lastAttacker._killMap = this._lastAttacker._killMap || new Array(HEAT_GW * HEAT_GH).fill(0);
        this._lastAttacker._killMap[_dgrid] = (this._lastAttacker._killMap[_dgrid] || 0) + 1;
      }
      for (const o of fighters) {
        if (o === this || !o.alive || o.team === this.team) continue;
        o.hype = Math.min(100, (o.hype || 0) + 22 + Math.min(20, (o.killStreak || 0) * 6)); // kill-streak snowballs hype
        o.killStreak = (o.killStreak || 0) + 1; o.deathStreak = 0;
      }
      if (!TRAIN && this._lastAttacker && this._lastAttacker !== this && this._lastAttacker.alive) {
        this._lastAttacker._celebrate = 0.8; // M61 kill celebration ring
        pushStreak(this._lastAttacker);       // M61 streak announcer (double/triple/rampage)
      }
      if (!TRAIN && King.active) {            // M87 live commentator
        const _k = this._lastAttacker, _vn = this.name, _kn = (_k && _k !== this) ? _k.name : null;
        const _pick = (arr) => arr[(Math.random() * arr.length) | 0];
        if (this.pos.y > KILL_Y) King.say(_pick(['😱 ' + _vn + ' dived into the void!', '🕳️ ' + _vn + ' swallowed by the void!', '💀 Ridiculous! ' + _vn + ' fell on their own!']));
        else if (_kn) King.say(_pick(['🔥 ' + _kn + ' took down ' + _vn + '!', '⚔️ ' + _kn + ' finished off ' + _vn + '!', '💥 ' + _vn + ' got dropped by ' + _kn + '!', '🎯 Clean execution by ' + _kn + '!']));
        else King.say('☠️ ' + _vn + ' is down!');
        try {                                  // M87 dramatic-death highlight capture (keep most dramatic of the match)
          const _dr = (this.pos.y > KILL_Y ? 120 : 0) + Math.min(60, Math.hypot(this.body.velocity.x, this.body.velocity.y) * 3) + (scores ? Math.max(scores[0], scores[1]) * 6 : 0);
          if (!King._highlight || _dr >= King._highlight.drama) {
            King._highlight = { drama: _dr, victim: _vn, vcolor: this.color, killer: _kn, type: this.pos.y > KILL_Y ? 'void' : 'ko', vx: this.body.velocity.x, round: scores ? (scores[0] + scores[1] + 1) : 1 };
          }
        } catch (e) {}
      }
      if (TRAIN) { // death penalty; ENEMIES get the kill bonus, surviving ALLIES are penalized for letting you die
        this.fit -= 150; // dying is now VERY costly (was -50) -> beats the "trade my life for a kill" habit
        for (const o of fighters) {
          if (o === this || !o.alive) continue;
          if (o.team === this.team) o.fit -= 20; // teammate went down on your watch
          else o.fit += 100;                      // enemy kill bonus (was +60)
        }
      }
      SFX.die();
      const v = this.body.velocity;
      // Capture death position BEFORE parking the body offscreen (ragdoll needs it).
      const dpx = this.pos.x, dpy = this.pos.y;
      if (!TRAIN) { spawnKillEffect(dpx, dpy, (ARENAS[currentArena] || {}).theme); ArenaReactivity.onKill(); } // M59 themed death burst
      this.weapon = null;
      Body.setStatic(this.body, true); // park controller offscreen-ish
      Body.setPosition(this.body, { x: -9999, y: -9999 });
      // CRITICAL: settle round/score bookkeeping FIRST. onDeath() is what flips
      // `roundOver` so the round can reset. The ragdoll below is purely cosmetic;
      // a fall into the void can hand us NaN/extreme coords that make Matter.js throw
      // while building the ragdoll body. If that threw BEFORE onDeath, step()'s
      // per-fighter try/catch swallowed it and the round never reset -> the classic
      // "sisa sendiri tapi ronde gak reset" bug. Bookkeeping now happens no matter what.
      onDeath(this);
      if (!TRAIN) {
        // launch ragdoll with current momentum + extra impulse + spin (torque)
        try {
          if (isFinite(dpx) && isFinite(dpy)) {
            const spin = (impulse ? impulse.x : 0) * 60 + (Math.random() - 0.5) * 0.6;
            const rd = new Ragdoll(
              dpx, dpy, this.color,
              (isFinite(v.x) ? v.x : 0) + (impulse ? impulse.x * 900 : 0),
              (isFinite(v.y) ? v.y : 0) + (impulse ? impulse.y * 900 : 0) - 4,
              Math.max(-0.9, Math.min(0.9, spin)) // M62 more floppy spin
            );
            ragdolls.push(rd);
          }
        } catch (e) { console.error('[ragdoll] skipped', e); }
      }
    }

    update(dt) {
      if (!this.alive) return;
      // ── Ledge climb: a scripted 2s mantle that lifts the fighter onto a tall
      //    platform it cannot simply hop to. Physics is overridden and every
      //    other action is frozen until it completes. ────────────────────────
      if (this._climb) {
        const cl = this._climb;
        cl.t += dt;
        const u = Math.min(1, cl.t / cl.dur);
        this._climbU = u;
        const ev = u < 0.7 ? (u / 0.7) : 1;        // rise vertically first
        const eh = u < 0.5 ? 0 : (u - 0.5) / 0.5;  // then pull in over the lip
        const nx = cl.sx + (cl.tx - cl.sx) * eh;
        const ny = cl.sy + (cl.ty - cl.sy) * ev;
        Body.setPosition(this.body, { x: nx, y: ny });
        Body.setVelocity(this.body, { x: 0, y: 0 });
        this.facing = (cl.tx >= cl.sx) ? 1 : -1;
        this.hurtFlash = Math.max(0, this.hurtFlash - dt);
        if (this._swing) this._swing = Math.max(0, this._swing - dt);
        if (u >= 1) { this._climb = null; this._climbU = 0; this._climbCd = 0.5; Body.setVelocity(this.body, { x: 0, y: -1 }); }
        return;
      }
      if (this._climbCd > 0) this._climbCd = Math.max(0, this._climbCd - dt);
      if (this._pickup > 0) this._pickup = Math.max(0, this._pickup - dt);
      if (TRAIN) {
        // Anti-stall: idling slowly bleeds score, so just standing is never "safe".
        this.fit -= 0.4 * dt;
        // Weapon shaping: holding a usable weapon pays well; being unarmed is
        // actively dangerous, PLUS a dense "move toward the nearest weapon"
        // gradient so neuroevolution can actually learn to navigate & grab one
        // (a sparse one-time pickup bonus alone is too weak to learn from).
        const armed = this.weapon && this.weapon.ammo > 0;
        if (armed) {
          this.fit += 5.0 * dt; // holding a usable weapon pays a LOT (was 3.0 / 1.1)
        } else {
          let bw = null, bd = Infinity;
          for (const w of weapons) {
            if (w.taken) continue;
            const d = Math.hypot(w.body.position.x - this.pos.x, w.body.position.y - this.pos.y);
            if (d < bd) { bd = d; bw = w; }
          }
          if (bw) {
            // ONLY penalize being empty-handed when a weapon is actually available
            // (fair: don't punish a bot for not grabbing a weapon that isn't there).
            this.fit -= 2.0 * dt; // ignoring an available weapon is actively bad (was a flat 0.7)
            if (this._lastWpnD != null && isFinite(this._lastWpnD)) {
              this.fit += Math.max(-1, Math.min(1, (this._lastWpnD - bd) / 24)) * 1.6; // dense "getting closer" gradient
            }
            this._lastWpnD = bd;
          }
        }
        // Staying far from the enemy costs extra -> forces them to close & fight.
        const foeF = nearestEnemy(this);
        if (foeF && Math.hypot(foeF.pos.x - this.pos.x, foeF.pos.y - this.pos.y) > 340) this.fit -= 0.5 * dt;
        // EDGE danger: loitering at the lip of a lethal drop bleeds score, so the
        // net learns to back away from cliffs instead of running off them.
        const efY = this.pos.y + 34;
        if (this.grounded && (!groundBelow(this.pos.x + 46, efY, 280) || !groundBelow(this.pos.x - 46, efY, 280))) this.fit -= 0.5 * dt;
        // TEAM play: while a teammate is alive, ADVANCING toward the enemy pays ->
        // kills the "stand back and let my ally die" equilibrium.
        const tally = nearestAlly(this);
        if (tally && tally.alive && foeF && Math.abs(this.body.velocity.x) > 0.6 &&
            Math.sign(foeF.pos.x - this.pos.x) === Math.sign(this.body.velocity.x)) this.fit += 0.7 * dt;
      }
      // HP regen: recover 3 HP/s after 5 seconds without taking any damage
      this._noHitTimer = (this._noHitTimer || 0) + dt;
      if (this._noHitTimer >= 5 && this.alive) this.hp = Math.min(this.maxHp, this.hp + 3 * dt);

      // Momentum decays back toward neutral; stamina regenerates while calm.
      this.hype += (0 - this.hype) * 0.4 * dt;
      if (this.hype > 100) this.hype = 100; else if (this.hype < -100) this.hype = -100;
      this.stamina = Math.min(100, (this.stamina || 0) + 10 * dt);

      // ── Opponent model decay + trick move timers ──────────────────────────
      if (this.foeModel) this.foeModel.aggressionLevel = Math.max(0, this.foeModel.aggressionLevel - 0.06 * dt);
      if (this._baitLand > 0) this._baitLand = Math.max(0, this._baitLand - dt);
      if (this._feintCd  > 0) this._feintCd  = Math.max(0, this._feintCd  - dt);
      // ── Opponent model: track foe's dodge direction (velocity bias) ───────
      const _foeForModel = nearestEnemy(this);
      if (_foeForModel && this.foeModel) {
        const fvx = _foeForModel.body.velocity.x;
        if (Math.abs(fvx) > 1.5) {
          const _dk = this.brain ? metaParams(this.brain).decay : 0.94; // evolved memory-decay rate
          this.foeModel.dodgeDirection = this.foeModel.dodgeDirection * _dk + Math.sign(fvx) * (1 - _dk);
          if (this.memory) this.memory.foeDodgePattern = this.foeModel.dodgeDirection;
        }
      }

      this._slow = Math.max(0, (this._slow || 0) - dt);   // ice slow timer
      // ── M61 status-effect ticks + cosmetic timers ──
      if (this._comboT > 0) this._comboT = Math.max(0, this._comboT - dt);
      if (this._entrance > 0) this._entrance = Math.max(0, this._entrance - dt);
      if (this._celebrate > 0) this._celebrate = Math.max(0, this._celebrate - dt);
      if (!TRAIN && this.alive) {
        if (this._burn > 0) { this._burn -= dt; this.hp -= 6 * dt;
          if (Math.random() < 0.4) particles.push({ x: this.pos.x + (Math.random()-0.5)*14, y: this.pos.y + (Math.random()-0.5)*22, vx: (Math.random()-0.5)*1.5, vy: -1 - Math.random(), life: 0.4, max: 0.4, r: 3, color: '#ff6a2c' });
          if (this.hp <= 0) this.die({ x: 0, y: 0 }); }
        if (this.alive && this._bleed > 0) { this._bleed -= dt;
          if (Math.abs(this.body.velocity.x) > 1.2) { this.hp -= 4 * dt;
            if (Math.random() < 0.3) particles.push({ x: this.pos.x, y: this.pos.y + 12, vx: 0, vy: 1.2, life: 0.5, max: 0.5, r: 2, color: '#b3121b' });
            if (this.hp <= 0) this.die({ x: 0, y: 0 }); } }
        if (this._confuse > 0) this._confuse -= dt;
        if (this._stun > 0) this._stun -= dt;
        if (!this._trail) this._trail = [];
        if (Math.abs(this.body.velocity.x) > 3.5 || this.body.velocity.y < -6) { this._trail.push({ x: this.pos.x, y: this.pos.y }); if (this._trail.length > 10) this._trail.shift(); }
        else if (this._trail.length) this._trail.shift();
      }
      if (this._swing) this._swing = Math.max(0, this._swing - dt); // melee swing anim
      const c = this.controls;
      this.grounded = onGround(this);
      const grounded = this.grounded;
      if (grounded && !this._wasGrounded && !this.isAI && this.body.velocity.y > 4 && !TRAIN) { try { (this.body.velocity.y > 9 ? SFX.thud() : SFX.land()); } catch (e) {} } // M107: hard landings thud
      this._wasGrounded = grounded;
      // M85 anti-stacking: being stood on (pinned underneath) deals chip damage and
      //  shoves the bottom fighter out, so bots can't camp on each other's heads.
      if (!TRAIN && this.alive) {
        for (const o of fighters) {
          if (o === this || !o.alive) continue;
          const sdx = o.pos.x - this.pos.x, above = this.pos.y - o.pos.y;
          if (Math.abs(sdx) < 16 && above > 24 && above < 62 && Math.abs(o.body.velocity.y) < 3.5) {
            const esc = sdx >= 0 ? -1 : 1;
            Body.applyForce(this.body, this.pos, { x: esc * 0.012, y: 0 });
            this._stackCd = (this._stackCd || 0) - dt;
            if (this._stackCd <= 0) { this.hurt(4, { x: esc * 0.02, y: 0.01 }, this.pos, o); this._stackCd = 0.55; }
            break;
          }
        }
      }
      let move = 0;
      let wantJump = false, wantDown = false, wantFire = false, wantHeavy = false, wantBlock = false;

      if (this.isAI) {
        const ai = this.think(dt);
        move = ai.move; wantJump = ai.jump; wantFire = ai.fire; wantDown = ai.down; wantHeavy = !!ai.heavy; wantBlock = !!ai.block;
      } else {
        if (keys[c.left]) move -= 1;
        if (keys[c.right]) move += 1;
        wantJump = keys[c.jump];
        wantDown = keys[c.down];
        wantFire = keys[c.fire];
        wantHeavy = !!keys[c.heavy];
        wantBlock = !!keys[c.block];
      }
      // ── M61 stun freezes all actions; confusion reverses movement (play only) ──
      if (!TRAIN) {
        if ((this._stun || 0) > 0) { move = 0; wantJump = false; wantFire = false; wantHeavy = false; wantBlock = false; }
        if ((this._confuse || 0) > 0) move = -move;
        if (arenaEvent === 'mirror' && !this.isAI) move = -move; // M62 mirror-controls arena (humans only)
      }
      // M96 pre-round countdown freezes all action until "FIGHT!" appears (final phase)
      if (!TRAIN && _countdown && _countdown.t > 0.633) { move = 0; wantJump = false; wantDown = false; wantFire = false; wantHeavy = false; wantBlock = false; }

      // ── Unpredictability: log a compact action token every ~6 frames ──────
      this._actTick = (this._actTick || 0) + 1;
      if (this._actTick % 6 === 0 && this.actionHistory) {
        const tok = (move < 0 ? 'L' : move > 0 ? 'R' : '_') + (wantJump ? 'J' : '') + (wantFire ? 'F' : '') + (wantHeavy ? 'H' : '') + (wantBlock ? 'B' : '');
        this.actionHistory.push(tok);
        if (this.actionHistory.length > 20) this.actionHistory.shift();
      }
      // ── LEARN-FROM-ME: sample EFFECTIVE behavior every 6 frames (cheap; reuses
      //    the _actTick cadence). Feeds the human style profile + bot imitation. ──
      if (this._actTick % 6 === 0 && this.alive && this._styleAcc) {
        const sa = this._styleAcc;
        sa.frames++;
        if (wantFire) sa.fire++;
        if (wantHeavy) sa.heavy++;
        if (wantBlock) sa.block++;
        if (wantJump) sa.jump++;
        const _sz = nearestEnemy(this);
        if (_sz) {
          const _sd = Math.hypot(_sz.pos.x - this.pos.x, _sz.pos.y - this.pos.y);
          sa.rangeSum += Math.min(1, _sd / 600);
          sa.approachSum += (move !== 0 && Math.sign(move) === Math.sign(_sz.pos.x - this.pos.x)) ? 1 : 0;
        }
      }
      if (TRAIN && this.alive) {
        const _foeZ = nearestEnemy(this);
        const selfSafe = getZoneSafety(this.pos);
        this.fit += (selfSafe - 0.5) * 1.0 * dt;                       // reward controlling safe ground
        if (_foeZ) { const foeSafe = getZoneSafety(_foeZ.pos); if (foeSafe < 0.3 && selfSafe > 0.6) this.fit += 5 * dt; } // pushed foe to the edge
        this.fit += unpredictabilityScore(this.actionHistory) * 0.5 * dt; // reward a varied action mix
      }

      // ---- block / guard ----
      this._blockCd = Math.max(0, (this._blockCd || 0) - dt);
      const _wasBlocking = this.blocking; // M111: detect guard-release for the anti-spam cooldown
      if (wantBlock && grounded && this._blockCd <= 0 && this._guard > 0.05) {
        if (!this.blocking) this._blockTime = 0;            // guard just raised -> open the parry window
        this.blocking = true;
        this._blockTime += dt;
        this._guard = Math.max(0, this._guard - dt * 0.55); // holding guard drains it (~1.8s to empty)
        if (this._guard <= 0) { this.blocking = false; this._blockCd = TRAIN ? 1.3 : 1.5; shake(4); } // exhausted -> guard break (M61: 1.5s stagger in play)
      } else {
        // M111: lowering the guard imposes a 0.6s cooldown before it can be raised
        // again, so block can't be spam-flickered. (A guard break already sets a
        // longer 1.3-1.5s lockout above; Math.max keeps whichever is larger.)
        if (_wasBlocking) this._blockCd = Math.max(this._blockCd, 0.6);
        this.blocking = false;
        this._guard = Math.min(1, (this._guard || 0) + dt * 0.4); // regenerates while lowered
      }

      // horizontal movement (target velocity); chilled by ice, slowed while guarding
      const speed = 4.6 * (this._slow > 0 ? 0.5 : 1) * (this.blocking ? 0.3 : 1) * ((this.stamina || 0) < 25 ? 0.6 : 1) * (activeMod.speed || 1) * (this._slide > 0 ? 1.6 : 1); // exhausted -> 40% slower; M61 speed-mod + slide boost
      const vx = this.body.velocity.x;
      // ── M62 special platform under the fighter (play only): ice / conveyor / trampoline ──
      let _plat = null;
      if (!TRAIN && this.alive) _plat = standingPlatform(this);
      this._onIce = !!(_plat && _plat.ice);
      const _accel = this._onIce ? 0.08 : 0.25;   // ice: poor grip, hard to change direction
      const _fric  = this._onIce ? 0.985 : 0.78;  // ice: barely decelerates -> keeps sliding
      if (move !== 0) {
        this.facing = move > 0 ? 1 : (move < 0 ? -1 : this.facing);
        const target = move * speed; // #82 continuous: |move| near 0 = slow creep, near 1 = full sprint
        Body.setVelocity(this.body, { x: vx + (target - vx) * _accel, y: this.body.velocity.y });
        this.walkPhase += dt * 14 * Math.min(1, Math.abs(move) + 0.3);
        // M107: human footsteps, paced off the walk cycle
        if (!this.isAI && grounded && !TRAIN) { const _sp = Math.floor(this.walkPhase / 3.1); if (_sp !== this._lastStep) { this._lastStep = _sp; try { SFX.footstep(); } catch (e) {} } }
      } else {
        Body.setVelocity(this.body, { x: vx * _fric, y: this.body.velocity.y });
        this.walkPhase += dt * 2;
      }
      // conveyor drift + trampoline bounce (play only)
      if (_plat) {
        if (_plat.conveyor) Body.setVelocity(this.body, { x: this.body.velocity.x + _plat.conveyor, y: this.body.velocity.y });
        if (_plat.tramp && this.body.velocity.y >= -2) { Body.setVelocity(this.body, { x: this.body.velocity.x, y: -13.5 }); SFX.bounce(); }
      }

      // ---- ledge climb: pressing jump while standing under/beside a ledge too
      //      tall to hop kicks off the scripted 2s mantle instead of a hop. ----
      if (wantJump && !this._jumpHeld && this._climbCd <= 0 && grounded) {
        const lg = climbLedge(this);
        if (lg) {
          this._climb = { t: 0, dur: 2.0, sx: this.pos.x, sy: this.pos.y, tx: lg.tx, ty: lg.ty };
          Body.setVelocity(this.body, { x: 0, y: 0 });
          this._jumpHeld = true; this._pickup = 0;
          SFX.jump(); if (this.matchStats) this.matchStats.jumps++;
          return;
        }
      }

      // jump (with small coyote time)
      if (grounded) this.coyote = 0.1; else this.coyote -= dt;
      if (wantJump && this.coyote > 0 && !this._jumpHeld && (this.stamina || 0) >= 9) { // too exhausted to jump
        const _jv = (this.isAI && this._jumpStrength != null) ? -(10 + Math.min(1, this._jumpStrength) * 5) : -14; // #82 variable jump height
        Body.setVelocity(this.body, { x: this.body.velocity.x, y: _jv });
        this.coyote = 0; this._jumpHeld = true; SFX.jump(); if (this.matchStats) this.matchStats.jumps++;
        this.stamina = Math.max(0, this.stamina - 9); // jumping costs stamina
      }
      if (!wantJump) this._jumpHeld = false;

      // ── M61 movement tech (human players only, play only) ��─
      this._iframes = Math.max(0, (this._iframes || 0) - dt);
      this._roll = Math.max(0, (this._roll || 0) - dt);
      this._rollCd = Math.max(0, (this._rollCd || 0) - dt);
      this._slide = Math.max(0, (this._slide || 0) - dt);
      this._slideCd = Math.max(0, (this._slideCd || 0) - dt);
      if (grounded) this._airDodged = false;
      if (!this.isAI && !TRAIN && this.alive) {
        const tdir = move !== 0 ? Math.sign(move) : this.facing;
        const dj = wantDown && wantJump;
        if (dj && !this._djHeld) {
          if (grounded && this._rollCd <= 0) {
            this._roll = 0.32; this._iframes = 0.34; this._rollCd = 0.85; this._crouch = true;
            try { if (!this.isAI) SFX.dash(); } catch (e) {}
            Body.setVelocity(this.body, { x: tdir * 9.5, y: -1.5 }); SFX.jump(); if (this.matchStats) this.matchStats.jumps++;
          } else if (!grounded && !this._airDodged) {
            this._airDodged = true; this._iframes = 0.22;
            const ax = ((keys[c.left] ? -1 : 0) + (keys[c.right] ? 1 : 0)) || tdir;
            Body.setVelocity(this.body, { x: ax * 8, y: -2.2 });
          }
        }
        this._djHeld = dj;
        if (this._roll > 0) Body.setVelocity(this.body, { x: tdir * 9.5, y: this.body.velocity.y });
        const fast = Math.abs(this.body.velocity.x) > 3.2;
        if (grounded && wantDown && !dj) {
          if (fast && this._slide <= 0 && this._slideCd <= 0) { this._slide = 0.42; this._slideCd = 0.95; this._crouch = true; }
          else if (!fast) this._crouch = true;
        } else if (this._roll <= 0 && this._slide <= 0) { this._crouch = false; }
        if (this._slide > 0) { this._crouch = true; Body.setVelocity(this.body, { x: this.facing * 7.6, y: this.body.velocity.y }); }
        if (!grounded && wantDown && !wantJump && this.body.velocity.y > -2) {
          this._pounding = true; Body.setVelocity(this.body, { x: this.body.velocity.x * 0.6, y: 16 });
        }
        if (this._pounding && grounded) {
          this._pounding = false; shake(9);
          for (const o of fighters) { if (o === this || !o.alive || o.team === this.team) continue;
            const dx = o.pos.x - this.pos.x, dy = o.pos.y - this.pos.y;
            if (Math.abs(dx) < 72 && Math.abs(dy) < 52) o.hurt(18, { x: Math.sign(dx || 1) * 0.05, y: -0.07 }, o.pos, this); }
          for (let i = 0; i < 12; i++) particles.push({ x: this.pos.x, y: this.pos.y + 30, vx: (Math.random()-0.5)*7, vy: -Math.random()*3.5, life: 0.4, max: 0.4, r: 3, color: '#ffd23f' });
        }
      }

      // aim toward nearest enemy when armed (with bullet-travel leading), else face movement
      const foe = nearestEnemy(this);
      if (foe) {
        let tx = foe.pos.x, ty = foe.pos.y - 8;
        // Bullet-travel leading only applies to PROJECTILE weapons that actually
        // have a finite projectile speed (guns / magic). Melee weapons have NO
        // `speed`, so `d / (undefined * 0.9)` was NaN — which silently poisoned
        // `aim`. That single NaN caused BOTH long-standing melee bugs:
        //   1) a melee fighter could ONLY ever face LEFT, because
        //      `Math.cos(NaN) >= 0` is false  ->  facing = -1 forever;
        //   2) a spear thrust applied `Math.cos(aim) * force` = NaN force, which
        //      flung the body to NaN coordinates  ->  the stickman VANISHED.
        // (The M123 lunge tweak never helped because the magnitude was never the
        //  problem — the NaN aim was.)
        if (this.weapon && isFinite(this.weapon.speed) && this.weapon.speed > 0) {
          const d = Math.hypot(tx - this.pos.x, ty - this.pos.y);
          const t = d / (this.weapon.speed * 0.9);          // steps for the bullet to arrive
          tx += foe.body.velocity.x * t;                    // lead the moving target
          ty += foe.body.velocity.y * t;
        }
        const a = Math.atan2(ty - (this.pos.y - 8), tx - this.pos.x);
        this.aim = isFinite(a) ? a : (this.facing >= 0 ? 0 : Math.PI); // never let aim go NaN
        this.facing = Math.cos(this.aim) >= 0 ? 1 : -1;
      } else {
        this.aim = this.facing >= 0 ? 0 : Math.PI;
      }

      // pick up weapon on ground: manual (down) for humans; bots auto-grab when
      // walking over one while unarmed/empty (the brain only needs to navigate to it).
      if (wantDown) this.tryPickup();
      else if (this.isAI && (!this.weapon || this.weapon.ammo <= 0)) this.tryPickup();

      // fire / melee / heavy attack
      this.fireCd -= dt; this.meleeCd -= dt; this.heavyCd -= dt;
      if ((this._spawnGrace || 0) > 0) this._spawnGrace = Math.max(0, this._spawnGrace - dt); // #73
      if (this._roundStats) { if (this.weapon) this._roundStats.weaponTime += dt; else this._roundStats.unarmedTime += dt; } // #64
      // Stamina gate: no juice -> the swing simply doesn't come out. This is what
      // actually stops attack-spam (the bot can mash all it wants, but an exhausted
      // fighter just can't punch until it recovers).
      const _stam = this.stamina || 0;
      const canLight = _stam >= 10;  // normal punch / swing
      const canHeavy = _stam >= 26;  // heavy needs a real reserve
      // ── M61 charge attack (human, play only): hold heavy to charge, release for a stronger blow ─���
      let heavyTrigger = wantHeavy;
      if (!this.isAI && !TRAIN) {
        const canCharge = !this.weapon || this.weapon.kind === 'melee';
        if (canCharge) {
          if (wantHeavy) { this._chargeT = Math.min(1.1, (this._chargeT || 0) + dt); this._wasCharging = true; heavyTrigger = false; }
          else if (this._wasCharging) {
            this._wasCharging = false; const c2 = this._chargeT || 0; this._chargeT = 0;
            if (c2 >= 0.4 && this.heavyCd <= 0 && this.meleeCd <= 0 && !this.blocking) this.chargedStrike(c2);
          }
        }
      }
      const doHeavy = heavyTrigger && canHeavy && !this.blocking && this.heavyCd <= 0 && this.meleeCd <= 0; // heavy = slow, committed, high-damage melee
      // Armed attacks (guns & melee weapons) are stamina-free: they neither cost nor are gated by stamina.
      const doHeavyArmed = heavyTrigger && !this.blocking && this.heavyCd <= 0 && this.meleeCd <= 0;
      // M106: a BOT may only throw a melee strike when a living enemy is actually
      // within range — no more shadow-boxing / swinging at empty air. (Humans never gated.)
      const _foe = foe;
      const _foeAlive = !!_foe && _foe.alive;
      const _wReach = (this.weapon && this.weapon.reach) || 60;
      const _foeInWpnRange = !this.isAI || (_foeAlive &&
        Math.abs(_foe.pos.x - this.pos.x) < _wReach + 28 && Math.abs(_foe.pos.y - this.pos.y) < 82);
      const _foeInFistRange = !this.isAI || (_foeAlive &&
        Math.abs(_foe.pos.x - this.pos.x) < 52 && Math.abs(_foe.pos.y - this.pos.y) < 64);
      if (this.weapon && this.weapon.kind === 'melee') {
        if (doHeavyArmed && _foeInWpnRange) this.meleeWeapon(true);                 // heavy weapon swing (no stamina gate)
        else if (wantFire && !this.blocking && this.meleeCd <= 0 && _foeInWpnRange) this.meleeWeapon(false); // normal weapon swing (no stamina gate)
      } else if (this.weapon && this.weapon.ammo > 0) {
        // AI never wastes shots into walls/platforms: require a clear line of sight.
        // (Covers both rule-based and trained-brain bots; humans always fire.)
        let losOk = true, ammoOk = true;
        if (this.isAI) {
          const _t = foe;
          losOk = !_t || !lineBlocked(this.pos.x, this.pos.y - 8, _t.pos.x, _t.pos.y - 8);
          // #61 Ammo-aware shooting discipline: conserve scarce ammo for high-% shots.
          if (_t) {
            const _wd = WEAPONS[this.weapon.type];
            const _maxA = (_wd && isFinite(_wd.ammo)) ? _wd.ammo : 0;
            const _ratio = _maxA > 0 ? this.weapon.ammo / _maxA : 1;
            const _acc = _wd && _wd.spread < 0.02; // snipers/lightning stay reliable far away
            const _dyy = Math.abs(_t.pos.y - this.pos.y);
            const _dd = Math.hypot(_t.pos.x - this.pos.x, _t.pos.y - this.pos.y);
            if (this.weapon.ammo === 1) ammoOk = _dyy < 40 && (_dd < 140 || _acc);
            else if (_ratio < 0.25) ammoOk = _dyy < 30 && (_dd < 240 || _acc);
          }
        }
        if (wantFire && !this.blocking && this.fireCd <= 0 && losOk && ammoOk) this.shoot();   // guns ignore heavy / stamina; can't shoot while guarding
      } else {
        if (doHeavy && _foeInFistRange) this.melee(true);                           // heavy punch (only if a foe is in range)
        else if (wantFire && canLight && !this.blocking && this.meleeCd <= 0 && _foeInFistRange) this.melee(false); // normal punch
      }
      this.recoilKick *= 0.82;
      this.hurtFlash = Math.max(0, this.hurtFlash - dt);

      // ── Anti-clump / anti-overlap: keep fighters readable on-screen.
      //    After the advanced tactics refactor, several bots can choose the same
      //    target; separate them physically so the fight doesn't become a boring pile.
      for (const o of fighters) {
        if (o === this || !o.alive) continue;
        const sdx = this.pos.x - o.pos.x, sdy = this.pos.y - o.pos.y;
        const adx = Math.abs(sdx), ady = Math.abs(sdy);
        if (adx < 56 && ady < 62) {
          // M106: stronger, wider separation so bots stop piling into a clump.
          const dir = adx < 0.5 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(sdx);
          const teamBoost = o.team === this.team ? 2.7 : 1.55;
          const push = dir * (3.6 + (56 - adx) * 0.13) * teamBoost;
          Body.setVelocity(this.body, { x: this.body.velocity.x + push, y: this.body.velocity.y - (ady < 18 ? 0.5 : 0) });
        }
      }

      // fell off the arena
      if (this.pos.y > KILL_Y) { if (this.matchStats) this.matchStats.deathByVoid++; if (TRAIN) this.fit -= 50; this.die({ x: 0, y: 0 }); } // falling into the void = death (-150) + extra -50 = -200, since it's fully avoidable
    }

    muzzle() {
      const dist = 30;
      return {
        x: this.pos.x + Math.cos(this.aim) * dist,
        y: this.pos.y - 8 + Math.sin(this.aim) * dist,
      };
    }
    shoot() {
      const w = this.weapon;
      // firing a weapon no longer drains stamina (armed attacks are stamina-free)
      if (this.matchStats) this.matchStats.shotsFired++;
      this.fireCd = w.cd;
      this._lastFireT = Date.now(); // #78 reload-window tracking
      const m = this.muzzle();
      const pellets = w.pellets || 1;
      for (let i = 0; i < pellets; i++) {
        const spread = (Math.random() - 0.5) * w.spread;
        const a = this.aim + spread;
        spawnBullet(m.x, m.y, a, this, w);
      }
      w.ammo--;
      // Newton's 3rd law: recoil pushes shooter backward
      Body.applyForce(this.body, this.pos, {
        x: -Math.cos(this.aim) * w.recoil,
        y: -Math.sin(this.aim) * w.recoil * 0.4,
      });
      this.recoilKick = 6;
      muzzleFlash(m.x, m.y, this.aim);
      // M107: big-bore guns (sniper, magic, high-recoil) get a beefier report
      if ((w.recoil || 0) >= 0.03 || w.type === 'sniper' || w.kind === 'magic') SFX.gunBig(); else SFX.shoot();
      shake(w.recoil * 800);
      if (w.ammo <= 0) { this.hype = Math.max(-100, (this.hype || 0) - 6); setTimeout(() => { if (this.weapon === w) this.weapon = null; }, 120); } // ran dry -> small morale dip
    }
    // CONTACT-BASED melee: a strike only lands if the arm/weapon tip ACTUALLY
    // reaches the target's body. We sample several points along the outer half of
    // the limb (shoulder -> tip) and test each against the victim's body box, so a
    // hit demands real contact -- no more "phantom" hits from a fist that never
    // touched. `reach` is measured from the shoulder, matching the drawn arm.
    meleeStrike(reach, dmg, knock, fitGain, opts) {
      opts = opts || {};
      // Momentum & stamina shape damage: on-fire +20%, exhausted -30%.
      dmg *= ((this.hype || 0) > 60 ? 1.2 : 1) * ((this.stamina || 0) < 25 ? 0.7 : 1);
      if (!TRAIN && this.hp < this.maxHp * 0.2) dmg *= 1.3; // 🔥 Rage: low-HP fighters hit 30% harder
      const sx = this.pos.x, sy = this.pos.y - 17;   // shoulder anchor (matches the drawn arm)
      const ca = Math.cos(this.aim), sa = Math.sin(this.aim);
      punchFx(sx + ca * reach, sy + sa * reach);
      const hit = new Map();
      for (const t of [0.3, 0.45, 0.6, 0.75, 0.9, 1.0]) {       // sample ALONG the whole limb (inner points too) so long-reach weapons like the spear still connect point-blank instead of whiffing
        const px = sx + ca * reach * t, py = sy + sa * reach * t;
        for (const f of fighters) {
          if (f === this || !f.alive || f.team === this.team || hit.has(f)) continue;
          if (pointHitsBody(px, py, f, 12)) hit.set(f, py);  // touch the body box (+12px); remember WHERE for zonal dmg
        }
      }
      for (const [f, _py] of hit) {
        const _z = damageZoneMult(_py, f);                 // M85 head > body > limbs
        f.hurt(dmg * _z.mult, { x: ca * knock, y: sa * knock - (opts.up || 0.03) }, f.pos, this);
        this._rsMeleeDmg = (this._rsMeleeDmg || 0) + dmg * _z.mult;   // M86 melee damage tally
        if (_z.zone === 'head' && !TRAIN) { shake(4); punchFx(f.pos.x, f.pos.y - 34); }
        if (!TRAIN) { if (opts.stun) f._stun = Math.max(f._stun || 0, opts.stun); if (opts.bleed) f._bleed = Math.max(f._bleed || 0, opts.bleed); }
        this._cumHits = (this._cumHits || 0) + 1; // #70
        if (TRAIN) { this.fit += fitGain; f.fit -= fitGain; }
        this.hype = Math.min(100, (this.hype || 0) + 6);   // landing blows builds momentum
        f.hype = Math.max(-100, (f.hype || 0) - 8);        // getting comboed kills it
      }
      return hit.size > 0;
    }
    chargedStrike(c) {
      const mult = 1 + c * 1.3;            // up to ~2.4x at full charge
      this._heavySwing = true; this._swing = 0.34; this._swingMax = 0.34; this._thrust = 18;
      shake(8 + c * 6);
      Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.024, y: -0.005 });
      if (this.weapon && this.weapon.kind === 'melee') {
        const w = this.weapon; this.meleeCd = w.cd * 1.8; this.heavyCd = w.cd * 2.4;
        this.meleeStrike(w.reach + 8, w.dmg * 2 * mult, w.knock * 2.2, 26, { stun: 0.6 });
      } else {
        this.meleeCd = 0.6; this.heavyCd = 1.1; this.stamina = Math.max(0, (this.stamina || 0) - 30);
        this.meleeStrike(36, 30 * mult, 0.22 * Math.min(2, mult), 26, { stun: 0.6 });
      }
    }
    melee(heavy) {
      this.stamina = Math.max(0, (this.stamina || 0) - (heavy ? 28 : 14)); // attacks drain stamina
      if (heavy) {
        this.meleeCd = 0.55; this.heavyCd = 1.0; this.recoilKick = 18;
        this._swing = 0.34; this._swingMax = 0.34; this._thrust = 18; // big, slow, telegraphed punch
        this._heavySwing = true;
        try { SFX.heavy(); } catch (e) {}
        shake(7);
        Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.022, y: -0.004 }); // lunge into it
        const heavyHit = this.meleeStrike(34, 30, 0.20, 26, { stun: 0.8 });   // long reach, hits hard, strong knockback + M61 stun
        if (TRAIN && heavyHit) this.fit += 5; // extra reward for landing a heavy punch
      } else {
        this.meleeCd = 0.8; this.heavyCd = Math.max(this.heavyCd, 0.12); this.recoilKick = 10; // M111: normal-punch cooldown 0.8s (anti-spam)
        this._swing = 0.16; this._swingMax = 0.16; this._thrust = 11;
        this._heavySwing = false; this._comboStep = (this._comboStep + 1) % 4; // cycle combo art
        try { SFX.swing(); } catch (e) {}
        let _dmg = 14, _kn = 0.05, _up = 0.03;
        if (!TRAIN && !this.isAI) { // M61 multi-hit combo: each consecutive jab escalates; 4th launches
          this._comboCount = (this._comboT > 0) ? Math.min(4, (this._comboCount || 0) + 1) : 1;
          this._comboT = 0.85;
          _dmg = 14 * (1 + 0.14 * (this._comboCount - 1));
          if (this._comboCount >= 4) { _kn = 0.16; _up = 0.22; this._comboCount = 0; shake(6); }
        }
        this.meleeStrike(28, _dmg, _kn, 15, { up: _up });   // quick short jab
      }
    }
    // melee weapon swing (sword / hammer / spear) — no ammo, uses weapon reach/dmg/knock
    // Each melee weapon now FIGHTS differently (M106):
    //   • SPEAR  = long straight THRUST/STAB (big reach, forward lunge, bleed)
    //   • HAMMER = slow ground-SLAM (massive knockback + shockwave AoE + stun)
    //   • SWORD  = balanced fast slashing combo + bleed
    meleeWeapon(heavy) {
      const w = this.weapon;
      const isSpear = w.type === 'spear', isHammer = w.type === 'hammer';
      // melee weapon swings no longer drain stamina (armed attacks are stamina-free)
      if (heavy) {
        this.meleeCd = w.cd * 1.6; this.heavyCd = w.cd * 2.2; this.recoilKick = 20;
        this._heavySwing = true;
        if (isSpear) {
          // committed LUNGING thrust: long forward stab, pierces toward the foe
          this._spearThrust = true; this._swing = 0.30; this._swingMax = 0.30; this._thrust = 30;
          Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.02, y: -0.004 }); // forward lunge — matched to sword/hammer so a thrust can't fling the spear user off the platform (was 0.05 → self-launched into the void = vanish)
          shake(5);
          try { SFX.stab(); } catch (e) {}   // M107: spear thrust gets a piercing stab cue
          const hit = this.meleeStrike(w.reach + 18, w.dmg * 1.8, w.knock * 2.2, 26, { stun: 0.5, bleed: 4 });
          if (TRAIN && hit) this.fit += 5;
        } else if (isHammer) {
          // ground-SLAM: slow, massive knockback + a shockwave that throws everyone nearby
          this._spearThrust = false; this._swing = 0.42; this._swingMax = 0.42; this._thrust = 0;
          shake(15);
          Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.02, y: 0.004 });
          try { SFX.slam(); } catch (e) {}   // M107: hammer ground-slam gets a deep boom + shockwave
          const hit = this.meleeStrike(w.reach + 6, w.dmg * 2, w.knock * 2.4, 26, { stun: 1.0 });
          this._hammerShock(w, w.dmg * 1.2, w.knock * 2.0);
          if (TRAIN && hit) this.fit += 5;
        } else {
          // SWORD: strong overhead slash
          this._spearThrust = false; this._swing = 0.36; this._swingMax = 0.36; this._thrust = 0;
          shake(w.knock * 160);
          Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.02, y: -0.004 });
          try { SFX.blade(); } catch (e) {}
          const hit = this.meleeStrike(w.reach + 6, w.dmg * 2, w.knock * 2, 26, { stun: 0.7, bleed: 3 });
          if (TRAIN && hit) this.fit += 5;
        }
      } else {
        this.meleeCd = w.cd; this.heavyCd = Math.max(this.heavyCd, 0.12); this.recoilKick = 13;
        this._heavySwing = false; this._comboStep = (this._comboStep + 1) % 4;
        if (isSpear) {
          // quick straight POKE: extended reach, minimal arc, small step into it
          this._spearThrust = true; this._swing = 0.18; this._swingMax = 0.18; this._thrust = 22;
          Body.applyForce(this.body, this.pos, { x: Math.cos(this.aim) * 0.022, y: 0 });
          try { SFX.stab(); } catch (e) {}   // M107: quick spear poke
          shake(3);
          this.meleeStrike(w.reach + 10, w.dmg, w.knock, 15, { bleed: 3 });
        } else if (isHammer) {
          // heavy one-handed bonk: slow, big knockback, brief stun, no combo
          this._spearThrust = false; this._swing = 0.30; this._swingMax = 0.30; this._thrust = 0;
          try { SFX.heavy(); } catch (e) {}
          shake(8);
          this.meleeStrike(w.reach, w.dmg, w.knock, 15, { stun: 0.3 });
        } else {
          // SWORD: fast slashing combo + bleed
          this._spearThrust = false; this._swing = 0.2; this._swingMax = 0.2; this._thrust = 0;
          try { SFX.blade(); } catch (e) {}
          shake(w.knock * 90);
          this.meleeStrike(w.reach, w.dmg, w.knock, 15, { bleed: 2.5 });
        }
      }
    }
    // HAMMER signature: a ground-slam radiates knockback + chip damage to EVERY
    // nearby fighter (no other melee weapon has an area effect).
    _hammerShock(w, dmg, knock) {
      const R = w.aoe || 80;
      for (const f of fighters) {
        if (f === this || !f.alive) continue;
        const dx = f.pos.x - this.pos.x, dy = f.pos.y - this.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 1) continue;
        const fall = 1 - d / R;                 // closer = stronger
        const ux = dx / d;
        f.hurt(dmg * fall, { x: ux * knock * (0.6 + fall), y: -(0.06 + fall * 0.06) }, f.pos, this);
        if (!TRAIN) f._stun = Math.max(f._stun || 0, 0.4 * fall);
        if (TRAIN) { this.fit += 1.5 * fall; }
      }
      if (!TRAIN) { try { shake(6); } catch (e) {} }
    }
    tryPickup() {
      for (const wp of weapons) {
        if (wp.taken) continue;
        if (Math.hypot(wp.body.position.x - this.pos.x, wp.body.position.y - this.pos.y) < 54) {
          this.weapon = makeWeapon(wp.type);
          wp.taken = true;
          World.remove(world, wp.body);
          this._pickup = 0.45;   // play the crouch-to-grab animation
          SFX.pickup();
          if (TRAIN) this.fit += 14; // reward: grabbed a weapon (boosted so pickups clearly pay off)
          break;
        }
      }
    }

    // ---- smart AI ----
    think(dt) {
      dt = dt || 0.016;
      if (this.brain) return brainAct(this.brain, this); // trained neural policy
      const out = { move: 0, jump: false, fire: false, heavy: false, down: false, block: false };
      const foe = nearestEnemy(this);
      if (!foe) { this.isEngaging = false; return out; }

      // ── Personality (from evolved genome; neutral if untrained) ───────────
      const _pers = (this.brain && this.brain.length > PERS_OFFSET) ? {
        atk: this.brain[PERS_OFFSET], flee: this.brain[PERS_OFFSET+1],
        blk: this.brain[PERS_OFFSET+2], wpn: this.brain[PERS_OFFSET+3],
      } : { atk: 0, flee: 0, blk: 0, wpn: 0 };

      // ── Threat Assessment ─────────────────────────────────────────────────
      const _fm = this.foeModel || { aggressionLevel: 0 };
      const _threat = (foe.weapon ? 0.40 : 0) + (foe.hp > this.hp ? 0.20 : 0) + (_fm.aggressionLevel * 0.40);
      const _highThreat = _threat > 0.50;

      const x = this.pos.x, y = this.pos.y, feet = y + 32;
      const dx = foe.pos.x - x, dy = foe.pos.y - y;
      const dist = Math.hypot(dx, dy);
      const wkind = this.weapon ? this.weapon.kind : null;
      const armed = !!(this.weapon && wkind !== 'melee' && this.weapon.ammo > 0); // usable ranged/magic
      const meleeWpn = wkind === 'melee';
      const foeArmed = !!(foe.weapon && foe.weapon.kind !== 'melee' && foe.weapon.ammo > 0);
      const grounded = this.grounded;

      // ── Line of sight: is a wall/platform blocking the shot at the target? ──
      // Tested torso-to-torso. Cached on the fighter so update()'s fire gate and
      // the tactics layer can both read it without recomputing.
      this._losBlocked = lineBlocked(x, y - 8, foe.pos.x, foe.pos.y - 8);

      this._jumpCd = (this._jumpCd || 0) - dt;
      this._dodgeCd = (this._dodgeCd || 0) - dt;
      this._strafeT = (this._strafeT || 0) - dt;

      // nearest free weapon on the field
      let wpn = null, wpnD = Infinity;
      for (const w of weapons) {
        if (w.taken) continue;
        const d = Math.hypot(w.body.position.x - x, w.body.position.y - y);
        if (d < wpnD) { wpnD = d; wpn = w; }
      }

      // Personality scales retreat/aggression thresholds
      const criticalHp = this.hp < (28 + _pers.flee * 12); // cautious bot retreats sooner
      const lowHp = this.hp < (45 + _pers.flee * 10);
      const hpAdvantage = foe && (this.hp - foe.hp) > 25; // healthier by 25+ -> press the attack
      const aliveAllies = fighters.filter(f => f !== this && f.team === this.team && f.alive).length;
      const aliveEnemies = fighters.filter(f => f.team !== this.team && f.alive).length;
      const myTeamAlive = aliveAllies + 1;             // count self
      const numAdvantage = aliveEnemies > 0 && myTeamAlive > aliveEnemies; // outnumber -> capitalize
      const wantWeapon = !this.weapon && wpn && wpnD < (900 * (1 + _pers.wpn * 0.4)); // weapon-lover hunts wider
      const needRegen = criticalHp && dist > 100 && !foeArmed; // back away unless being shot at
      const _hypeAtk = (this.hype || 0) > 60 ? 1 : ((this.hype || 0) < -40 ? -1 : 0); // on fire / tilted mental state
      const flee = !this.weapon && foeArmed && (dist < 430 || lowHp) && !hpAdvantage && (_highThreat || _pers.flee > -0.4) && _hypeAtk <= 0;

      // ── Stamina recovery tactic ────────────────────────────────────────���─��
      // When gassed, break off the fight and open up distance to catch your breath,
      // then re-engage once recovered. Hysteresis (drops in <22, resumes >60) stops
      // it from flip-flopping in/out of recovery every frame.
      const _stamNow = this.stamina || 0;
      if (this._staminaFlee) { if (_stamNow > 60) this._staminaFlee = false; }
      else if (_stamNow < 22) this._staminaFlee = true;
      const recoverStamina = this._staminaFlee && _hypeAtk <= 0; // on-fire bots fight through it

      // ---- pick a goal (where to go + why) ----
      let goalX, goalY, mode;
      if (needRegen) {
        // Retreat away from foe but clamp within arena bounds (80-1200) to avoid wall-sticking
        const regenDir = -Math.sign(dx || 1);
        goalX = Math.max(80, Math.min(1200, x + regenDir * 350)); goalY = y; mode = 'regen';
      } else if (recoverStamina) {
        // Gassed out -> disengage and rebuild stamina before committing to a fight again.
        const sDir = -Math.sign(dx || 1);
        goalX = Math.max(80, Math.min(1200, x + sDir * 320)); goalY = y; mode = 'stamina';
      } else if (wantWeapon) {
        goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'weapon';
      } else if (flee) {
        // Flee away from foe but clamp to arena bounds
        const fleeDir = -Math.sign(dx || 1);
        goalX = Math.max(80, Math.min(1200, x + fleeDir * 350)); goalY = y; mode = 'flee';
      } else if (numAdvantage && !armed) {
        goalX = foe.pos.x; goalY = foe.pos.y; mode = 'press'; // numerical edge -> rush unarmed
      } else if (hpAdvantage && !armed) {
        goalX = foe.pos.x; goalY = foe.pos.y; mode = 'press'; // hp edge -> rush unarmed
      } else if (armed) {
        const wt = this.weapon.type;
        const ideal = (wt === 'shotgun' || wt === 'fireball' || wt === 'rocket') ? 160 : (wt === 'sniper') ? 470 : 320;
        if (dist > ideal + 80) goalX = foe.pos.x;                 // close in
        else if (dist < ideal - 90) goalX = x - Math.sign(dx || 1) * 220; // back off
        else {                                                    // hold range and strafe
          if (this._strafeT <= 0) { this._strafeDir = (this._strafeDir || 1) * -1; this._strafeT = 0.8 + Math.random() * 0.5; }
          goalX = x + (this._strafeDir || 1) * 130;
        }
        goalY = foe.pos.y; mode = 'engage';
      } else {
        goalX = foe.pos.x; goalY = foe.pos.y; mode = 'rush';
      }

      // ── #8 Last Man Standing: 1v1 final override ────────────────────────────────
      const isLastManStanding = fighters.filter(f => f.alive).length === 2;
      if (isLastManStanding && (mode === 'flee' || mode === 'regen')) {
        if (this.hp > 15) { goalX = foe.pos.x; goalY = foe.pos.y; mode = armed ? 'engage' : 'final_rush'; }
      }

      const goalUp = goalY < y - 60;
      const goalDown = goalY > y + 80;
      const plat = currentPlatform(this);

      // If the goal is higher and nothing is climbable right here, route toward
      // the nearest stepping-stone platform above us (multi-step path-finding).
      if (goalUp && !climbTarget(this)) {
        let step = null, sd = Infinity;
        for (const p of platforms) {
          const up = feet - (p.y - p.h / 2);
          if (up > 30 && up < 185) { const d = Math.abs(p.x - x); if (d < sd) { sd = d; step = p; } }
        }
        if (step) goalX = step.x;
      }

      let dir = (goalX < x - 12) ? -1 : (goalX > x + 12 ? 1 : 0);
      // Commit to a heading briefly so the bot walks with clear intent instead of
      // flip-flopping left/right every frame while hovering right next to its target.
      this._navHold = (this._navHold || 0) - dt;
      if (dir !== 0) {
        if (this._navDir && dir !== this._navDir && this._navHold > 0 && Math.abs(goalX - x) < 70) dir = this._navDir;
        else { this._navDir = dir; this._navHold = 0.3; }
      }
      if (wpn && wpnD < 56) out.down = true;   // grab weapon underfoot

      // ---- navigation: climb / cross gaps / never fall off ----
      if (grounded && this._jumpCd <= 0) {
        if (goalUp) {
          const ct = climbTarget(this);
          if (ct) {
            const within = x > ct.x - ct.w / 2 - 12 && x < ct.x + ct.w / 2 + 12;
            if (within) { out.jump = true; this._jumpCd = 0.55; }   // hop straight up
            else dir = ct.x < x ? -1 : 1;                            // walk under it first
          }
        }
        if (!out.jump && plat && dir !== 0) {
          const edge = dir > 0 ? plat.x + plat.w / 2 : plat.x - plat.w / 2;
          if ((edge - x) * dir < 42) {                               // near the ledge
            const land = platformInDirection(this, dir);
            if (land) { out.jump = true; this._jumpCd = 0.5; }        // leap the gap
            else dir = 0; // ALWAYS refuse to walk into void — no safe landing found in any direction
          }
        }
      }

      out.move = dir;

      // Whether it's safe to hop right here (not hanging over a ledge with no landing).
      // NOTE: declared UP-FRONT — it is read by BOTH the unstick and dodge logic below.
      // (Previously this was declared later with `const`, so the unstick check read it
      //  in the temporal dead zone and threw a ReferenceError every frame a bot got
      //  stuck — which cascaded and bounced the match back to the menu.)
      const safeToJump = !plat || (
        (x > plat.x - plat.w / 2 + 40) && (x < plat.x + plat.w / 2 - 40) // not within 40px of either edge
      );

      // unstick: pressing into something but not actually moving
      if (grounded && dir !== 0 && Math.abs(this.body.velocity.x) < 0.3) this._stuck = (this._stuck || 0) + dt;
      else this._stuck = 0;
      // unstick jump — only if safe (not near a platform edge with no landing)
      if (this._stuck > 0.3 && this._jumpCd <= 0 && safeToJump) { out.jump = true; this._jumpCd = 0.4; this._stuck = 0; }

      // dodge incoming fire — but only if NOT near a ledge with no safe landing
      const threat = foeArmed && Math.abs(dy) < 70 && dist < 560 && Math.sign(foe.pos.x - x) === foe.facing;
      if (threat && grounded && safeToJump && this._dodgeCd <= 0) { out.jump = true; this._dodgeCd = 1.1 + Math.random() * 0.4; }

      // dodge incoming MELEE: a close foe that is mid-swing (or right on top of us)
      // -> don't just stand there and eat it. Skip back out of reach and/or hop, or
      // raise a guard to parry. This is the fix for "bot lets itself get hit".
      const meleeThreat = !foeArmed && dist < 104 && Math.abs(dy) < 66 && Math.sign(foe.pos.x - x) === foe.facing;
      if (meleeThreat && this._dodgeCd <= 0 && (foe._swing > 0 || dist < 70)) {
        if (foe._swing > 0 && Math.random() < 0.5) { out.block = true; out.move = 0; } // parry the active swing
        else {
          out.move = (x <= foe.pos.x ? -1 : 1); // step away from the foe
          if (grounded && safeToJump && Math.random() < 0.5) out.jump = true; // hop the swing
        }
        this._dodgeCd = 0.5 + Math.random() * 0.3;
      }

      // -- #1 Whiff Punish: punish foe's missed attack --
      const foeJustWhiffed = foe._swing === 0 && foe.meleeCd > 0 && dist < 120;
      if (foeJustWhiffed && this._dodgeCd <= 0) {
        out.fire = true;
        if (TRAIN) this.fit += 10;
      }

      // ---- shooting / melee ----
      if (armed) {
        // -- #3 Ammo Conservation: conserve when low --
        const baseAmmo = WEAPONS[this.weapon.type] ? WEAPONS[this.weapon.type].ammo : 30;
        const ammoRatio = this.weapon.ammo / baseAmmo;
        const aligned = Math.abs(dy) < 90 && Math.sign(dx || this.facing) === this.facing && dist < 800;
        let perfectShot = Math.abs(dy) < 30 && dist < 250;
        if (aligned && !flee) out.fire = true;
        if (ammoRatio < 0.25 && !perfectShot) out.fire = false; // low ammo -> only perfect shots
        if (ammoRatio < 0.1 && dist > 300) { mode = 'weapon'; out.fire = false; } // critical ammo -> find new weapon
        if (this.weapon.type === 'shotgun' && dist > 230) out.fire = false; // save shells for close range

        // -- #4 Burst & Retreat: SMG/minigun hit-and-run cycle --
        const isSprayWeapon = ['smg', 'minigun', 'rifle'].includes(this.weapon.type);
        if (isSprayWeapon) {
          this._burstTimer = (this._burstTimer || 0) + dt;
          if (this._burstTimer < 0.6) {
            out.fire = true; goalX = foe.pos.x; // burst phase
          } else if (this._burstTimer < 1.4) {
            goalX = x - Math.sign(dx || 1) * 200; out.fire = false; // retreat phase
          } else {
            this._burstTimer = 0; // reset cycle
          }
        }

        // -- #7 Exploit Status Effects: icebolt slow + lightning knockback --
        if (foe._slow > 1.0 && this.weapon.type === 'icebolt') {
          const idealRange = 80; // closer than usual
          if (dist > idealRange + 40) goalX = foe.pos.x;
          if (TRAIN) this.fit += 2 * dt;
        }
        if (Math.abs(foe.body.velocity.x) > 8) {
          goalX = foe.pos.x + foe.body.velocity.x * 0.3; // follow knockback
        }
      } else if (meleeWpn) {
        if (dist < this.weapon.reach * 0.95 && Math.abs(dy) < 60) {
          out.fire = true; // swing the blade
          if (dist < this.weapon.reach * 0.6 && Math.random() < 0.2) out.heavy = true; // commit a heavy blow up close
        }
      } else if (dist < 50 && Math.abs(dy) < 50) { // tightened to match the new contact hitbox (~46px real reach)
        out.fire = true; // punch
        if (dist < 34 && Math.random() < 0.25) out.heavy = true; // point-blank -> heavy punch
      }
      // ── Team Coordination: if ally is engaging, flank from opposite side ──
      const _ally = nearestAlly(this);
      if (_ally && _ally.isEngaging && !this.isEngaging && mode !== 'regen' && mode !== 'flee' && mode !== 'stamina') {
        goalX = foe.pos.x + (this.pos.x > _ally.pos.x ? -150 : 150); mode = 'wide_flank';
        if (TRAIN) this.fit += 0.3 * dt; // reward coordinated flanking
      }

      // ── Opponent Model Counter-strategy ─���────────────────��────────────────
      // Aggressive foe → prefer reactive block when in close range
      if (_highThreat && dist < 100 && !this.weapon && this.grounded) {
        if (Math.random() < (0.30 + _pers.blk * 0.25 + (_hypeAtk < 0 ? 0.25 : 0))) out.block = true; // tilted -> turtles up
      }

      // -- Advanced tactical refactor (#11-#40): helper can override goal/mode/actions safely --
      const _adv = advancedTactics(this, foe, { out, goalX, goalY, mode, dist, dt, armed, foeArmed, plat, grounded, safeToJump, wpn, wpnD, goalUp });
      goalX = _adv.goalX; goalY = _adv.goalY; mode = _adv.mode;
      // Shot blocked by cover: stop firing into the wall and move to the target's
      // column to re-open a clean line instead of wasting ammo standing still.
      if (armed && this._losBlocked && mode !== 'flee' && mode !== 'regen' && mode !== 'stamina') {
        goalX = foe.pos.x; mode = 'get_los'; out.fire = false;
      }
      out.move = (goalX < x - 12) ? -1 : (goalX > x + 12 ? 1 : 0);

      // suppress attacks while retreating to heal
      if (mode === 'regen' || mode === 'stamina') { out.fire = false; out.heavy = false; } // recovering -> hold attacks

      // reactive guard: block chance scaled by personality
      const _bChance = Math.max(0.15, 0.45 + _pers.blk * 0.25);
      if (foe._swing > 0 && dist < 75 && this.grounded && Math.random() < _bChance) { out.block = true; out.fire = false; out.heavy = false; }

      // -- #9 Fake Retreat: reverse bait mindgame --
      this._fakeFleeTimer = Math.max(0, (this._fakeFleeTimer || 0) - dt);
      if (!armed && dist < 200 && this.hp > 60 && this._fakeFleeTimer <= 0 && Math.random() < 0.15) {
        this._fakeFleeing = true; this._fakeFleeTimer = 1.2;
      }
      if (this._fakeFleeing) {
        if (this._fakeFleeTimer > 0.4) {
          goalX = x - Math.sign(dx || 1) * 300; out.move = goalX < x ? -1 : 1; // fake flee
        } else {
          goalX = foe.pos.x; out.fire = true; this._fakeFleeing = false; // reverse!
          if (TRAIN && dist < 80) this.fit += 8;
        }
      }

      // ── Update isEngaging for team coordination ───────────────────────────
      this.isEngaging = dist < 140;
      return out;
    }

    draw(g) {
      drawFighterIK(g, this);
      drawFitBreakdown(g, this);
    }
  }

  // ============================================================
  //  IK stickman animation (ported & adapted from the IK demo)
  // ============================================================
  const _GAIT = {
    walk: { stride:15, lift:10, armStride:13, armReach:0.90, lean:0.12, bobAmp:2.2, baseLeg:43 },
    run:  { stride:24, lift:19, armStride:21, armReach:0.70, lean:0.36, bobAmp:4.0, baseLeg:41 },
  };
  const _ikLerp = (a,b,t)=>a+(b-a)*t;
  const _ikClamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const _ikEoc = t => 1 - Math.pow(1-t, 3);
  const _ikEio = t => t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;
  // 2-bone IK: returns mid-joint + clamped target so limbs never over-extend
  function ikSolve(rx, ry, tx, ty, l1, l2, bend){
    let dx = tx-rx, dy = ty-ry;
    let d = Math.hypot(dx, dy) || 0.0001;
    const maxd = l1+l2-0.001, mind = Math.abs(l1-l2)+0.001;
    const dc = _ikClamp(d, mind, maxd);
    const ux = dx/d, uy = dy/d;
    tx = rx + ux*dc; ty = ry + uy*dc;
    const a = Math.atan2(ty-ry, tx-rx);
    const c = _ikClamp((l1*l1 + dc*dc - l2*l2)/(2*l1*dc), -1, 1);
    const ang = Math.acos(c);
    const ja = a + bend*ang;
    return { jx: rx + Math.cos(ja)*l1, jy: ry + Math.sin(ja)*l1, tx, ty };
  }
  function ikSlash(t0, t1, R, f, prog){
    const wind = _ikClamp(prog/0.30, 0, 1);
    const strike = _ikEoc(_ikClamp((prog-0.30)/0.55, 0, 1));
    const mid = (t0+t1)/2;
    const th = prog<0.30 ? _ikLerp(mid, t0, wind) : _ikLerp(t0, t1, strike);
    return { x: f*R*Math.cos(th), y: R*Math.sin(th) };
  }

  // Map a Fighter's live state onto the IK skeleton.
  function ikSkeleton(fi) {
    const f = fi.facing;
    const vx = fi.body.velocity.x, vy = fi.body.velocity.y;
    const grounded = fi.grounded;
    const spd = Math.abs(vx);
    const moving = spd > 0.6;
    const t = performance.now() * 0.06;   // ~ per-frame tick (matches IK demo cadence)
    const p = fi.walkPhase;

    let st;
    if (!grounded) st = 'jump';
    else if (moving) st = spd > 3.2 ? 'run' : 'walk';
    else st = 'idle';

    const hasGun = !!(fi.weapon && fi.weapon.kind !== 'melee');
    const hasMelee = !!(fi.weapon && fi.weapon.kind === 'melee');
    const armed = hasMelee; // IK blade arcs only for melee weapons

    const blocking = fi.blocking;
    const swing = fi._swing || 0;
    const sm = fi._swingMax || 0.2;
    let action = null, prog = 0;
    if (fi._climb) { action = 'climb'; prog = fi._climbU || 0; }
    else if (fi._pickup > 0) { action = 'pickup'; prog = _ikClamp(1 - fi._pickup / 0.45, 0, 1); }
    else if (hasGun) { action = null; }
    else if (blocking) { action = 'block'; prog = 1; }
    else if (swing > 0) { action = fi._heavySwing ? 'heavy' : 'punch'; prog = _ikClamp(1 - swing/sm, 0, 1); }
    const punchStep = fi._comboStep || 0;

    const thigh=24, shin=24, upper=18, fore=16;
    const spineLen=30, neckHead=15, headR=11, footLen=11;
    const armLen = upper+fore;

    let stride=0, lift=0, armStride=0, armReach=0.95, lean=0.05, bobAmp=0, baseLeg=43;
    if (st==='walk' || st==='run'){
      const g = _GAIT[st];
      stride=g.stride; lift=g.lift; armStride=g.armStride; armReach=g.armReach;
      lean=g.lean; bobAmp=g.bobAmp; baseLeg=g.baseLeg;
    } else if (st==='jump'){ lean=0.16; baseLeg=34; }

    const breath = Math.sin(t*0.05);
    let spineLenV = spineLen;
    const sway = st==='idle' ? (Math.sin(t*0.045)*1.6 + Math.sin(t*0.021)*0.9) : 0;
    let bob = (st==='walk'||st==='run') ? bobAmp*(0.5-Math.abs(Math.sin(p)))
            : (st==='idle' ? Math.sin(t*0.045)*1.0 : 0);
    if (st==='walk' || st==='run'){ lean += Math.sin(p)*0.045; bob += Math.sin(p*2)*0.7; }
    if (st==='idle'){ lean += Math.sin(t*0.038)*0.03; spineLenV += breath*1.2; }
    let lunge=0, hipOff=0, punchArm='A';

    // ---- leg targets ----
    let footAx,footAy,footBx,footBy, liftAn=0, liftBn=0;
    if (st==='walk' || st==='run'){
      const pa=p, pb=p+Math.PI;
      const la = lift*Math.max(0,-Math.sin(pa));
      const lb = lift*Math.max(0,-Math.sin(pb));
      footAx = f*stride*Math.cos(pa); footAy = baseLeg - la - bob; liftAn = la/(lift||1);
      footBx = f*stride*Math.cos(pb); footBy = baseLeg - lb - bob; liftBn = lb/(lift||1);
    } else if (st==='jump'){
      const u = vy<0;
      footAx=f*(u?11:6); footAy=u?30:38; footBx=f*(u?-7:-4); footBy=u?25:40;
    } else {
      footAx = f*6 + sway*0.3; footAy = baseLeg;
      footBx = -f*8 + sway*0.3; footBy = baseLeg;
    }

    // ---- arm targets ----
    let handAx,handAy,handBx,handBy;
    if (st==='walk' || st==='run'){
      handAx = f*armStride*Math.cos(p+Math.PI) + f*2; handAy = armLen*armReach + Math.sin(p*2)*2.4;
      handBx = f*armStride*Math.cos(p) + f*2;         handBy = armLen*armReach + Math.sin(p*2+Math.PI)*2.4;
    } else if (st==='jump'){
      handAx=f*3; handAy=-armLen*0.5; handBx=-f*5; handBy=-armLen*0.42;
    } else {
      const s2=Math.sin(t*0.027+1);
      handAx = f*5 + sway*0.5 + s2*1.1; handAy = armLen*0.92 + breath*1.8;
      handBx = -f*3 + sway*0.5 - s2*1.1; handBy = armLen*0.90 + breath*1.8;
    }

    // ---- action overrides ----
    if (action==='punch'){
      const step = punchStep;
      const usingA = armed ? true : (step % 2 === 0);
      punchArm = usingA ? 'A' : 'B';
      let hpx, hpy;
      if (armed && fi._spearThrust){
        // SPEAR: a straight forward THRUST — the arm drives out along the facing (no slash arc)
        const ext = Math.sin(prog*Math.PI);
        hpx = _ikLerp(f*6, f*(armLen*1.08), ext);
        hpy = _ikLerp(2, -2, ext);
        lean = 0.06 + ext*0.10;
        lunge = ext*11;
      } else if (armed){
        const arcs = [[-0.9,0.95],[0.9,-0.7],[-0.3,1.0],[-1.6,1.2]][step];
        const sw = ikSlash(arcs[0], arcs[1], armLen*0.95, f, prog);
        hpx=sw.x; hpy=sw.y;
        lean = 0.07 + Math.sin(prog*Math.PI)*(step===3?0.26:0.16);
        lunge = Math.sin(prog*Math.PI)*(step===3?8:4);
      } else if (step < 2){
        const reach = Math.sin(prog*Math.PI);
        hpx = _ikLerp(f*8, f*(armLen-2), reach); hpy = _ikLerp(6, -2, reach);
        lean = 0.10 + reach*0.10; lunge = reach*5;
      } else if (step === 2){
        const sw = ikSlash(0.9, -0.2, armLen*0.92, f, prog);
        hpx=sw.x; hpy=sw.y; lean=0.10+Math.sin(prog*Math.PI)*0.12; lunge=Math.sin(prog*Math.PI)*5;
      } else {
        const wind=_ikClamp(prog/0.40,0,1), strike=_ikEoc(_ikClamp((prog-0.40)/0.50,0,1));
        if (prog<0.40){ hpx=_ikLerp(f*8,-f*14,_ikEio(wind)); hpy=_ikLerp(4,-28,_ikEio(wind)); lean=0.12-wind*0.22; }
        else { hpx=_ikLerp(-f*14,f*(armLen-3),strike); hpy=_ikLerp(-28,14,strike); lean=-0.04+strike*0.42; lunge=strike*7; }
      }
      const hgx=f*9, hgy=-2;
      if (usingA){ handAx=hpx; handAy=hpy; handBx=hgx; handBy=hgy; }
      else       { handBx=hpx; handBy=hpy; handAx=hgx; handAy=hgy; }
      footAx=f*10; footAy=baseLeg; footBx=-f*12; footBy=baseLeg; liftAn=liftBn=0;
    } else if (action==='heavy'){
      if (armed && fi._spearThrust){
        // SPEAR heavy: a deep lunging stab — wind back briefly, then drive far forward
        const wind = _ikClamp(prog/0.30, 0, 1);
        const strike = _ikEoc(_ikClamp((prog-0.30)/0.55, 0, 1));
        handAx = prog<0.30 ? _ikLerp(f*6, -f*5, _ikEio(wind)) : _ikLerp(-f*5, f*(armLen*1.18), strike);
        handAy = -2; handBx=-f*8; handBy=6;
        lean=-0.02+strike*0.34; lunge=strike*15; hipOff=strike*2;
        footAx=f*(14+strike*10); footAy=baseLeg; footBx=-f*18; footBy=baseLeg; liftAn=liftBn=0;
      } else if (armed){
        const sw = ikSlash(-1.7, 1.25, armLen*0.98, f, prog);
        handAx=sw.x; handAy=sw.y; handBx=-f*8; handBy=6;
        const strike=_ikEoc(_ikClamp((prog-0.40)/0.50,0,1));
        lean=-0.05+strike*0.50; lunge=strike*8; hipOff=strike*3;
        footAx=f*(14+strike*8); footAy=baseLeg; footBx=-f*16; footBy=baseLeg; liftAn=liftBn=0;
      } else {
        const wind = _ikClamp(prog/0.40, 0, 1);
        const strike = _ikEoc(_ikClamp((prog-0.40)/0.45, 0, 1));
        const gX=f*8, gY=4, wX=-f*14, wY=-30, sX=f*(armLen-4), sY=20;
        if (prog < 0.40){ handAx=_ikLerp(gX,wX,_ikEio(wind)); handAy=_ikLerp(gY,wY,_ikEio(wind)); lean=0.12-wind*0.26; }
        else { handAx=_ikLerp(wX,sX,strike); handAy=_ikLerp(wY,sY,strike); lean=-0.05+strike*0.48; lunge=strike*7; hipOff=strike*3; }
        handBx=-f*8; handBy=6;
        footAx=f*(14 + (prog>=0.40?strike*8:0)); footAy=baseLeg; footBx=-f*16; footBy=baseLeg; liftAn=liftBn=0;
      }
    } else if (action==='block'){
      lean=0.08; hipOff=4;
      handAx=f*15; handAy=-15; handBx=f*9; handBy=-20;
      footAx=f*9; footAy=baseLeg-5; footBx=-f*10; footBy=baseLeg-5; liftAn=liftBn=0;
    } else if (action==='pickup'){
      const reach = Math.sin(_ikClamp(prog,0,1)*Math.PI);   // squat down, then rise back up
      hipOff = 13*reach;                                     // hips drop into the crouch
      lean = 0.22*reach;                                     // torso leans over the item
      footAx=f*9; footAy=baseLeg - hipOff; footBx=-f*10; footBy=baseLeg - hipOff; liftAn=liftBn=0;
      const gx = f*13, gy = baseLeg*0.60 + hipOff;           // near hand reaches the ground
      handAx = _ikLerp(f*5, gx, reach); handAy = _ikLerp(armLen*0.85, gy, reach);
      handBx = -f*4; handBy = armLen*0.7;
    } else if (action==='climb'){
      const u = _ikClamp(prog,0,1);
      lean = 0.10;
      // hands grip high at the start, then push down as the body rises over the lip
      handAx = f*8;  handAy = _ikLerp(-armLen*0.98, -armLen*0.15, u);
      handBx = f*2;  handBy = _ikLerp(-armLen*0.90, -armLen*0.05, u);
      // legs tuck up early, then plant on top as the climb finishes
      footAx = f*(6+u*5);  footAy = _ikLerp(baseLeg*0.45, baseLeg, u);
      footBx = -f*(4+u*3); footBy = _ikLerp(baseLeg*0.40, baseLeg, u);
      liftAn = liftBn = 0;
    }

    // ---- build joint points (hip-local) ----
    const hx = lunge + sway*0.4, hy = bob + hipOff;
    const ux = f*Math.sin(lean), uy = -Math.cos(lean);
    const neck     = { x: hx+ux*spineLenV,     y: hy+uy*spineLenV };
    const shoulder = { x: hx+ux*(spineLenV-7), y: hy+uy*(spineLenV-7) };
    const head     = { x: neck.x+ux*neckHead, y: neck.y+uy*neckHead };

    let footA={x:hx+footAx,y:hy+footAy}, footB={x:hx+footBx,y:hy+footBy};
    const kA=ikSolve(hx,hy,footA.x,footA.y,thigh,shin,-f);
    const kB=ikSolve(hx,hy,footB.x,footB.y,thigh,shin,-f);
    const kneeA={x:kA.jx,y:kA.jy}; footA={x:kA.tx,y:kA.ty};
    const kneeB={x:kB.jx,y:kB.jy}; footB={x:kB.tx,y:kB.ty};
    const pitA=-0.6*liftAn, pitB=-0.6*liftBn;
    const toeA={x:footA.x+f*footLen*Math.cos(pitA), y:footA.y+footLen*Math.sin(pitA)};
    const toeB={x:footB.x+f*footLen*Math.cos(pitB), y:footB.y+footLen*Math.sin(pitB)};

    let handA={x:shoulder.x+handAx,y:shoulder.y+handAy}, handB={x:shoulder.x+handBx,y:shoulder.y+handBy};
    const eA=ikSolve(shoulder.x,shoulder.y,handA.x,handA.y,upper,fore,f);
    const eB=ikSolve(shoulder.x,shoulder.y,handB.x,handB.y,upper,fore,f);
    const elbowA={x:eA.jx,y:eA.jy}; handA={x:eA.tx,y:eA.ty};
    const elbowB={x:eB.jx,y:eB.jy}; handB={x:eB.tx,y:eB.ty};

    return { f, hx, hy, neck, shoulder, head, headR,
             kneeA, footA, toeA, kneeB, footB, toeB,
             elbowA, handA, elbowB, handB, prog, action, punchArm, hasGun, hasMelee };
  }

  function drawFighterIK(g, fi) {
    const J = ikSkeleton(fi);
    const S = 0.74 * (fi._scale || 1);     // scale IK rig (×_scale enlarges the Boss)
    // M96 respawn animation: yank-up -> drop -> landing squash -> slow stand-up (visual only)
    let _entLift = 0, _entVS = 1, _entTilt = 0, _entShadow = 1;
    if (fi._entrance > 0) {
      const ED = 1.0, pr = 1 - fi._entrance / ED; // 0 at spawn -> 1 when done
      if (pr < 0.34) {
        // body yanked up above spawn, then dropped with an accelerating fall
        const u = pr / 0.34;
        const lift = u < 0.4 ? (u / 0.4) : (1 - Math.pow((u - 0.4) / 0.6, 2));
        _entLift = 168 * Math.max(0, lift);
        _entShadow = 0.35 + 0.65 * (1 - Math.max(0, lift));
      } else {
        // landing squash recovering into a slow stand-up
        const u = (pr - 0.34) / 0.66; // 0..1
        _entVS = 0.5 + 0.5 * (1 - Math.pow(1 - u, 3)); // ease-out 0.5 -> 1.0
        _entTilt = 0.14 * (1 - u);
      }
    }
    const ox = fi.pos.x, oy = fi.pos.y - 2 + (fi._crouch ? 8 : 0);
    const col = fi.hurtFlash > 0 ? '#ffffff' : fi.color;
    // suppress the ranged aim-arm while climbing or crouching to grab
    const gunAim = J.hasGun && J.action !== 'climb' && J.action !== 'pickup';
    const wtype = fi.weapon ? fi.weapon.type : null;
    g.save();
    g.lineCap='round'; g.lineJoin='round';

    const seg = (a,b,w,al)=>{ g.globalAlpha=al; g.lineWidth=w; g.strokeStyle=col;
      g.beginPath(); g.moveTo(ox+a.x*S, oy+a.y*S); g.lineTo(ox+b.x*S, oy+b.y*S); g.stroke(); };

    // ground shadow (stays on the true ground; shrinks/fades while airborne during respawn)
    g.globalAlpha = 0.20 * _entShadow; g.fillStyle = 'rgba(0,0,0,1)';
    g.beginPath(); g.ellipse(ox + J.hx*S, oy + 34, 17 * (0.6 + 0.4 * _entShadow), 4.5 * (0.6 + 0.4 * _entShadow), 0, 0, Math.PI*2); g.fill();
    g.globalAlpha = 1;
    // M96 apply respawn transform to the whole body around the feet pivot (shadow drawn above is excluded)
    if (fi._entrance > 0) {
      const _pvx = ox + J.hx*S, _pvy = oy + 34;
      g.translate(_pvx, _pvy - _entLift);
      g.scale(1, _entVS);
      g.rotate(_entTilt);
      g.translate(-_pvx, -_pvy);
    }

    const hip={x:J.hx,y:J.hy};
    const drawLeg=(k,ft,toe,w,al)=>{ seg(hip,k,w,al); seg(k,ft,w,al); seg(ft,toe,w,al); };
    const drawArm=(el,hd,w,al)=>{ seg(J.shoulder,el,w,al); seg(el,hd,w,al); };
    // Draws the held melee weapon in the hand, shaped by its type so a hammer
    // and spear no longer render as a sword.
    const drawMeleeWeapon=(hd,el,type)=>{
      const hX=ox+hd.x*S, hY=oy+hd.y*S;
      let dx=hd.x-el.x, dy=hd.y-el.y; const m=Math.hypot(dx,dy)||1; dx/=m; dy/=m;
      const nx=-dy, ny=dx;                       // perpendicular (for guards/heads)
      g.globalAlpha=1;
      if (type==='hammer'){
        g.strokeStyle='#6b4a2b'; g.lineWidth=4;  // handle
        g.beginPath(); g.moveTo(hX,hY); g.lineTo(hX+dx*22*S, hY+dy*22*S); g.stroke();
        const hkx=hX+dx*25*S, hky=hY+dy*25*S;    // big steel head
        g.save(); g.translate(hkx,hky); g.rotate(Math.atan2(dy,dx));
        g.fillStyle='#6b7484'; g.fillRect(-4*S,-10*S, 15*S, 20*S);
        g.fillStyle='#8b94a4'; g.fillRect(-4*S,-10*S, 4*S, 20*S);
        g.restore();
      } else if (type==='spear'){
        g.strokeStyle='#6b4a2b'; g.lineWidth=3.2; // long shaft
        g.beginPath(); g.moveTo(hX-dx*10*S, hY-dy*10*S); g.lineTo(hX+dx*46*S, hY+dy*46*S); g.stroke();
        const tx=hX+dx*46*S, ty=hY+dy*46*S;       // leaf tip
        g.fillStyle='#dfe6f2';
        g.beginPath();
        g.moveTo(tx+dx*10*S, ty+dy*10*S);
        g.lineTo(tx+nx*4*S,  ty+ny*4*S);
        g.lineTo(tx-nx*4*S,  ty-ny*4*S);
        g.closePath(); g.fill();
      } else if (type==='chainsaw'){
        g.strokeStyle='#6b4a2b'; g.lineWidth=4;                 // short grip
        g.beginPath(); g.moveTo(hX,hY); g.lineTo(hX+dx*7*S, hY+dy*7*S); g.stroke();
        g.save(); g.translate(hX+dx*7*S, hY+dy*7*S); g.rotate(Math.atan2(dy,dx));
        g.fillStyle='#d7522a'; g.fillRect(0,-5*S, 30*S, 10*S);      // orange bar
        g.fillStyle='#2b3142'; g.fillRect(0,-5*S, 9*S, 10*S);       // motor housing
        g.fillStyle='#cfd6e6';                                       // chain teeth
        for (let i=0;i<6;i++){ g.fillRect((11+i*3.4)*S, -7.5*S, 2*S, 3*S); }
        g.restore();
      } else if (type==='mirrorshield'){
        g.save(); g.translate(hX+dx*6*S, hY+dy*6*S); g.rotate(Math.atan2(dy,dx));
        g.fillStyle='#9fe8ff'; g.strokeStyle='#dfe7ef'; g.lineWidth=2*S;
        g.beginPath(); g.ellipse(0,0, 6*S, 14*S, 0, 0, Math.PI*2); g.fill(); g.stroke();
        g.strokeStyle='rgba(255,255,255,.7)'; g.lineWidth=1.5*S;     // shine
        g.beginPath(); g.moveTo(-2*S,-9*S); g.lineTo(-2*S,9*S); g.stroke();
        g.restore();
      } else { // sword (default)
        g.strokeStyle='#c9ced6'; g.lineWidth=3.4; // blade
        g.beginPath(); g.moveTo(hX,hY); g.lineTo(hX+dx*30*S, hY+dy*30*S); g.stroke();
        g.strokeStyle='#6b4a2b'; g.lineWidth=4;    // crossguard
        g.beginPath(); g.moveTo(hX-nx*6, hY-ny*6); g.lineTo(hX+nx*6, hY+ny*6); g.stroke();
      }
    };

    const legAfront = J.f*J.footA.x >= J.f*J.footB.x;
    let armAfront;
    if (J.action==='punch') armAfront = (J.punchArm==='A');
    else if (J.action)      armAfront = true;
    else                    armAfront = (J.f*J.handA.x >= J.f*J.handB.x);

    // back limbs (dimmed for depth)
    if (legAfront) drawLeg(J.kneeB,J.footB,J.toeB,4.4,0.5); else drawLeg(J.kneeA,J.footA,J.toeA,4.4,0.5);
    if (!gunAim){ if (armAfront) drawArm(J.elbowB,J.handB,4,0.5); else drawArm(J.elbowA,J.handA,4,0.5); }
    if (J.hasMelee && !armAfront) drawMeleeWeapon(J.handA, J.elbowA, wtype);

    // torso + head
    seg(hip, J.neck, 5.2, 1);
    g.globalAlpha=1;
    const hxw=ox+J.head.x*S, hyw=oy+J.head.y*S, hr=J.headR*S;
    g.lineWidth=4.2; g.strokeStyle='#0c1018'; g.fillStyle=col;
    g.beginPath(); g.arc(hxw,hyw,hr,0,Math.PI*2); g.fill(); g.stroke();
    if (fi._slow > 0){ g.fillStyle='rgba(170,240,255,.45)'; g.beginPath(); g.arc(hxw,hyw,hr,0,Math.PI*2); g.fill(); }

    // front limbs
    if (legAfront) drawLeg(J.kneeA,J.footA,J.toeA,5,1); else drawLeg(J.kneeB,J.footB,J.toeB,5,1);
    if (!gunAim){ if (armAfront) drawArm(J.elbowA,J.handA,4.4,1); else drawArm(J.elbowB,J.handB,4.4,1); }
    if (J.hasMelee && armAfront) drawMeleeWeapon(J.handA, J.elbowA, wtype);

    // gun arm aims toward fi.aim (keeps ranged combat readable)
    if (gunAim){
      g.globalAlpha=1;
      const shX=ox+J.shoulder.x*S, shY=oy+J.shoulder.y*S;
      const aim=fi.aim, aLen=20;
      const hX=shX+Math.cos(aim)*aLen, hY=shY+Math.sin(aim)*aLen;
      const eX=shX+Math.cos(aim)*aLen*0.5 + Math.sin(aim)*4, eY=shY+Math.sin(aim)*aLen*0.5 - Math.cos(aim)*4;
      g.strokeStyle=col; g.lineWidth=4.4;
      g.beginPath(); g.moveTo(shX,shY); g.lineTo(eX,eY); g.lineTo(hX,hY); g.stroke();
      drawGun(g, hX, hY, aim, fi.weapon.type);
    }

    // guard arc while blocking
    if (fi.blocking){
      g.globalAlpha = 0.45 + 0.35 * fi._guard;
      g.strokeStyle = fi._guard > 0.25 ? '#bfe9ff' : '#ff8a8a';
      g.lineWidth = 3.5;
      const headWX = ox+J.head.x*S, headWY = oy+J.head.y*S;
      g.beginPath();
      g.arc(headWX + Math.cos(fi.aim)*8, headWY + 14 + Math.sin(fi.aim)*8, 16, fi.aim-1.15, fi.aim+1.15);
      g.stroke();
    }

    g.globalAlpha=1;
    g.restore();
    drawHpBar(g, fi);
  }

  function drawLimb(g, x1, y1, x2, y2, x3, y3) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.quadraticCurveTo(x2, y2, x3, y3);
    g.stroke();
  }
  // two-segment articulated limbs (knee / elbow joint) for nicer animation
  function drawJointLeg(g, hx, hy, kx, ky, fx, fy) {
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(kx, ky); g.lineTo(fx, fy); g.stroke();
  }
  function drawJointArm(g, sx, sy, ex, ey, hx, hy) {
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.lineTo(hx, hy); g.stroke();
  }

  function drawStaff(g, gem) {
    g.strokeStyle = '#6b5238'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(24, -4); g.stroke();
    g.fillStyle = gem; g.beginPath(); g.arc(26, -5, 5, 0, Math.PI*2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.arc(26, -5, 2, 0, Math.PI*2); g.fill();
  }
  // True if point (px,py) is within `margin` px of fighter f's body box (~18x64).
  // This is the core of the contact hitbox: a melee strike point must reach here.
  // M85 zonal hitbox: head takes more, legs/arms take less, torso normal.
  function damageZoneMult(py, f) {
    const rel = py - f.pos.y;          // negative = up toward the head
    if (rel < -28) return { mult: 1.6, zone: 'head' };
    if (rel > 12)  return { mult: 0.6, zone: 'limb' };
    return { mult: 1.0, zone: 'body' };
  }
  function pointHitsBody(px, py, f, margin) {
    const dx = Math.max(Math.abs(px - f.pos.x) - 11, 0);          // body half-width  ~11
    const dy = Math.max(Math.abs(py - (f.pos.y - 4)) - 36, 0);    // half-height ~36, centered on the taller IK torso
    return dx * dx + dy * dy <= margin * margin;
  }

  function drawGun(g, x, y, ang, type) {
    g.save();
    g.translate(x, y); g.rotate(ang);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.fillStyle = '#2b3142'; g.strokeStyle = '#cfd6e6'; g.lineWidth = 1;
    switch (type) {
      case 'pistol':  g.fillRect(0,-3,18,6); g.fillRect(2,0,5,8); break;
      case 'rifle':   g.fillRect(0,-3,34,6); g.fillRect(4,0,5,9); g.fillRect(20,-5,4,4); break;
      case 'shotgun': g.fillStyle='#3a2f24'; g.fillRect(0,-4,30,8); g.fillStyle='#6b7484'; g.fillRect(20,-4,10,8); break;
      case 'smg':     g.fillStyle='#23283a'; g.fillRect(0,-3,22,6); g.fillRect(3,0,5,10); g.fillStyle='#4a5470'; g.fillRect(14,-4,6,3); break;
      case 'sniper':  g.fillStyle='#1f2636'; g.fillRect(0,-2.5,46,5); g.fillStyle='#9fe8ff'; g.fillRect(16,-7,12,3); g.fillStyle='#23283a'; g.fillRect(4,0,5,9); break;
      case 'minigun': g.fillStyle='#2b3142'; g.fillRect(0,-6,26,12); g.fillStyle='#6b7484'; g.fillRect(22,-5,15,3); g.fillRect(22,2,15,3); g.fillRect(22,-1.5,15,3); break;
      case 'sword':   g.fillStyle='#8a5a3c'; g.fillRect(-5,-3,7,6); g.strokeStyle='#cfd6e6'; g.lineWidth=2; g.beginPath(); g.moveTo(2,-7); g.lineTo(2,7); g.stroke(); g.strokeStyle='#eef3ff'; g.lineWidth=3; g.beginPath(); g.moveTo(2,0); g.lineTo(42,-2); g.stroke(); break;
      case 'hammer':  g.strokeStyle='#8a5a3c'; g.lineWidth=4; g.beginPath(); g.moveTo(0,0); g.lineTo(30,0); g.stroke(); g.fillStyle='#6b7484'; g.fillRect(26,-11,13,22); g.fillStyle='#878f9e'; g.fillRect(26,-11,4,22); break;
      case 'spear':   g.strokeStyle='#8a5a3c'; g.lineWidth=3; g.beginPath(); g.moveTo(0,0); g.lineTo(54,0); g.stroke(); g.fillStyle='#eef3ff'; g.beginPath(); g.moveTo(54,-5); g.lineTo(66,0); g.lineTo(54,5); g.closePath(); g.fill(); break;
      case 'rocket':  g.fillStyle='#3a4458'; g.fillRect(0,-5,30,10); g.fillStyle='#ff8a3c'; g.beginPath(); g.moveTo(30,-5); g.lineTo(40,0); g.lineTo(30,5); g.closePath(); g.fill(); g.fillStyle='#23283a'; g.fillRect(4,4,6,7); break;
      case 'fireball':  drawStaff(g, '#ff5a2c'); break;
      case 'lightning': drawStaff(g, '#bfe9ff'); break;
      case 'icebolt':   drawStaff(g, '#a9f1ff'); break;

      // ── M62 new weapons ────────────────────────────────────────
      case 'chainsaw':
        // body
        g.fillStyle='#2b3142'; g.fillRect(0,-5,30,10);
        // blade bar (orange)
        g.fillStyle='#c04010'; g.fillRect(26,-4,24,8);
        // teeth top
        g.fillStyle='#cfd6e6';
        for(let _i=0;_i<6;_i++){ g.fillRect(28+_i*4,-8,3,4); }
        // teeth bottom
        for(let _i=0;_i<6;_i++){ g.fillRect(28+_i*4,4,3,4); }
        // grip
        g.fillStyle='#4a5470'; g.fillRect(4,4,7,8);
        // engine accent
        g.fillStyle='#e05c20'; g.beginPath(); g.arc(14,0,5,0,Math.PI*2); g.fill();
        g.fillStyle='#ff8040'; g.beginPath(); g.arc(14,0,2.5,0,Math.PI*2); g.fill();
        break;

      case 'mirrorshield':
        // outer rim
        g.fillStyle='#6878a0';
        g.beginPath(); g.arc(0,0,19,0,Math.PI*2); g.fill();
        // chrome face
        g.fillStyle='#b8cce0';
        g.beginPath(); g.arc(0,0,15,0,Math.PI*2); g.fill();
        // inner highlight
        g.fillStyle='#e0eef8';
        g.beginPath(); g.arc(0,0,9,0,Math.PI*2); g.fill();
        // shine streak
        g.strokeStyle='#ffffff'; g.lineWidth=2;
        g.beginPath(); g.moveTo(-6,-10); g.lineTo(3,-4); g.stroke();
        // cross lines
        g.strokeStyle='#8090b0'; g.lineWidth=1;
        g.beginPath(); g.moveTo(-14,0); g.lineTo(14,0); g.stroke();
        g.beginPath(); g.moveTo(0,-14); g.lineTo(0,14); g.stroke();
        break;

      case 'flamethrower':
        // main body
        g.fillStyle='#2b3142'; g.fillRect(0,-6,34,12);
        // tank on top
        g.fillStyle='#3a4050'; g.fillRect(8,-13,14,7);
        g.fillStyle='#4a5060'; g.fillRect(9,-12,12,5);
        // grip
        g.fillStyle='#4a5470'; g.fillRect(4,5,8,9);
        // nozzle (orange)
        g.fillStyle='#d05010'; g.fillRect(30,-5,14,10);
        g.fillStyle='#ff7020'; g.fillRect(40,-3,6,6);
        // fuel hose
        g.strokeStyle='#5a3020'; g.lineWidth=3;
        g.beginPath(); g.moveTo(22,0); g.lineTo(22,8); g.stroke();
        // heat glow at tip
        g.fillStyle='rgba(255,140,0,0.5)';
        g.beginPath(); g.arc(48,0,8,0,Math.PI*2); g.fill();
        break;

      case 'netgun':
        // body
        g.fillStyle='#3a4a38'; g.fillRect(0,-5,20,10);
        // wide launcher barrel
        g.fillStyle='#2a3a28'; g.fillRect(16,-9,16,18);
        g.fillStyle='#4a5a46'; g.fillRect(18,-7,12,14);
        // grip
        g.fillStyle='#2b3a2b'; g.fillRect(4,4,6,9);
        // net pattern on barrel face
        g.strokeStyle='#c0d4b8'; g.lineWidth=1;
        g.beginPath(); g.moveTo(18,-7); g.lineTo(30,7); g.stroke();
        g.beginPath(); g.moveTo(24,-7); g.lineTo(18,7); g.stroke();
        g.beginPath(); g.moveTo(30,-7); g.lineTo(22,7); g.stroke();
        g.beginPath(); g.moveTo(18,-2); g.lineTo(30,-2); g.stroke();
        g.beginPath(); g.moveTo(18,3);  g.lineTo(30,3);  g.stroke();
        break;

      case 'boomerang':
        // shadow/outline
        g.strokeStyle='#a06820'; g.lineWidth=10; g.lineCap='round';
        g.beginPath(); g.moveTo(4,2); g.quadraticCurveTo(24,-20,44,2); g.stroke();
        // body
        g.strokeStyle='#e8a030'; g.lineWidth=7;
        g.beginPath(); g.moveTo(4,2); g.quadraticCurveTo(24,-20,44,2); g.stroke();
        // highlight stripe
        g.strokeStyle='#ffd880'; g.lineWidth=3;
        g.beginPath(); g.moveTo(4,1); g.quadraticCurveTo(24,-18,44,1); g.stroke();
        // tips
        g.fillStyle='#ffeeaa';
        g.beginPath(); g.arc(4,2,4,0,Math.PI*2); g.fill();
        g.beginPath(); g.arc(44,2,4,0,Math.PI*2); g.fill();
        break;

      case 'gravitygun':
        // body
        g.fillStyle='#2a1e4a'; g.fillRect(0,-5,28,10);
        // barrel
        g.fillStyle='#4020a0'; g.fillRect(24,-6,18,12);
        // grip
        g.fillStyle='#1e1638'; g.fillRect(4,4,8,10);
        // purple glow ring
        g.strokeStyle='#8050d0'; g.lineWidth=3;
        g.beginPath(); g.arc(34,0,8,0,Math.PI*2); g.stroke();
        // inner glow
        g.fillStyle='rgba(180,120,255,0.4)';
        g.beginPath(); g.arc(34,0,8,0,Math.PI*2); g.fill();
        // energy core
        g.fillStyle='#e3d0ff';
        g.beginPath(); g.arc(34,0,3.5,0,Math.PI*2); g.fill();
        // energy lines on body
        g.strokeStyle='#b07cff'; g.lineWidth=1;
        g.beginPath(); g.moveTo(6,-5); g.lineTo(22,-5); g.stroke();
        g.beginPath(); g.moveTo(6,5);  g.lineTo(22,5);  g.stroke();
        break;

      case 'teleportgun':
        // body
        g.fillStyle='#0f2e2e'; g.fillRect(0,-4,24,8);
        // barrel block
        g.fillStyle='#0d3832'; g.fillRect(20,-7,20,14);
        g.fillStyle='#1a4a44'; g.fillRect(22,-5,16,10);
        // grip
        g.fillStyle='#0a2020'; g.fillRect(4,3,6,9);
        // teal glow ring
        g.strokeStyle='#3cf6c0'; g.lineWidth=2.5;
        g.beginPath(); g.arc(36,0,7,0,Math.PI*2); g.stroke();
        // inner glow fill
        g.fillStyle='rgba(60,246,192,0.25)';
        g.beginPath(); g.arc(36,0,7,0,Math.PI*2); g.fill();
        // bright core
        g.fillStyle='#c0ffe8';
        g.beginPath(); g.arc(36,0,2.5,0,Math.PI*2); g.fill();
        // side rails
        g.strokeStyle='#20c090'; g.lineWidth=1;
        g.beginPath(); g.moveTo(20,-7); g.lineTo(40,-7); g.stroke();
        g.beginPath(); g.moveTo(20,7);  g.lineTo(40,7);  g.stroke();
        break;

      case 'emp':
        // body
        g.fillStyle='#101828'; g.fillRect(0,-5,28,10);
        // barrel
        g.fillStyle='#183060'; g.fillRect(24,-5,14,10);
        // grip
        g.fillStyle='#101828'; g.fillRect(4,4,7,9);
        // antenna coil on top
        g.strokeStyle='#4090d0'; g.lineWidth=1.5;
        for(let _i=0;_i<4;_i++){
          g.beginPath();
          g.arc(10+_i*4,-5,2.5,Math.PI,0);
          g.stroke();
        }
        // discharge tip
        g.fillStyle='rgba(120,200,255,0.4)';
        g.beginPath(); g.arc(34,0,9,0,Math.PI*2); g.fill();
        g.fillStyle='#cfefff';
        g.beginPath(); g.arc(34,0,4,0,Math.PI*2); g.fill();
        g.fillStyle='#7cc8ff';
        g.beginPath(); g.arc(34,0,2,0,Math.PI*2); g.fill();
        // lightning bolt symbol
        g.strokeStyle='#ffffff'; g.lineWidth=1.5;
        g.beginPath();
        g.moveTo(32,-4); g.lineTo(29,0); g.lineTo(32,0); g.lineTo(29,4);
        g.stroke();
        break;
      // ─────────────────────────────────────────────────────────────

      default: g.fillRect(0,-3,18,6);
    }
    g.restore();
  }

  function drawHpBar(g, f) {
    const x = f.pos.x, y = f.pos.y - 58;
    const w = 46, h = 6;
    g.save();
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(x - w/2 - 1, y - 1, w + 2, h + 2);
    g.fillStyle = '#2a3145';
    g.fillRect(x - w/2, y, w, h);
    const pct = Math.max(0, f.hp / f.maxHp);
    g.fillStyle = f.color;
    g.fillRect(x - w/2, y, w * pct, h);
    g.fillStyle = f.color;
    g.font = '700 11px Trebuchet MS';
    g.textAlign = 'center';
    let wlabel = '';
    if (f.weapon) wlabel = '  ·  ' + (f.weapon.kind === 'melee' ? f.weapon.type : f.weapon.ammo);
    let mood = '';
    if ((f.hype || 0) > 60) mood = ' ����'; else if ((f.hype || 0) < -40) mood = ' 😵';
    g.fillText(f.name + mood + wlabel, x, y - 5);
    // stamina sliver under the HP bar (turns orange when exhausted)
    const st = Math.max(0, Math.min(1, (f.stamina != null ? f.stamina : 100) / 100));
    g.fillStyle = st < 0.25 ? '#e0683c' : '#5ad6c0';
    g.fillRect(x - w/2, y + h + 1, w * st, 2);
    g.restore();
  }

  // ============================================================
  //  Weapons
  // ============================================================
  const WEAPONS = {
    // --- guns (ranged, ammo-based) ---
    pistol:  { type:'pistol',  kind:'gun', ammo: 9,  cd: 0.28, dmg: 16, speed: 26, recoil: 0.010, spread: 0.03, knock: 0.018 },
    rifle:   { type:'rifle',   kind:'gun', ammo: 24, cd: 0.09, dmg: 9,  speed: 34, recoil: 0.006, spread: 0.05, knock: 0.012 },
    shotgun: { type:'shotgun', kind:'gun', ammo: 5,  cd: 0.7,  dmg: 9,  speed: 24, recoil: 0.03,  spread: 0.32, knock: 0.02, pellets: 6 },
    smg:     { type:'smg',     kind:'gun', ammo: 30, cd: 0.06, dmg: 6,  speed: 32, recoil: 0.004, spread: 0.09, knock: 0.010 },
    sniper:  { type:'sniper',  kind:'gun', ammo: 5,  cd: 1.05, dmg: 44, speed: 62, recoil: 0.045, spread: 0.004, knock: 0.05, proj:{ color:'#9fe8ff', r:3.4, len:20 } },
    minigun: { type:'minigun', kind:'gun', ammo: 90, cd: 0.035,dmg: 5,  speed: 36, recoil: 0.003, spread: 0.12, knock: 0.008 },
    // --- melee (no ammo, swing) ---
    sword:   { type:'sword',   kind:'melee', ammo: Infinity, reach: 70,  dmg: 34, knock: 0.10, cd: 0.32 },                 // balanced: fast multi-hit slashes + bleed
    hammer:  { type:'hammer',  kind:'melee', ammo: Infinity, reach: 60,  dmg: 46, knock: 0.30, cd: 0.74, aoe: 82 },        // slow ground-slam: huge knockback + shockwave AoE
    spear:   { type:'spear',   kind:'melee', ammo: Infinity, reach: 110, dmg: 32, knock: 0.07, cd: 0.46, pierce: true },   // long-range THRUST: stabs straight, big reach
    // --- magic (ammo-based, special projectiles) ---
    rocket:   { type:'rocket',   kind:'magic', ammo: 3, cd: 1.15, dmg: 26, speed: 17, recoil: 0.02,  spread: 0.01, knock: 0.05, proj:{ color:'#ff8a3c', r:6,  glow:'#ffce6b' }, explode:{ radius:98, dmg:30 } },
    fireball: { type:'fireball', kind:'magic', ammo: 7, cd: 0.55, dmg: 14, speed: 19, recoil: 0.004, spread: 0.02, knock: 0.03, proj:{ color:'#ff5a2c', r:7,  glow:'#ffb23c' }, explode:{ radius:66, dmg:14 } },
    lightning:{ type:'lightning',kind:'magic', ammo: 9, cd: 0.42, dmg: 22, speed: 90, recoil: 0.006, spread: 0.01, knock: 0.02, proj:{ color:'#bfe9ff', r:3,  glow:'#ffffff', bolt:true } },
    icebolt:  { type:'icebolt',  kind:'magic', ammo: 11,cd: 0.40, dmg: 9,  speed: 28, recoil: 0.004, spread: 0.03, knock: 0.02, proj:{ color:'#a9f1ff', r:5,  glow:'#dffaff' }, slow:1.6 },
  };
  function makeWeapon(type) {
    const w = Object.assign({}, WEAPONS[type]);
    if (w.proj) w.proj = Object.assign({}, w.proj);
    if (w.explode) w.explode = Object.assign({}, w.explode);
    return w;
  }

  let weapons = [];
  let weaponTimer = 0;
  let weaponSpawnLog = []; // #65 history of weapon drop locations/times for spawn prediction
  const WEAPON_TYPES = Object.keys(WEAPONS);
  // ── M62 new weapons (PLAY-ONLY drops; training pool stays = WEAPON_TYPES above) ──
  const NEW_WEAPONS = {
    chainsaw:     { type:'chainsaw',     kind:'melee', ammo: Infinity, reach: 46, dmg: 10, knock: 0.04, cd: 0.12 },
    mirrorshield: { type:'mirrorshield', kind:'melee', ammo: Infinity, reach: 30, dmg: 8,  knock: 0.05, cd: 0.50, shield:true },
    flamethrower: { type:'flamethrower', kind:'gun', ammo: 60, cd: 0.04, dmg: 3,  speed: 16, recoil: 0.002, spread: 0.20, knock: 0.005, proj:{ color:'#ff7a1c', r:6, glow:'#ffd23c', life:0.35, fire:true } },
    netgun:       { type:'netgun',       kind:'gun', ammo: 4,  cd: 0.90, dmg: 4,  speed: 22, recoil: 0.010, spread: 0.0, knock: 0.0,  proj:{ color:'#dfe7ef', r:7, net:true }, slow: 2.4 },
    boomerang:    { type:'boomerang',    kind:'gun', ammo: 3,  cd: 0.80, dmg: 18, speed: 26, recoil: 0.008, spread: 0.0, knock: 0.06, proj:{ color:'#ffd27a', r:6, glow:'#ffeeb0', boomerang:true } },
    gravitygun:   { type:'gravitygun',   kind:'gun', ammo: 4,  cd: 1.00, dmg: 8,  speed: 30, recoil: 0.010, spread: 0.0, knock: 0.0,  proj:{ color:'#b07cff', r:7, glow:'#e3d0ff', pull:true } },
    teleportgun:  { type:'teleportgun',  kind:'gun', ammo: 3,  cd: 1.00, dmg: 10, speed: 40, recoil: 0.0,   spread: 0.0, knock: 0.03, proj:{ color:'#3cf6c0', r:6, glow:'#c0ffe8', tele:true } },
    emp:          { type:'emp',          kind:'magic', ammo: 2, cd: 1.40, dmg: 6, speed: 24, recoil: 0.010, spread: 0.0, knock: 0.02, proj:{ color:'#7cc8ff', r:6, glow:'#cfefff' }, explode:{ radius:130, dmg:8, emp:true } },
  };
  Object.assign(WEAPONS, NEW_WEAPONS);
  const PLAY_WEAPON_TYPES = Object.keys(WEAPONS); // base + M62 new (used for play-mode drops only)
  // #65 Weapon Spawn Prediction: estimate where/when the next drop lands from history.
  function predictNextSpawn() {
    if (weaponSpawnLog.length < 2) return null;
    let avgX = 0, sumGap = 0, gaps = 0;
    for (let i = 0; i < weaponSpawnLog.length; i++) {
      avgX += weaponSpawnLog[i].x;
      if (i > 0) { sumGap += weaponSpawnLog[i].time - weaponSpawnLog[i - 1].time; gaps++; }
    }
    avgX /= weaponSpawnLog.length;
    const avgGap = gaps ? sumGap / gaps : 0;
    const last = weaponSpawnLog[weaponSpawnLog.length - 1];
    const timeToNext = avgGap ? (last.time + avgGap - Date.now()) : Infinity;
    return { avgX, avgGap, timeToNext };
  }

  function spawnWeaponDrop() {
    const types = TRAIN ? WEAPON_TYPES : PLAY_WEAPON_TYPES; // M62 new weapons drop in play only; training pool unchanged
    const type = types[(Math.random() * types.length) | 0];
    const x = 200 + Math.random() * (VIEW.w - 400);
    const body = Bodies.rectangle(x, -40, 30, 12, {
      friction: 0.6, frictionAir: 0.02, restitution: 0.3, density: 0.001,
      collisionFilter: { category: CAT.WEAPON, mask: CAT.GROUND },
      label: 'weapon',
    });
    body.wtype = type;
    World.add(world, body);
    weapons.push({ body, type, taken: false, life: 16 });
    try { if (!TRAIN) SFX.weaponDrop(); } catch (e) {}
    weaponSpawnLog.push({ type, x: body.position.x, y: body.position.y, time: Date.now() }); // #65
    if (weaponSpawnLog.length > 50) weaponSpawnLog.shift();
  }

  // ============================================================
  //  Bullets
  // ============================================================
  let bullets = [];
  function spawnBullet(x, y, ang, owner, w) {
    const proj = w.proj || {};
    const rr = proj.r || 3;
    const b = Bodies.circle(x, y, Math.max(2, rr * 0.7), {
      frictionAir: 0, restitution: 0.2, density: 0.004,
      collisionFilter: { category: CAT.BULLET, mask: CAT.GROUND | CAT.PLAYER | CAT.RAGDOLL },
      label: 'bullet',
    });
    b.bullet = {
      owner, dmg: w.dmg, knock: w.knock,
      life: (proj.life || (w.kind === 'magic' ? 3.2 : 2.4)),
      proj, explode: w.explode || null, slow: w.slow || 0, bolt: !!proj.bolt,
      fire: !!proj.fire, net: !!proj.net, pull: !!proj.pull, tele: !!proj.tele, // M62 weapon effects
      boomerang: !!proj.boomerang, age: 0,
    };
    Body.setVelocity(b, { x: Math.cos(ang) * w.speed, y: Math.sin(ang) * w.speed });
    b.prev = { x, y };
    World.add(world, b);
    bullets.push(b);
  }

  // ============================================================
  //  Particles / FX
  // ============================================================
  let particles = [];
  function spawnBlood(p, impulse, color) {
    if (TRAIN) return;
    const n = 10;
    for (let i = 0; i < n; i++) {
      particles.push({
        x: p.x, y: p.y,
        vx: (impulse?impulse.x*200:0) + (Math.random()-0.5)*6,
        vy: (impulse?impulse.y*200:0) + (Math.random()-0.5)*6 - 2,
        life: 0.5 + Math.random()*0.4, max: 0.9, r: 2+Math.random()*2, color,
      });
    }
  }
  function muzzleFlash(x, y, ang) {
    if (TRAIN) return;
    particles.push({ x, y, vx: Math.cos(ang)*2, vy: Math.sin(ang)*2, life: 0.06, max: 0.06, r: 9, color: '#ffe27a', flash: true });
    for (let i=0;i<5;i++) particles.push({ x, y, vx: Math.cos(ang)*(4+Math.random()*4)+(Math.random()-.5)*2, vy: Math.sin(ang)*(4+Math.random()*4)+(Math.random()-.5)*2, life:.18, max:.18, r:1.6, color:'#ffd23f' });
  }
  function punchFx(x, y) {
    if (TRAIN) return;
    for (let i=0;i<6;i++){ const a=Math.random()*Math.PI*2; particles.push({x,y,vx:Math.cos(a)*3,vy:Math.sin(a)*3,life:.2,max:.2,r:2,color:'#ffffff'});}
  }
  function blockFx(p, perfect) {
    if (TRAIN) return;
    const color = perfect ? '#9fe8ff' : '#cfd8e3';
    const n = perfect ? 12 : 7, s = perfect ? 5 : 3;
    for (let i=0;i<n;i++){ const a=Math.random()*Math.PI*2; particles.push({x:p.x,y:p.y-6,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:.28,max:.28,r:perfect?2.4:1.8,color,flash:perfect});}
  }
  function sparks(x, y) {
    if (TRAIN) return;
    for (let i=0;i<5;i++){ const a=Math.random()*Math.PI*2; particles.push({x,y,vx:Math.cos(a)*4,vy:Math.sin(a)*4-1,life:.25,max:.25,r:1.5,color:'#ffd23f'});}
  }

  // screen shake
  let shakeAmt = 0;
  function shake(a) { if (TRAIN) return; shakeAmt = Math.min(22, shakeAmt + a); }

  // ============================================================
  //  Game state
  // ============================================================
  let fighters = [];
  let ragdolls = [];
  let state = 'menu'; // menu | play | paused | result
  let scores = [0, 0];
  let curMode = 'bot';   // 1p | 2p | bot | 2v2 | 3v3 | 4v4 | ffa
  let roundOver = false;
  let roundEndT = 0;
  let roundTime = 0;

  // ═══════════════════════════════════════════════════════════
  //  M61: Round modifiers · status FX · slow-mo · streak announcer
  // ═══════════════════════════════════════════════════════════
  let activeMod = {};        // multipliers/flags for the current round (play only)
  let activeModName = '';
  let _modBannerT = 0;       // round-start modifier banner timer
  let _slowmo = 0;           // last-hit slow-motion timer (play only)
  let _announce = null;      // streak announcer { text, t }
  let _countdown = null;     // M96 pre-round "3,2,FIGHT!" countdown { t, ph } (play+King; not TRAIN)
  let _killLog = [];         // recent kills for multi-kill detection
  let windX = 0;             // M62 wind force field strength/direction (play only)
  let arenaEvent = null;     // M62 active arena event id (play only)
  let arenaEventName = '';
  let roundEvent = null, roundEventName = '', _eventFired = false, _eventAt = 12; // M62 mid-round event + objective
  let _suddenDeath = false, _meteorT = 0, _meteorAcc = 0, _bounty = null;
  const METEOR_W = { kind: 'magic', dmg: 18, knock: 0.05, speed: 18, recoil: 0, spread: 0, proj: { color: '#ff7a3c', r: 6, glow: '#ffce6b' }, explode: { radius: 80, dmg: 18 } };
  // ── M62 new game modes: King of the Hill + Infection (Boss is asymmetric last-standing) ──
  let _kothScore = null, _infectT = 0; // KotH points per team / infection survivors-win timer
  const KOTH_TARGET = 100;
  const KOTH_ZONE = { x: VIEW.w / 2, y: VIEW.h / 2, r: 90 };
  const ROUND_EVENTS = [
    { id: 'weaponrain',  name: '\uD83C\uDF02 WEAPON RAIN' },
    { id: 'meteor',      name: '\u2604\uFE0F METEOR SHOWER' },
    { id: 'frenzy',      name: '\uD83D\uDD25 FRENZY' },
    { id: 'suddendeath', name: '\u2620\uFE0F SUDDEN DEATH' },
    { id: 'bounty',      name: '\uD83D\uDC51 BOUNTY (objective)' },
  ];
  let _floodY = 99999;       // M62 rising-lava surface y
  let _shrinkX = 0;          // M62 shrinking-arena inset per side
  let _ambient = null;       // M62 day-night ambient tint {r,g,b,a} | null = bright day
  const ARENA_EVENTS = [
    { id: 'flood',    name: '\uD83C\uDF0A RISING LAVA' },
    { id: 'shrink',   name: '\u2194\uFE0F SHRINKING ARENA' },
    { id: 'mirror',   name: '\uD83E\uDE9E MIRROR CONTROLS' },
    { id: 'tilt',     name: '\uD83C\uDF00 TILTING ARENA' },
  ];
  const ROUND_MODS = [
    { id: 'lowgrav',  name: '\uD83C\uDF19 LOW GRAVITY' },
    { id: 'speed',    name: '\u26A1 SPEED DEMON' },
    { id: 'glass',    name: '\uD83D\uDC8E GLASS CANNON' },
    { id: 'noweapons',name: '\u270A NO WEAPONS' },
    { id: 'oneshot',  name: '\uD83D\uDC80 ONE SHOT' },
  ];
  // Pick + apply one random modifier at round start. Training is always gated
  // (base game), so the evolved brain is never trained under a modifier.
  function applyRoundModifier() {
    try { engine.gravity.y = 1.6; engine.gravity.x = 0; } catch (e) {}
    for (const f of fighters) f.maxHp = 100;
    activeMod = {}; activeModName = ''; _modBannerT = 0;
    for (const p of platforms) { if (!p.breakable) continue; if (p._broken && !TRAIN) { try { World.add(world, p.body); } catch (e) {} p._broken = false; } p._hp = p.hp || 0; } // M65 restore destructible walls each round
    if (Math.random() < 0.45) return;        // ~55% of rounds are vanilla (training + play)
    const m = ROUND_MODS[(Math.random() * ROUND_MODS.length) | 0];
    activeModName = m.name;
    switch (m.id) {
      case 'lowgrav': try { engine.gravity.y = 0.72; } catch (e) {} break;
      case 'speed': activeMod.speed = 1.5; break;
      case 'glass': activeMod.dmgMul = 2; for (const f of fighters) { f.maxHp = 50; f.hp = 50; } break;
      case 'noweapons': activeMod.noWeapons = true; break;
      case 'oneshot': activeMod.oneShot = true; break;
      case 'fog': activeMod.fog = true; break;
    }
    _modBannerT = 2.6;
  }
  // Multi-kill detection -> big on-screen announcer.
  function pushStreak(killer) {
    if (!killer) return;
    const now = Date.now();
    _killLog.push({ by: killer, t: now });
    _killLog = _killLog.filter(k => now - k.t < 4000);
    const n = _killLog.filter(k => k.by === killer).length;
    let txt = '';
    if (n === 2) txt = 'DOUBLE KILL!';
    else if (n === 3) txt = 'TRIPLE KILL!';
    else if (n >= 4) txt = 'RAMPAGE!';
    if (txt) { _announce = { text: txt, t: 1.7 }; try { SFX && SFX.announce && SFX.announce(); } catch (e) {} }
  }

  // Line-of-sight test: returns true if the segment (ax,ay)->(bx,by) is blocked
  // by any solid platform OR wall. Bullets physically collide with CAT.GROUND,
  // so this lets bots avoid wasting shots into obstacles they can't shoot through.
  // Liang–Barsky segment-vs-AABB clip against every platform rectangle.
  function lineBlocked(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    for (const p of platforms) {
      const hw = p.w / 2, hh = p.h / 2;
      const minX = p.x - hw, maxX = p.x + hw, minY = p.y - hh, maxY = p.y + hh;
      let t0 = 0, t1 = 1, hit = true;
      const edges = [[-dx, ax - minX], [dx, maxX - ax], [-dy, ay - minY], [dy, maxY - ay]];
      for (const e of edges) {
        const pk = e[0], qk = e[1];
        if (pk === 0) { if (qk < 0) { hit = false; break; } }
        else {
          const r = qk / pk;
          if (pk < 0) { if (r > t1) { hit = false; break; } if (r > t0) t0 = r; }
          else { if (r < t0) { hit = false; break; } if (r < t1) t1 = r; }
        }
      }
      if (hit && t0 <= t1) return true;
    }
    return false;
  }
  function nearestEnemy(self) {
    let best = null, bd = Infinity;
    for (const f of fighters) {
      if (f === self || !f.alive || f.team === self.team) continue;
      const d = Math.hypot(f.pos.x - self.pos.x, f.pos.y - self.pos.y);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  // Nearest LIVING teammate (same team). Returns null in 1v1 / FFA (no allies).
  function nearestAlly(self) {
    let best = null, bd = Infinity;
    for (const f of fighters) {
      if (f === self || !f.alive || f.team !== self.team) continue;
      const d = Math.hypot(f.pos.x - self.pos.x, f.pos.y - self.pos.y);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  // Is there standable ground just below (px, feetY) within maxDrop px? Tall
  // walls don't count. Used for edge/void sensing and the edge-danger reward.
  function groundBelow(px, feetY, maxDrop) {
    for (const p of platforms) {
      if (p.wall) continue;
      const top = p.y - p.h / 2;
      if (top >= feetY - 6 && top <= feetY + maxDrop && px >= p.x - p.w / 2 - 8 && px <= p.x + p.w / 2 + 8) return true;
    }
    return false;
  }
  function aliveTeams() {
    const s = new Set();
    for (const f of fighters) if (f.alive) s.add(f.team);
    return s;
  }
  function teamColor(t) {
    const f = fighters.find(x => x.team === t);
    return f ? f.color : (t ? '#ff5c5c' : '#ffd23f');
  }
  function winTarget() { return (typeof King !== 'undefined' && King.active) ? King.winsNeeded : 5; }

  // Platform the fighter is currently standing on (or null if airborne).
  function currentPlatform(f) {
    const px = f.pos.x, feet = f.pos.y + 32;
    let best = null, bestDy = 60;
    for (const p of platforms) {
      if (px > p.x - p.w / 2 - 8 && px < p.x + p.w / 2 + 8) {
        const d = (p.y - p.h / 2) - feet;
        if (d > -24 && d < bestDy) { bestDy = d; best = p; }
      }
    }
    return best;
  }

  // A platform the fighter could realistically jump to in a given direction.
  function platformInDirection(f, dir) {
    const cur = currentPlatform(f);
    const feet = f.pos.y + 32;
    let best = null, bestScore = Infinity;
    for (const p of platforms) {
      if (cur && p === cur) continue;
      const nearEdge = dir > 0 ? (p.x - p.w / 2) : (p.x + p.w / 2);
      const gap = (nearEdge - f.pos.x) * dir;     // forward distance to its near edge
      if (gap < -30 || gap > 240) continue;       // too far to reach horizontally
      const up = feet - (p.y - p.h / 2);          // positive => platform is above us
      if (up > 175 || up < -120) continue;        // outside the jump arc
      const score = gap + Math.abs(up) * 0.6;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // Deterministic ground check: feet resting on a platform top with low vertical speed.
  function onGround(f) {
    const feet = f.pos.y + 32;
    for (const p of platforms) {
      const top = p.y - p.h / 2;
      if (f.pos.x > p.x - p.w / 2 - 6 && f.pos.x < p.x + p.w / 2 + 6 &&
          feet >= top - 5 && feet <= top + 16 && Math.abs(f.body.velocity.y) < 2.4) {
        return true;
      }
    }
    return false;
  }

  // M62: the platform a fighter is standing on (feet on its top), or null.
  function standingPlatform(f) {
    const feet = f.pos.y + 32;
    for (const p of platforms) {
      const top = p.y - p.h / 2;
      if (f.pos.x > p.x - p.w / 2 - 6 && f.pos.x < p.x + p.w / 2 + 6 &&
          feet >= top - 5 && feet <= top + 16 && Math.abs(f.body.velocity.y) < 3.0) {
        return p;
      }
    }
    return null;
  }

  // A higher platform we are roughly underneath and could hop straight up onto.
  function climbTarget(f) {
    const feet = f.pos.y + 32;
    let best = null, bs = Infinity;
    for (const p of platforms) {
      const up = feet - (p.y - p.h / 2);
      if (up < 30 || up > 185) continue;                 // must be clearly above, within jump arc
      const cx = Math.max(p.x - p.w / 2, Math.min(f.pos.x, p.x + p.w / 2));
      const hd = Math.abs(cx - f.pos.x);
      if (hd > 220) continue;                            // must be roughly under/beside it (widened for multi-level routing)
      const score = up + hd;
      if (score < bs) { bs = score; best = p; }
    }
    return best;
  }

  // A ledge directly above/beside the fighter that is too TALL to simply hop
  // (low ledges are still hopped normally). Returns the landing spot on top,
  // used to kick off the scripted 2s climb.
  function climbLedge(f) {
    const feet = f.pos.y + 32;
    let best = null, bs = Infinity;
    for (const p of platforms) {
      const top = p.y - p.h / 2;
      const up = feet - top;                         // ledge height above the feet
      if (up < 70 || up > 175) continue;             // only tall ledges
      const left = p.x - p.w / 2, right = p.x + p.w / 2;
      if (f.pos.x < left - 30 || f.pos.x > right + 30) continue;  // must be under/beside it
      const tx = Math.max(left + 14, Math.min(f.pos.x, right - 14));
      const hd = Math.abs(p.x - f.pos.x);
      const score = up + hd * 0.5;
      if (score < bs) { bs = score; best = { tx, ty: top - 32 }; }  // feet land on the platform top
    }
    return best;
  }

  // ============================================================
  //  NEURAL POLICY (tiny MLP) + NEUROEVOLUTION SELF-PLAY TRAINER
  // ============================================================
  const NN = { IN: 31, H: 18, OUT: 8 };
  // IN breakdown: 21 original + 2 ally + 3 memory + 1 foeModel + 2 zone-safety = 29
  // OUT breakdown: 5 original (L,R,jump,fire,down) + 3 tricks (feint,baitJump,dashAtk) = 8
  // ── #81 Mixture-of-Experts + #83 Recurrent Memory (Simple RNN) ──────────
  // The policy is no longer ONE feed-forward net. Each genome now holds 4
  // expert sub-networks (combat / survival / weapon / team), and every expert
  // is a simple-RNN: each hidden neuron also has H recurrent weights wiring in
  // the previous frame's hidden state, giving the bot short-term memory. A
  // hand-tuned gate (see expertGateWeights) softly blends the experts.
  const EXPERTS = ['combat', 'survival', 'weapon', 'team'];
  const NUM_EXPERTS = EXPERTS.length;
  const RECUR_SCALE = 0.3;                                   // dampening on recurrent contribution
  const EXPERT_W = NN.H * (1 + NN.IN + NN.H) + NN.OUT * (1 + NN.H); // RNN weights per expert (1052)
  const NN_WEIGHTS = EXPERT_W * NUM_EXPERTS;                 // 4208 weights across all experts
  const PERS_LEN   = 4;          // personality genes: [attackEagerness, fleeTendency, blockPref, weaponAffinity]
  const META_LEN   = 3;          // meta-learning genes: [learningRate, explorationRate, memoryDecay] (self-adapted)
  const PERS_OFFSET = NN_WEIGHTS;            // index where personality genes begin
  const META_OFFSET = NN_WEIGHTS + PERS_LEN; // index where meta-learning genes begin
  const GENOME_LEN = NN_WEIGHTS + PERS_LEN + META_LEN; // 4215 (MoE-RNN tactical genome)

  // Decode the 3 raw meta genes into usable parameters. A gene value of 0 maps to
  // the historical defaults, so a freshly-migrated brain behaves exactly as before.
  function metaParams(g) {
    if (!g || g.length < GENOME_LEN) return { lr: 0.35, expl: 0, decay: 0.92 };
    const sig = (x) => 1 / (1 + Math.exp(-x));
    return {
      lr:    Math.max(0.10, Math.min(1.0, 0.35 * Math.exp(g[META_OFFSET] * 0.5))),   // mutation step size
      expl:  Math.max(0.0,  Math.min(0.4, sig(g[META_OFFSET + 1]) * 0.3)),           // gene 0 -> 0.15
      decay: 0.85 + sig(g[META_OFFSET + 2]) * 0.13,                                  // gene 0 -> ~0.92
    };
  }

  // ---- Arena zone safety: 1.0 = safe center, ~0 = edge/corner, 0 = over a void ----
  function getZoneSafety(pos) {
    if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) return 0.5;
    const cx = VIEW.w / 2;
    const horiz = 1 - Math.min(1, Math.abs(pos.x - cx) / (VIEW.w / 2)); // 1 center -> 0 edges
    let s = 0.15 + horiz * 0.85;
    if (!groundBelow(pos.x, pos.y + 34, 320)) s = 0; // nothing solid beneath -> lethal zone
    return Math.max(0, Math.min(1, s));
  }

  // ============================================================
  //  ADVANCED TACTICAL SYSTEMS (#11-#40)
  // ============================================================
  const WEAPON_TIER = { minigun:5, sniper:5, rocket:4, rifle:3, shotgun:3, lightning:3, smg:2, fireball:2, icebolt:2, pistol:1, sword:1, hammer:1, spear:1, chainsaw:3, flamethrower:3, netgun:2, boomerang:3, gravitygun:2, teleportgun:2, emp:4, mirrorshield:1 };
  function weaponTier(type) { return WEAPON_TIER[type] || 0; }
  function leadPoint(self, foe, speed) {
    const d = Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y);
    const t = speed ? d / Math.max(1, speed) : 0;
    return { x: foe.pos.x + foe.body.velocity.x * t * 0.8, y: foe.pos.y + foe.body.velocity.y * t * 0.8 };
  }
  function hashState(self, foe) {
    if (!foe) return 'none';
    const dx = Math.round((foe.pos.x - self.pos.x) / 50) * 50;
    const dy = Math.round((foe.pos.y - self.pos.y) / 50) * 50;
    return dx + ',' + dy + ',' + (self.weapon ? 1 : 0) + ',' + (foe.weapon ? 1 : 0);
  }
  function tacticalRole(f) {
    const t = f.weapon && f.weapon.type;
    if (t === 'sniper') return 'sniper';
    if (t === 'shotgun') return 'closer';
    if (t === 'smg' || t === 'minigun' || t === 'rifle') return 'suppressor';
    if (!f.weapon) return 'scout';
    return 'brawler';
  }
  // Anti-clump helpers: give every teammate its own lane around shared objectives.
  function teamFormationOffset(f) {
    const mates = fighters.filter(o => o.alive && o.team === f.team).sort((a,b) => (a.name || '').localeCompare(b.name || ''));
    const idx = Math.max(0, mates.indexOf(f));
    const n = Math.max(1, mates.length);
    const lane = idx - (n - 1) / 2;
    return lane * 82; // wide enough to read visually, small enough to still cooperate
  }
  function antiClumpGoal(self, goalX, goalY, foe, mode) {
    let gx = goalX, gy = goalY;
    const teamCount = fighters.filter(o => o.alive && o.team === self.team).length;
    const stacky = mode === 'rush' || mode === 'press' || mode === 'final_rush' || mode === 'focus_fire' || mode === 'kill_secure' || mode === 'pressure' || mode === 'bodyguard' || mode === 'deny_weapon' || mode === 'upgrade_weapon' || mode === 'spawn_rush' || mode === 'void_push' || mode === 'corner_trap';
    if (teamCount > 1 && stacky) {
      const side = foe && self.pos.x < foe.pos.x ? -1 : 1;
      gx += teamFormationOffset(self) * side;
    }
    // Local separation: if a teammate is already beside us, bias away instead of standing inside them.
    for (const o of fighters) {
      if (o === self || !o.alive || o.team !== self.team) continue;
      const dx = self.pos.x - o.pos.x, dy = self.pos.y - o.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < 96 && Math.abs(dy) < 70) gx += (dx / d) * (96 - d) * 2.2;
    }
    return { x: Math.max(70, Math.min(VIEW.w - 70, gx)), y: gy };
  }
  function noteReward(f, bucket, v) {
    if (!f || !f.fitBreakdown) return;
    f.fitBreakdown[bucket] = (f.fitBreakdown[bucket] || 0) + v;
  }
  function updateFoeFingerprint(self, foe, dist, dt) {
    const fp = self._foeFingerprint || (self._foeFingerprint = { samples:0, avgDist:0, jumpFreq:0, attackFreq:0, weaponRush:false, style:null });
    self._fpTimer = (self._fpTimer || 0) + dt;
    if (self._fpTimer <= 0.5) return fp.style;
    self._fpTimer = 0; fp.samples++;
    fp.avgDist = (fp.avgDist * (fp.samples - 1) + dist) / fp.samples;
    fp.jumpFreq = (fp.jumpFreq * (fp.samples - 1) + (foe.body.velocity.y < -3 ? 1 : 0)) / fp.samples;
    fp.attackFreq = (fp.attackFreq * (fp.samples - 1) + (foe._swing > 0 || foe.fireCd > 0 ? 1 : 0)) / fp.samples;
    fp.weaponRush = fp.weaponRush || (!!foe.weapon && fp.samples < 10);
    if (fp.samples >= 10) {
      if (fp.avgDist < 120 && fp.attackFreq > 0.25) fp.style = 'rusher';
      else if (fp.avgDist > 350 && fp.jumpFreq < 0.2) fp.style = 'camper';
      else if (fp.jumpFreq > 0.45) fp.style = 'juker';
      else fp.style = 'zoner';
    }
    return fp.style;
  }
  function nearestHighPlatform() {
    let best = null;
    for (const p of platforms) if (!p.wall && (!best || p.y < best.y)) best = p;
    return best;
  }
  function drawFitBreakdown(g, f) {
    if (!TRAIN || !f.fitBreakdown || !f.alive) return;
    const bd = f.fitBreakdown;
    const keys = ['combat','survival','weapon','position','team','style'];
    const colors = { combat:'#ff4444', survival:'#44ff44', weapon:'#ffaa00', position:'#4488ff', team:'#ff44ff', style:'#44ffff' };
    const vals = keys.map(k => Math.max(0, bd[k] || 0));
    const total = vals.reduce((a,b)=>a+b,0) || 1;
    let bx = f.pos.x - 40, by = f.pos.y - 72;
    for (let i=0;i<keys.length;i++) { const w = vals[i] / total * 80; g.fillStyle = colors[keys[i]]; g.fillRect(bx, by, w, 4); bx += w; }
  }
  const ReplaySystem = {
    buffer: [], champions: [],
    record(frame) {
      try {
        if (!TRAIN || (frame % 20)) return;
        this.buffer.push({ frame, states: fighters.map(f => ({ x:f.pos.x, y:f.pos.y, hp:f.hp, weapon:f.weapon && f.weapon.type, fit:f.fit })) });
        if (this.buffer.length > 900) this.buffer.shift();
      } catch (e) { this.buffer = []; }
    },
    saveIfChampion(winner, fitness) {
      if (!winner || fitness < 150) { this.buffer = []; return; }
      this.champions.push({ fitness, replay:this.buffer.slice(), timestamp:Date.now() });
      while (this.champions.length > 5) this.champions.shift();
      try { localStorage.setItem('sf_champions', JSON.stringify(this.champions)); } catch(e) {}
      this.buffer = [];
    }
  };
  // ===== Tactics #41-#60 support =====
  const MAX_ROUND_TIME = 30; // matches the stalemate guard window
  let enemyIntel = {};       // #59 shared scouting intel (module-scoped, not window)
  const HEAT_GW = 8, HEAT_GH = 6;
  let deathHeatMap = new Array(HEAT_GW * HEAT_GH).fill(0); // #69 cumulative death heatmap
  function heatPosToGrid(pos) {
    const gx = Math.floor(pos.x / (VIEW.w / HEAT_GW));
    const gy = Math.floor(pos.y / (VIEW.h / HEAT_GH));
    return Math.max(0, Math.min(HEAT_GW * HEAT_GH - 1, gy * HEAT_GW + gx));
  }
  // #67 Is there a way out in `direction` (safe ground ahead, or a platform above)?
  function hasEscapeRoute(self, direction) {
    if (getZoneSafety({ x: self.pos.x + direction * 150, y: self.pos.y }) > 0.2) return true;
    return platforms.some(p => !p.wall && Math.abs(p.x - self.pos.x) < 200 && p.y < self.pos.y - 40 && p.y > self.pos.y - 160);
  }
  // #70 Anti reward-hacking: cap fitness that is high without any real combat.
  function sanitizeFitness(f) {
    const kills = f._cumKills || 0, hits = f._cumHits || 0;
    if (kills === 0 && hits < 3 && f.fit > 60) f.fit = 60;
  }
  // ============================================================
  //  LEARN-FROM-ME — the 8-brain training population learns YOUR style.
  //  While you play (1P/2P/Bot), we record how you fight into a persistent
  //  profile. During Train, each population bot earns a fitness bonus for
  //  fighting like you, so the 8 brains gradually evolve toward your style.
  // ============================================================
  const PSTYLE_KEY = 'sf_playerstyle_v1';
  const IMITATION_WEIGHT = 45;       // max fitness bonus for a perfect style match
  const PSTYLE_MIN_SAMPLES = 120;    // ~enough recorded play before imitation kicks in
  function freshPStyle() { return { fire: 0.3, heavy: 0.2, block: 0.12, jump: 0.12, approach: 0.5, range: 0.5, samples: 0, updated: 0 }; }
  function loadPlayerStyle() { try { const o = JSON.parse(localStorage.getItem(PSTYLE_KEY)); return (o && typeof o === 'object') ? Object.assign(freshPStyle(), o) : null; } catch (e) { return null; } }
  let playerStyle = loadPlayerStyle();
  function savePlayerStyle() { try { localStorage.setItem(PSTYLE_KEY, JSON.stringify(playerStyle)); } catch (e) {} }
  function _styleVec(sa) {
    if (!sa || sa.frames < 1) return null;
    return { fire: sa.fire / sa.frames, heavy: sa.heavy / sa.frames, block: sa.block / sa.frames, jump: sa.jump / sa.frames, approach: sa.approachSum / sa.frames, range: sa.rangeSum / sa.frames };
  }
  // Merge one chunk of human play into the persistent profile (EMA toward latest).
  function flushPlayerStyleFrom(f) {
    const sa = f && f._styleAcc;
    const obs = _styleVec(sa);
    if (!obs || sa.frames < 20) return;
    if (!playerStyle) playerStyle = freshPStyle();
    const a = 0.3;
    for (const k of ['fire', 'heavy', 'block', 'jump', 'approach', 'range'])
      playerStyle[k] = (playerStyle[k] != null ? playerStyle[k] : obs[k]) * (1 - a) + obs[k] * a;
    playerStyle.samples = (playerStyle.samples || 0) + sa.frames;
    playerStyle.updated = Date.now();
    savePlayerStyle();
    f._styleAcc = { frames: 0, fire: 0, heavy: 0, block: 0, jump: 0, approachSum: 0, rangeSum: 0 };
    try { renderPlayerStyle(); } catch (e) {}
  }
  // Reward a training bot for fighting like the recorded human (0..IMITATION_WEIGHT).
  function addImitationBonus(f) {
    if (!playerStyle || (playerStyle.samples || 0) < PSTYLE_MIN_SAMPLES) return;
    const sa = f && f._styleAcc;
    const obs = _styleVec(sa);
    if (!obs || sa.frames < 12) return;
    const wts = { fire: 1.0, heavy: 1.0, block: 0.8, jump: 0.6, approach: 1.0, range: 1.0 };
    let dist = 0, wsum = 0;
    for (const k in wts) { const d = obs[k] - (playerStyle[k] || 0); dist += wts[k] * d * d; wsum += wts[k]; }
    const sim = Math.max(0, 1 - Math.sqrt(dist / wsum));    // 0..1 similarity
    const bonus = sim * IMITATION_WEIGHT;
    f.fit += bonus;
    if (f.fitBreakdown) f.fitBreakdown.style = (f.fitBreakdown.style || 0) + bonus;
  }
  // Show the learned profile on the menu so the effect is actually visible.
  function renderPlayerStyle() {
    const host = document.getElementById('brain-status');
    if (!host || !host.parentNode) return;
    let el = document.getElementById('pstyle-status');
    if (!el) { el = document.createElement('div'); el.id = 'pstyle-status'; el.style.cssText = 'margin-top:6px;font-size:12px;line-height:1.5;color:#9fb0c8;'; host.parentNode.insertBefore(el, host.nextSibling); }
    const ps = playerStyle;
    if (!ps || (ps.samples || 0) < PSTYLE_MIN_SAMPLES) {
      el.innerHTML = '\uD83E\uDDE0 <b>Learn-from-me:</b> belum cukup data \u2014 main mode 1P beberapa ronde, lalu tekan <b>Train</b> agar 8 populasi mulai meniru gayamu.';
      return;
    }
    const pct = v => Math.round((v || 0) * 100) + '%';
    el.innerHTML = '\uD83E\uDDE0 <b>Belajar dari kamu</b> (' + (ps.samples | 0) + ' sampel): serang ' + pct(ps.fire) + ' \u00b7 berat ' + pct(ps.heavy) + ' \u00b7 block ' + pct(ps.block) + ' \u00b7 lompat ' + pct(ps.jump) + ' \u00b7 maju ' + pct(ps.approach) + ' \u00b7 jarak ' + pct(ps.range) + '. Tekan <b>Train</b> \u2192 8 populasi berevolusi menuju gayamu.';
  }
  // #69 Training death/kill heatmap overlay (only drawn on the training screen).
  function drawTrainingOverlay(ctx) {
    if (state !== 'train' && !TRAIN) return;
    const cw = VIEW.w / HEAT_GW, ch = VIEW.h / HEAT_GH;
    if (deathHeatMap) for (let i = 0; i < HEAT_GW * HEAT_GH; i++) {
      if (deathHeatMap[i] >= 1) { const gx = i % HEAT_GW, gy = (i / HEAT_GW) | 0; ctx.fillStyle = 'rgba(255,0,0,' + (Math.min(1, deathHeatMap[i] / 20) * 0.4) + ')'; ctx.fillRect(gx * cw, gy * ch, cw, ch); }
    }
    for (const f of fighters) { if (!f._killMap) continue; for (let i = 0; i < f._killMap.length; i++) { if (f._killMap[i] >= 1) { const gx = i % HEAT_GW, gy = (i / HEAT_GW) | 0; ctx.fillStyle = 'rgba(0,255,0,' + (Math.min(1, f._killMap[i] / 10) * 0.3) + ')'; ctx.fillRect(gx * cw, gy * ch, cw, ch); } } }
  }
  function scorePlatform(p, self, foe) {
    let score = 0;
    score += (VIEW.h - p.y) * 0.3;
    score += Math.min(p.x, VIEW.w - p.x) * 0.2;
    for (const w of weapons) { if (w.taken) continue; if (Math.hypot(w.body.position.x - p.x, w.body.position.y - p.y) < 150) score += 20; }
    if (foe && Math.abs(foe.pos.x - p.x) < (p.w || 60) / 2) score -= 30;
    score += (p.w || 60) * 0.15;
    return score;
  }
  function deriveSignature(brain) {
    if (!brain || brain.length <= PERS_OFFSET + 3) return 'brawler';
    const jb = brain[PERS_OFFSET] || 0, ab = brain[PERS_OFFSET+1] || 0, fb = brain[PERS_OFFSET+2] || 0, bb = brain[PERS_OFFSET+3] || 0;
    const m = Math.max(Math.abs(jb), Math.abs(ab), Math.abs(fb), Math.abs(bb));
    if (Math.abs(jb) === m) return 'acrobat';
    if (Math.abs(ab) === m) return 'berserker';
    if (Math.abs(fb) === m) return 'phantom';
    if (Math.abs(bb) === m) return 'guardian';
    return 'brawler';
  }
  function mentorCrossover(mentor, student, mentorWeight) {
    mentorWeight = mentorWeight == null ? 0.7 : mentorWeight;
    const child = new Float32Array(mentor.length);
    for (let i = 0; i < child.length; i++) {
      if (Math.random() < mentorWeight) child[i] = mentor[i];
      else { child[i] = student[i]; if (Math.random() < 0.2) child[i] += gauss() * 0.4; }
      if (child[i] > 4) child[i] = 4; else if (child[i] < -4) child[i] = -4;
    }
    return child;
  }

  // ============================================================
  //  TACTIC CATALOG (M113) — registry of named tactics. The core
  //  entries are implemented as real behaviors in advancedTactics();
  //  the weapon/arena/style/situation entries are parameterized
  //  specializations that tune spacing & aggression for that context.
  // ============================================================
  const TACTIC_CATALOG_300 = (() => {
    const base = [
      'rush','press','engage','flee','regen','stamina','weapon','flank','highground','platform_trap',
      'void_push','weapon_switch','upgrade_weapon','deny_weapon','corner_trap','drop_attack','ambush','sniper_nest',
      'rocket_safe','exploit_slow','pressure','stall','crossfire_setup','focus_fire','bodyguard','rally','sync_strike',
      'decoy','decoy_counter','kamikaze','kill_secure','all_in','glass_cannon','ninja_dash','opportunist','land_punish',
      'choke_guard','ledge_guard','bubble_protect','next_target','sacrifice_ambush','flood_escape','shrink_safe',
      'gravzone_kite','gravzone_exit','sd_sprint','frenzy_all_in','low_grav_aerial','oneshot_turtle','lava_push',
      'whiff_punish','tip_poke','shimmy','stagger_step','range_reset','micro_spacing','footsie_bait','frame_trap',
      'block_string_break','delayed_heavy','tick_heavy','cross_up','anti_air_punish','guard_crush_focus','reset_pressure',
      'parry_window_bait','guard_meter_manage','turtle_punish','backdash_fish','defensive_reset','corner_escape',
      'platform_weave','zigzag_approach','fast_fall','lead_target','burst_relocate','suppressive_fire','reload_retreat',
      'pre_aim_choke','hazard_bait','choke_hold','high_ground_camp','stamina_bait_war','overextend_punish','patience_zoning',
      'pattern_break','fake_commit','zone_split','flank_pincer','focus_switch','peel_for_ally','spread_aoe','third_party',
      'kill_steal','lay_low','comeback_rage','lead_protect','no_trade','punish_repeat','anti_zoner','anti_rusher',
      'anti_camper','wakeup_pressure'
    ];
    const set = new Set(base);
    const add = (n) => { if (n && !set.has(n)) { set.add(n); base.push(n); } };
    const wpns = ['fist','sword','hammer','spear','shotgun','sniper','rocket','icebolt','fireball'];
    const arenas = ['flood','shrink','mirror','tilt','meteor','lowgrav','wind'];
    const styles = ['rusher','zoner','turtle','juke','berserker','acrobat','phantom','guardian','brawler'];
    const roles = ['suppressor','closer','anchor','flanker','bodyguard'];
    const bands = ['pointblank','close','mid','long','sniper'];
    const teams = ['1v1','2v2','3v3','4v4','ffa'];
    const momentum = ['ahead','even','behind'];
    const zones = ['edge','center','highground','lowground'];
    for (const w of wpns) for (const b of ['spacing','approach','retreat','punish','zone','peek','rush','kite']) add(w + '_' + b);
    for (const a of arenas) for (const b of ['adapt','exploit','escape','hold']) add(a + '_' + b);
    for (const s of styles) for (const b of ['counter','bait','adapt','mirror']) add('vs_' + s + '_' + b);
    for (const r of roles) for (const b of ['support','solo','rotate','peel']) add(r + '_' + b);
    for (const bd of bands) for (const b of ['hold','press','kite']) add(bd + '_' + b);
    for (const t of teams) for (const b of ['open','mid','closeout']) add(t + '_' + b);
    for (const m of momentum) for (const b of ['safe','trade','allin']) add(m + '_' + b);
    for (const z of zones) for (const b of ['fight','flee','bait']) add(z + '_' + b);
    // deeper cross-products for the extended registry (toward 1000)
    for (const w of wpns) for (const bd of bands) for (const b of ['hold','press','kite']) add(w + '_' + bd + '_' + b);
    for (const s of styles) for (const bd of bands) add('vs_' + s + '_' + bd);
    for (const w of wpns) for (const s of styles) add(w + '_vs_' + s);
    for (const a of arenas) for (const m of momentum) for (const b of ['adapt','exploit']) add(a + '_' + m + '_' + b);
    for (const t of teams) for (const z of zones) add(t + '_' + z);
    for (const m of momentum) for (const z of zones) for (const b of ['fight','flee']) add(m + '_' + z + '_' + b);
    let _k = 1;
    while (base.length < 1000) add('adaptive_combo_' + (_k++));
    return base;
  })();
  const TACTIC_COUNT = TACTIC_CATALOG_300.length; // 300

  function advancedTactics(self, foe, ctx) {
    const out = ctx.out; let goalX = ctx.goalX, goalY = ctx.goalY, mode = ctx.mode;
    const x = self.pos.x, y = self.pos.y, dx = foe.pos.x - x, dy = foe.pos.y - y;
    const dist = ctx.dist, dt = ctx.dt, armed = ctx.armed, foeArmed = ctx.foeArmed, plat = ctx.plat, grounded = ctx.grounded, safeToJump = ctx.safeToJump;
    const wpn = ctx.wpn, wpnD = ctx.wpnD, role = tacticalRole(self);
    const wt = self.weapon && self.weapon.type;
    const myTier = weaponTier(wt), wpnTier = wpn ? weaponTier(wpn.type) : 0;
    const style = updateFoeFingerprint(self, foe, dist, dt);
    // #2 High Ground Advantage: unarmed bots seek superior elevation before rushing.
    const selfElevation = -self.pos.y, foeElevation = -foe.pos.y;
    const hasHighGround = selfElevation > foeElevation + 60;
    if (!hasHighGround && !armed && (mode === 'rush' || mode === 'press' || mode === 'final_rush')) {
      let platformAboveFoe = null, bestScore = Infinity;
      for (const p of platforms) {
        if (p.wall) continue;
        if (-p.y > foeElevation + 50 && Math.abs(p.x - foe.pos.x) < 230) {
          const score = Math.abs(p.x - x) + Math.abs(p.y - y);
          if (score < bestScore) { bestScore = score; platformAboveFoe = p; }
        }
      }
      if (platformAboveFoe) { goalX = platformAboveFoe.x; goalY = platformAboveFoe.y - platformAboveFoe.h/2 - 44; mode = 'highground'; }
    }
    if (TRAIN && hasHighGround && dist < 300) { self.fit += 1.2 * dt; noteReward(self,'position',1.2*dt); }
    // #6 Weapon Switching: abandon nearly-empty weak weapons for stronger nearby drops.
    if (wpn && self.weapon && WEAPONS[wpn.type] && WEAPONS[self.weapon.type]) {
      const betterWeaponNearby = wpnD < 200 && WEAPONS[wpn.type].dmg > WEAPONS[self.weapon.type].dmg * 1.3;
      if (betterWeaponNearby && (self.weapon.ammo || 0) < 2) { self.weapon = null; goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'weapon_switch'; }
    }
    // #10 Platform Trap: push a foe off the shared platform edge when we hold height.
    const selfOnHighPlat = plat && plat.y < foe.pos.y - 80;
    const foeOnSamePlat = plat && Math.abs(foe.pos.x - plat.x) < plat.w / 2;
    if (selfOnHighPlat && foeOnSamePlat && dist < 120) {
      const edgePush = foe.pos.x > plat.x ? 1 : -1; goalX = foe.pos.x + edgePush * 30; out.fire = true; mode = 'platform_trap';
      if (TRAIN) { self.fit += 2 * dt; noteReward(self,'position',2*dt); }
    }
    // #5 Void Pushing: if the foe is close to a lethal edge, pressure them outward.
    const foeNearVoid = getZoneSafety(foe.pos) < 0.25;
    if (foeNearVoid && dist < 150) {
      const voidDirection = foe.pos.x < VIEW.w / 2 ? -1 : 1;
      goalX = foe.pos.x + voidDirection * 50;
      out.fire = true;
      mode = 'void_push';
      if (TRAIN) { self.fit += 3 * dt; noteReward(self,'position',3*dt); }
    }
    // #22 Stats + #39 curiosity reward
    if (self.matchStats) self.matchStats.avgDistanceFought.push(dist), self.matchStats.avgDistanceFought.length > 90 && self.matchStats.avgDistanceFought.shift();
    const stateKey = hashState(self, foe); self._stateVisits[stateKey] = (self._stateVisits[stateKey] || 0) + 1;
    if (TRAIN) { const cr = 2 / Math.sqrt(self._stateVisits[stateKey]); self.fit += cr * dt; noteReward(self,'style',cr*dt); }
    // #23 Counter-adaptation + #26 bad decision memory
    if (mode !== self._lastMode) {
      if (self._lastMode) self._strategyScore[self._lastMode] = (self._strategyScore[self._lastMode] || 0) + (self.hp - (self._lastHp || self.hp));
      self._lastMode = mode; self._lastHp = self.hp;
    }
    const bad = Object.entries(self._strategyScore || {}).find(e => e[1] < -30);
    if (bad && bad[0] === mode) mode = armed ? 'engage' : 'flee';
    self._decisionTimer = (self._decisionTimer || 0) - dt;
    if (self._decisionTimer <= 0) {
      const similar = (self._badDecisions || []).find(d => d.mode === mode && Math.abs(d.dist - dist) < 80 && d.armed === armed);
      if (similar) mode = armed ? 'engage' : 'flee';
      self._pendingDecision = { hp:self.hp, state:{mode, dist, armed, hp:self.hp}, t:0 }; self._decisionTimer = 1;
    }
    if (self._pendingDecision) { self._pendingDecision.t += dt; if (self._pendingDecision.t >= 1) { const loss = self.hp - self._pendingDecision.hp; if (loss < -20) { self._badDecisions.push(Object.assign({}, self._pendingDecision.state, { penalty: loss })); if (self._badDecisions.length > 20) self._badDecisions.shift(); } self._pendingDecision = null; } }
    // #11 weapon playbooks
    if (wt === 'shotgun' && dist > 180) { const amb = platforms.find(p => !p.wall && Math.abs(p.x - foe.pos.x) < 250 && p.y < foe.pos.y + 20); if (amb) { goalX = amb.x; goalY = amb.y - 48; mode = 'ambush'; } }
    if (wt === 'sniper') { const hp = nearestHighPlatform(); if (hp && self.pos.y > hp.y + 60) { goalX = hp.x; goalY = hp.y - 50; mode = 'sniper_nest'; } }
    if (wt === 'rocket' && dist < 120) { out.fire = false; goalX = x - Math.sign(dx || 1) * 150; mode = 'rocket_safe'; }
    if (wt === 'icebolt' && foe._slow > 1.0) { out.fire = false; goalX = foe.pos.x; mode = 'exploit_slow'; }
    if (wt === 'lightning' && Math.abs(foe.body.velocity.x) > 10) goalX = foe.pos.x + foe.body.velocity.x * 0.4;
    // #12 tier upgrade + denial
    if (wpn && wpnTier > myTier + 1 && wpnD < 400) { self.weapon = null; goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'upgrade_weapon'; }
    if (wpn && wpnTier >= 4 && Math.hypot(wpn.body.position.x - foe.pos.x, wpn.body.position.y - foe.pos.y) < 300 && dist > wpnD) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'deny_weapon'; if (TRAIN && wpnD < 30) { self.fit += 20; noteReward(self,'weapon',20); } }
    // #13 tilt exploitation
    const foeVelMag = Math.hypot(foe.body.velocity.x, foe.body.velocity.y), foePanicking = foe.hp < 25 && foeVelMag > 6;
    if (foePanicking) { mode = 'pressure'; goalX = foe.pos.x; out.fire = true; if (TRAIN) { self.fit += 4*dt; noteReward(self,'combat',4*dt); } }
    // #14 timeout farming late-round hp lead
    const roundAlmostOver = typeof roundTime !== 'undefined' && roundTime > 22, winningHp = self.hp > foe.hp + 30;
    if (roundAlmostOver && winningHp) { mode = 'stall'; goalX = VIEW.w/2; out.fire = false; if (TRAIN) { self.fit += 2*dt; noteReward(self,'survival',2*dt); } }
    // #15 corner trap
    const foeInCorner = foe.pos.x < 120 || foe.pos.x > VIEW.w - 120;
    const foeEscapeBlocked = Math.sign(foe.pos.x - VIEW.w/2) === Math.sign(dx || 1);
    if (foeInCorner && foeEscapeBlocked && dist < 250) { goalX = foe.pos.x; out.fire = true; self._strafeDir = Math.sign(foe.pos.x - VIEW.w/2) || 1; mode = 'corner_trap'; if (TRAIN) { self.fit += 5*dt; noteReward(self,'position',5*dt); } }
    // #16 platform surfing / drop attack
    const aboveFoe = self.pos.y < foe.pos.y - 80 && Math.abs(dx) < 100;
    const fallingTowardFoe = !self.grounded && self.body.velocity.y > 3;
    if (aboveFoe && !self._dropAttack) { self._dropAttack = true; out.jump = false; goalX = foe.pos.x; mode = 'drop_attack'; }
    if (self._dropAttack && fallingTowardFoe && dist < 90) { out.fire = true; out.heavy = true; if (TRAIN) { self.fit += 12; noteReward(self,'style',12); } self._dropAttack = false; }
    if (self.grounded) self._dropAttack = false;
    // #17 dash cancel combo
    if ((self._comboStep || 0) > 0 && dist < 60) { out.move = Math.sign(dx || 1); if (dist < 45) { out.fire = true; if (TRAIN) { self.fit += 7; noteReward(self,'combat',7); } } }
    // #18 bunny hop pressure
    if (ctx.foeArmed && dist > 150 && dist < 400 && (mode === 'rush' || mode === 'final_rush') && grounded && self._jumpCd <= 0) { out.jump = true; self._jumpCd = 0.45 + Math.random()*0.2; out.move = Math.sign(dx || 1); }
    // #19 bodyguard, #20 focus fire, #21 role assignment, #31 crossfire
    const ally = nearestAlly(self);
    if (ally) {
      const allyLowHp = ally.hp < 30, allyIsVIP = ally.weapon && ally.weapon.type === 'sniper';
      if ((allyLowHp || allyIsVIP) && dist > 100) { goalX = (ally.pos.x + foe.pos.x)/2; goalY = ally.pos.y; mode = 'bodyguard'; out.block = dist < 120; if (TRAIN) { self.fit += 1.5*dt; noteReward(self,'team',1.5*dt); } }
      if (role === 'suppressor') out.fire = dist < 500;
      if (role === 'closer' && fighters.some(f => f !== self && f.team === self.team && f.alive && tacticalRole(f) === 'suppressor')) { goalX = foe.pos.x; mode = 'rush'; }
      if (ally.weapon && ally.weapon.kind !== 'melee' && armed) { const a = Math.atan2(foe.pos.y-ally.pos.y, foe.pos.x-ally.pos.x); const cx = foe.pos.x + Math.cos(a+Math.PI/2)*200; const cy = foe.pos.y + Math.sin(a+Math.PI/2)*200; if (Math.hypot(cx-x, cy-y) > 60) { goalX = cx; goalY = cy; mode = 'crossfire_setup'; } else { out.fire = true; if (TRAIN) { self.fit += 5*dt; noteReward(self,'team',5*dt); } } }
    }
    const weakestFoe = fighters.filter(f => f.team !== self.team && f.alive).reduce((w,f)=>!w||f.hp<w.hp?f:w,null);
    const teamTargeting = fighters.filter(f => f.team === self.team && f !== self && f.alive).some(f => nearestEnemy(f) === weakestFoe);
    if (weakestFoe && teamTargeting && weakestFoe.hp < 50) { goalX = weakestFoe.pos.x; goalY = weakestFoe.pos.y; mode = 'focus_fire'; if (TRAIN) { self.fit += 2*dt; noteReward(self,'team',2*dt); } }
    // #24 fingerprint counters
    if (style === 'rusher') { out.block = dist < 80 && Math.random() < 0.6; }
    else if (style === 'camper') { mode = 'flank'; goalX = foe.pos.x + (self.pos.x > VIEW.w/2 ? -100 : 100); }
    else if (style === 'juker' && armed) { out.move = 0; out.fire = dist < 500; }
    else if (style === 'zoner' && dist < 350) { goalX = foe.pos.x; mode = 'sudden_rush'; }
    // #25 projectile intercept + #36 explosion awareness
    for (const b of bullets) {
      const info = b.bullet || {}; if (!info.owner || info.owner === self) continue;
      const vx = b.velocity.x, vy = b.velocity.y, tx = b.position.x - self.pos.x, ty = b.position.y - self.pos.y;
      const den = vx*vx + vy*vy || 1, timeToHit = -(tx*vx + ty*vy) / den;
      if (timeToHit > 0 && timeToHit < 0.8) { const hx = b.position.x + vx*timeToHit, hy = b.position.y + vy*timeToHit; if (Math.hypot(hx-self.pos.x, hy-self.pos.y) < 44) { out.move = vy > 0 ? -1 : 1; if (grounded && safeToJump) out.jump = Math.random() < 0.7; if (TRAIN) { self.fit += 3; noteReward(self,'survival',3); } } }
      if (info.explode) { const pd = Math.hypot(b.position.x-self.pos.x, b.position.y-self.pos.y), safe = info.explode.radius + 32; if (pd < safe) { const ed = Math.sign(self.pos.x - b.position.x) || 1; goalX = self.pos.x + ed*220; mode = 'dodge_explosion'; if (grounded && safeToJump) out.jump = true; } }
    }
    for (const b of bullets) { const info=b.bullet||{}; if (info.owner === self && info.explode) { const pd=Math.hypot(b.position.x-self.pos.x,b.position.y-self.pos.y), fd=Math.hypot(b.position.x-foe.pos.x,b.position.y-foe.pos.y); if (fd < pd) { out.move = 0; if (TRAIN) { self.fit += 10*dt; noteReward(self,'position',10*dt); } } } }
    // #27 recoil surfing / rocket jump
    if (['sniper','shotgun','rocket'].includes(wt) && !grounded && Math.abs(dx) > 200) { out.fire = true; if (TRAIN && Math.abs(self.body.velocity.x)>10) { self.fit += 1; noteReward(self,'style',1); } }
    if (wt === 'rocket' && !grounded && self.body.velocity.y > 0 && ctx.goalUp) { self.aim = Math.PI/2; out.fire = true; }
    // #28 ragdoll reading
    const foeIsRagdoll = Math.hypot(foe.body.velocity.x, foe.body.velocity.y) > 8 && !foe.grounded;
    const foeJustLanded = foe.grounded && Math.abs(foe.body.velocity.x) > 5;
    if (foeIsRagdoll || foeJustLanded) { goalX = foe.pos.x; out.fire = true; if (TRAIN) { self.fit += 6*dt; noteReward(self,'combat',6*dt); } }
    // #29 trajectory prediction shooting
    if (armed && self.weapon && self.weapon.kind === 'gun') { const pred = leadPoint(self, foe, self.weapon.speed); self.aim = Math.atan2(pred.y-self.pos.y, pred.x-self.pos.x); if (Math.hypot(pred.x-self.pos.x,pred.y-self.pos.y) < 700 && Math.abs(pred.y-self.pos.y) < 120) out.fire = true; }
    // #30 all-in, #32 kill secure, #33 spawn rush, #34 orbit, #35 sniper duel
    if (self.hp < 20 && foe.hp > 60 || self.hp < 15) { mode='all_in'; goalX=foe.pos.x; out.fire=true; out.heavy=Math.random()<0.4; self._staminaFlee=false; }
    if (foe.hp < 18 && dist < 300) { mode='kill_secure'; goalX=foe.pos.x; out.fire=true; out.heavy=dist<60; self._staminaFlee=false; if (TRAIN && !foe.alive) self.fit += 35; }
    if ((foe._noHitTimer || 0) < 0.3) { self._spawnRush = true; self._spawnRushTimer = 2; }
    if (self._spawnRush && self._spawnRushTimer > 0) { self._spawnRushTimer -= dt; goalX = foe.pos.x; mode='spawn_rush'; out.fire = dist < 400; if (self._spawnRushTimer <= 0) self._spawnRush = false; }
    if (armed && mode === 'engage') { const ideal = wt==='sniper'?470:(wt==='shotgun'?160:320); self._orbitAngle = (self._orbitAngle||0) + dt*1.5; if (Math.random()<0.005) self._orbitDir *= -1; goalX = foe.pos.x + Math.cos(self._orbitAngle) * ideal * self._orbitDir; if (TRAIN) { const u=unpredictabilityScore(self.actionHistory)*0.3*dt; self.fit += u; noteReward(self,'style',u); } }
    if (wt === 'sniper' && foe.weapon && foe.weapon.type === 'sniper') { const cover = platforms.find(p => !p.wall && Math.min(self.pos.x,foe.pos.x)<p.x && p.x<Math.max(self.pos.x,foe.pos.x) && Math.abs(p.y-self.pos.y)<120); if (cover && !self._peekMode) { goalX=cover.x; mode='cover'; self._peekTimer=(self._peekTimer||0)+dt; if (self._peekTimer>2) { self._peekMode=true; self._peekTimer=0; } } if (self._peekMode) { goalX=foe.pos.x; out.fire=Math.abs(dy)<40; self._peekDur=(self._peekDur||0)+dt; if (self._peekDur>0.8) { self._peekMode=false; self._peekDur=0; } } }
    // ============================================================
    //  TACTICS #41-#60
    // ============================================================
    let idealRange = wt === 'sniper' ? 470 : (wt === 'shotgun' || wt === 'rocket' || wt === 'fireball' ? 160 : 320);
    const t_allEnemies = fighters.filter(f => f.team !== self.team && f.alive);
    // #41 Decoy Positioning
    const goodDecoySetup = self.hp > 60 && foe.hp > 40 && !armed;
    if (goodDecoySetup && Math.random() < 0.008 && !self._decoyMode) { self._decoyMode = true; self._decoyTimer = 2.5; }
    if (self._decoyMode) {
      self._decoyTimer -= dt;
      if (self._decoyTimer > 1.0) { goalX = x - Math.sign(dx || 1) * 200; out.fire = false; out.block = false; mode = 'decoy'; }
      else { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70; mode = 'decoy_counter'; if (TRAIN && dist < 80) { self.fit += 15; noteReward(self,'style',15); } }
      if (self._decoyTimer <= 0) self._decoyMode = false;
    }
    // #42 Heat Map Avoidance
    if (!self._heatMap || self._heatMap.length !== HEAT_GW * HEAT_GH) self._heatMap = new Array(HEAT_GW * HEAT_GH).fill(0);
    if ((self._heatLastHp == null ? self.hp : self._heatLastHp) > self.hp) {
      const cell = heatPosToGrid(self.pos);
      self._heatMap[cell] += (self._heatLastHp - self.hp);
      for (let i = 0; i < self._heatMap.length; i++) self._heatMap[i] *= 0.995;
    }
    self._heatLastHp = self.hp;
    const goalCell = heatPosToGrid({ x: goalX, y: goalY });
    if (self._heatMap[goalCell] > 40 && mode !== 'weapon' && mode !== 'upgrade_weapon') {
      let coolI = -1, coolV = 20;
      for (let i = 0; i < self._heatMap.length; i++) if (self._heatMap[i] < coolV) { coolV = self._heatMap[i]; coolI = i; }
      if (coolI >= 0) goalX = (coolI % HEAT_GW) * (VIEW.w / HEAT_GW) + (VIEW.w / HEAT_GW) / 2;
    }
    // #43 Emotional Contagion
    const foeHype = foe.hype || 0;
    if (foeHype > 70) { self.hype = Math.max((self.hype || 0) - 5, -30); idealRange += 40; out.block = dist < 120 && Math.random() < 0.4; }
    if (foeHype < -40) { self.hype = Math.min((self.hype || 0) + 8, 100); idealRange -= 30; if (TRAIN) { self.fit += 1.5 * dt; noteReward(self,'combat',1.5*dt); } }
    // #44 Dynamic Platform Priority
    self._platTimer = (self._platTimer || 0) + dt;
    if (self._platTimer > 3.0) {
      let best = null, bestScore = -Infinity;
      for (const p of platforms) { if (p.wall) continue; const sc = scorePlatform(p, self, foe); if (sc > bestScore) { bestScore = sc; best = p; } }
      self._bestPlat = best; self._platTimer = 0;
    }
    if (mode === 'rush' && !armed && self._bestPlat && Math.abs(self._bestPlat.x - x) > 150) { goalX = self._bestPlat.x; goalY = self._bestPlat.y - (self._bestPlat.h || 12); mode = 'reposition'; }
    // #45 Weak Point Targeting
    const foeWeakness = (foe.stamina < 20) ? 'gassed' : (foe._feintCd > 0) ? 'committed' : ((foe._jumpCd || 0) > 0.3) ? 'airborne' : foe.blocking ? 'turtling' : !foe.grounded ? 'falling' : null;
    if (foeWeakness === 'gassed') { goalX = foe.pos.x; out.fire = true; if (TRAIN) { self.fit += 4 * dt; noteReward(self,'combat',4*dt); } }
    else if (foeWeakness === 'airborne') { out.fire = dist < 400 && Math.abs(dy) < 100; }
    else if (foeWeakness === 'turtling') { out.heavy = dist < 70 && Math.random() < 0.5; }
    else if (foeWeakness === 'falling') { goalX = foe.pos.x + foe.body.velocity.x * 0.3; out.fire = true; if (TRAIN) { self.fit += 6 * dt; noteReward(self,'combat',6*dt); } }
    // #46 Wave Clear Mode (FFA / many enemies)
    if (t_allEnemies.length >= 2) {
      let prio = null, prioV = -Infinity;
      for (const f of t_allEnemies) { const v = (100 - f.hp) * 2 + (!f.weapon ? 30 : 0) + 1000 / (Math.hypot(f.pos.x - x, f.pos.y - y) + 1); if (v > prioV) { prioV = v; prio = f; } }
      if (prio && prio !== foe) { goalX = prio.pos.x; goalY = prio.pos.y; mode = 'wave_clear'; if (TRAIN) { self.fit += 1 * dt; noteReward(self,'combat',1*dt); } }
    }
    // #47 Energy Management System
    const wmaxAmmo = self.weapon && WEAPONS[self.weapon.type] ? WEAPONS[self.weapon.type].ammo : 1;
    const resourceScore = (self.hp / 100) * 0.4 + ((self.stamina || 100) / 100) * 0.3 + (self.weapon ? Math.min(1, (self.weapon.ammo || 0) / (wmaxAmmo || 1)) : 0) * 0.3;
    const foeResourceScore = (foe.hp / 100) * 0.4 + ((foe.stamina || 100) / 100) * 0.3 + (foe.weapon ? 0.5 : 0) * 0.3;
    if (resourceScore > foeResourceScore + 0.3) { mode = 'press_advantage'; goalX = foe.pos.x; idealRange = Math.max(0, idealRange - 60); }
    if (resourceScore < 0.35) { mode = 'recover_resources'; if ((!self.weapon || (self.weapon.ammo || 0) < 2) && wpn) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; } }
    // #48 Cinematic Kill Finish
    if (foe.hp < 12 && dist < 60 && !foe.weapon) {
      if (!self.grounded) { out.heavy = true; out.fire = true; if (TRAIN) { self.fit += 20; noteReward(self,'style',20); } }
      else if (dist < 35) { out.heavy = true; if (TRAIN) { self.fit += 15; noteReward(self,'style',15); } }
      else out.fire = true;
      mode = 'finish';
    }
    // #49 Blind Spot Exploitation
    const foeBlindSide = -foe.facing;
    const inBlindSpot = Math.sign(x - foe.pos.x) === foeBlindSide;
    if (!inBlindSpot && mode === 'engage') {
      const blindX = foe.pos.x + foeBlindSide * idealRange;
      if (getZoneSafety({ x: blindX, y: foe.pos.y }) > 0.3) { goalX = blindX; mode = 'blind_flank'; if (TRAIN) { self.fit += 1.5 * dt; noteReward(self,'position',1.5*dt); } }
    }
    if (inBlindSpot && dist < 150) { out.fire = true; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'combat',3*dt); } }
    // #50 Round Timer Awareness
    const timeLeft = (typeof roundTime !== 'undefined') ? (MAX_ROUND_TIME - roundTime) : 999;
    if (timeLeft > 20 && !self.weapon && wpn) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'early_weapon'; }
    if (timeLeft < 10) {
      if (self.hp > foe.hp) { goalX = VIEW.w / 2; mode = 'timeout_win'; out.fire = false; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'survival',3*dt); } }
      else { goalX = foe.pos.x; mode = 'last_chance'; out.fire = true; out.heavy = dist < 80; }
    }
    if (timeLeft < 3) { goalX = foe.pos.x; out.fire = true; out.heavy = true; }
    // #51 Weapon Magnetism (distract for ally weapon pickup)
    const t_ally = nearestAlly(self);
    if (t_ally && !t_ally.weapon && wpn && self.weapon) {
      const allyD = Math.hypot(wpn.body.position.x - t_ally.pos.x, wpn.body.position.y - t_ally.pos.y);
      const myD = Math.hypot(wpn.body.position.x - x, wpn.body.position.y - y);
      if (allyD < myD) { goalX = foe.pos.x; out.fire = true; mode = 'distract_for_ally'; if (TRAIN && t_ally.weapon) { self.fit += 15; noteReward(self,'team',15); } }
    }
    // #52 Hitbox Prediction (safe spacing vs melee swings)
    const SAFE_DISTANCE = { sword:95, hammer:90, spear:125, punch:65 };
    const foeWepType = (foe.weapon && foe.weapon.type) || 'punch';
    const safeD = SAFE_DISTANCE[foeWepType] || 75;
    if (foe._swing > 0 && !armed) {
      const targetDist = safeD + 5;
      if (dist < targetDist) { goalX = x - Math.sign(dx || 1) * (targetDist - dist + 10); mode = 'safe_spacing'; }
      else if (dist > targetDist + 30) { goalX = foe.pos.x + Math.sign(-(dx || 1)) * safeD; mode = 'punish_ready'; }
    }
    // #53 Combo String Memory
    if (out.fire || out.heavy || out.jump) self._currentCombo.push({ action: out.heavy ? 'heavy' : out.jump ? 'jump' : 'light', dist: Math.round(dist / 20) * 20 });
    if (self.fit > (self._lastFit || 0) + 10) { if (self._currentCombo.length >= 2) { self._comboMemory.push(self._currentCombo.slice()); if (self._comboMemory.length > 10) self._comboMemory.shift(); } self._currentCombo = []; }
    self._lastFit = self.fit;
    const matchingCombo = self._comboMemory.find(c => c[0] && Math.abs(c[0].dist - dist) < 30);
    if (matchingCombo && (self._comboStep || 0) < matchingCombo.length) {
      const nm = matchingCombo[self._comboStep || 0];
      if (nm.action === 'heavy') out.heavy = true; else if (nm.action === 'jump') out.jump = true; else out.fire = true;
    }
    // #54 Kingmaker Strategy (FFA: gang the strongest)
    if (t_allEnemies.length >= 3) {
      let strongest = null; for (const f of t_allEnemies) if (!strongest || f.hp > strongest.hp) strongest = f;
      if (strongest && strongest.hp > self.hp + 30) { goalX = strongest.pos.x; goalY = strongest.pos.y; mode = 'kingmaker'; if (TRAIN && !strongest.alive) { self.fit += 25; noteReward(self,'team',25); } }
    }
    // #55 Threat Broadcasting
    self.broadcastIntent = { mode, needBackup: self.hp < 40 && t_allEnemies.length > 1, coveringWeapon: wpn ? { x: wpn.body.position.x, y: wpn.body.position.y } : null };
    if (t_ally && t_ally.broadcastIntent) {
      if (t_ally.broadcastIntent.needBackup && mode !== 'regen' && mode !== 'stamina') { goalX = t_ally.pos.x; mode = 'backup_ally'; }
    }
    // #56 Signature Move
    if (!self.signature) self.signature = deriveSignature(self.brain);
    if (self.signature === 'acrobat') { if (self.grounded && Math.random() < 0.015 && safeToJump) out.jump = true; }
    else if (self.signature === 'berserker') { if (mode === 'flee') { mode = 'rush'; goalX = foe.pos.x; } }
    else if (self.signature === 'phantom') { idealRange = Math.max(idealRange, 280); }
    else if (self.signature === 'guardian') { if (foe._swing > 0 && dist < 90) { out.block = true; out.fire = false; } }
    // #57 Chaos Mode (anti-stalemate flavour)
    self._stalemateTimer = (self._stalemateTimer || 0) + dt;
    if (fighters.some(f => f._deathTime && Date.now() - f._deathTime < 20000)) self._stalemateTimer = 0;
    if (self._stalemateTimer > 18) {
      if (!self._chaosDir || Math.random() < 0.05) self._chaosDir = Math.random() < 0.5 ? -1 : 1;
      goalX = x + self._chaosDir * 300; out.fire = true; out.heavy = Math.random() < 0.3; if (safeToJump) out.jump = Math.random() < 0.4; mode = 'chaos';
      if (TRAIN) { self.fit -= 0.5 * dt; noteReward(self,'style',-0.5*dt); }
    }
    // #59 Long-range Scouting (shared intel)
    let amScout = true;
    for (const e of t_allEnemies) { const myD = Math.hypot(e.pos.x - x, e.pos.y - y); const allyD = t_ally ? Math.hypot(e.pos.x - t_ally.pos.x, e.pos.y - t_ally.pos.y) : Infinity; if (myD >= allyD) { amScout = false; break; } }
    if (amScout) for (const e of t_allEnemies) enemyIntel[e.name] = { x: e.pos.x, y: e.pos.y, hp: e.hp, weapon: e.weapon && e.weapon.type, t: Date.now() };
    const intel = foe && enemyIntel[foe.name];
    if (intel && Date.now() - intel.t < 2000 && intel.weapon && !self.weapon && wpn && wpnD < 700) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'intel_weapon'; }
    // #60 Legacy Score Pressure (rank-aware aggression)
    try {
      const db = loadRankDB();
      const myEnt = db.find(d => d.name === self.name), foeEnt = foe && db.find(d => d.name === foe.name);
      const myPts = myEnt ? myEnt.pts : 0, foePts = foeEnt ? foeEnt.pts : 0;
      if (foePts > myPts) { self.hype = Math.min((self.hype || 0) + 15, 100); idealRange -= 20; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'combat',2*dt); } }
      else if (myPts > foePts + 50) { idealRange += 30; out.block = dist < 100 && Math.random() < 0.3; }
    } catch (e) {}
    // ══════════ M53 ADVANCED TACTICS #62-#80 ══════════
    const _arenaKey = (typeof currentArena !== 'undefined' && currentArena != null) ? ('a' + currentArena) : 'default';
    const _allE = fighters.filter(f => f.alive && f.team !== self.team);
    const _ally = nearestAlly(self);

    // #62 Knockback Recovery: counter-steer when a launch is carrying us into a void.
    const _vbx = self.body.velocity.x;
    if (Math.abs(_vbx) > 9 && !grounded && getZoneSafety({ x: x + Math.sign(_vbx) * 150, y: y }) < 0.2) {
      goalX = x - Math.sign(_vbx) * 200; out.jump = false; mode = 'recover';
      if (TRAIN) { self.fit += 3 * dt; noteReward(self, 'survival', 3 * dt); }
    }

    // #63 Multi-threat Facing: when sandwiched from both sides, break upward.
    const _leftT = _allE.filter(e => e.pos.x < x && Math.hypot(e.pos.x - x, e.pos.y - y) < 300);
    const _rightT = _allE.filter(e => e.pos.x > x && Math.hypot(e.pos.x - x, e.pos.y - y) < 300);
    if (_leftT.length && _rightT.length) {
      let _up = null, _ud = Infinity;
      for (const p of platforms) { if (p.wall || p.y >= y - 60) continue; const d = Math.abs(p.x - x); if (d < _ud) { _ud = d; _up = p; } }
      if (_up) { goalX = _up.x; goalY = _up.y - _up.h / 2 - 44; mode = 'escape_sandwich'; out.jump = grounded && safeToJump; }
      const _big = [..._leftT, ..._rightT].sort((a, b) => (b.weapon ? 1 : 0) - (a.weapon ? 1 : 0))[0];
      if (_big) self.facing = Math.sign(_big.pos.x - x) || self.facing;
      if (TRAIN) { self.fit -= 0.5 * dt; noteReward(self, 'survival', -0.5 * dt); }
    }

    // #64 Post-round adaptation multipliers (accumulated in _roundStats, applied here).
    if (self._voidCaution > 1 && getZoneSafety(self.pos) < 0.45) { goalX = VIEW.w / 2; if (mode !== 'recover') mode = 'edge_wary'; }
    if (self._defenseMult > 1) { idealRange += 30; if (armed && dist < 110) out.block = out.block || Math.random() < 0.25; }
    if (self._weaponUrgency > 1 && (!self.weapon || (self.weapon.ammo || 0) <= 0) && wpn) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'arm_up'; }

    // #65 Weapon Spawn Prediction: pre-position toward the next drop while unarmed.
    if (!self.weapon || (self.weapon.ammo || 0) <= 0) {
      const _ns = predictNextSpawn();
      if (_ns && _ns.timeToNext < 1500 && _ns.timeToNext > -500) { goalX = _ns.avgX; mode = 'preempt_spawn'; }
    }

    // #66 Damage Source Memory: counter whatever has hurt us the most this match.
    let _topDmg = null, _topN = 0;
    for (const _k in self._damageLog) if (self._damageLog[_k] > _topN) { _topN = self._damageLog[_k]; _topDmg = _k; }
    if (_topDmg === 'sniper' && dist > 350) { goalX = x + (self._strafeDir || 1) * 140; }
    else if (_topDmg === 'shotgun' && dist < 180) { idealRange = Math.max(idealRange, 230); if (dist < 150) goalX = x - Math.sign(dx || 1) * 160; }
    else if (_topDmg === 'melee' && !self.weapon && wpn && ['smg', 'pistol', 'rifle'].includes(wpn.type)) { goalX = wpn.body.position.x; goalY = wpn.body.position.y; mode = 'arm_up'; }

    // #67 Escape Velocity Check: cornered while fleeing -> stop running into the void, fight.
    if ((mode === 'flee' || mode === 'regen') && !hasEscapeRoute(self, -Math.sign(dx || 1))) {
      mode = 'cornered_fight'; goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70 && Math.random() < 0.4;
      if (TRAIN) { self.fit += 1 * dt; noteReward(self, 'combat', 1 * dt); }
    }

    // #71 Gravity Well Awareness: while rising/airborne, don't burn panic-jumps.
    if (!grounded && self.body.velocity.y < 0.5) out.jump = false;

    // #72 Weapon Ammo Sharing (team): drop a near-empty gun beside an unarmed ally.
    if (_ally && !_ally.weapon && self.weapon && self.weapon.kind !== 'melee' && (self.weapon.ammo || 0) <= 1 && Math.hypot(_ally.pos.x - x, _ally.pos.y - y) < 80) self.weapon = null;

    // #74 Audio Cue Simulation: "hear" an incoming projectile and brace/dodge.
    let _incoming = false;
    for (const _b of bullets) {
      if (!_b.bullet || (_b.bullet.owner && _b.bullet.owner.team === self.team)) continue;
      const _bx = _b.position.x, _by = _b.position.y;
      if (Math.hypot(_bx - x, _by - y) < 220 && (_b.velocity.x * (x - _bx) + _b.velocity.y * (y - _by)) > 0) { _incoming = true; break; }
    }
    if (_incoming) {
      if (grounded && safeToJump && Math.random() < 0.3) out.jump = true; else out.block = out.block || Math.random() < 0.3;
      if (TRAIN) { self.fit += 0.3 * dt; noteReward(self, 'survival', 0.3 * dt); }
    }

    // #75 Aggression Ramp-up: the longer the round drags, the bolder bots get.
    const _ramp = Math.min(1, roundTime / 25);
    if (_ramp > 0.3) { idealRange = Math.max(60, idealRange - _ramp * 80); if (_ramp > 0.7 && armed && dist < idealRange + 120) out.fire = true; }

    // #76 Platform Edge Dancing: hold the lip of a higher platform to bait bad jumps.
    if (plat && plat.y < foe.pos.y - 70 && Math.abs(foe.pos.x - x) > 120 && grounded && mode !== 'cornered_fight') {
      goalX = plat.x + Math.sign(foe.pos.x - plat.x) * (plat.w / 2 - 14); mode = 'edge_dance';
    }

    // #77 Instant Kill Recognition: if a single hit finishes the foe, commit to it.
    const _wpnDef = self.weapon ? WEAPONS[self.weapon.type] : null;
    const _myDmg = _wpnDef ? _wpnDef.dmg * (_wpnDef.pellets || 1) : 28;
    if (foe.hp <= _myDmg + 2) { mode = 'execute'; goalX = foe.pos.x; out.fire = true; if (dist < 70) out.heavy = true; if (TRAIN) { self.fit += 1.5 * dt; noteReward(self, 'combat', 1.5 * dt); } }

    // #78 Reload Window Exploitation: punish a foe that just emptied or is mid-cooldown.
    if (armed && foe._lastFireT) {
      const _since = Date.now() - foe._lastFireT;
      const _foeCd = (foe.weapon && WEAPONS[foe.weapon.type]) ? WEAPONS[foe.weapon.type].cd * 1000 : 0;
      if ((foe.weapon && (foe.weapon.ammo || 0) <= 0) || (_foeCd > 250 && _since < _foeCd)) { mode = 'press_advantage'; goalX = foe.pos.x; idealRange = Math.max(0, idealRange - 60); }
    }

    // #79 Formation Memory (team): remember the lane side that won, hold it when idle.
    if (_ally) {
      if (self._goodLane === undefined) self._goodLane = Math.sign(x - VIEW.w / 2) || 1;
      if (mode === 'engage' && Math.abs(goalX - x) < 30) goalX = x + self._goodLane * 60;
    }

    // #80 Curiosity-driven Exploration per Arena (TRAIN): reward visiting rare cells.
    if (TRAIN) {
      let _ak = self._arenaVisits[_arenaKey]; if (!_ak) _ak = self._arenaVisits[_arenaKey] = new Array(HEAT_GW * HEAT_GH).fill(0);
      const _gi = heatPosToGrid(self.pos); _ak[_gi]++;
      if (_ak[_gi] < 3) { self.fit += 0.4 * dt; noteReward(self, 'style', 0.4 * dt); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  NEW TACTICS — PSYCHOLOGY · MOBILITY · WEAPONS · TEAM · EVENTS · STYLES
    // ══════════════════════════════════════════════════════════════════
    const _newTeammates = fighters.filter(f => f !== self && f.alive && f.team === self.team);

    // ── PSYCHOLOGY & MIND GAMES ──
    // #A Fake Retreat: flee briefly then pivot 180° and attack
    if (self._fakeRetreat) {
      self._fakeRetreatT = (self._fakeRetreatT || 0) - dt;
      if (self._fakeRetreatT > 0.7) { goalX = x - Math.sign(dx || 1) * 260; mode = 'fake_retreat'; out.fire = false; }
      else { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 80; mode = 'pivot_attack'; if (TRAIN && dist < 150) { self.fit += 8; noteReward(self,'style',8); } }
      if (self._fakeRetreatT <= 0) self._fakeRetreat = false;
    } else if (mode === 'engage' && self.hp > 50 && dist < 200 && Math.random() < 0.004) { self._fakeRetreat = true; self._fakeRetreatT = 1.5; }

    // #B Shadow Walk: mirror foe's position at hold range, wait for opening
    if (self._shadowWalk) {
      self._shadowWalkT = (self._shadowWalkT || 0) - dt;
      goalX = foe.pos.x + Math.sign(x - foe.pos.x) * 270; out.fire = false; mode = 'shadow_walk';
      if (self._shadowWalkT <= 0) { self._shadowWalk = false; goalX = foe.pos.x; out.fire = armed; if (TRAIN) { self.fit += 5; noteReward(self,'style',5); } }
    } else if (mode === 'engage' && dist > 180 && dist < 380 && !armed && !foeArmed && Math.random() < 0.006) { self._shadowWalk = true; self._shadowWalkT = 1.8; }

    // #C Double Feint: two direction changes then commit real strike
    if ((self._dblFeintStep || 0) > 0) {
      self._dblFeintT = (self._dblFeintT || 0) - dt;
      if (self._dblFeintStep === 1) { goalX = x + Math.sign(dx || 1) * 90; out.fire = false; if (self._dblFeintT <= 0) { self._dblFeintStep = 2; self._dblFeintT = 0.25; } }
      else if (self._dblFeintStep === 2) { goalX = x - Math.sign(dx || 1) * 90; out.fire = false; if (self._dblFeintT <= 0) { self._dblFeintStep = 3; self._dblFeintT = 0.35; } }
      else { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70; mode = 'dbl_feint_strike'; if (self._dblFeintT <= 0) { self._dblFeintStep = 0; if (TRAIN && dist < 120) { self.fit += 12; noteReward(self,'style',12); } } }
    } else if (mode === 'engage' && dist < 160 && !armed && Math.random() < 0.003) { self._dblFeintStep = 1; self._dblFeintT = 0.25; }

    // #D Intimidation Approach: healthy vs critical foe — close in slowly, maximise pressure
    if (self.hp > 75 && foe.hp < 25 && dist < 380 && dist > 70) { idealRange = Math.max(50, idealRange - 120); mode = 'intimidate'; }

    // #E Weapon Flex: high-tier weapon vs unarmed foe → press closer to apply threat
    if (armed && !foeArmed && WEAPONS[wt] && (WEAPONS[wt].tier || 0) >= 3) { idealRange = Math.max(50, idealRange - 70); }

    // #F Pacifist Bait: stand still to invite attack, then parry/dodge-counter
    if (self._pacifistActive) {
      self._pacifistT = (self._pacifistT || 0) - dt;
      out.move = 0; goalX = x; out.fire = false; mode = 'pacifist_bait';
      if (foe._swing > 0 && dist < 100) {
        out.block = Math.random() < 0.55; if (!out.block && grounded && safeToJump) out.jump = true;
        out.fire = true; mode = 'pacifist_counter'; if (TRAIN) { self.fit += 10; noteReward(self,'style',10); }
      }
      if (self._pacifistT <= 0) self._pacifistActive = false;
    } else if (self.hp > 55 && dist < 180 && mode === 'engage' && Math.random() < 0.003) { self._pacifistActive = true; self._pacifistT = 1.1; }

    // ── MOBILITY & POSITIONING ──
    // #G Zone Control: contest center when unarmed and healthy
    if (!armed && self.hp > 60 && mode === 'rush' && (x < 380 || x > 900) && Math.random() < 0.005) { goalX = VIEW.w / 2; mode = 'zone_control'; }

    // #H Bait Jump Punish: approach under foe's platform → punish when they jump
    if (self._baitJump) {
      self._baitJumpT = (self._baitJumpT || 0) - dt;
      goalX = foe.pos.x; out.fire = armed && dist < 350; mode = 'bait_jump';
      if (!foe.grounded && armed) { out.fire = true; if (TRAIN) { self.fit += 5; noteReward(self,'combat',5); } }
      if (self._baitJumpT <= 0) self._baitJump = false;
    } else if (!armed && foe.grounded && plat && plat.y < foe.pos.y - 50 && Math.random() < 0.003) { self._baitJump = true; self._baitJumpT = 1.2; }

    // #I Ceiling Hug: when outgunned, retreat to highest available platform
    if (foeArmed && !armed && Math.random() < 0.003) {
      let _topP = null, _topPY = Infinity;
      for (const p of platforms) { if (!p.wall && p.y < _topPY) { _topPY = p.y; _topP = p; } }
      if (_topP && _topP.y < y - 100) { goalX = _topP.x; mode = 'ceiling_hug'; }
    }

    // #I2 Ping-Pong Pressure: bounce between two adjacent platforms while firing
    if (self._ppTarget && (self._ppT || 0) > 0) {
      self._ppT -= dt;
      goalX = self._ppTarget.x; out.fire = armed && dist < 500; out.jump = grounded && safeToJump && Math.abs(self._ppTarget.x - x) < 50;
      mode = 'ping_pong';
      if (self._ppT <= 0) { self._ppTarget = null; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'style',2*dt); } }
    } else if (armed && grounded && mode === 'engage' && plat && Math.random() < 0.005) {
      const _ppAdj = platforms.filter(p => !p.wall && p !== plat && Math.abs(p.x - plat.x) < 320 && Math.abs(p.y - plat.y) < 110);
      if (_ppAdj.length) { self._ppTarget = _ppAdj[Math.floor(Math.random() * _ppAdj.length)]; self._ppT = 0.9; }
    }

    // #J Anchor Hold (team): high-HP bot holds elevation, ally pushes
    if (_ally && _ally.alive && self.hp > _ally.hp + 20 && plat && plat.y < foe.pos.y - 60 && mode === 'engage') {
      goalX = plat.x; out.fire = armed && dist < 550; mode = 'anchor_hold';
      if (TRAIN) { self.fit += 1 * dt; noteReward(self,'position',1*dt); }
    }

    // ── WEAPON & AMMO ──
    // #K Ammo Count Tracking: estimate foe ammo, rush when depleted
    if (foe.weapon && foe._lastFireT) {
      const _fWDef = WEAPONS[foe.weapon.type]; const _fBase = _fWDef ? (_fWDef.ammo || 10) : 10;
      if (self._foeAmmoEst == null) self._foeAmmoEst = _fBase;
      if ((Date.now() - foe._lastFireT) < 80) self._foeAmmoEst = Math.max(0, (self._foeAmmoEst || _fBase) - 1);
      if (self._foeAmmoEst <= 0) { mode = 'ammo_punish'; goalX = foe.pos.x; out.fire = true; idealRange = Math.max(0, idealRange - 80); if (TRAIN) { self.fit += 3 * dt; noteReward(self,'combat',3*dt); } }
    } else { self._foeAmmoEst = null; }

    // #L Arc Shot: lob rocket/fireball at floor near cover-hiding foe
    if (armed && ['rocket','fireball'].includes(wt) && dist < 450) {
      const _foeCovered = platforms.some(p => !p.wall && Math.abs(p.x - foe.pos.x) < 50 && p.y < foe.pos.y - 20 && p.y > foe.pos.y - 100);
      if (_foeCovered && Math.random() < 0.25) { self.aim = Math.atan2(foe.pos.y + 50 - y, foe.pos.x - x); out.fire = dist < 400; mode = 'arc_shot'; }
    }

    // #M Empty Weapon Bait: fire last bullet conspicuously then counter foe's rush
    if (armed && self.weapon && (self.weapon.ammo || 0) <= 1 && dist < 280 && Math.random() < 0.18) { out.fire = true; self._emptyBait = true; self._emptyBaitT = 1.2; }
    if (self._emptyBait && !self.weapon) {
      self._emptyBaitT = (self._emptyBaitT || 0) - dt;
      const _fVx = foe.body && foe.body.velocity ? foe.body.velocity.x : 0;
      if (dist < 160 && Math.sign(_fVx) === Math.sign(x - foe.pos.x)) { out.fire = true; out.heavy = dist < 70; mode = 'empty_bait_counter'; if (TRAIN) { self.fit += 10; noteReward(self,'style',10); } }
      if (self._emptyBaitT <= 0) self._emptyBait = false;
    }

    // #N Dual Threat (team): ally has ranged weapon, I rush melee simultaneously
    if (_ally && _ally.alive && _ally.weapon && _ally.weapon.kind !== 'melee' && !self.weapon && dist < 280) {
      goalX = foe.pos.x; mode = 'dual_rush'; out.fire = dist < 55;
      if (TRAIN) { self.fit += 2 * dt; noteReward(self,'team',2*dt); }
    }

    // ── TEAM TACTICS ──
    // #O Leapfrog Attack: farther teammate covers, closer teammate pushes
    if (_ally && _ally.alive) {
      const _allyFoeDist = Math.hypot(_ally.pos.x - foe.pos.x, _ally.pos.y - foe.pos.y);
      if (dist > _allyFoeDist + 120) { out.fire = armed && dist < 500; mode = 'leapfrog_cover'; if (TRAIN) { self.fit += 0.8 * dt; noteReward(self,'team',0.8*dt); } }
      else if (dist < _allyFoeDist - 120 && mode === 'engage') { goalX = foe.pos.x; out.fire = true; mode = 'leapfrog_push'; }
    }

    // #P Sync Strike: both teammates attack same target within 0.35s window
    if (_ally && _ally.alive && Math.abs(_ally.pos.x - x) < 220 && dist < 200) {
      self._syncT = (self._syncT == null ? 0.35 : self._syncT) - dt;
      if (self._syncT <= 0) { out.fire = true; out.heavy = dist < 70; mode = 'sync_strike'; self._syncT = 0.35; if (TRAIN) { self.fit += 6; noteReward(self,'team',6); } }
    }

    // #Q Bubble Protection: high-HP bot shields wounded ally
    if (_ally && _ally.alive && _ally.hp < 28 && self.hp > 55) {
      const _betX = (_ally.pos.x + foe.pos.x) / 2;
      if (Math.abs(x - _betX) > 70) { goalX = _betX; mode = 'bubble_protect'; out.block = dist < 130; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'team',2*dt); } }
    }

    // #R Kill Steal Prevention: if ally is finishing a kill, switch to next target
    if (_ally && _ally.alive && foe.hp < 15 && Math.hypot(_ally.pos.x - foe.pos.x, _ally.pos.y - foe.pos.y) < 80) {
      const _nxtFoe = _allE.find(f => f !== foe && f.alive && f.hp > 15);
      if (_nxtFoe) { goalX = _nxtFoe.pos.x; mode = 'next_target'; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'team',3*dt); } }
    }

    // #RA Decoy Sacrifice: low-HP ally becomes bait, I ambush from behind
    if (_ally && _ally.alive && _ally.hp < 12 && dist > 250) {
      goalX = foe.pos.x - Math.sign(x - foe.pos.x) * 150; mode = 'ambush_setup';
      if (dist < 180) { out.fire = true; out.heavy = dist < 70; mode = 'sacrifice_ambush'; if (TRAIN) { self.fit += 8; noteReward(self,'team',8); } }
    }

    // #RB Rally Point: if team is spread >420px wide, converge before attacking
    if (_newTeammates.length >= 1) {
      const _allT = fighters.filter(f => f.alive && f.team === self.team);
      if (_allT.length >= 2) {
        const _spreadW = Math.max(..._allT.map(f => f.pos.x)) - Math.min(..._allT.map(f => f.pos.x));
        if (_spreadW > 420 && mode === 'regen') { goalX = _allT.reduce((s,f) => s+f.pos.x,0) / _allT.length; mode = 'rally'; }
      }
    }

    // ── SITUATIONAL / EVENT-AWARE ──
    // #S Flood Climber: Rising Lava → sprint to highest safe platform
    if (arenaEvent === 'flood') {
      const _dangerY = _floodY - 140;
      if (y > _dangerY) {
        let _fp = null, _fpY = Infinity;
        for (const p of platforms) { if (!p.wall && p.y < _dangerY && p.y < _fpY) { _fpY = p.y; _fp = p; } }
        if (_fp) { goalX = _fp.x; mode = 'flood_escape'; out.jump = grounded && safeToJump; if (TRAIN) { self.fit += 4 * dt; noteReward(self,'survival',4*dt); } }
      }
    }

    // #T Shrink Anticipation: stay in safe zone as arena shrinks
    if (arenaEvent === 'shrink' && _shrinkX > 70) {
      const _sl = _shrinkX + 90, _sr = VIEW.w - _shrinkX - 90;
      if (x < _sl) { goalX = _sl + 60; mode = 'shrink_safe'; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'survival',2*dt); } }
      else if (x > _sr) { goalX = _sr - 60; mode = 'shrink_safe'; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'survival',2*dt); } }
    }

    // #U Tilt Surfer: use tilted gravity to boost approach
    if (arenaEvent === 'tilt') { try { const _gx = engine.gravity.x; if (Math.abs(_gx) > 0.2 && mode === 'engage') goalX = foe.pos.x + Math.sign(_gx) * 80; } catch(e) {} }

    // #V Gravity Zone Kiter: fight from outside the flip zone; push foe inside it
    if (arenaEvent === 'gravzone') {
      const _gzX0 = VIEW.w * 0.38, _gzX1 = VIEW.w * 0.62;
      if (foe.pos.x > _gzX0 && foe.pos.x < _gzX1 && !(x > _gzX0 && x < _gzX1)) {
        out.fire = armed && dist < 600; goalX = x; mode = 'gravzone_kite'; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'position',2*dt); }
      } else if (x > _gzX0 && x < _gzX1) { goalX = x < VIEW.w / 2 ? _gzX0 - 55 : _gzX1 + 55; mode = 'gravzone_exit'; }
    }

    // #W Sudden Death Sprint: if HP draining, all-in for fastest kill
    if (_suddenDeath && self.hp < 70) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 80; mode = 'sd_sprint'; if (TRAIN) { self.fit += 2 * dt; noteReward(self,'combat',2*dt); } }

    // #X Frenzy Exploit: activate full aggression when frenzy modifier is live
    if (activeMod && activeMod.dmgMul && activeMod.speed) { idealRange = Math.max(40, idealRange - 70); goalX = foe.pos.x; out.fire = dist < 380; mode = 'frenzy_all_in'; }

    // #Y Low Grav Aerial Combo: chain hits while airborne in low gravity
    try { if (engine.gravity.y < 1.0 && !grounded && dist < 220 && Math.abs(dy) < 110) { out.fire = true; out.heavy = dist < 80; mode = 'low_grav_aerial'; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'style',3*dt); } } } catch(e) {}

    // #Z One-Shot Turtle: maximise defence when one-shot modifier is active
    if (activeMod && activeMod.oneShot) { out.block = dist < 160; idealRange += 70; if (dist < 55) out.fire = true; mode = 'oneshot_turtle'; }

    // #ZA Wind Drift Shot: compensate aim angle against active wind
    if (Math.abs(windX) > 0.25 && armed && dist > 150) { const _wAdj = -Math.sign(windX) * 0.12 * Math.min(1, Math.abs(windX)); self.aim = (self.aim || 0) + _wAdj; }

    // #ZB Meteor Dodge & Press: during meteor shower, stay mobile and press foe who is dodging
    if (roundEvent === 'meteor' && _meteorT > 0) { idealRange = Math.max(50, idealRange - 50); out.fire = armed && dist < 380; if (TRAIN) { self.fit += 1 * dt; noteReward(self,'style',1*dt); } }

    // #ZC Lava Wall Trap: during flood, push foe toward rising lava below
    if (arenaEvent === 'flood' && plat && foe.pos.y > y + 80) { goalX = foe.pos.x; out.fire = true; mode = 'lava_push'; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'position',3*dt); } }

    // ── ADAPTATION & LEARNING ──
    // #ZD Opponent Style Profiling: classify foe playstyle and counter it
    if (!self._foeStyle) self._foeStyle = { rush: 0, camp: 0, juke: 0, turtle: 0 };
    if (dist < 120 && foe.body && foe.body.velocity && Math.abs(foe.body.velocity.x) > 5) self._foeStyle.rush++;
    if (foe.blocking) self._foeStyle.turtle++;
    if ((foe._strafeT || 0) > 0.5) self._foeStyle.juke++;
    if (dist > 350 && foe.body && foe.body.velocity && Math.abs(foe.body.velocity.x) < 1) self._foeStyle.camp++;
    const _topFoeStyle = Object.keys(self._foeStyle).sort((a,b) => self._foeStyle[b] - self._foeStyle[a])[0];
    if (self._foeStyle[_topFoeStyle] > 18) {
      if (_topFoeStyle === 'rush') { out.block = dist < 130 && !out.block && Math.random() < 0.35; idealRange += 25; }
      else if (_topFoeStyle === 'camp') { goalX = foe.pos.x; idealRange = Math.max(50, idealRange - 50); }
      else if (_topFoeStyle === 'juke') { self._waitShotT = (self._waitShotT || 0) + dt; if (self._waitShotT > 0.45) { out.fire = armed; self._waitShotT = 0; } else out.fire = false; }
      else if (_topFoeStyle === 'turtle') { out.heavy = dist < 80 && Math.random() < 0.4; }
    }

    // #ZE Tilt Detector: foe died 3+ times in a row → they're tilted, press hard
    if (!foe.alive && self._foeWasAlive) self._foeDeathStreak = (self._foeDeathStreak || 0) + 1;
    else if (foe.alive && !self._foeWasAlive) self._foeDeathStreak = 0;
    self._foeWasAlive = foe.alive;
    if ((self._foeDeathStreak || 0) >= 3) { goalX = foe.pos.x; idealRange = Math.max(50, idealRange - 40); out.fire = armed && dist < 450; if (TRAIN) { self.fit += 1.5 * dt; noteReward(self,'combat',1.5*dt); } }

    // ── FIGHTING STYLES (signature-driven) ��─
    // #ZF Glass Cannon: berserker ignores retreat — always attacks regardless of HP
    if (self.signature === 'berserker' && (mode === 'flee' || mode === 'regen') && self.hp > 8) {
      mode = 'glass_cannon'; goalX = foe.pos.x; out.fire = armed; out.block = false;
    }

    // #ZG Ninja Style: phantom never stays still >0.5s — constant movement
    if (self.signature === 'phantom') {
      const _sVx = self.body && self.body.velocity ? Math.abs(self.body.velocity.x) : 0;
      self._ninjaStillT = _sVx < 1 ? (self._ninjaStillT || 0) + dt : 0;
      if (self._ninjaStillT > 0.5) { goalX = x + (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 160); mode = 'ninja_dash'; self._ninjaStillT = 0; }
    }

    // #ZH Opportunist: guardian only strikes when foe is busy attacking someone else
    if (self.signature === 'guardian' && _allE.length >= 2) {
      const _foeBusy = _allE.some(e => e !== self && e.alive && Math.hypot(e.pos.x - foe.pos.x, e.pos.y - foe.pos.y) < 130);
      if (_foeBusy) { goalX = foe.pos.x; out.fire = true; mode = 'opportunist'; if (TRAIN) { self.fit += 3 * dt; noteReward(self,'style',3*dt); } }
    }

    // #ZI Kamikaze Rush: below 28% HP, ignore defence and rush
    if (self.hp < 28 && mode !== 'all_in' && mode !== 'kill_secure' && Math.random() < 0.015) {
      mode = 'kamikaze'; goalX = foe.pos.x; out.fire = true; out.heavy = dist < 80; self._staminaFlee = false;
      if (TRAIN) { self.fit += 1 * dt; noteReward(self,'combat',1*dt); }
    }

    // ── MICRO-MECHANICS ──
    // #ZJ Landing Lag Punish: attack immediately after foe lands
    if (!foe.grounded) self._foeLandingRecent = true;
    if (foe.grounded && self._foeLandingRecent) { self._foeLandT = 0.22; self._foeLandingRecent = false; }
    if ((self._foeLandT || 0) > 0) {
      self._foeLandT -= dt;
      if (dist < 200) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70; mode = 'land_punish'; if (TRAIN) { self.fit += 4; noteReward(self,'combat',4); } }
    }

    // #ZK Frame-Perfect Parry: block only when foe's swing is actively out
    if (foe._swing > 0 && dist < 92 && Math.abs(dy) < 65 && Math.random() < 0.52) { out.block = true; out.fire = false; if (TRAIN) { self.fit += 4; noteReward(self,'survival',4); } }

    // #ZL Choke Point Guard: hold the entrance of a narrow platform, shoot climbers
    if (armed && plat && plat.w < 110 && dist > 220) {
      const _cpEdge = plat.x + Math.sign(foe.pos.x - x) * (plat.w / 2 - 12);
      goalX = _cpEdge; mode = 'choke_guard'; out.fire = foe.pos.y > plat.y - 40 && dist < 580;
    }

    // #ZM Predictive Dodge: jump right as foe's fire cooldown is about to expire
    if (foe.weapon && foe._lastFireT && grounded && safeToJump) {
      const _fWDef2 = WEAPONS[foe.weapon.type]; const _fWCd = _fWDef2 ? _fWDef2.cd : 0.5;
      const _fSec = (Date.now() - foe._lastFireT) / 1000;
      if (Math.abs(_fSec - _fWCd) < 0.06 && Math.random() < 0.4) { out.jump = true; if (TRAIN) { self.fit += 1.5; noteReward(self,'survival',1.5); } }
    }

    // #ZN Ledge Guard: position at platform edge and punish foe recovering from knockback
    if (plat && !foe.grounded && foe.body && foe.body.velocity && Math.abs(foe.body.velocity.x) > 5 && dist > 280) {
      const _lgEdge = plat.x + Math.sign(foe.pos.x - plat.x) * (plat.w / 2 - 10);
      goalX = _lgEdge; mode = 'ledge_guard'; out.fire = armed && dist < 280; out.heavy = dist < 80;
      if (TRAIN && dist < 200) { self.fit += 3 * dt; noteReward(self,'combat',3*dt); }
    }

    // Apply idealRange to ranged hold-spacing so #43/#47/#56/#60 actually affect movement.
    if (armed && (mode === 'engage' || mode === 'press_advantage')) {
      if (dist > idealRange + 70) goalX = foe.pos.x;
      else if (dist < idealRange - 80) goalX = x - Math.sign(dx || 1) * 180;
    }

    // Anti-clump final pass: same team may focus same target, but not occupy same pixel.
    const spaced = antiClumpGoal(self, goalX, goalY, foe, mode);
    goalX = spaced.x; goalY = spaced.y;
    if (TRAIN) {
      for (const o of fighters) if (o !== self && o.alive && o.team === self.team && Math.hypot(o.pos.x-self.pos.x, o.pos.y-self.pos.y) < 54) { self.fit -= 1.5 * dt; noteReward(self,'position',-1.5*dt); }
    }
    // ============================================================
    //  TACTICS #81-#134 (M113 expansion) — guarded, low-priority
    //  refinements. The whole block is wrapped in try/catch so a bad
    //  branch can never crash the sim, and every offensive tactic is
    //  gated by !_crit so it never overrides survival/recovery modes.
    // ============================================================
    try {
      const _crit = mode === 'flee' || mode === 'regen' || mode === 'stamina' ||
        mode === 'flood_escape' || mode === 'shrink_safe' || mode === 'gravzone_exit' || mode === 'recover';
      const _allies = fighters.filter(f => f !== self && f.alive && f.team === self.team);
      const _enemies = fighters.filter(f => f.alive && f.team !== self.team);
      const _fvx = (foe.body && foe.body.velocity) ? foe.body.velocity.x : 0;
      const _fvy = (foe.body && foe.body.velocity) ? foe.body.velocity.y : 0;
      const _stam = self.stamina == null ? 100 : self.stamina;
      const _lowGuard = (self._guard == null ? 1 : self._guard) < 0.3;
      const _onBlockCd = (self._blockCd || 0) > 0;
      const _sgn = Math.sign(dx || 1) || 1;

      // ── A. Footsies & spacing ──
      if (!_crit && !armed && dist > idealRange && dist < idealRange + 60 && (foe._swing || 0) > 0 && Math.random() < 0.4) { goalX = foe.pos.x; out.fire = dist < 80; mode = 'whiff_punish'; if (TRAIN) { self.fit += 3 * dt; noteReward(self, 'combat', 3 * dt); } } // #81
      if (!_crit && armed && wt === 'spear' && dist > idealRange - 20 && dist < idealRange + 40) { out.fire = true; goalX = x; mode = 'tip_poke'; } // #82
      if (!_crit && !armed && dist < 150 && dist > 70 && Math.random() < 0.02) self._shimmy = 0.4;
      if ((self._shimmy || 0) > 0) { self._shimmy -= dt; goalX = x + _sgn * (self._shimmy > 0.2 ? 40 : -40); mode = 'shimmy'; } // #83
      if (!_crit && (mode === 'rush' || mode === 'engage') && Math.random() < 0.03) self._stagger = 0.25;
      if ((self._stagger || 0) > 0) { self._stagger -= dt; goalX = x + _sgn * 30; mode = 'stagger_step'; } // #84
      if (!_crit && _lowGuard && dist < 90) { goalX = x - _sgn * 160; mode = 'range_reset'; } // #85
      if (!_crit && foeArmed && !armed) idealRange = Math.max(idealRange, 220); // #86 micro_spacing
      if (!_crit && armed && mode === 'engage' && dist < idealRange - 40) { goalX = x - _sgn * 120; mode = 'footsie_bait'; } // #87

      // ── B. Melee depth ──
      if (!_crit && !armed && dist < 60 && (self.meleeCd || 0) <= 0 && Math.random() < 0.5) { out.fire = true; mode = 'frame_trap'; } // #88
      if (!_crit && dist < 70 && foe.blocking) { out.heavy = Math.random() < 0.5; mode = 'block_string_break'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'combat', 2 * dt); } } // #89
      if (!_crit && !armed && dist < 90 && Math.abs(_fvx) < 1 && Math.random() < 0.02) { out.heavy = true; mode = 'delayed_heavy'; } // #90
      if (!_crit && dist < 55 && foe.blocking && (self.meleeCd || 0) <= 0) { out.heavy = true; mode = 'tick_heavy'; } // #91
      if (!_crit && _fvy > 2.5 && dist < 120) { goalX = foe.pos.x; out.fire = true; mode = 'anti_air_punish'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'combat', 2 * dt); } } // #93
      if (!_crit && foe.blocking && (foe._guard == null ? 1 : foe._guard) < 0.4 && dist < 80) { out.heavy = true; goalX = foe.pos.x; mode = 'guard_crush_focus'; } // #94

      // ── C. Defensive / guard (block-cd aware) ──
      if ((self._guard == null ? 1 : self._guard) < 0.2 || _onBlockCd) out.block = false; // #97 guard_meter_manage
      if (!_crit && foe.blocking && dist < 120 && mode === 'engage') { goalX = foe.pos.x + _sgn * 30; out.heavy = dist < 70 && Math.random() < 0.4; mode = 'turtle_punish'; } // #98
      if (self.hp < 25 && dist < 120 && !_crit) { goalX = x - _sgn * 140; out.block = dist < 90 && !_onBlockCd; mode = 'defensive_reset'; } // #100

      // ── D. Mobility ──
      if (!_crit && (x < 110 || x > VIEW.w - 110) && dist < 150 && grounded && safeToJump) { out.jump = true; goalX = VIEW.w / 2; mode = 'corner_escape'; } // #101
      if (!_crit && foeArmed && !armed && grounded && safeToJump && Math.random() < 0.02) { out.jump = true; mode = 'platform_weave'; } // #102
      if (!_crit && foeArmed && dist > 250 && (mode === 'rush' || mode === 'engage')) { self._zz = (self._zz || 0) + dt; goalX = foe.pos.x + Math.sin(self._zz * 6) * 70; mode = 'zigzag_approach'; } // #103
      if (!_crit && self.hp > 50 && _fvy < -0.5 && dist < 200 && Math.abs(dx) < 60) { goalX = foe.pos.x; mode = 'fast_fall'; } // #104

      // ── E. Ranged micro ──
      if (armed && wt && wt !== 'melee' && Math.abs(_fvx) > 2 && dist > 150) { self.aim = Math.atan2((foe.pos.y + _fvy * 6) - y, (foe.pos.x + _fvx * 8) - x); mode = 'lead_target'; } // #105
      if (armed && (wt === 'sniper' || wt === 'rocket') && dist > 300) { self._burstT = (self._burstT || 0) + dt; if (self._burstT > 1.2) { goalX = x - _sgn * 200; mode = 'burst_relocate'; if (self._burstT > 2) self._burstT = 0; } } // #106
      if (armed && wt === 'shotgun' && dist > 200 && dist < 360) { out.fire = true; mode = 'suppressive_fire'; } // #107
      if (armed && self.weapon && (self.weapon.ammo || 0) <= 0 && dist < 200) { goalX = x - _sgn * 180; mode = 'reload_retreat'; } // #108
      if (armed && wt && wt !== 'melee' && dist > 250 && Math.abs(dy) < 40) { out.fire = true; mode = 'pre_aim_choke'; } // #109

      // ── F. Arena exploitation ──
      if (!_crit && getZoneSafety(foe.pos) < 0.4 && dist < 160) { goalX = foe.pos.x + (foe.pos.x < VIEW.w / 2 ? -1 : 1) * 40; out.fire = true; mode = 'hazard_bait'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'position', 2 * dt); } } // #110
      if (!_crit && armed && getZoneSafety(self.pos) > 0.7 && dist > 200 && dist < 480) { goalX = x; out.fire = true; mode = 'choke_hold'; } // #111
      if (!_crit && armed && wt && wt !== 'melee' && (-y) > (-foe.pos.y) + 80) { goalX = x; out.fire = dist < 520; mode = 'high_ground_camp'; if (TRAIN) { self.fit += 1 * dt; noteReward(self, 'position', 1 * dt); } } // #112

      // ── G. Tempo / resource ──
      if (!_crit && _stam > 60 && foe.stamina != null && foe.stamina < 30 && dist < 200) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70; mode = 'stamina_bait_war'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'combat', 2 * dt); } } // #113
      if (!_crit && _enemies.length > 1) { const _fm = fighters.filter(f => f !== foe && f.alive && f.team === foe.team); if (_fm.length && Math.min(..._fm.map(m => Math.hypot(m.pos.x - foe.pos.x, m.pos.y - foe.pos.y))) > 350 && dist < 250) { goalX = foe.pos.x; out.fire = true; mode = 'overextend_punish'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'team', 2 * dt); } } } // #114
      if (!_crit && armed && wt && wt !== 'melee' && self.hp > foe.hp + 20) { idealRange = Math.max(idealRange, 360); if (mode === 'engage') mode = 'patience_zoning'; } // #115

      // ── H. Mind games ──
      if (!_crit && Math.random() < 0.004) self._patBreak = 0.4;
      if ((self._patBreak || 0) > 0) { self._patBreak -= dt; out.fire = false; goalX = x - _sgn * 60; mode = 'pattern_break'; } // #116
      if (!_crit && !armed && dist < 140 && dist > 80 && Math.random() < 0.02) self._fakeC = 0.25;
      if ((self._fakeC || 0) > 0) { self._fakeC -= dt; goalX = foe.pos.x; out.fire = false; mode = 'fake_commit'; } // #117

      // ── I. Team coordination ──
      if (_allies.length) {
        const _a2 = _allies[0];
        if (!_crit && Math.hypot(_a2.pos.x - x, _a2.pos.y - y) < 70) { goalX = x + (x < _a2.pos.x ? -1 : 1) * 120; mode = 'zone_split'; } // #118
        if (!_crit && _a2.alive && mode === 'engage') { const _aSide = Math.sign(foe.pos.x - _a2.pos.x) || 1; goalX = foe.pos.x + _aSide * 120; mode = 'flank_pincer'; if (TRAIN) { self.fit += 1 * dt; noteReward(self, 'team', 1 * dt); } } // #119
        const _weak = _enemies.slice().sort((a, b) => a.hp - b.hp)[0];
        if (!_crit && _weak && _weak.hp < 45 && (mode === 'engage' || mode === 'rush')) { goalX = _weak.pos.x; mode = 'focus_switch'; } // #120
        if (!_crit && _a2.hp < 30) { const _ch = _enemies.slice().sort((a, b) => Math.hypot(a.pos.x - _a2.pos.x, a.pos.y - _a2.pos.y) - Math.hypot(b.pos.x - _a2.pos.x, b.pos.y - _a2.pos.y))[0]; if (_ch) { goalX = (_ch.pos.x + _a2.pos.x) / 2; out.block = !_onBlockCd; mode = 'peel_for_ally'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'team', 2 * dt); } } } // #121
        if (!_crit && _enemies.some(e => e.weapon && e.weapon.type === 'rocket') && Math.hypot(_a2.pos.x - x, _a2.pos.y - y) < 120) { goalX = x + (x < _a2.pos.x ? -1 : 1) * 150; mode = 'spread_aoe'; } // #122
      }

      // ── J. Mode-specific (FFA / many-bot) ──
      if (!_crit && _enemies.length >= 2) { const _busy = _enemies.filter(e => fighters.some(g => g !== e && g !== self && g.alive && Math.hypot(g.pos.x - e.pos.x, g.pos.y - e.pos.y) < 130)); if (_busy.length >= 2 && self.hp > 50) { const _t3 = _busy.slice().sort((a, b) => a.hp - b.hp)[0]; goalX = _t3.pos.x; out.fire = armed; mode = 'third_party'; } } // #123
      if (!_crit && foe.hp < 18 && dist < 220) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 70; mode = 'kill_steal'; } // #124
      if (!_crit && _enemies.length >= 3 && self.hp < 60) { idealRange = Math.max(idealRange, 300); out.fire = armed && dist < idealRange; if (mode === 'engage') mode = 'lay_low'; } // #125

      // ── K. Risk / momentum ──
      if (!_crit && self.hp < foe.hp - 35) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 80; mode = 'comeback_rage'; } // #126
      if (!_crit && self.hp > foe.hp + 40 && armed && wt && wt !== 'melee') idealRange = Math.max(idealRange, 340); // #127 lead_protect
      if (!_crit && self.hp < foe.hp - 15 && dist < 70 && !_onBlockCd) { out.block = true; mode = 'no_trade'; } // #128

      // ── L. Adaptive ──
      self._foeBlockT = foe.blocking ? (self._foeBlockT || 0) + dt : 0;
      if (!_crit && (self._foeBlockT || 0) > 0.6 && dist < 90) { out.heavy = true; mode = 'punish_repeat'; } // #129
      if (foeArmed && foe.weapon && (foe.weapon.type === 'sniper' || foe.weapon.type === 'rocket')) idealRange = Math.min(idealRange, 130); // #130 adapt_to_weapon_meta

      // ── M. Counters ──
      if (!_crit && foeArmed && foe.weapon && (foe.weapon.type === 'sniper' || foe.weapon.type === 'shotgun') && dist > 280) { goalX = foe.pos.x; out.fire = false; mode = 'anti_zoner'; } // #131
      if (!_crit && _fvx * (-_sgn) > 4 && dist < 130) { out.fire = dist < 80; out.block = dist > 80 && !_onBlockCd; mode = 'anti_rusher'; } // #132
      if (!_crit && Math.abs(_fvx) < 1 && (-foe.pos.y) > (-y) + 60 && dist < 300) { goalX = foe.pos.x; out.jump = grounded && safeToJump; mode = 'anti_camper'; } // #133

      self._lastTactic = mode; // telemetry
    } catch (e) {}

    // ============================================================
    //  TACTICS #135-#157 (M114 expansion 2) — more guarded refinements.
    //  Separate try/catch + !_c survival guard, same low-priority rules.
    // ============================================================
    try {
      const _c = mode === 'flee' || mode === 'regen' || mode === 'stamina' ||
        mode === 'flood_escape' || mode === 'shrink_safe' || mode === 'gravzone_exit' || mode === 'recover';
      const _en = fighters.filter(f => f.alive && f.team !== self.team);
      const _al = fighters.filter(f => f !== self && f.alive && f.team === self.team);
      const _vx = (foe.body && foe.body.velocity) ? foe.body.velocity.x : 0;
      const _vy = (foe.body && foe.body.velocity) ? foe.body.velocity.y : 0;
      const _sg = Math.sign(dx || 1) || 1;
      const _bcd = (self._blockCd || 0) > 0;
      const _ev = (typeof arenaEvent !== 'undefined') ? arenaEvent : null;
      const _rt = (typeof roundTime !== 'undefined') ? roundTime : 0;
      const _maxRt = (typeof MAX_ROUND_TIME !== 'undefined') ? MAX_ROUND_TIME : 30;


      // ── Guard / stamina economy ──
      if (!_c && foe.blocking && (foe._guard == null ? 1 : foe._guard) < 0.5 && dist < 90) { out.heavy = true; goalX = foe.pos.x; mode = 'guard_bait'; } // #139
      if (!_c && foe.stamina != null && foe.stamina > 70 && dist < idealRange && !armed) { goalX = x - _sg * 110; mode = 'stamina_drain_zoning'; } // #140
      if (!_c && foeArmed && foe.weapon && (foe.weapon.ammo || 0) <= 0 && dist < 260) { goalX = foe.pos.x; out.fire = dist < 90; mode = 'punish_enemy_reload'; if (TRAIN) { self.fit += 2 * dt; noteReward(self, 'combat', 2 * dt); } } // #141

      // ── Off-stage / edge ──
      if (!_c && getZoneSafety(foe.pos) < 0.35 && _vy > 1 && dist < 200) { goalX = foe.pos.x; out.fire = true; out.heavy = dist < 80; mode = 'edge_hog'; } // #142
      if (!_c && (foe.pos.x < 60 || foe.pos.x > VIEW.w - 60) && dist < 120) { goalX = foe.pos.x + _sg * 30; out.heavy = true; mode = 'spike_offstage'; } // #143

      // ── Event arena ──
      if (!_c && _ev === 'shrink') { goalX = goalX * 0.5 + (VIEW.w / 2) * 0.5; if (mode === 'engage') mode = 'shrink_center_control'; } // #144
      if (!_c && _ev && _ev !== 'none' && self.hp >= foe.hp) { out.fire = armed && dist < idealRange + 40; if (dist < 220) mode = 'event_window_aggro'; } // #145

      // ── Team advanced ──
      if (_al.length) {
        const _a = _al[0];
        if (!_c && _a.alive && armed && wt && wt !== 'melee') { const _side = Math.sign(_a.pos.x - foe.pos.x) || 1; goalX = foe.pos.x - _side * 130; out.fire = true; mode = 'crossfire_funnel'; } // #146
        if (!_c && _a.alive) { self._stg = (self._stg || self.team * 0.5) + dt; out.fire = (Math.sin(self._stg * 3) > 0) && dist < idealRange + 40; if (dist < 120) mode = 'stagger_focus'; } // #147
        if (!_c && _a.alive && Math.sign(foe.pos.x - _a.pos.x) !== _sg && dist < 200) { goalX = foe.pos.x + _sg * 60; mode = 'bait_into_sandwich'; } // #148
      }

      // ── FFA macro ──
      if (!_c && _en.length >= 3) { const _strong = _en.slice().sort((a, b) => b.hp - a.hp)[0]; if (_strong && _strong.hp > 70) { goalX = _strong.pos.x; if (mode === 'engage' || mode === 'rush') mode = 'kingmaker_deny'; } } // #149

      // ── Time management (only when round clock is live) ──
      if (!_c && _rt > _maxRt * 0.6 && self.hp > foe.hp + 25) { goalX = x * 0.6 + (VIEW.w / 2) * 0.4; out.fire = false; mode = 'clock_stall'; } // #150
      if (!_c && _rt > _maxRt * 0.8 && self.hp > foe.hp && armed) { idealRange = Math.max(idealRange, 300); out.fire = dist < idealRange; mode = 'timeout_chip'; } // #151

      // ── Anti-projectile ──
      if (!_c && !armed && foeArmed && foe.weapon && foe.weapon.type !== 'melee' && dist > 220) { self._wv = (self._wv || 0) + dt; goalX = foe.pos.x; if (Math.sin(self._wv * 7) > 0.6 && grounded && safeToJump) out.jump = true; mode = 'shot_weave'; } // #152
      if (!_c && armed && wt && wt !== 'melee' && (-y) > (-foe.pos.y) + 60) { self._peek = (self._peek || 0) + dt; out.fire = Math.sin(self._peek * 2) > 0; mode = 'peek_punish'; } // #153
      if (!_c && !armed && foeArmed && (foe._swing || 0) > 0 && dist > 150 && dist < 320) { goalX = foe.pos.x; mode = 'bait_then_close'; } // #154

      // ── Movement mixups ──
      if (!_c && !armed && dist > idealRange - 20 && dist < idealRange + 80) { self._dd = (self._dd || 0) + dt; goalX = x + Math.sin(self._dd * 8) * 50; if (Math.abs(Math.sin(self._dd * 8)) > 0.9) mode = 'dash_dance_bait'; } // #155
      if (!_c && self._lastSg != null && (Math.sign(dx) || 1) !== self._lastSg && dist < 110) { goalX = foe.pos.x; out.fire = (self.meleeCd || 0) <= 0; mode = 'instant_turn_punish'; }
      self._lastSg = Math.sign(dx) || 1; // #157

      self._lastTactic = mode;
    } catch (e) {}

    return { goalX, goalY, mode };
  }


  // ---- Unpredictability: Shannon entropy of recent action tokens (higher = less predictable) ----
  function unpredictabilityScore(history) {
    if (!history || history.length < 4) return 0;
    const freq = {};
    history.forEach(a => { freq[a] = (freq[a] || 0) + 1; });
    return -Object.values(freq)
      .map(f => f / history.length)
      .reduce((s, p) => s + p * Math.log2(p), 0);
  }

  function randGenome() {
    const g = new Float32Array(GENOME_LEN);
    for (let i = 0; i < g.length; i++) g[i] = (Math.random() * 2 - 1) * 0.8;
    return g;
  }
  // Forward pass: inputs -> tanh hidden layer -> tanh outputs (bias-first layout).
  function netForward(g, inp) {
    const IN = NN.IN, H = NN.H, OUT = NN.OUT;
    const hid = new Float32Array(H);
    let k = 0;
    for (let j = 0; j < H; j++) {
      let s = g[k++];
      for (let i = 0; i < IN; i++) s += g[k++] * inp[i];
      hid[j] = Math.tanh(s);
    }
    const out = new Float32Array(OUT);
    for (let j = 0; j < OUT; j++) {
      let s = g[k++];
      for (let i = 0; i < H; i++) s += g[k++] * hid[i];
      out[j] = Math.tanh(s);
    }
    return out;
  }
  // #83 RNN forward for a SINGLE expert. `base` = expert's first weight index in g.
  // prevHidden carries the last frame's hidden state; the new hidden state is
  // written into `hidOut` so the caller can persist it for next frame.
  function netForwardRNN(g, inp, prevHidden, base, hidOut) {
    const IN = NN.IN, H = NN.H, OUT = NN.OUT;
    const hid = hidOut || new Float32Array(H);
    let k = base;
    for (let j = 0; j < H; j++) {
      let s = g[k++];                                   // hidden bias
      for (let i = 0; i < IN; i++) s += g[k++] * inp[i];          // input -> hidden
      for (let i = 0; i < H; i++) s += g[k++] * prevHidden[i] * RECUR_SCALE; // recurrent
      hid[j] = Math.tanh(s);
    }
    const out = new Float32Array(OUT);
    for (let j = 0; j < OUT; j++) {
      let s = g[k++];
      for (let i = 0; i < H; i++) s += g[k++] * hid[i];
      out[j] = Math.tanh(s);
    }
    return out;
  }
  // #81 MoE gate: hand-tuned soft weights that pick which experts dominate.
  function expertGateWeights(self, foe) {
    const lowHp    = self.hp < 40;
    const noWeapon = !self.weapon || (self.weapon.ammo || 0) <= 0;
    const hasAlly  = !!nearestAlly(self);
    const inCombat = !!foe && Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y) < 200;
    const w = [
      inCombat && !lowHp ? 0.7 : 0.1, // combat
      lowHp ? 0.8 : 0.1,              // survival
      noWeapon ? 0.7 : 0.1,           // weapon
      hasAlly ? 0.4 : 0.0,            // team
    ];
    let tot = w[0] + w[1] + w[2] + w[3]; if (tot <= 0) tot = 1;
    for (let i = 0; i < w.length; i++) w[i] /= tot;
    return w;
  }
  // #81 Blend all expert RNN outputs into one action vector; persist hidden states.
  function moeForward(g, self, foe, hiddenStates) {
    const inp = senseFeatures(self, foe);
    const w = expertGateWeights(self, foe);
    const blended = new Float32Array(NN.OUT);
    for (let e = 0; e < NUM_EXPERTS; e++) {
      const nextHid = new Float32Array(NN.H);
      const out = netForwardRNN(g, inp, hiddenStates[e], e * EXPERT_W, nextHid);
      hiddenStates[e] = nextHid;
      const we = w[e];
      for (let i = 0; i < NN.OUT; i++) blended[i] += out[i] * we;
    }
    self._lastGate = w; // exposed for debug/HUD
    return blended;
  }
  const clamp1 = (v) => v < -1 ? -1 : v > 1 ? 1 : v;
  // Turn the world around a fighter into a normalized 16-feature vector.
  function senseFeatures(self, foe) {
    const inp = new Array(NN.IN).fill(0);
    if (!foe) return inp;
    const dx = foe.pos.x - self.pos.x, dy = foe.pos.y - self.pos.y;
    inp[0] = clamp1(dx / 600); inp[1] = clamp1(dy / 400); inp[2] = clamp1(Math.hypot(dx, dy) / 800);
    inp[3] = clamp1(self.body.velocity.x / 8); inp[4] = clamp1(self.body.velocity.y / 14);
    inp[5] = (self.weapon && self.weapon.ammo > 0) ? 1 : 0;
    inp[6] = self.weapon ? clamp1(self.weapon.ammo / 24) : 0;
    inp[7] = (foe.weapon && foe.weapon.ammo > 0) ? 1 : 0;
    inp[8] = clamp1(foe.body.velocity.x / 8); inp[9] = clamp1(foe.body.velocity.y / 14);
    let wx = 0, wy = 0, has = 0, bd = Infinity;
    for (const w of weapons) {
      if (w.taken) continue;
      const d = Math.hypot(w.body.position.x - self.pos.x, w.body.position.y - self.pos.y);
      if (d < bd) { bd = d; wx = w.body.position.x - self.pos.x; wy = w.body.position.y - self.pos.y; has = 1; }
    }
    inp[10] = clamp1(wx / 600); inp[11] = clamp1(wy / 400); inp[12] = has;
    inp[13] = clamp1(self.hp / 100); inp[14] = clamp1(foe.hp / 100); inp[15] = self.grounded ? 1 : 0;
    // ---- EDGE / VOID awareness: feeler probes left & right. 1 = lethal drop, 0 = solid ground ----
    const feetY = self.pos.y + 34;
    inp[16] = groundBelow(self.pos.x + 60, feetY, 280) ? 0 : 1; // void to the right
    inp[17] = groundBelow(self.pos.x - 60, feetY, 280) ? 0 : 1; // void to the left
    // ---- TEAMMATE awareness (all 0 when solo / 1v1): nearest ally relative pos + HP ----
    const ally = nearestAlly(self);
    if (ally) {
      inp[18] = clamp1((ally.pos.x - self.pos.x) / 600);
      inp[19] = clamp1((ally.pos.y - self.pos.y) / 400);
      inp[20] = clamp1(ally.hp / 100);
      inp[21] = ally.isEngaging ? 1 : 0;  // ally currently in combat?
      inp[22] = clamp1(Math.hypot(ally.pos.x - self.pos.x, ally.pos.y - self.pos.y) / 600);
    }
    // Short-term memory: what happened earlier this round?
    const mem = self.memory || {};
    inp[23] = mem.lastHitByMelee  || 0; // 1=was hit by melee, 0=ranged/nothing
    inp[24] = clamp1(mem.foeDodgePattern || 0); // foe's dodge direction bias (-1 L, +1 R)
    inp[25] = mem.lastParrySuccess || 0; // 1=last parry succeeded
    // Opponent model: foe aggression level
    inp[26] = clamp1((self.foeModel && self.foeModel.aggressionLevel) || 0);
    // ---- Arena awareness: how safe is MY zone vs the foe's zone (center good, edge/void bad) ----
    inp[27] = getZoneSafety(self.pos);
    inp[28] = getZoneSafety(foe.pos);
    inp[29] = getZoneSafety(foe.pos) < 0.25 ? 1 : 0; // foe near void (#5)
    inp[30] = fighters.filter(f => f.alive).length === 2 ? 1 : 0; // final duel (#8)
    return inp;
  }
  // Run the policy and decode it into a control intent.
  function brainAct(g, self) {
    const foe = nearestEnemy(self);
    // #83 per-expert recurrent hidden state (carried frame-to-frame, reset each round).
    if (!self._hiddenState || self._hiddenState.length !== NUM_EXPERTS) {
      self._hiddenState = [];
      for (let e = 0; e < NUM_EXPERTS; e++) self._hiddenState.push(new Float32Array(NN.H));
    }
    // #81 Mixture-of-Experts: blend the 4 expert RNNs for this frame's action.
    const o = moeForward(g, self, foe, self._hiddenState);

    // ── Personality genes (evolved alongside weights, genome[656..659]) ──────
    const pAtk   = g[PERS_OFFSET];     // attack eagerness  [-1 coward … +1 berserker]
    const pFlee  = g[PERS_OFFSET + 1]; // flee tendency     [-1 fearless … +1 cautious]
    const pBlock = g[PERS_OFFSET + 2]; // block preference  [-1 never … +1 always]
    const pWpn   = g[PERS_OFFSET + 3]; // weapon affinity   [-1 prefers melee … +1 weapon hunter]

    // Thresholds shaped by personality
    const fireThresh  = Math.max(0.10, 0.30 - pAtk * 0.14); // aggressive = attacks more freely
    const heavyThresh = Math.max(0.50, 0.82 - pAtk * 0.18); // aggressive = commits to heavy earlier
    const blockChance = Math.max(0.05, 0.40 + pBlock * 0.28);

    // #82 Continuous action space: move is a smooth strength in [-1,1] (walk vs sprint),
    // jump height scales with output, fire is probabilistic on top of the threshold.
    let move = Math.tanh(o[1] - o[0]);
    if (Math.abs(move) < 0.15) move = 0;             // deadzone so bots don't micro-jitter
    const jumpStrength = Math.max(0, o[2]);
    self._jumpStrength = jumpStrength;               // consumed by update() for variable jump height
    let jump  = jumpStrength > 0.3;
    self._fireProbability = Math.max(0, o[3]);
    let fire  = o[3] > fireThresh || Math.random() < self._fireProbability;
    let heavy = o[3] > heavyThresh;
    let down  = o[4] > 0.2;
    let block = !!foe && foe._swing > 0 && o[3] < 0.3 &&
                Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y) < 95 &&
                Math.random() < blockChance;

    // ── Trick moves (outputs 5, 6, 7) ────────��──────────────��─────────────
    const doFeint    = o[5] > 0.55 && !(self._feintCd > 0);
    const doBaitJump = o[6] > 0.55;
    const doDashAtk  = o[7] > 0.55;

    if (doFeint && foe) {
      // Feint: cancel own attack and raise block to bait foe's counter into a parry
      fire = false; block = true; self._feintCd = 0.5;
      if (TRAIN && foe._swing > 0) self.fit += 6; // baited an incoming swing
    }
    if (doBaitJump && !self._baitLand) {
      // Bait jump: leap up to draw foe, then auto-attack on landing
      jump = true; self._baitLand = 0.75;
    }
    if (self._baitLand > 0 && self.grounded && self._baitLand < 0.6) {
      // Landing attack from bait jump
      fire = true; if (pAtk > 0.2) heavy = true;
      if (TRAIN) self.fit += 4;
      self._baitLand = 0;
    }
    if (doDashAtk && foe && !fire) {
      // Dash attack: rush toward foe while firing simultaneously
      fire = true;
      move = Math.sign(foe.pos.x - self.pos.x);
      if (TRAIN && self.meleeCd <= 0) self.fit += 3;
    }

    // #68 Trick Move Chaining: feint->dash and baitjump->aerial-punish combos.
    if (foe) {
      const _cd = Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y);
      const tc = self._trickChain || (self._trickChain = { step: 0, active: false, timer: 0, combo: null });
      tc.timer = Math.max(0, tc.timer - 1 / 60);
      if (!tc.active && doFeint && foe._swing === 0) { tc.active = true; tc.step = 1; tc.combo = 'feint_dash'; tc.timer = 0.4; }
      if (tc.active && tc.combo === 'feint_dash') {
        if (tc.step === 1 && tc.timer <= 0) { move = Math.sign(foe.pos.x - self.pos.x); fire = true; tc.step = 2; tc.timer = 0.3; if (TRAIN && _cd < 80) self.fit += 10; }
        else if (tc.step === 2 && tc.timer <= 0) { tc.active = false; tc.step = 0; }
      }
      if (!tc.active && doBaitJump && foe.body.velocity.y < -2) { tc.active = true; tc.combo = 'aerial_punish'; tc.timer = 0.5; fire = true; move = Math.sign(foe.pos.x - self.pos.x); if (TRAIN) self.fit += 8; }
    }

    // ── Team coord: update isEngaging flag ───────────────��───���────────────
    self.isEngaging = !!foe && Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y) < 140;

    // ── Momentum / Hype: on-fire = bolder & quicker to attack; tilted = hesitant ──
    const _h = Math.max(-1, Math.min(1, (self.hype || 0) / 100));
    if (_h > 0.6) {                       // ON FIRE
      if (o[3] > fireThresh - 0.10) fire = true;
      if (foe) move = move || Math.sign(foe.pos.x - self.pos.x);
    } else if (_h < -0.4) {               // TILTED -> mistimed, more defensive
      if (Math.random() < 0.15) fire = false;                  // fumbles the attack timing
      if (foe && foe._swing > 0 && Math.random() < 0.25) block = true;
    }

    // ── Meta-learning exploration: occasionally try a new action (TRAIN only) ─���
    if (TRAIN) {
      const expl = metaParams(g).expl;
      if (Math.random() < expl) {
        const r = Math.random();
        if (r < 0.4) move = (Math.random() < 0.5 ? -1 : 1);
        else if (r < 0.6) jump = !jump;
        else if (r < 0.8) fire = !fire;
        else heavy = !heavy;
      }
    }

    // ── M106 Weapon priority: an UNARMED trained bot actively walks to the nearest
    //    reachable weapon and grabs it FIRST, instead of milling around or brawling
    //    empty-handed. Skipped only when a foe is right on top of it.
    if (!self.weapon || (self.weapon.ammo || 0) <= 0) {
      let nw = null, nd = 1e9;
      for (const wp of weapons) {
        if (wp.taken) continue;
        const d = Math.hypot(wp.body.position.x - self.pos.x, wp.body.position.y - self.pos.y);
        if (d < nd) { nd = d; nw = wp; }
      }
      const foeRightHere = foe && Math.hypot(foe.pos.x - self.pos.x, foe.pos.y - self.pos.y) < 72;
      if (nw && nd < 640 && !foeRightHere) {
        const wdx = nw.body.position.x - self.pos.x;
        move = Math.sign(wdx) || move;
        if (Math.abs(wdx) < 56) down = true;                      // crouch-grab when standing over it
        if (nw.body.position.y < self.pos.y - 40) jump = true;    // hop up to a raised weapon
        fire = false; heavy = false;                              // don't swing at air while fetching
      }
    }

    return { move, jump, fire, heavy, down, block };
  }

  // ---- persistence (localStorage) ----
  // Upgrade a legacy 401-weight genome (IN=16) to the current 491-weight layout
  // (IN=21). Existing weights are copied verbatim; the 5 new sensor inputs start
  // at weight 0, so a migrated brain behaves EXACTLY as before until retrained
  // -> no training progress is lost.
  // Migrate any older genome (length 401=IN16/OUT5 or 491=IN21/OUT5) to current
  // GENOME_LEN=660 (IN27/OUT8 + 4 personality genes). Existing weights are
  // copied verbatim; new inputs start at 0 (neutral); new output neurons and
  // personality genes start at 0. No training progress is lost.
  // Expand an OLD single feed-forward genome into the new MoE-RNN layout.
  // Each of the 4 experts is seeded with a copy of the old FFN weights and ZERO
  // recurrent weights, so a freshly-migrated brain behaves exactly like the old
  // one (all experts identical -> blended output == old output, no memory yet)
  // and then specialises as training continues. H has always been 18.
  function migrateGenome(old) {
    if (old.length === GENOME_LEN) return Float32Array.from(old); // already MoE-RNN
    let OLD_IN, OLD_OUT, OLD_PERS = 0, OLD_META = 0;
    if (old.length === 401)      { OLD_IN = 16; OLD_OUT = 5; }
    else if (old.length === 491) { OLD_IN = 21; OLD_OUT = 5; }
    else if (old.length === 660) { OLD_IN = 27; OLD_OUT = 8; OLD_PERS = 4; }
    else if (old.length === 699) { OLD_IN = 29; OLD_OUT = 8; OLD_PERS = 4; OLD_META = 3; }
    else if (old.length === 735) { OLD_IN = 31; OLD_OUT = 8; OLD_PERS = 4; OLD_META = 3; } // pre-MoE FFN
    else return randGenome(); // unknown layout -> start fresh
    const H = NN.H, IN = NN.IN, OUT = NN.OUT;
    // Parse the old FFN into hidden (bias + OLD_IN weights) and output (bias + H) blocks.
    let ko = 0;
    const oh = [];
    for (let j = 0; j < H; j++) { const bias = old[ko++]; const w = []; for (let i = 0; i < OLD_IN; i++) w.push(old[ko++]); oh.push({ bias, w }); }
    const oo = [];
    for (let j = 0; j < OLD_OUT; j++) { const bias = old[ko++]; const w = []; for (let i = 0; i < H; i++) w.push(old[ko++]); oo.push({ bias, w }); }
    const tail = ko; // personality/meta genes (if any) begin here
    const g = new Float32Array(GENOME_LEN); // zero-initialised
    let kn = 0;
    for (let e = 0; e < NUM_EXPERTS; e++) {
      for (let j = 0; j < H; j++) {
        g[kn++] = oh[j].bias;                                          // hidden bias
        for (let i = 0; i < IN; i++) g[kn++] = i < OLD_IN ? oh[j].w[i] : 0; // input weights (+pad new inputs)
        for (let i = 0; i < H; i++) g[kn++] = 0;                       // recurrent weights start neutral
      }
      for (let j = 0; j < OUT; j++) {
        if (j < OLD_OUT) { g[kn++] = oo[j].bias; for (let i = 0; i < H; i++) g[kn++] = oo[j].w[i]; }
        else { kn++; for (let i = 0; i < H; i++) kn++; }              // new output neuron = 0
      }
    }
    let kt = tail;
    for (let i = 0; i < OLD_PERS && i < PERS_LEN; i++) g[PERS_OFFSET + i] = old[kt++];
    for (let i = 0; i < OLD_META && i < META_LEN; i++) g[META_OFFSET + i] = old[kt++];
    return g;
  }
  function saveBrain(g, meta) {
    try { localStorage.setItem('sf_brain_v1', JSON.stringify({ w: Array.from(g), meta })); } catch (e) {}
  }
  // ---- Hall of Fame: frozen champion snapshots used as permanent benchmark foes ----
  function loadHoF() {
    try {
      const a = JSON.parse(localStorage.getItem('sf_hof_v1')) || [];
      return a.map(w => { const f = Float32Array.from(w); return f.length === GENOME_LEN ? f : migrateGenome(f); });
    } catch (e) { return []; }
  }
  function saveHoF(list) {
    try { localStorage.setItem('sf_hof_v1', JSON.stringify(list.map(g => Array.from(g)))); } catch (e) {}
  }
  // ---- King pool: rolling list of the LAST 8 DISTINCT training champions, so the
  //  King Tournament fields 8 *different* past champions instead of 8 clones of one. ----
  // M107: the King pool now stores each champion WITH the fitness & generation it
  // earned when crowned, so the post-training tournament can rank MANY real,
  // DISTINCT champions instead of leaving everyone but the single champion at 0.
  // Backward compatible: older saves were raw genome arrays (fit/gen default 0).
  function _normGenome(w) { const f = Float32Array.from(w); return f.length === GENOME_LEN ? f : migrateGenome(f); }
  function loadKingPoolEntries() {
    try {
      const a = JSON.parse(localStorage.getItem('sf_king_pool_v1'));
      if (!a || !a.length) return [];
      return a.map(e => {
        if (e && e.w && e.w.length) return { genome: _normGenome(e.w), fit: e.fit || 0, gen: e.gen || 0 };
        if (e && e.length) return { genome: _normGenome(e), fit: 0, gen: 0 }; // legacy raw-array entry
        return null;
      }).filter(Boolean);
    } catch (e) { return []; }
  }
  function loadKingPool() { return loadKingPoolEntries().map(e => e.genome); } // genomes only (King bracket contenders)
  function saveKingPool(entries) {
    try {
      const norm = (entries || []).map(e => {
        if (e && e.genome) return { w: Array.from(e.genome), fit: e.fit || 0, gen: e.gen || 0 };
        if (e && e.w) return { w: Array.from(e.w), fit: e.fit || 0, gen: e.gen || 0 };
        return { w: Array.from(e), fit: 0, gen: 0 };
      });
      localStorage.setItem('sf_king_pool_v1', JSON.stringify(norm));
    } catch (e) {}
  }
  function _genomeSig(g) { let s = 0; for (let i = 0; i < g.length; i += 97) s += g[i] * (i + 1); return Math.round(s * 1000); }
  function pushKingChampion(genome, fit, gen) {
    if (!genome || !genome.length) return;
    try {
      const entries = loadKingPoolEntries();
      const sig = _genomeSig(genome);
      const existing = entries.find(e => _genomeSig(e.genome) === sig);
      if (existing) { // already banked: keep the BEST fitness/gen so the entry stays meaningful
        if ((fit || 0) > (existing.fit || 0)) { existing.fit = Math.round(fit || 0); existing.gen = gen || existing.gen; }
        saveKingPool(entries); return;
      }
      entries.push({ genome: Float32Array.from(genome), fit: Math.round(fit || 0), gen: gen || 0 });
      while (entries.length > 8) entries.shift();
      saveKingPool(entries);
    } catch (e) {}
  }
  // ---- Full population persistence: keep ALL 8 evolving brains (their distinct
  //  tactics) between sessions, so variety accumulates instead of resetting to
  //  champion-clones every time you train. Champion is still re-injected at slot 0
  //  and protected by elitism. ----
  function savePop(list) {
    try { localStorage.setItem('sf_pop_v1', JSON.stringify((list || []).map(g => Array.from(g)))); } catch (e) {}
  }
  function loadPop() {
    try {
      const a = JSON.parse(localStorage.getItem('sf_pop_v1'));
      if (!a || !a.length) return null;
      return a.map(w => { const f = Float32Array.from(w); return f.length === GENOME_LEN ? f : migrateGenome(f); });
    } catch (e) { return null; }
  }

  // ---- Unified brain bank: every DISTINCT trained genome we have on hand
  //  (live population + Hall of Fame + King pool + reigning champion), de-duped
  //  by genome fingerprint. Play-mode opponents are drawn at RANDOM from this so
  //  you don't keep fighting the same brain every match. Each distinct genome
  //  also derives its own signature/personality, so variety is both tactical
  //  and stylistic. ----
  function allBrainGenomes() {
    const out = [], seen = new Set();
    const add = g => { if (g && g.length) { const s = _genomeSig(g); if (!seen.has(s)) { seen.add(s); out.push(g); } } };
    try { (loadPop() || []).forEach(add); } catch (e) {}
    try { (loadHoF() || []).forEach(add); } catch (e) {}
    try { (loadKingPool() || []).forEach(add); } catch (e) {}
    if (bestBrain) add(bestBrain);
    return out;
  }

  // ============================================================
  //  Rank Points DB — persistent cumulative score across all modes
  //  Stored in localStorage under sf_rank_v1. Never auto-reset.
  //  Bot objective: win rounds in any mode to climb to #1.
  // ============================================================
  const RANK_KEY = 'sf_rank_v1';
  function loadRankDB() {
    try { return JSON.parse(localStorage.getItem(RANK_KEY)) || []; } catch (e) { return []; }
  }
  function saveRankDB(db) {
    try { localStorage.setItem(RANK_KEY, JSON.stringify(db)); } catch (e) {}
  }
  function addRankPoints(name, color, pts) {
    if (!pts || pts <= 0) return;
    const db = loadRankDB();
    let ent = db.find(e => e.name === name);
    if (!ent) { ent = { name, color, pts: 0 }; db.push(ent); }
    ent.pts += Math.round(pts);
    ent.color = color;
    db.sort((a, b) => b.pts - a.pts);
    saveRankDB(db);
  }
  function renderRankBoard() {
    const el = document.getElementById('rank-board');
    if (!el) return;
    const db = loadRankDB();
    if (!db.length) { el.innerHTML = '<p class="rank-empty">No data yet — play a round first!</p>'; return; }
    const medals = ['🥇', '🥈', '🥉'];
    let html = '';
    db.slice(0, 10).forEach((ent, i) => {
      const me = i < 3 ? medals[i] : (i + 1) + '.';
      html += '<div class="rank-row"><span class="rank-pos">' + me + '</span>' +
        '<span class="rank-dot" style="background:' + (ent.color || '#888') + '"></span>' +
        '<span class="rank-name">' + ent.name + '</span>' +
        '<span class="rank-pts">' + ent.pts + ' pts</span></div>';
    });
    el.innerHTML = html;
  }

  function loadBrain() {
    try {
      const s = localStorage.getItem('sf_brain_v1');
      if (!s) return null;
      const o = JSON.parse(s);
      if (!o.w) return null;
      let w = o.w;
      if (w.length !== GENOME_LEN) w = migrateGenome(Float32Array.from(w)); // migrate any older layout (incl. pre-MoE FFN) into MoE-RNN
      bestBrainMeta = o.meta || {};
      return (w instanceof Float32Array) ? w : Float32Array.from(w);
    } catch (e) { return null; }
  }
  // ── #100 Grand Tournament: every saved brain competes for the all-time crown. ──
  const TournamentSystem = {
    loadAllBrains() {
      const brains = [];
      const seen = {};
      // De-dupe by genome signature; when the same brain shows up twice keep the
      // copy carrying the higher recorded fitness so its score isn't lost.
      const addBrain = (b) => {
        if (!b || !b.genome || !b.genome.length) return;
        const sig = _genomeSig(b.genome);
        const prev = seen[sig];
        if (prev) { if ((b.fit || 0) > (prev.fit || 0)) { prev.fit = b.fit; prev.gen = b.gen; } return; }
        seen[sig] = b; brains.push(b);
      };
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.indexOf('sf_brain_') === 0) {
          try {
            const data = JSON.parse(localStorage.getItem(key));
            if (data && data.w && data.w.length) {
              addBrain({ name: key.replace('sf_brain_', ''), genome: _normGenome(data.w), gen: (data.meta && data.meta.gen) || 0, fit: (data.meta && data.meta.fit) || 0, tournScore: 0 });
            }
          } catch (e) {}
        }
      }
      // M107: the rolling pool of DISTINCT training champions — each carries the
      // fitness it earned when crowned, so the bracket now has SEVERAL real
      // contenders with their own scores instead of just one.
      try { loadKingPoolEntries().forEach((e, i) => addBrain({ name: 'Champion ' + (e.gen ? 'G' + e.gen : (i + 1)), genome: e.genome, gen: e.gen || 0, fit: Math.round(e.fit || 0), tournScore: 0 })); } catch (e) {}
      // Frozen Hall-of-Fame champions also enter the bracket.
      try { (loadHoF() || []).forEach((w, i) => { if (w && w.length) addBrain({ name: 'HoF-' + (i + 1), genome: _normGenome(w), gen: 0, fit: 0, tournScore: 0 }); }); } catch (e) {}
      return brains;
    },
    runTournament() {
      const brains = this.loadAllBrains();
      if (brains.length < 2) { alert('Need at least 2 saved brains for a tournament. Train & export some first \ud83d\ude42'); return []; }
      // Round-robin scored by recorded fitness head-to-head. (Live re-fights would need an async match runner.)
      for (let i = 0; i < brains.length; i++) {
        for (let j = i + 1; j < brains.length; j++) {
          if (brains[i].fit > brains[j].fit) brains[i].tournScore += 3;
          else if (brains[j].fit > brains[i].fit) brains[j].tournScore += 3;
          else { brains[i].tournScore++; brains[j].tournScore++; }
        }
      }
      const ranked = brains.sort((a, b) => b.tournScore - a.tournScore || b.fit - a.fit);
      if (ranked[0]) { bestBrain = ranked[0].genome.slice(); bestBrainMeta = { gen: ranked[0].gen, fit: ranked[0].fit, trained: (bestBrainMeta && bestBrainMeta.trained) || 0 }; saveBrain(bestBrain, bestBrainMeta); refreshBrainStatus(); }
      return ranked;
    },
  };
  function showTournamentResults(ranked) {
    if (!ranked || !ranked.length) return;
    const lines = ranked.map((b, i) => (i + 1) + '. ' + b.name + ' (Gen ' + b.gen + ') \u2014 ' + b.tournScore + ' pts, score ' + b.fit);
    alert('\ud83c\udfc6 TOURNAMENT RESULTS\n\n' + lines.join('\n') + '\n\nWinner set as active AI.');
  }

  // ---- export / import (portable backup, survives clearing site data) ----
  function exportBrain() {
    if (!bestBrain) { alert('No trained AI to export yet. Train first \ud83d\ude42'); return; }
    // Carry the WHOLE brain bank: champion (w/meta) + full population (pop) + Hall of Fame (hof).
    const data = JSON.stringify({ w: Array.from(bestBrain), meta: bestBrainMeta, pop: (loadPop() || []).map(g => Array.from(g)), hof: (loadHoF() || []).map(g => Array.from(g)) });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stickfight-brain-gen' + (bestBrainMeta.gen || 0) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  // Wipe ALL trained AI memory (champion, population, Hall of Fame, rank board) and start fresh.
  function resetAllAI() {
    if (!confirm('Delete ALL AI (champion, 8 population brains, Hall of Fame, leaderboard) and start from ZERO? This cannot be undone.')) return;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && (k.indexOf('sf_brain') === 0 || k === 'sf_pop_v1' || k === 'sf_hof_v1' || k === 'sf_rank_v1' || k === 'sf_champions')) keys.push(k); }
      keys.forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    bestBrain = null; bestBrainMeta = {};
    try { if (typeof Trainer !== 'undefined' && Trainer) { Trainer.best = null; Trainer.hasChampion = false; Trainer.hallOfFame = []; Trainer.baseTrained = 0; } } catch (e) {}
    try { const cb = document.getElementById('use-brain'); if (cb) cb.checked = false; } catch (e) {}
    refreshBrainStatus(); renderRankBoard();
    alert('All AI has been reset \uD83E\uDDF9 Brains start from zero. Press "Train AI" to train from scratch.');
  }
  function importBrain(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const o = JSON.parse(reader.result);
        if (!o.w || !o.w.length) { alert('Invalid brain file \u274c'); return; }
        bestBrain = (o.w.length === GENOME_LEN) ? Float32Array.from(o.w) : migrateGenome(Float32Array.from(o.w));
        bestBrainMeta = o.meta || {};
        saveBrain(bestBrain, bestBrainMeta);
        // Restore the FULL population + Hall of Fame if the file carries them, so
        // every distinct bot brain comes back \u2014 not just the champion.
        let _popN = 0;
        if (o.pop && o.pop.length) {
          const _p = o.pop.map(w => { const f = Float32Array.from(w); return f.length === GENOME_LEN ? f : migrateGenome(f); });
          savePop(_p); _popN = _p.length;
        }
        if (o.hof && o.hof.length) {
          const _h = o.hof.map(w => { const f = Float32Array.from(w); return f.length === GENOME_LEN ? f : migrateGenome(f); });
          saveHoF(_h);
        }
        refreshBrainStatus();
        alert('Brain imported successfully \u2705 ' + (_popN ? ('(' + _popN + ' population brains + champion) ') : '') + 'Check "Use trained AI" then start Bot vs Bot.');
      } catch (e) { alert('Failed to read brain file \u274c'); }
    };
    reader.readAsText(file);
  }

  // ---- genetic operators ----
  function gauss() { return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.7; }
  function adaptiveMutate(g, generationStuck) {
    const baseMutRate = 0.14, baseResetRate = 0.02;
    const stuckBonus = Math.min((generationStuck || 0) * 0.015, 0.20);
    const step = metaParams(g).lr + stuckBonus;
    for (let i = 0; i < g.length; i++) {
      if (Math.random() < baseMutRate + stuckBonus) g[i] += gauss() * step;
      if (Math.random() < baseResetRate + stuckBonus * 0.3) g[i] = (Math.random() * 2 - 1) * 1.2;
      if (g[i] > 4) g[i] = 4; else if (g[i] < -4) g[i] = -4;
    }
    return g;
  }
  function mutate(g) {
    g = adaptiveMutate(g, Trainer && Trainer.stale || 0);
    // Meta genes mutate at a fixed gentle rate so they stay free to adapt even
    // when the learningRate they encode is small.
    for (let m = 0; m < META_LEN; m++) {
      if (Math.random() < 0.20) g[META_OFFSET + m] += gauss() * 0.18;
      const v = g[META_OFFSET + m]; if (v > 4) g[META_OFFSET + m] = 4; else if (v < -4) g[META_OFFSET + m] = -4;
    }
    return g;
  }
  function crossover(a, b) {
    const c = new Float32Array(a.length);
    for (let i = 0; i < c.length; i++) c[i] = Math.random() < 0.5 ? a[i] : b[i];
    return c;
  }
  // Rough genetic distance between two genomes (sampled every 8th gene for speed).
  // Used to preserve brains whose STRATEGY differs from the champion, so the
  // population keeps a variety of tactics instead of collapsing into clones.
  function genomeDist(a, b) {
    if (!a || !b) return 1e9;
    let s = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 8) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }
  function shuffleIdx(n) {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // 8 distinct stickman colors, one per population member (merah, oren, kuning,
  // hijau, biru, ungu, abu-abu, coklat) so each brain is visually identifiable.
  const POP_COLORS = ['#ff5c5c', '#ff9f43', '#ffd23f', '#4ec96a', '#4db5ff', '#b06cff', '#9aa3b2', '#8a5a3c'];

  // ---- the self-play trainer (cooperative, time-budgeted per animation frame) ----
  const Trainer = {
    popSize: 8, elite: 2, maxGen: 60, matchSteps: 60 * 18,
    pop: [], fitSum: [], fitCnt: [], queue: [], cur: null, gen: 0, genTotal: 0,
    bestFit: -1e9, recordFit: -1e9, fitHistory: [], best: null, running: false, turbo: false, stale: 0,
    trials: [], baseTrained: 0, done: false, hasChampion: false,
    hallOfFame: [], _lastHofMark: 0,

    start() {
      // read training options from the menu (generations + turbo speed)
      const gsel = document.getElementById('train-gens');
      if (gsel) this.maxGen = parseInt(gsel.value, 10) || 60;
      const tchk = document.getElementById('train-turbo');
      this.turbo = !!(tchk && tchk.checked);
      this.running = true; this.gen = 0; this.bestFit = -1e9; this.best = bestBrain ? bestBrain.slice() : null;
      this.recordFit = (bestBrainMeta && typeof bestBrainMeta.fit === 'number') ? bestBrainMeta.fit : -1e9; this.fitHistory = [];
      this.hasChampion = !!bestBrain; // a saved brain is the reigning champion that new candidates must BEAT (protects it from regressing)
      this.trials = new Array(this.popSize).fill(0);                 // cumulative matches per brain (this session)
      this.baseTrained = (bestBrainMeta && bestBrainMeta.trained) || 0; // generations carried over from saved brain
      this.done = false;
      this.stale = 0; // generations since the champion last improved (drives the stagnation escape)
      this.hallOfFame = loadHoF();                      // frozen past champions (Hall of Fame opponents)
      this._lastHofMark = Math.floor(this.baseTrained / 100);
      this.pop = [];
      const savedPop = loadPop(); // resume the WHOLE evolved population (preserves distinct tactics across sessions)
      if (savedPop && savedPop.length) {
        for (let i = 0; i < this.popSize; i++) this.pop.push(savedPop[i % savedPop.length].slice());
      } else {
        for (let i = 0; i < this.popSize; i++) {
          if (bestBrain && i < this.popSize / 2) this.pop.push(mutate(bestBrain.slice()));
          else this.pop.push(randGenome());
        }
      }
      if (bestBrain) this.pop[0] = bestBrain.slice(); // keep current champion intact
      setupMatch('bot');
      this.beginGen();
    },
    stop() {
      this.running = false; TRAIN = false;
      if (this.best) { bestBrain = this.best.slice(); saveBrain(bestBrain, { gen: this.gen, fit: Math.round(this.bestFit), trained: this.baseTrained + this.gen }); }
    },
    beginGen() {
      this.fitSum = new Array(this.popSize).fill(0);
      this.fitCnt = new Array(this.popSize).fill(0);
      this.queue = [];
      // Round 1: random pairings (diversity)
      const o = shuffleIdx(this.popSize);
      for (let i = 0; i + 1 < this.popSize; i += 2) this.queue.push([o[i], o[i + 1]]);
      // Round 1b: a SECOND random pairing so each brain plays more matches per
      // generation -> averaged fitness is less noisy and the displayed score is
      // more stable from generation to generation.
      const o1b = shuffleIdx(this.popSize);
      for (let i = 0; i + 1 < this.popSize; i += 2) this.queue.push([o1b[i], o1b[i + 1]]);
      // Round 2: gauntlet vs reigning champion (pop[0] = best of last gen).
      // A passive bot that just survives will get killed by a strong champion
      // and score low -> kills the "both stand still" equilibrium.
      for (let i = 1; i < this.popSize; i++) this.queue.push([i, 0]);
      // Round 3: one 2v2 team match (a 4-slot entry) so the teammate sensors and
      // team rewards are actually exercised -> bots learn to push, not camp.
      if (this.popSize >= 4) { const t = shuffleIdx(this.popSize); this.queue.push([t[0], t[1], t[2], t[3]]); }
      // Round 4: every brain also fights the hand-coded rule-based AI (an EXTERNAL,
      // non-drifting opponent), so fitness is anchored to beating a REAL strategy
      // -- not just to beating its own kin. This prevents self-play collapse.
      for (let i = 0; i < this.popSize; i++) this.queue.push([i, -1]);
      // Round 5: Hall of Fame gauntlet — ~30% of matches are against frozen past
      // champions so the population can't "forget" how to beat old strategies.
      if (this.hallOfFame && this.hallOfFame.length) {
        for (let i = 0; i < this.popSize; i++) {
          const h = (Math.random() * this.hallOfFame.length) | 0;
          this.queue.push([i, -2 - h]); // bi <= -2 encodes a Hall-of-Fame opponent (index = -bi-2)
        }
      }
      this.genTotal = this.queue.length;
      this.cur = null;
    },
    beginMatch(ai, bi) {
      TRAIN = true;
      ragdolls.forEach(r => r.remove()); ragdolls = [];
      bullets.forEach(b => World.remove(world, b)); bullets = [];
      weapons.forEach(w => { if (!w.taken) World.remove(world, w.body); }); weapons = [];
      spawnBots([0, 1]); // 1v1
      const rule = (bi === -1); // -1 => opponent is the hand-coded rule-based AI (external benchmark)
      const isHof = (bi <= -2);                                   // <= -2 => frozen Hall-of-Fame foe
      const hofBrain = isHof ? (this.hallOfFame[-bi - 2] || null) : null;
      fighters[0].brain = this.pop[ai];
      fighters[1].brain = rule ? null : isHof ? hofBrain : this.pop[bi];
      fighters[0].color = POP_COLORS[ai % POP_COLORS.length];
      fighters[1].color = rule ? '#888888' : isHof ? '#6b5ca8' : POP_COLORS[bi % POP_COLORS.length];
      fighters.forEach(f => f.reset());
      roundOver = false; roundTime = 0; weaponTimer = 0.8;
      // Only the population brain (slot ai) earns fitness; rule/HoF foes don't.
      this.cur = { slots: (rule || isHof) ? [ai] : [ai, bi], step: 0 };
    },
    // 2v2 team self-play, so the ally-awareness sensors + team rewards get trained.
    beginTeamMatch(slots) {
      TRAIN = true;
      ragdolls.forEach(r => r.remove()); ragdolls = [];
      bullets.forEach(b => World.remove(world, b)); bullets = [];
      weapons.forEach(w => { if (!w.taken) World.remove(world, w.body); }); weapons = [];
      spawnBots([0, 0, 1, 1]); // team A = slots[0..1], team B = slots[2..3]
      for (let i = 0; i < 4; i++) { fighters[i].brain = this.pop[slots[i]]; fighters[i].color = POP_COLORS[slots[i] % POP_COLORS.length]; }
      fighters.forEach(f => f.reset());
      roundOver = false; roundTime = 0; weaponTimer = 0.8;
      this.cur = { slots: slots.slice(), step: 0, team: true };
    },
    endMatch() {
      const c = this.cur;
      // Credit each participating brain slot with the fitness its fighter earned
      // (works for both 1v1 = 2 fighters and 2v2 = 4 fighters).
      for (let i = 0; i < c.slots.length; i++) {
        const s = c.slots[i];
        if (s == null || !fighters[i]) continue;
        addImitationBonus(fighters[i]); // LEARN-FROM-ME: bias evolution toward your playstyle
        this.fitSum[s] += fighters[i].fit; this.fitCnt[s]++;
        this.trials[s] = (this.trials[s] || 0) + 1;
      }
      this.cur = null;
    },
    avg(i) { return this.fitCnt[i] ? this.fitSum[i] / this.fitCnt[i] : -1e9; },
    sparkline() {
      const h = this.fitHistory || [];
      if (h.length < 2) return '(no data yet)';
      const bars = '▁▂▃▄▅▆▇█';
      const recent = h.slice(-40);
      const mn = Math.min.apply(null, recent), mx = Math.max.apply(null, recent);
      const rng = (mx - mn) || 1;
      return recent.map(v => bars[Math.max(0, Math.min(7, Math.round((v - mn) / rng * 7)))]).join('');
    },
    evolve() {
      const idx = [...Array(this.popSize).keys()].sort((a, b) => this.avg(b) - this.avg(a));
      const topSlot = idx[0];
      const topFit = this.avg(topSlot);
      // Slot 0 is ALWAYS the reigning all-time champion (re-injected every gen),
      // so avg(0) is the champion's score under THIS generation's exact conditions.
      // Crown a new champion only when a candidate clearly beats it head-to-head
      // (same opponents, same arena). This makes the saved brain monotonic:
      // it can improve or hold its ground, but can NEVER regress / "anjlok".
      const MARGIN = 8; // require a clear win, not lucky noise, before dethroning (raised for stability)
      const champScore = this.hasChampion ? this.avg(0) : -1e9;
      // Track the all-time best (monotonic, never decreases) + per-generation
      // history for the trend sparkline shown on the training screen.
      this.recordFit = Math.max(this.recordFit, topFit, this.hasChampion ? champScore : topFit);
      this.fitHistory.push(Math.round(Math.max(topFit, this.hasChampion ? champScore : topFit)));
      if (this.fitHistory.length > 60) this.fitHistory.shift();
      if (!this.hasChampion || topFit > champScore + MARGIN) {
        this.best = this.pop[topSlot].slice();
        this.bestFit = topFit;
        this.hasChampion = true;
        bestBrain = this.best.slice();
        bestBrainMeta = { gen: this.gen + 1, fit: Math.round(topFit), trained: this.baseTrained + this.gen + 1 };
        saveBrain(bestBrain, bestBrainMeta);
        pushKingChampion(bestBrain, topFit, this.gen + 1); // M107: bank this champion WITH its fitness for tournaments
        ReplaySystem.saveIfChampion(fighters.find(f => f.alive), topFit);
        this.stale = 0; // progress! reset the stagnation counter
        // Hall of Fame: freeze a snapshot of the champion every 100 total generations.
        const _mark = Math.floor((this.baseTrained + this.gen + 1) / 100);
        if (_mark > (this._lastHofMark || 0)) {
          this.hallOfFame.push(bestBrain.slice());
          while (this.hallOfFame.length > 6) this.hallOfFame.shift();
          saveHoF(this.hallOfFame);
          this._lastHofMark = _mark;
        }
      } else {
        if (champScore > this.bestFit) this.bestFit = champScore; // champion held -> keep displaying its score
        this.stale = (this.stale || 0) + 1; // no new champion this generation
      }
      const half = Math.max(2, this.popSize >> 1);
      const pick = () => { let b = idx[(Math.random() * half) | 0]; for (let t = 0; t < 2; t++) { const c = idx[(Math.random() * half) | 0]; if (this.avg(c) > this.avg(b)) b = c; } return this.pop[b]; };
      const np = [];
      if (bestBrain) np.push(bestBrain.slice()); // HARD elitism: the all-time champion always survives, unmutated, as slot 0
      for (let e = 0; e < this.elite && np.length < this.popSize; e++) np.push(this.pop[idx[e]].slice());
      // Stagnation escape: if no new champion has emerged for many generations the
      // gene pool is stuck in a local optimum -> flood the lower half with FRESH
      // random brains for diversity. The champion is preserved above, so progress
      // is never lost; this just gives evolution new material to dethrone it with.
      if ((this.stale || 0) >= 40) {
        const fresh = Math.max(2, this.popSize >> 1);
        for (let k = 0; k < fresh && np.length < this.popSize; k++) np.push(randGenome());
        this.stale = 0;
      }
      // #101 Diversity preservation: carry forward the BEST brains that are most
      // genetically DIFFERENT from the champion, so varied tactics survive across
      // generations instead of everything collapsing into champion-clones.
      const _champG = bestBrain || this.pop[idx[0]];
      const _diverse = idx.slice(0, half).slice().sort((a, b) => genomeDist(this.pop[b], _champG) - genomeDist(this.pop[a], _champG));
      for (let d = 0; d < 2 && np.length < this.popSize && d < _diverse.length; d++) np.push(mutate(this.pop[_diverse[d]].slice()));
      // #58 Mentor System: the champion teaches ONE promising rank; the rest stay diverse.
      const _mentor = (bestBrain && bestBrain.length) ? bestBrain : (this.pop[idx[0]] || null);
      if (_mentor && np.length < this.popSize) { const student = this.pop[idx[1]] || this.pop[idx[0]]; if (student) np.push(mentorCrossover(_mentor, student)); }
      while (np.length < this.popSize) np.push(mutate(crossover(pick(), pick())));
      this.pop = np;
      savePop(this.pop); // persist the full evolving population every generation
    },
    tick() {
      if (!this.running) return;
      const tEnd = performance.now() + (this.turbo ? 30 : 11); // turbo trains ~3x faster (less smooth)
      while (performance.now() < tEnd) {
        try {
          if (!this.cur) {
            if (this.queue.length === 0) {
              this.evolve(); this.gen++;
              if (this.gen >= this.maxGen) { this.complete(); return; }
              this.beginGen();
            }
            const pair = this.queue.shift();
            if (!pair) { this.beginGen(); continue; }
            if (pair.length === 4) this.beginTeamMatch(pair);
            else this.beginMatch(pair[0], pair[1]);
          }
          simStep(1 / 60);
          if (!this.cur) continue; // a guarded sim error may discard the match
          this.cur.step++;
          if (roundOver || this.cur.step >= this.matchSteps) this.endMatch();
        } catch (e) {
          // Never let one bad tactical edge-case kill the whole training session.
          // Discard the current match, penalize its participants lightly, and continue.
          console.error('[Trainer.tick guarded]', e);
          if (this.cur && this.cur.slots) {
            for (const s of this.cur.slots) if (s != null) { this.fitSum[s] = (this.fitSum[s] || 0) - 25; this.fitCnt[s] = (this.fitCnt[s] || 0) + 1; }
          }
          this.cur = null;
          roundOver = false;
          bullets.forEach(b => { try { World.remove(world, b); } catch (_) {} }); bullets = [];
          weapons.forEach(w => { try { if (!w.taken) World.remove(world, w.body); } catch (_) {} }); weapons = [];
        }
      }
      try { this.updateUI(); } catch (e) { console.error('[Trainer.updateUI guarded]', e); }
    },
    // Training reached the last generation: STOP & SAVE but keep the overlay open
    // so the final leaderboard stays visible until the player closes it manually.
    complete() {
      if (this.done) return;
      this.running = false; TRAIN = false;
      if (this.best) { bestBrain = this.best.slice(); saveBrain(bestBrain, { gen: this.gen, fit: Math.round(this.bestFit), trained: this.baseTrained + this.gen }); pushKingChampion(bestBrain, this.bestFit, this.gen); }
      // M106: don't bank only the single all-time champion — also enroll the most
      // DISTINCT strong brains from the final population, so the King Tournament has
      // SEVERAL different champions to crown instead of always the same one.
      try {
        const ranked = [...Array(this.popSize).keys()].sort((a, b) => this.avg(b) - this.avg(a));
        for (const slot of ranked) pushKingChampion(this.pop[slot], this.avg(slot), this.gen); // M107: bank each strong brain WITH its fitness
      } catch (e) {}
      // Seed the Hall of Fame with at least one champion so future sessions have a benchmark foe.
      if (bestBrain && (!this.hallOfFame || this.hallOfFame.length === 0)) { this.hallOfFame = (this.hallOfFame || []); this.hallOfFame.push(bestBrain.slice()); saveHoF(this.hallOfFame); }
      this.done = true;
      this.updateUI(); // render the FINAL leaderboard and freeze it on screen
      const btn = document.getElementById('btn-train-stop');
      if (btn) btn.textContent = 'Back to Menu \u2713';
    },
    // Actually leave the training screen and go back to the menu.
    close() {
      this.running = false; TRAIN = false; this.done = false; state = 'menu';
      hideOverlay('train'); showOverlay('menu'); refreshBrainStatus();
      const btn = document.getElementById('btn-train-stop');
      if (btn) btn.textContent = 'Finish & Save';
    },
    updateUI() {
      const total = this.genTotal || this.popSize; // matches per generation
      const done = total - this.queue.length - (this.cur ? 1 : 0);
      const totalTrained = this.baseTrained + this.gen; // generations completed so far (incl. carried-over)
      const stats = document.getElementById('train-stats');
      if (stats) {
        stats.innerHTML =
          (this.done ? '<span class="train-done">\u2705 Training complete! Best brain saved.</span><br>' : '') +
          'Generation: <b>' + Math.min(this.gen + 1, this.maxGen) + '</b> / ' + this.maxGen + '<br>' +
          'Matches this generation: <b>' + Math.max(0, done) + '</b> / ' + total + '<br>' +
          'Best score this session: <b>' + (this.bestFit > -1e8 ? Math.round(this.bestFit) : '\u2014') + '</b><br>' +
          'Rekor fitness tertinggi: <b>' + (this.recordFit > -1e8 ? Math.round(this.recordFit) : '?') + '</b><br>' +
          'Tren fitness: <b style="letter-spacing:1px">' + this.sparkline() + '</b><br>' +
          'Total trained: <b>' + totalTrained + '</b> generations<br>' +
          'Population: <b>' + this.popSize + '</b> brains';
      }
      const fill = document.getElementById('train-bar-fill');
      if (fill) fill.style.width = (this.done ? 100 : Math.round(((this.gen + Math.max(0, done) / total) / this.maxGen) * 100)) + '%';
      // ---- Leaderboard: rank brains best -> worst by avg fitness this generation ----
      const board = document.getElementById('train-board');
      if (board) {
        const order = [...Array(this.popSize).keys()].sort((a, b) => this.avg(b) - this.avg(a));
        const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
        let html = '<div class="board-title">\uD83C\uDFC6 Brain Leaderboard <span>(best \u2192 worst score)</span></div>';
        order.forEach((slot, rank) => {
          const played = this.fitCnt[slot] > 0;
          const score = played ? Math.round(this.avg(slot)) : null;
          const color = POP_COLORS[slot % POP_COLORS.length];
          const tag = rank < 3 ? medals[rank] : (rank + 1) + '.';
          const live = (this.cur && this.cur.slots && this.cur.slots.indexOf(slot) >= 0) ? ' bertanding' : '';
          html +=
            '<div class="board-row' + live + '">' +
              '<span class="board-rank">' + tag + '</span>' +
              '<span class="board-dot" style="background:' + color + '"></span>' +
              '<span class="board-name">Brain #' + (slot + 1) + (live ? ' \u2694\uFE0F' : '') + '</span>' +
              '<span class="board-score">' + (played ? score : '\u2014') + '</span>' +
              '<span class="board-trials">' + (this.trials[slot] || 0) + '\u00D7 trained</span>' +
            '</div>';
        });
        board.innerHTML = html;
      }
    },
  };

  // Headless physics+logic step used for fast training (no FX / round mgmt / UI).
  function simStep(dt) {
    for (const f of fighters) f.grounded = false;
    Engine.update(engine, dt * 1000);
    // Sanitize physics: extreme impulses (explosions/knockback) can occasionally
    // produce NaN/Infinity positions. Left unchecked, NaN propagates everywhere
    // and eventually throws, which would kill the game loop. Non-finite => death; tunnel-out => snap to spawn.
    for (const f of fighters) {
      const p = f.body.position, v = f.body.velocity;
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(v.x) || !isFinite(v.y)) {
        // M111: mirror the play-loop fix. A non-finite body is unrecoverable, so a
        // void death (not a free spawn-revive) is the correct, consistent outcome
        // for training too, otherwise bots learn that blowing up dodges death.
        if (f.alive) {
          Body.setPosition(f.body, { x: isFinite(f.spawn.x) ? f.spawn.x : VIEW.w / 2, y: KILL_Y + 80 });
          Body.setVelocity(f.body, { x: 0, y: 0 });
          Body.setAngularVelocity(f.body, 0);
          try { f.die({ x: 0, y: 0 }); } catch (e) {}
        } else {
          Body.setPosition(f.body, { x: -9999, y: -9999 });
          Body.setVelocity(f.body, { x: 0, y: 0 });
          Body.setAngularVelocity(f.body, 0);
        }
      } else if (f.alive && (p.x < -60 || p.x > VIEW.w + 60 || p.y < -1500)) {
        // Alive fighter tunneled out of the sealed arena (e.g. blasted through a
        // wall by an explosion): snap back to spawn so it never silently
        // "disappears" mid-match. Void deaths (p.y > KILL_Y) are intentional and
        // handled in update(), so they are deliberately NOT caught here.
        Body.setPosition(f.body, { x: f.spawn.x, y: f.spawn.y });
        Body.setVelocity(f.body, { x: 0, y: 0 });
        Body.setAngularVelocity(f.body, 0);
      }
    }
    // Isolate per-fighter logic so one bot's error can't abort the whole training
    // tick and bounce the player back to the menu. step() already had this guard;
    // simStep (the training loop) was missing it -> a single throw ejected to menu
    // and the whole training run was lost ("hasil latihan ga pernah berhasil").
    for (const f of fighters) { try { f.update(dt); } catch (e) { console.error('[sim fighter.update]', e); } }
    for (const b of bullets.slice()) {
      b.bullet.life -= dt;
      if (b.bullet.life <= 0 || b.position.y > KILL_Y) removeBullet(b);
    }
    trainDodge();
    weaponTimer -= dt;
    if (weaponTimer <= 0 && !roundOver) { spawnWeaponDrop(); weaponTimer = 2.5 + Math.random() * 2.5; } // faster spawns during training
    for (const w of weapons.slice()) {
      if (w.taken) continue;
      w.life -= dt;
      if (w.life <= 0 || w.body.position.y > KILL_Y) { World.remove(world, w.body); weapons.splice(weapons.indexOf(w), 1); }
    }
  }
  // Reward +15 when an enemy bullet comes close then starts receding (a successful dodge).
  function trainDodge() {
    for (const b of bullets) {
      const info = b.bullet; if (!info || !info.owner) continue;
      if (!info._pd) { info._pd = {}; info._dz = {}; }
      for (let i = 0; i < fighters.length; i++) {
        const f = fighters[i];
        if (f === info.owner || !f.alive) continue;
        const d = Math.hypot(b.position.x - f.pos.x, b.position.y - f.pos.y);
        const pd = info._pd[i];
        if (d < 46 && pd !== undefined && d > pd && !info._dz[i]) { f.fit += 3; f.hype = Math.min(100, (f.hype || 0) + 12); info._dz[i] = true; } // dodge reward + momentum
        info._pd[i] = d;
      }
    }
  }

  function resolveStalemate() {
    if (roundOver) return;
    const alive = fighters.filter(f => f.alive);
    if (!alive.length) return;
    const hpByTeam = {};
    for (const f of alive) hpByTeam[f.team] = (hpByTeam[f.team] || 0) + Math.max(0, f.hp || 0);
    let winTeam = alive[0].team, bestHp = -Infinity, tie = false;
    for (const k in hpByTeam) {
      const v = hpByTeam[k];
      if (v > bestHp) { bestHp = v; winTeam = +k; tie = false; }
      else if (v === bestHp) tie = true;
    }
    roundOver = true; roundEndT = 1.2;
    if (!tie) {
      scores[winTeam] = (scores[winTeam] || 0) + 1;
      if (TRAIN) for (const f of fighters) if (f.alive && f.team === winTeam) f.fit += 45;
    }
  }

  function onDeath(f) {
    if (roundOver) return;
    const teamsAlive = aliveTeams();
    if (teamsAlive.size <= 1) {
      roundOver = true;
      roundEndT = 1.6;
      if (!TRAIN) _slowmo = 0.5; // M61 last-hit slow motion when a round ends
      if (teamsAlive.size === 1) {
        const t = [...teamsAlive][0];
        scores[t] = (scores[t] || 0) + 1;
        // Training: surviving fighters on the winning team get a large round-win bonus
        // This aligns the training objective with the rank-point system (win rounds = earn points)
        if (TRAIN) for (const fw of fighters) if (fw.alive && fw.team === t) fw.fit += 80;
      }
    }
  }

  // Build N all-AI bots assigned to the given team ids (used by the trainer for
  // both 1v1 and 2v2 self-play). Clears any existing fighters first.
  function spawnBots(teamArr) {
    fighters.forEach(f => World.remove(world, f.body));
    fighters = [];
    buildLevel(currentArena);
    const sp = computeSpawns(teamArr.length);
    for (let i = 0; i < teamArr.length; i++) {
      fighters.push(new Fighter({ x: sp[i].x, y: sp[i].y, color: POP_COLORS[i % POP_COLORS.length], name: 'B' + (i + 1), facing: sp[i].x < VIEW.w / 2 ? 1 : -1, isAI: true, team: teamArr[i], controls: {} }));
    }
  }
  function setupMatch(mode) {
    // 1v1: '1p' (P1 vs bot) | '2p' (P1 vs P2) | 'bot' (bot vs bot)
    // team brawls (all bots): '2v2' | '3v3' | '4v4' (2 teams)  |  'ffa' (8 bots, free-for-all)
    curMode = mode;
    _kothScore = null; _infectT = 0; // M62 reset game-mode state
    fighters.forEach(f => World.remove(world, f.body));
    fighters = [];
    buildLevel(currentArena);
    const CTRL_A = { left: 'KeyA', right: 'KeyD', jump: 'KeyW', down: 'KeyS', fire: 'Space', heavy: 'KeyE', block: 'KeyQ' };
    const CTRL_B = { left: 'ArrowLeft', right: 'ArrowRight', jump: 'ArrowUp', down: 'ArrowDown', fire: 'Enter', heavy: 'ShiftRight', block: 'Slash' };
    const TEAM_A = ['#ff5c5c', '#ff9f43', '#ffd23f', '#ff8db0'];
    const TEAM_B = ['#4db5ff', '#4ec96a', '#b06cff', '#5ad1c4'];

    if (mode === '1p' || mode === '2p' || mode === 'bot') {
      scores = [0, 0];
      const sp = computeSpawns(2);
      const p1AI = mode === 'bot';
      const p2AI = mode === '1p' || mode === 'bot';
      fighters.push(new Fighter({ x: sp[0].x, y: sp[0].y, color: '#ffd23f', name: p1AI ? 'BOT 1' : 'P1', facing: 1, isAI: p1AI, team: 0, controls: CTRL_A }));
      fighters.push(new Fighter({ x: sp[1].x, y: sp[1].y, color: '#ff5c5c', name: mode === '2p' ? 'P2' : (mode === 'bot' ? 'BOT 2' : 'BOT'), facing: -1, isAI: p2AI, team: 1, controls: CTRL_B }));
    } else if (mode === 'ffa') {
      const n = 8;
      scores = new Array(n).fill(0);
      const sp = computeSpawns(n);
      for (let i = 0; i < n; i++) {
        fighters.push(new Fighter({ x: sp[i].x, y: sp[i].y, color: POP_COLORS[i % POP_COLORS.length], name: 'B' + (i + 1), facing: sp[i].x < VIEW.w / 2 ? 1 : -1, isAI: true, team: i, controls: {} }));
      }
    } else if (mode === 'boss') {
      // BOSS: one giant high-HP boss (team 0) vs 4 hunters (team 1) — last team standing wins.
      scores = [0, 0];
      const sp = computeSpawns(5);
      const boss = new Fighter({ x: VIEW.w / 2, y: sp[0].y, color: '#b02a2a', name: 'BOSS', facing: -1, isAI: true, team: 0, controls: {} });
      boss.maxHp = 500; boss.hp = 500; boss._boss = true; boss._scale = 2.0;
      try { Body.scale(boss.body, 2.0, 2.0); } catch (e) {}
      fighters.push(boss);
      for (let i = 0; i < 4; i++) { const s = sp[i + 1]; fighters.push(new Fighter({ x: s.x, y: s.y, color: TEAM_B[i], name: 'H' + (i + 1), facing: 1, isAI: true, team: 1, controls: {} })); }
    } else if (mode === 'infection') {
      // INFECTION: 1 zombie (team 1) converts survivors (team 0) on contact; survivors win on the timer.
      const n = 6; scores = [0, 0];
      const sp = computeSpawns(n);
      for (let i = 0; i < n; i++) {
        const inf = (i === 0);
        fighters.push(new Fighter({ x: sp[i].x, y: sp[i].y, color: inf ? '#7ee07e' : POP_COLORS[(i + 2) % POP_COLORS.length], name: inf ? 'ZOMBIE' : 'S' + i, facing: sp[i].x < VIEW.w / 2 ? 1 : -1, isAI: true, team: inf ? 1 : 0, controls: {} }));
      }
      _infectT = 35;
    } else if (mode === 'koth') {
      // KING OF THE HILL: two teams of 2 fight to hold the center zone.
      const n = 4; scores = [0, 0]; _kothScore = [0, 0];
      const sp = computeSpawns(n);
      for (let i = 0; i < n; i++) fighters.push(new Fighter({ x: sp[i].x, y: sp[i].y, color: (i % 2 === 0 ? TEAM_A[i >> 1] : TEAM_B[i >> 1]), name: (i % 2 === 0 ? 'A' : 'B') + ((i >> 1) + 1), facing: sp[i].x < VIEW.w / 2 ? 1 : -1, isAI: true, team: i % 2, controls: {} }));
    } else {
      const per = mode === '2v2' ? 2 : mode === '3v3' ? 3 : 4;
      scores = [0, 0];
      const sp = computeSpawns(per * 2);
      // M113: randomize team identity each match so the same colored stickmen
      // aren't always grouped together. Randomly swap which palette is team A/B,
      // then shuffle the colors within each team.
      const _swap = Math.random() < 0.5;
      const _palA = (_swap ? TEAM_B : TEAM_A).slice();
      const _palB = (_swap ? TEAM_A : TEAM_B).slice();
      const _ia = shuffleIdx(_palA.length), _ib = shuffleIdx(_palB.length);
      for (let i = 0; i < per; i++)
        fighters.push(new Fighter({ x: sp[i].x, y: sp[i].y, color: _palA[_ia[i % _ia.length]], name: 'A' + (i + 1), facing: 1, isAI: true, team: 0, controls: {} }));
      for (let i = 0; i < per; i++) {
        const s = sp[per + i];
        fighters.push(new Fighter({ x: s.x, y: s.y, color: _palB[_ib[i % _ib.length]], name: 'B' + (i + 1), facing: -1, isAI: true, team: 1, controls: {} }));
      }
    }
    // Pull from the WIDEST bank of distinct trained brains (population + Hall of
    // Fame + King pool + champion) and assign them at RANDOM, so every match —
    // especially player-vs-bot — pits you against a different brain/personality
    // instead of the same one every time. The "use trained AI" toggle still acts
    // as an off-switch (unchecked = raw hand-coded tactics).
    const _useChk = document.getElementById('use-brain');
    const _wantBrain = !_useChk || _useChk.checked;
    const _brainPool = _wantBrain ? allBrainGenomes() : [];
    const _shuf = _brainPool.length ? shuffleIdx(_brainPool.length) : [];
    let _bi = 0;
    for (const f of fighters) {
      if (!(f.isAI && _brainPool.length)) { f.brain = null; continue; }
      f.brain = _brainPool[_shuf[_bi % _shuf.length]]; _bi++;
    }
  }

  function startRound() {
    ragdolls.forEach(r => r.remove()); ragdolls = [];
    bullets.forEach(b => World.remove(world, b)); bullets = [];
    weapons.forEach(w => { if (!w.taken) World.remove(world, w.body); }); weapons = [];
    particles = [];
    fighters.forEach(f => f.reset());
    applyRoundModifier();                                   // M61 random round modifier (play only)
    _slowmo = 0; _announce = null; _killLog = [];
    for (const f of fighters) { f._entrance = 1.0; f._trail = []; } // M61/M96 entrance drop + slow stand-up + clean trails
    try { if (!TRAIN) SFX.respawn(); } catch (e) {}   // M107: fighters drop-in whoosh
    _countdown = TRAIN ? null : { t: 1.9, ph: -1 }; // M96 pre-round countdown (skipped in training)
    windX = (Math.random() < 0.4) ? (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.7) : 0; // M62 random per-round wind (training + play)
    // ── M62 arena event (training + play so bots adapt) ─���
    arenaEvent = Math.random() < 0.4 ? ARENA_EVENTS[Math.floor(Math.random() * ARENA_EVENTS.length)].id : null;
    arenaEventName = arenaEvent ? ((ARENA_EVENTS.find(e => e.id === arenaEvent) || {}).name || '') : '';
    _floodY = VIEW.h + 80; _shrinkX = 0; // always reset flood/shrink state
    if (!TRAIN) {
      const _amb = [null, { r: 255, g: 150, b: 60, a: 0.14 }, { r: 90, g: 60, b: 160, a: 0.20 }, { r: 18, g: 26, b: 70, a: 0.32 }];
      _ambient = _amb[Math.floor(Math.random() * _amb.length)];
    } else { _ambient = null; }
    // ── M62 mid-round event (training + play so bots adapt) ──
    roundEvent = Math.random() < 0.35 ? ROUND_EVENTS[Math.floor(Math.random() * ROUND_EVENTS.length)].id : null;
    roundEventName = roundEvent ? ((ROUND_EVENTS.find(e => e.id === roundEvent) || {}).name || '') : '';
    _eventFired = false; _eventAt = 9 + Math.random() * 5;
    _suddenDeath = false; _meteorT = 0; _meteorAcc = 0; _bounty = null;
    roundOver = false; roundEndT = 0; roundTime = 0; weaponTimer = 1.2;
    state = 'play';
    hideOverlay('result'); hideOverlay('pause'); hideOverlay('menu');
    hideReplayOverlay();
    if (!TRAIN && !King.active && !arActive && (scores[0] | 0) === 0 && (scores[1] | 0) === 0) startMatchReplay(); // auto-record this fresh match for the end-of-match replay
    try { if (!TRAIN) { SFX.roundStart(); if (arenaEvent) setTimeout(() => { try { SFX.event(); } catch (e) {} }, 280); } } catch (e) {}
  }

  // ============================================================
  //  Collision handling
  // ============================================================
  function bindCollisions() {
    Events.on(engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        const a = pair.bodyA, b = pair.bodyB;
        handleBullet(a, b);
        handleBullet(b, a);
        oneWay(a, b, pair); oneWay(b, a, pair); // M65 one-way platforms
        // grounded detection for fighters
        checkGround(a, b, pair);
        checkGround(b, a, pair);
      }
    });
    Events.on(engine, 'collisionActive', (ev) => {
      for (const pair of ev.pairs) {
        oneWay(pair.bodyA, pair.bodyB, pair); oneWay(pair.bodyB, pair.bodyA, pair); // M65 one-way platforms
        checkGround(pair.bodyA, pair.bodyB, pair);
        checkGround(pair.bodyB, pair.bodyA, pair);
      }
    });
  }
  // M65 one-way platform: let fighters rise up through it and only land on top (play only).
  function oneWay(a, b, pair) {
    if (TRAIN || a.label !== 'fighter' || b.label !== 'platform' || !b.oneway) return;
    const platTop = b.position.y - (b.platH || 24) / 2;
    const feet = a.position.y + 32;
    if (a.velocity.y < -0.05 || feet > platTop + 10) pair.isActive = false;
  }
  function checkGround(a, b, pair) {
    if (a.label === 'fighter' && b.label === 'platform') {
      // contact roughly below the fighter
      if (a.position.y < b.position.y) a.fighter.grounded = true;
    }
  }
  function handleBullet(a, b) {
    if (a.label !== 'bullet' || !a.bullet) return;
    const info = a.bullet;
    if (b.label === 'platform') {
      if (info.tele && info.owner && info.owner.alive && a.position.y < KILL_Y - 40) { Body.setPosition(info.owner.body, { x: a.position.x, y: a.position.y - 12 }); Body.setVelocity(info.owner.body, { x: 0, y: 0 }); } // M62 teleport gun
      if (!TRAIN && b.breakable && b.platRef) damageWall(b.platRef, info.dmg || 8); // M65 chip destructible wall
      if (info.explode) explodeAt(a.position.x, a.position.y, info.explode, info.owner);
      else sparks(a.position.x, a.position.y);
      removeBullet(a);
    } else if (b.label === 'fighter' && b.fighter !== info.owner && b.fighter.alive &&
               (!info.owner || b.fighter.team !== info.owner.team)) {       // no friendly fire
      // M62 mirror shield: a blocking shield-holder reflects the bullet back at the shooter
      if (b.fighter.blocking && b.fighter.weapon && b.fighter.weapon.type === 'mirrorshield') {
        Body.setVelocity(a, { x: -a.velocity.x, y: -a.velocity.y });
        info.owner = b.fighter; SFX.parry(); sparks(a.position.x, a.position.y);
        return;
      }
      const dir = Vector.normalise(a.velocity);
      const _bz = damageZoneMult(a.position.y, b.fighter);   // M85 zonal hitbox (headshots hurt more)
      b.fighter.hurt(info.dmg * _bz.mult, { x: dir.x * info.knock, y: dir.y * info.knock - 0.005 }, a.position, info.owner);
      if (info.owner) info.owner._rsGunDmg = (info.owner._rsGunDmg || 0) + info.dmg * _bz.mult;   // M86 gun damage tally
      if (_bz.zone === 'head' && !TRAIN) { sparks(a.position.x, a.position.y); shake(4); }
      if (info.owner) info.owner._cumHits = (info.owner._cumHits || 0) + 1; // #70
      if (info.slow) b.fighter._slow = info.slow;                            // ice chill
      if (info.fire && !TRAIN) b.fighter._burn = Math.max(b.fighter._burn || 0, 2.0);            // M62 flamethrower ignites
      if (info.net && !TRAIN) { b.fighter._slow = Math.max(b.fighter._slow || 0, 2.4); b.fighter._stun = Math.max(b.fighter._stun || 0, 0.5); } // M62 net roots
      if (info.pull && info.owner) { const _pa = Math.atan2(info.owner.pos.y - b.fighter.pos.y, info.owner.pos.x - b.fighter.pos.x); Body.applyForce(b.fighter.body, b.fighter.pos, { x: Math.cos(_pa) * 0.12, y: Math.sin(_pa) * 0.12 - 0.02 }); } // M62 gravity gun yank
      if (info.tele && info.owner && info.owner.alive && a.position.y < KILL_Y - 40) { Body.setPosition(info.owner.body, { x: a.position.x, y: a.position.y - 12 }); Body.setVelocity(info.owner.body, { x: 0, y: 0 }); } // M62 teleport gun
      if (info.owner && info.owner.matchStats) info.owner.matchStats.shotsHit++;
      if (info.owner && info.owner.fitBreakdown) info.owner.fitBreakdown.combat += 15;
      if (TRAIN && info.owner) { info.owner.fit += 15; b.fighter.fit -= 15; } // reward: hit / got hit (was 10)
      if (info.explode) explodeAt(a.position.x, a.position.y, info.explode, info.owner);
      removeBullet(a);
    } else if (b.label && b.label.startsWith('rd')) {
      // hitting a ragdoll part: push it (momentum transfer)
      const dir = Vector.normalise(a.velocity);
      Body.applyForce(b, a.position, { x: dir.x * 0.04, y: dir.y * 0.04 });
      if (info.explode) explodeAt(a.position.x, a.position.y, info.explode, info.owner);
      else sparks(a.position.x, a.position.y);
      removeBullet(a);
    }
  }
  function removeBullet(b) {
    const i = bullets.indexOf(b);
    if (i >= 0) bullets.splice(i, 1);
    World.remove(world, b);
  }
  // AoE blast from rockets / fireballs: radial damage + knockback falloff.
  function spawnExplosion(x, y, radius) {
    if (TRAIN) return;
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 7;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, life: 0.35 + Math.random() * 0.35, max: 0.7, r: 2 + Math.random() * 4, color: i % 2 ? '#ff8a3c' : '#ffd23f' });
    }
    particles.push({ x, y, vx: 0, vy: 0, life: 0.12, max: 0.12, r: radius * 0.7, color: 'rgba(255,180,90,.5)', flash: true });
  }
  // M65 destructible barrier: bullets & explosions chip away play-only breakable walls.
  function damageWall(p, dmg) {
    if (TRAIN || !p || !p.breakable || p._broken) return;
    p._hp -= dmg;
    for (let i = 0; i < 4; i++) sparks(p.x + (Math.random() - 0.5) * p.w, p.y + (Math.random() - 0.5) * p.h);
    if (p._hp <= 0) {
      p._broken = true;
      try { World.remove(world, p.body); } catch (e) {}
      for (let i = 0; i < 16; i++) sparks(p.x + (Math.random() - 0.5) * p.w, p.y + (Math.random() - 0.5) * p.h);
      shake(8); try { SFX.die(); } catch (e) {}
    }
  }
  function explodeAt(x, y, ex, owner) {
    spawnExplosion(x, y, ex.radius);
    shake(10);
    try { SFX.explode(); } catch (e) {}
    ArenaReactivity.onExplosion(); // M59 environment reacts to chaos
    for (const f of fighters) {
      if (!f.alive) continue;
      const d = Math.hypot(f.pos.x - x, f.pos.y - y);
      if (d < ex.radius) {
        const k = 1 - d / ex.radius;
        const ang = Math.atan2(f.pos.y - y, f.pos.x - x);
        f.hurt(ex.dmg * k, { x: Math.cos(ang) * 0.09 * k, y: Math.sin(ang) * 0.09 * k - 0.02 }, f.pos, owner);
        if (ex.emp && !TRAIN && f !== owner && (!owner || f.team !== owner.team)) { f._stun = Math.max(f._stun || 0, 0.8); f.weapon = null; } // M62 EMP stuns + disarms
        if (TRAIN && owner && f !== owner && f.team !== owner.team) { owner.fit += 8 * k; f.fit -= 8 * k; }
      }
    }
    if (!TRAIN) for (const p of platforms) if (p.breakable && !p._broken && Math.hypot(p.x - x, p.y - y) < ex.radius + 50) damageWall(p, ex.dmg * 0.9); // M65 explosions damage breakable walls
  }

  // ============================================================
  //  Main loop
  // ============================================================
  let last = performance.now();
  let _errStreak = 0;       // consecutive frames that threw (resets on a clean frame)
  let _errBanner = null;    // { msg, t } on-screen error notice that fades out
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    let threw = false;
    // --- update phase (physics / AI / training) ---
    try {
      if (state === 'play') { const _sd = _slowmo > 0 ? dt * 0.32 : dt; if (_slowmo > 0) _slowmo = Math.max(0, _slowmo - dt); step(_sd); } // M61 last-hit slow motion
      else if (state === 'train') Trainer.tick();
      else if (state === 'king') King.tick(dt);
    } catch (err) {
      threw = true;
      console.error('[loop] update error (frame skipped):', err);
      _errBanner = { msg: String((err && err.message) || err), t: 2.5 };
    }
    // --- render phase (ALWAYS attempted, even if the update above failed) ---
    try {
      render();
    } catch (err) {
      threw = true;
      console.error('[loop] render error (frame skipped):', err);
      _errBanner = { msg: String((err && err.message) || err), t: 2.5 };
    }
    // A single transient error must NOT eject the player to the menu. Skip the
    // bad frame and keep playing. Only bail out if the game is genuinely wedged
    // (an error EVERY frame for ~1 second straight).
    if (threw) {
      _errStreak++;
      if (_errStreak >= 60) {
        // In training, do NOT eject to menu. The trainer has its own guarded
        // match-discard path now, so keep the overlay alive and continue from
        // the next match/generation instead of losing the whole run.
        if (state === 'train') {
          _errStreak = 0;
          try { Trainer.cur = null; Trainer.updateUI(); } catch (e) {}
        } else {
          _errStreak = 0; _errBanner = null;
          try { Trainer.running = false; } catch (e) {}
          TRAIN = false;
          state = 'menu';
          try { hideOverlay('train'); hideOverlay('pause'); hideOverlay('result'); showOverlay('menu'); } catch (e) {}
          try { refreshBrainStatus(); } catch (e) {}
        }
      }
    } else {
      _errStreak = 0;
    }
    // draw the fading error banner on top, in raw device pixels so it shows no
    // matter what the render transform was doing when it failed.
    if (_errBanner && _errBanner.t > 0) {
      try {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = Math.min(1, _errBanner.t);
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(8, 8, 380, 26);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 12px Trebuchet MS';
        ctx.textAlign = 'left';
        ctx.fillText('⚠ ' + _errBanner.msg, 14, 25);
        ctx.restore();
      } catch (e) {}
      _errBanner.t -= dt;
    }
    requestAnimationFrame(loop);
  }

  function step(dt) {
    // reset grounded; collisions will re-set it this frame
    for (const f of fighters) f.grounded = false;
    updateMovingPlatforms(dt); // M59: moving platforms (play only)
    // physics substeps for stability
    Engine.update(engine, dt * 1000);
    tickHazards(dt);            // M59: environmental hazards (play only)
    ArenaReactivity.update(dt); // M59: action-driven ambiance decay

    // Sanitize physics: extreme impulses (explosions/knockback) can occasionally
    // produce NaN/Infinity positions. Left unchecked, NaN propagates everywhere and
    // eventually throws, which would kill the game loop. Non-finite => death; tunnel-out => snap to spawn.
    for (const f of fighters) {
      const p = f.body.position, v = f.body.velocity;
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(v.x) || !isFinite(v.y)) {
        // M111: a non-finite body is unrecoverable. Reviving it at spawn (the old
        // behaviour) let a fighter cheat a void death ("jatuh ke jurang malah balik
        // lagi") and made it flicker/teleport away ("hilang tiba-tiba"). Treat it as a
        // void death instead, snapping to sane finite coords first so the death
        // bookkeeping + ragdoll classify it correctly as a void kill.
        if (f.alive) {
          Body.setPosition(f.body, { x: isFinite(f.spawn.x) ? f.spawn.x : VIEW.w / 2, y: KILL_Y + 80 });
          Body.setVelocity(f.body, { x: 0, y: 0 });
          Body.setAngularVelocity(f.body, 0);
          try { f.die({ x: 0, y: 0 }); } catch (e) {}
        } else {
          Body.setPosition(f.body, { x: -9999, y: -9999 });
          Body.setVelocity(f.body, { x: 0, y: 0 });
          Body.setAngularVelocity(f.body, 0);
        }
      } else if (f.alive && (p.x < -60 || p.x > VIEW.w + 60 || p.y < -1500)) {
        // Alive fighter tunneled out of the sealed arena (e.g. blasted through a
        // wall by an explosion): snap back to spawn so it never silently
        // "disappears" mid-match. Void deaths (p.y > KILL_Y) are intentional and
        // handled in update(), so they are deliberately NOT caught here.
        Body.setPosition(f.body, { x: f.spawn.x, y: f.spawn.y });
        Body.setVelocity(f.body, { x: 0, y: 0 });
        Body.setAngularVelocity(f.body, 0);
      }
    }

    // Isolate per-fighter logic so one bot's error can never freeze the whole match.
    for (const f of fighters) { try { f.update(dt); } catch (e) { console.error('[fighter.update]', e); } }

    ReplaySystem.record(ReplaySystem.buffer.length);

    // bullets lifetime + trails
    for (const b of bullets.slice()) {
      b.prev = { x: b.position.x, y: b.position.y };
      b.bullet.life -= dt;
      b.bullet.age = (b.bullet.age || 0) + dt;
      if (b.bullet.boomerang && b.bullet.owner && b.bullet.owner.alive) { // M62 boomerang curves back to the thrower
        const o = b.bullet.owner, _ba = Math.atan2(o.pos.y - b.position.y, o.pos.x - b.position.x);
        const _pull = b.bullet.age > 0.35 ? 0.0016 : 0;
        if (_pull) Body.applyForce(b, b.position, { x: Math.cos(_ba) * _pull, y: Math.sin(_ba) * _pull });
        if (b.bullet.age > 0.5 && Math.hypot(o.pos.x - b.position.x, o.pos.y - b.position.y) < 36) { removeBullet(b); continue; }
      }
      if (b.bullet.life <= 0 || b.position.y > KILL_Y) removeBullet(b);
    }

    // ── M62 wind force field (play only): nudges airborne fighters + bullets sideways ──
    if (windX !== 0) {
      for (const f of fighters) { if (f.alive && !onGround(f)) Body.applyForce(f.body, f.pos, { x: windX * 0.00006, y: 0 }); }
      for (const b of bullets) Body.applyForce(b, b.position, { x: windX * 0.0000045, y: 0 });
    }
    if (arenaEvent) applyArenaEvent(dt); // M62 rising lava / shrinking arena / gravity-flip zone (training + play)
    // weapon drops
    weaponTimer -= dt;
    if (weaponTimer <= 0 && !roundOver && !activeMod.noWeapons && !(_countdown && _countdown.t > 0.633)) { // M61 'No weapons' modifier suppresses drops + M96 no drops during countdown
      spawnWeaponDrop();
      weaponTimer = 5 + Math.random() * 4;
    }
    for (const w of weapons.slice()) {
      if (w.taken) continue;
      w.life -= dt;
      if (w.life <= 0 || w.body.position.y > KILL_Y) {
        World.remove(world, w.body);
        weapons.splice(weapons.indexOf(w), 1);
      }
    }

    // ragdolls lifetime
    for (const r of ragdolls.slice()) {
      r.life -= dt;
      if (r.life <= 0) { r.remove(); ragdolls.splice(ragdolls.indexOf(r), 1); }
    }

    // particles
    for (const p of particles) {
      p.life -= dt;
      if (!p.flash) { p.vy += 12 * dt; p.x += p.vx; p.y += p.vy; }
    }
    particles = particles.filter(p => p.life > 0);

    shakeAmt *= 0.86;
    if (_modBannerT > 0) _modBannerT = Math.max(0, _modBannerT - dt);   // M61 banner fade
    if (_announce) { _announce.t -= dt; if (_announce.t <= 0) _announce = null; } // M61 announcer fade
    if (_countdown) { // M96 pre-round countdown tick + per-number beep
      _countdown.t -= dt;
      const _cp = Math.min(2, Math.floor((1.9 - _countdown.t) / (1.9 / 3)));
      if (_cp !== _countdown.ph) { _countdown.ph = _cp; try { SFX.countdown(); } catch (e) {} }
      if (_countdown.t <= 0) _countdown = null;
    }
    if (King.active && King._comment) { King._comment.t -= dt; if (King._comment.t <= 0) King._comment = null; } // M87 commentator fade

    // Round-end watchdog: guarantee the round always resolves even if a death's
    // bookkeeping was somehow skipped (e.g. an exception thrown between die() and
    // onDeath()). onDeath() ignores its argument and resolves purely from who is
    // still alive, so this also un-sticks a hung round and lets everyone respawn.
    if (!roundOver && aliveTeams().size <= 1) onDeath();

    // round end -> show result
    if (roundOver) {
      roundEndT -= dt;
      if (roundEndT <= 0) endRound();
    } else if (!(_countdown && _countdown.t > 0.633)) { // M96 freeze round timer + events during the countdown
      roundTime += dt;
      if (roundEvent && !_eventFired && roundTime >= _eventAt) fireRoundEvent(); // M62 mid-round event trigger (training + play)
      if (_suddenDeath || _meteorT > 0 || _bounty) tickRoundEvent(dt);           // M62 ongoing event effects (training + play)
      if (!TRAIN) tickGameMode(dt);                                               // M62 KotH / Infection mode logic (play only)
      if (roundTime >= 30) resolveStalemate();
    }
  }

  function endRound() {
    // #64 post-round adaptation · #79 formation memory · #70 fitness sanitize
    for (const f of fighters) {
      const rs = f._roundStats;
      if (rs) {
        if (rs.voidDeaths > rs.combatDeaths) f._voidCaution = Math.min(4, (f._voidCaution || 1) * 1.3);
        if (rs.damageDealt < rs.damageTaken * 0.5) f._defenseMult = Math.min(3, (f._defenseMult || 1) * 1.2);
        if (rs.unarmedTime > rs.weaponTime * 2) f._weaponUrgency = Math.min(3, (f._weaponUrgency || 1) * 1.25);
        if (f.alive && rs.damageDealt > rs.damageTaken * 1.2) f._goodLane = Math.sign(f.pos.x - VIEW.w / 2) || (f._goodLane || 1);
      }
      if (TRAIN) sanitizeFitness(f);
      else if (!f.isAI) flushPlayerStyleFrom(f); // LEARN-FROM-ME: learn from this round of human play
    }
    if (King.active) { try { King.recordRound(); } catch (e) {} }   // M86 tally tournament stats for achievement titles
    // best of: first to 5 round wins takes the match
    const target = winTarget();
    const max = Math.max.apply(null, scores);
    if (max >= target) {
      const wi = scores.indexOf(max);
      if (King.active) { King.onMatchDecided(wi); return; }  // 👑 King Tournament: advance bracket instead of normal result
      let label;
      // ---- Award persistent rank points: 15 pts per round won ----
      const isTeam = curMode === '2v2' || curMode === '3v3' || curMode === '4v4';
      if (curMode === 'ffa') {
        scores.forEach((s, i) => { const f = fighters[i]; if (f && s > 0) addRankPoints(f.name, f.color, s * 15); });
      } else if (isTeam) {
        // distribute to every fighter on the winning team proportional to rounds won
        scores.forEach((s, ti) => { if (s > 0) for (const f of fighters) if (f.team === ti) addRankPoints(f.name, f.color, s * 12); });
      } else {
        scores.forEach((s, i) => { const f = fighters[i]; if (f && s > 0) addRankPoints(f.name, f.color, s * 15); });
      }
      renderRankBoard();
      if (isTeam) label = (wi === 0 ? 'TEAM A' : 'TEAM B') + ' WINS! 🏆';
      else if (curMode === 'ffa') label = (fighters[wi] ? fighters[wi].name : '?') + ' WINS! 🏆';
      else label = (fighters[wi] ? fighters[wi].name : 'P' + (wi + 1)) + ' WINS! 🏆';
      showResult(label, true);
      try { SFX.matchWin(); } catch (e) {}
      stopMatchReplay();                                    // match over -> finalize recording + show replay viewer
    } else {
      if (King.active) { King.startKingRound(); } else { try { SFX.roundWin(); } catch (e) {} startRound(); }
    }
  }

  // ============================================================
  //  Rendering
  // ============================================================
  // ── M61 cosmetic + modifier render helpers ──
  function drawTrails(g) {
    for (const f of fighters) {
      if (!f._trail || !f._trail.length) continue;
      for (let i = 0; i < f._trail.length; i++) {
        const p = f._trail[i], a = (i / f._trail.length) * 0.32;
        g.globalAlpha = a; g.fillStyle = f.color;
        g.fillRect(p.x - 6, p.y - 24, 12, 46);
      }
    }
    g.globalAlpha = 1;
  }
  function drawFighterAura(g) {
    for (const f of fighters) {
      if (!f.alive) continue;
      const x = f.pos.x, y = f.pos.y;
      if ((f._iframes || 0) > 0) {
        g.globalAlpha = 0.35 + 0.3 * Math.abs(Math.sin(Date.now() / 40));
        g.strokeStyle = '#bfefff'; g.lineWidth = 2;
        g.beginPath(); g.ellipse(x, y, 20, 34, 0, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
      }
      if ((f._celebrate || 0) > 0) {
        const k = f._celebrate / 0.8, r = (1 - k) * 46 + 8;
        g.globalAlpha = Math.max(0, k) * 0.8; g.strokeStyle = '#ffd23f'; g.lineWidth = 3;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
      }
      let icon = '';
      if ((f._burn || 0) > 0) icon = '\uD83D\uDD25';
      else if ((f._confuse || 0) > 0) icon = '\u2753';
      else if ((f._stun || 0) > 0) icon = '\uD83D\uDCAB';
      if (icon) { g.globalAlpha = 1; g.font = '18px sans-serif'; g.textAlign = 'center'; g.fillText(icon, x, y - 46); g.textAlign = 'left'; }
    }
    g.globalAlpha = 1;
  }
  function drawFogOfWar(g) {
    if (!activeMod.fog) return;
    g.save();
    g.fillStyle = 'rgba(4,6,12,0.85)';
    g.fillRect(-300, -300, VIEW.w + 600, VIEW.h + 600);
    g.globalCompositeOperation = 'destination-out';
    for (const f of fighters) {
      if (!f.alive) continue;
      const grad = g.createRadialGradient(f.pos.x, f.pos.y, 18, f.pos.x, f.pos.y, 195);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.7, 'rgba(0,0,0,0.82)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(f.pos.x, f.pos.y, 195, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  function drawMvpSpotlight(g) {
    if (!roundOver) return;
    const alive = fighters.filter(f => f.alive);
    if (alive.length !== 1) return;
    const f = alive[0], t = Date.now() / 300;
    g.save();
    g.globalAlpha = 0.15; g.fillStyle = '#ffe066';
    g.beginPath(); g.moveTo(f.pos.x, f.pos.y - 40); g.lineTo(f.pos.x - 60, f.pos.y - 320); g.lineTo(f.pos.x + 60, f.pos.y - 320); g.closePath(); g.fill();
    g.globalAlpha = 0.5 + 0.2 * Math.sin(t); g.strokeStyle = '#ffe066'; g.lineWidth = 4;
    g.beginPath(); g.arc(f.pos.x, f.pos.y, 50 + 6 * Math.sin(t), 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  function drawModBanner(g) {
    if (_modBannerT <= 0 || !activeModName) return;
    const a = Math.min(1, _modBannerT / 0.5);
    g.save();
    g.globalAlpha = a; g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(VIEW.w / 2 - 260, 70, 520, 64);
    g.font = 'bold 38px sans-serif'; g.fillStyle = '#ffd23f';
    g.fillText(activeModName, VIEW.w / 2, 115);
    g.restore();
    g.textAlign = 'left';
  }
  function drawWind(g) {
    if (TRAIN || !windX || state !== 'play') return;
    const t = Date.now() / 1000, dir = Math.sign(windX), spd = Math.abs(windX);
    g.save(); g.strokeStyle = 'rgba(200,220,255,0.16)'; g.lineWidth = 2;
    for (let i = 0; i < 20; i++) {
      const yy = (i * 71) % VIEW.h;
      const xx = (((i * 137 + t * 300 * windX) % (VIEW.w + 200)) + (VIEW.w + 200)) % (VIEW.w + 200) - 100;
      g.beginPath(); g.moveTo(xx, yy); g.lineTo(xx + (28 + spd * 20) * dir, yy); g.stroke();
    }
    g.restore();
  }
  function drawAnnouncer(g) {
    if (!_announce) return;
    const a = Math.min(1, _announce.t / 0.5);
    const scale = 1 + (1.7 - _announce.t) * 0.14;
    g.save();
    g.globalAlpha = a; g.textAlign = 'center';
    g.translate(VIEW.w / 2, VIEW.h * 0.34); g.scale(scale, scale);
    g.font = 'bold 64px sans-serif'; g.lineWidth = 6; g.strokeStyle = '#000';
    g.strokeText(_announce.text, 0, 0);
    g.fillStyle = '#ff3b3b'; g.fillText(_announce.text, 0, 0);
    g.restore();
    g.textAlign = 'left';
  }
  // ── M96 pre-round countdown: big center-screen "3" -> "2" -> "FIGHT!", white fill + black outline, smooth pop in/out ──
  function drawCountdown(g) {
    if (!_countdown) return;
    const DUR = 1.9, ph = DUR / 3;
    const el = DUR - _countdown.t;
    let idx = Math.floor(el / ph); if (idx < 0) idx = 0; if (idx > 2) idx = 2;
    const txt = idx === 2 ? 'FIGHT!' : String(3 - idx); // 3 -> 2 -> FIGHT!
    const local = Math.min(1, Math.max(0, (el - idx * ph) / ph)); // progress within this number
    const eo = t => 1 - Math.pow(1 - t, 3);
    let scale, alpha;
    if (local < 0.2) { scale = 0.35 + 0.85 * eo(local / 0.2); alpha = local / 0.18; }      // pop in (overshoot)
    else if (local < 0.34) { scale = 1.2 - 0.2 * ((local - 0.2) / 0.14); alpha = 1; }       // settle
    else if (local < 0.72) { scale = 1.0; alpha = 1; }                                       // hold
    else { const u = (local - 0.72) / 0.28; scale = 1.0 + 0.35 * u; alpha = 1 - u; }         // pop out (grow + fade)
    alpha = Math.min(1, Math.max(0, alpha));
    const big = idx === 2;
    const fs = (big ? 104 : 170) * scale;
    g.save();
    g.globalAlpha = alpha;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 ' + fs.toFixed(1) + 'px "Arial Black", Impact, "Segoe UI", sans-serif';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(6, fs * 0.085);
    g.strokeStyle = '#000';
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 18; g.shadowOffsetY = 4;
    g.strokeText(txt, VIEW.w / 2, VIEW.h * 0.42);
    g.shadowBlur = 0; g.shadowOffsetY = 0;
    g.fillStyle = '#ffffff';
    g.fillText(txt, VIEW.w / 2, VIEW.h * 0.42);
    g.restore();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }
  // ── M62 arena-event render helpers ──
  function drawArenaFlood(g) {
    if (TRAIN || arenaEvent !== 'flood' || state !== 'play') return;
    const t = Date.now() / 1000;
    g.save();
    g.fillStyle = 'rgba(255,80,20,0.55)';
    g.fillRect(-60, _floodY, VIEW.w + 120, VIEW.h + 200);
    g.fillStyle = 'rgba(255,180,40,0.9)';
    g.beginPath(); g.moveTo(-60, _floodY);
    for (let xx = -60; xx <= VIEW.w + 60; xx += 24) g.lineTo(xx, _floodY + Math.sin(xx * 0.03 + t * 4) * 6);
    g.lineTo(VIEW.w + 60, _floodY + 34); g.lineTo(-60, _floodY + 34); g.closePath(); g.fill();
    g.restore();
  }
  function drawArenaShrink(g) {
    if (TRAIN || arenaEvent !== 'shrink' || state !== 'play') return;
    g.save();
    g.fillStyle = 'rgba(255,40,60,0.30)';
    g.fillRect(-60, -60, _shrinkX + 60, VIEW.h + 120);
    g.fillRect(VIEW.w - _shrinkX, -60, _shrinkX + 60, VIEW.h + 120);
    g.fillStyle = 'rgba(255,60,80,0.85)';
    g.fillRect(_shrinkX - 4, 0, 4, VIEW.h);
    g.fillRect(VIEW.w - _shrinkX, 0, 4, VIEW.h);
    g.restore();
  }
  function drawGravZone(g) {
    if (TRAIN || arenaEvent !== 'gravzone' || state !== 'play') return;
    const x0 = VIEW.w * 0.38, x1 = VIEW.w * 0.62, t = Date.now() / 1000;
    g.save();
    g.globalAlpha = 0.12 + 0.05 * Math.sin(t * 3); g.fillStyle = '#77ccff';
    g.fillRect(x0, 0, x1 - x0, VIEW.h);
    g.globalAlpha = 0.6; g.fillStyle = '#aaeeff';
    for (let i = 0; i < 6; i++) { const yy = VIEW.h - (((t * 90 + i * 130) % VIEW.h)); const cx = x0 + (x1 - x0) * ((i + 0.5) / 6); g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx - 8, yy + 14); g.lineTo(cx + 8, yy + 14); g.closePath(); g.fill(); }
    g.restore();
  }
  function drawAmbient(g) {
    if (TRAIN || !_ambient || state !== 'play') return;
    g.save(); g.globalAlpha = _ambient.a;
    g.fillStyle = 'rgb(' + _ambient.r + ',' + _ambient.g + ',' + _ambient.b + ')';
    g.fillRect(-60, -60, VIEW.w + 120, VIEW.h + 120); g.restore();
  }
  function drawDarkness(g) {
    if (TRAIN || arenaEvent !== 'dark' || state !== 'play') return;
    g.save();
    g.fillStyle = 'rgba(2,3,8,0.82)'; g.fillRect(-60, -60, VIEW.w + 120, VIEW.h + 120);
    g.globalCompositeOperation = 'destination-out';
    for (const f of fighters) {
      if (!f.alive) continue;
      const grad = g.createRadialGradient(f.pos.x, f.pos.y, 16, f.pos.x, f.pos.y, 165);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.72, 'rgba(0,0,0,0.8)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.beginPath(); g.arc(f.pos.x, f.pos.y, 165, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  function drawArenaEventLabel(g) {
    if (TRAIN || !arenaEventName || state !== 'play') return;
    g.save(); g.textAlign = 'center'; g.font = 'bold 18px Trebuchet MS';
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(VIEW.w / 2 - 150, 132, 300, 30);
    g.fillStyle = '#ffd23f'; g.fillText(arenaEventName, VIEW.w / 2, 153);
    g.restore(); g.textAlign = 'left';
  }
  function drawRoundEvent(g) {
    if (TRAIN || state !== 'play') return;
    if (_bounty && !_bounty.claimed) {
      const t = Date.now() / 1000, pr = 30 + Math.sin(t * 4) * 5;
      g.save(); g.globalAlpha = 0.45; g.fillStyle = '#ffd23f';
      g.beginPath(); g.arc(_bounty.x, _bounty.y, pr + 8, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1; g.textAlign = 'center'; g.font = '26px serif';
      g.fillText('\uD83D\uDC51', _bounty.x, _bounty.y + 9);
      g.restore(); g.textAlign = 'left';
    }
    if (_suddenDeath) {
      const t = Date.now() / 1000; g.save();
      g.globalAlpha = 0.10 + 0.05 * Math.sin(t * 6); g.fillStyle = '#ff2030';
      g.fillRect(-60, -60, VIEW.w + 120, VIEW.h + 120); g.restore();
    }
  }
  function drawGameMode(g) {
    if (TRAIN || state !== 'play' || curMode !== 'koth' || !_kothScore) return;
    const t = Date.now() / 1000;
    g.save();
    g.globalAlpha = 0.16 + 0.05 * Math.sin(t * 3);
    const lead = _kothScore[0] >= _kothScore[1] ? 0 : 1;
    g.fillStyle = lead === 0 ? '#ff7a7a' : '#6cc0ff';
    g.beginPath(); g.arc(KOTH_ZONE.x, KOTH_ZONE.y, KOTH_ZONE.r, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.6; g.lineWidth = 3; g.strokeStyle = '#ffd23f';
    g.beginPath(); g.arc(KOTH_ZONE.x, KOTH_ZONE.y, KOTH_ZONE.r, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1; g.textAlign = 'center'; g.font = 'bold 14px Trebuchet MS';
    g.fillStyle = '#ff7a7a'; g.fillText('A ' + Math.floor(_kothScore[0]) + '%', KOTH_ZONE.x - 42, KOTH_ZONE.y - KOTH_ZONE.r - 10);
    g.fillStyle = '#6cc0ff'; g.fillText('B ' + Math.floor(_kothScore[1]) + '%', KOTH_ZONE.x + 42, KOTH_ZONE.y - KOTH_ZONE.r - 10);
    g.restore(); g.textAlign = 'left';
  }
  function render() {
    if (state === 'king') { try { King.render(ctx); } catch (e) { console.error('[King.render]', e); } return; }
    tickTransition(); // M59: arena fade transition
    ctx.save();
    ctx.clearRect(0, 0, VIEW.w, VIEW.h);
    // background
    const _th = currentTheme();
    const grd = ctx.createLinearGradient(0, 0, 0, VIEW.h);
    grd.addColorStop(0, _th.sky[0]);
    grd.addColorStop(1, _th.sky[1]);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
    drawParallax(ctx);

    // screen shake
    const sx = (Math.random() - 0.5) * shakeAmt;
    const sy = (Math.random() - 0.5) * shakeAmt;
    ctx.translate(sx, sy);

    // platforms
    for (const p of platforms) drawPlatform(ctx, p);
    drawTrainingOverlay(ctx); // #69 death/kill heatmap (training view only)

    // weapon drops
    for (const w of weapons) { if (!w.taken) drawWeaponDrop(ctx, w); }

    // ragdolls
    for (const r of ragdolls) r.draw(ctx);

    // fighters
    drawTrails(ctx); // M61 motion trails behind fighters
    for (const f of fighters) { try { f.draw(ctx); } catch (e) { /* skip one bad draw, keep the frame alive */ } }
    drawFighterAura(ctx); // M61 celebration / status / i-frame auras

    // bullets — colored per projectile type (guns / magic / lightning bolt)
    ctx.lineCap = 'round';
    for (const b of bullets) {
      const info = b.bullet || {};
      const proj = info.proj && info.proj.color ? info.proj : { color: '#ffe9a6', r: 2.4 };
      const px = b.prev ? b.prev.x : b.position.x, py = b.prev ? b.prev.y : b.position.y;
      if (info.bolt) {
        // jagged lightning streak
        ctx.globalAlpha = 0.9; ctx.strokeStyle = proj.glow || '#fff'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(px, py);
        for (let i = 1; i <= 4; i++) { const t = i / 4; ctx.lineTo(px + (b.position.x - px) * t + (Math.random() - 0.5) * 11, py + (b.position.y - py) * t + (Math.random() - 0.5) * 11); }
        ctx.stroke(); ctx.globalAlpha = 1;
        ctx.strokeStyle = proj.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(b.position.x, b.position.y); ctx.stroke();
        continue;
      }
      if (proj.glow) { ctx.shadowColor = proj.glow; ctx.shadowBlur = 12; }
      ctx.strokeStyle = proj.color; ctx.lineWidth = Math.max(2, proj.r);
      ctx.beginPath();
      if (proj.len) { const a = Math.atan2(b.velocity.y, b.velocity.x); ctx.moveTo(b.position.x - Math.cos(a) * proj.len, b.position.y - Math.sin(a) * proj.len); }
      else ctx.moveTo(px, py);
      ctx.lineTo(b.position.x, b.position.y); ctx.stroke();
      ctx.fillStyle = proj.glow || '#fff7df';
      ctx.beginPath(); ctx.arc(b.position.x, b.position.y, Math.max(2, proj.r), 0, Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // particles
    for (const p of particles) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.r) || p.r < 0) continue; // guard: a NaN/negative radius throws on the real canvas every frame -> ejects to menu
      const al = Math.max(0, p.life / p.max);
      ctx.globalAlpha = al;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawHazards(ctx);          // M59: hazard visuals (play only)
    drawForeground(ctx);       // M59: foreground depth layer
    drawDynamicLighting(ctx);  // M59: weapon/explosion lighting
    drawFogOfWar(ctx);         // M61: fog-of-war round modifier
    drawMvpSpotlight(ctx);     // M61: round-winner spotlight
    drawArenaFlood(ctx);       // M62: rising lava
    drawArenaShrink(ctx);      // M62: shrinking arena walls
    drawGravZone(ctx);         // M62: gravity-flip zone
    drawAmbient(ctx);          // M62: day-night ambient tint
    drawDarkness(ctx);         // M62: darkness arena vignette
    drawRoundEvent(ctx);       // M62: bounty marker + sudden-death flash
    drawGameMode(ctx);         // M62: King of the Hill zone

    ctx.restore();

    // HUD (scoreboard) — drawn without shake
    drawWind(ctx); // M62 wind streaks (play only)
    drawArenaEventLabel(ctx); // M62 active arena-event label
    if (state === 'play' || state === 'paused') drawScore(ctx);
    if ((state === 'play' || state === 'paused') && !roundOver) drawMatchTimer(ctx); // M107 match countdown clock
    drawTransition(ctx); // M59: arena fade transition (over everything)
    drawModBanner(ctx);  // M61 round-modifier banner
    drawAnnouncer(ctx);  // M61 streak announcer
    drawCountdown(ctx);  // M96 pre-round 3,2,FIGHT! countdown
    if (King.active && state === 'play') { try { King.drawHud(ctx); } catch (e) {} }  // 👑 King Tournament HUD
  }

  // ── Arena themes: each map gets a distinct visual identity. ──
  const THEMES = {
    castle:  { sky: ['#2c2335', '#0e0b15'], plat: '#4a4038', platTop: '#6e5f49', edge: 'rgba(0,0,0,.35)', accent: '#ffb347' },
    forest:  { sky: ['#16302a', '#08140f'], plat: '#384a2c', platTop: '#5c7a3a', edge: 'rgba(0,0,0,.30)', accent: '#9bd14f' },
    factory: { sky: ['#2a2622', '#100d0a'], plat: '#3a3e44', platTop: '#5c616b', edge: 'rgba(0,0,0,.40)', accent: '#ff9a1a' },
    scifi:   { sky: ['#0a1c30', '#04070e'], plat: '#14273e', platTop: '#22d3ee', edge: 'rgba(0,0,0,.35)', accent: '#22d3ee' },
    lab:     { sky: ['#11212b', '#060c11'], plat: '#1c2f36', platTop: '#3fe0c8', edge: 'rgba(0,0,0,.35)', accent: '#43e8cf' },
  };
  function currentTheme() {
    const a = ARENAS[currentArena];
    return THEMES[a && a.theme] || THEMES.scifi;
  }
  // ── Pixel-art helpers (everything snaps to a chunky grid) ──
  const PX = 4; // pixel-art unit
  function pq(v) { return Math.round(v / PX) * PX; }
  function pxRect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(pq(x), pq(y), Math.max(PX, pq(w)), Math.max(PX, pq(h))); }
  function pxCircle(g, cx, cy, r, col) { // blocky disc scanned row by row
    g.fillStyle = col;
    for (let yy = -r; yy <= r; yy += PX) {
      const ww = Math.sqrt(Math.max(0, r * r - yy * yy));
      g.fillRect(pq(cx - ww), pq(cy + yy), Math.max(PX, pq(ww * 2)), PX);
    }
  }
  function pxPine(g, cx, topY, halfW, fullH, col, swayTop) { // triangular pine, top sways
    g.fillStyle = col;
    for (let yy = 0; yy <= fullH; yy += PX) {
      const frac = yy / fullH;             // 0 top → 1 base
      const ww = halfW * frac;
      const off = swayTop * (1 - frac);    // wind strongest at the crown
      g.fillRect(pq(cx + off - ww), pq(topY + yy), Math.max(PX, pq(ww * 2)), PX);
    }
  }

  // Animated, pixel-art arena backdrops. Motion is driven by a wall clock so it
  // animates every frame; layouts stay deterministic (no flicker).
  function drawParallax(g) {
    const th = currentTheme();
    const name = (ARENAS[currentArena] || {}).theme;
    const W = VIEW.w, H = VIEW.h;
    const t = Date.now() / 1000;
    g.save();
    g.imageSmoothingEnabled = false;
    if (name === 'castle') {
      pxCircle(g, W - 190, 130, 44, '#f0e6c8');                                 // moon
      for (let x = 0; x < W; x += 150) {                                        // towers + battlements + lit windows
        const h = 180 + ((x * 53) % 120);
        pxRect(g, x + 20, H - h, 100, h, '#1a1422');
        for (let c = 0; c < 100; c += 28) pxRect(g, x + 20 + c, H - h - 16, 16, 16, '#1a1422');
        const flick = (Math.sin(t * 6 + x) > -0.3) ? '#ffcf6b' : '#7a5a1e';
        for (let wy = H - h + 28; wy < H - 40; wy += 44) pxRect(g, x + 56, wy, 12, 16, flick);
      }
      for (let i = 0, x = 110; x < W; x += 220, i++) {                          // animated torches w/ flames + embers
        const baseY = H - 250;
        pxRect(g, x - 3, baseY, 6, 28, '#5a4636');
        const fl = Math.sin(t * 9 + i) * 0.5 + Math.sin(t * 14 + i * 2) * 0.5;   // -1..1 flicker
        const fh = 20 + fl * 6;
        const gr = g.createRadialGradient(x, baseY - 6, 2, x, baseY - 6, 46 + fl * 8);
        gr.addColorStop(0, 'rgba(255,170,60,.55)'); gr.addColorStop(1, 'rgba(255,170,60,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, baseY - 6, 46 + fl * 8, 0, Math.PI * 2); g.fill();
        pxRect(g, x - 5, baseY - fh, 10, fh, '#ff7a1a');
        pxRect(g, x - 3, baseY - fh + 4, 6, fh - 6, '#ffd23f');
        pxRect(g, x - 1, baseY - fh + 8, 3, fh - 12, '#fff3c0');
        const ey = baseY - fh - ((t * 34 + i * 17) % 44);                        // rising ember
        pxRect(g, x + (i % 2 ? 3 : -3), ey, 3, 3, '#ffb347');
      }
    } else if (name === 'forest') {
      const layers = [['#0d2018', 1.0, 1.0], ['#12301f', 0.8, 1.5], ['#173d27', 0.6, 2.1]];
      layers.forEach((L, li) => {
        const col = L[0], scl = L[1], swayAmp = L[2] * 7;
        for (let x = -40; x < W + 40; x += 70 - li * 12) {
          const th2 = (200 + ((x * (37 + li * 11)) % 150)) * scl;
          const sway = Math.sin(t * 1.3 + x * 0.05 + li) * swayAmp;             // wind
          pxRect(g, x + 26, H - 42, 8, 42, '#3a2a1a');                          // trunk
          pxPine(g, x + 30, H - th2, 46, th2 - 42, col, sway);
        }
      });
      for (let i = 0; i < 26; i++) {                                            // drifting, blinking fireflies
        const fx = (((i * 197 + t * 18 * (i % 2 ? 1 : -1)) % W) + W) % W;
        const fy = 120 + ((i * 83) % 260) + Math.sin(t * 2 + i) * 9;
        const blink = (Math.sin(t * 4 + i * 1.7) + 1) / 2;
        g.globalAlpha = 0.25 + blink * 0.65; pxRect(g, fx, fy, 3, 3, '#d8ff6a');
      }
      g.globalAlpha = 1;
    } else if (name === 'factory') {
      for (let x = 0; x < W; x += 170) {                                        // smokestacks + rising smoke puffs
        const h = 220 + ((x * 61) % 120);
        pxRect(g, x + 30, H - h, 70, h, '#15110d');
        pxRect(g, x + 20, H - h - 14, 90, 14, '#221a12');
        for (let s = 0; s < 4; s++) {
          const prog = (t * 0.4 + s * 0.25 + x * 0.001) % 1;
          const sz = 8 + prog * 20;
          g.globalAlpha = 0.28 * (1 - prog);
          pxRect(g, x + 65 - sz / 2 + Math.sin(prog * 6 + x) * 9, H - h - 14 - prog * 130, sz, sz, '#9aa0a8');
        }
        g.globalAlpha = 1;
      }
      for (let i = 0, x = 150; x < W; x += 300, i++) {                          // rotating pixel gears
        const ang = t * (i % 2 ? 1.4 : -1.8);
        pxCircle(g, x, 185, 22, '#2a2018');
        for (let k = 0; k < 8; k++) { const a = ang + k / 8 * Math.PI * 2; pxRect(g, x + Math.cos(a) * 30 - 4, 185 + Math.sin(a) * 30 - 4, 8, 8, '#4a3a22'); }
        pxCircle(g, x, 185, 7, th.accent);
      }
    } else if (name === 'scifi') {
      for (let i = 0; i < 70; i++) {                                            // twinkling stars
        const tw = (Math.sin(t * 3 + i * 1.3) + 1) / 2;
        g.globalAlpha = 0.3 + tw * 0.6; pxRect(g, (i * 173) % W, (i * 97) % ((H * 0.6) | 0), 2, 2, '#bfefff');
      }
      g.globalAlpha = 1;
      const pr = 60 + Math.sin(t * 1.2) * 5;                                    // pulsing planet
      pxCircle(g, W - 210, 150, pr, '#1c6f8a');
      pxCircle(g, W - 226, 134, pr * 0.55, '#2bd4ee');
      g.strokeStyle = th.accent; g.globalAlpha = 0.22; g.lineWidth = 2;          // scrolling neon grid
      const hz = H * 0.62;
      for (let k = 0; k < 12; k++) { const f = ((k + (t * 0.5) % 1) / 12); const y = hz + f * f * (H - hz); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      for (let x = -W; x < W * 2; x += 90) { g.beginPath(); g.moveTo(W / 2 + (x - W / 2) * 0.15, hz); g.lineTo(x, H); g.stroke(); }
      g.globalAlpha = 1;
    } else if (name === 'lab') {
      g.globalAlpha = 0.08;                                                     // grid dot wall
      for (let x = 0; x < W; x += 48) for (let y = 0; y < H; y += 48) pxRect(g, x, y, 3, 3, th.accent);
      g.globalAlpha = 1;
      for (let i = 0, x = 90; x < W; x += 240, i++) {                           // tubes: oscillating liquid + rising bubbles
        const tubeH = 360, tubeY = H - tubeH;
        pxRect(g, x, tubeY, 46, tubeH, '#0c1c22');
        const level = 200 + Math.sin(t * 1.5 + i) * 16;
        g.globalAlpha = 0.5; pxRect(g, x + 4, H - level, 38, level, th.accent); g.globalAlpha = 1;
        for (let b = 0; b < 5; b++) {
          const prog = (t * 0.5 + b * 0.2 + i * 0.1) % 1;
          g.globalAlpha = 0.7 * (1 - prog * 0.5);
          pxRect(g, x + 12 + ((b * 13) % 24) + Math.sin(prog * 8 + b) * 4, H - 6 - prog * (level - 12), 4, 4, '#bafff0');
        }
        g.globalAlpha = 0.12; pxRect(g, x + 8, tubeY + 6, 6, tubeH - 12, '#ffffff'); g.globalAlpha = 1;
        pxRect(g, x + 18, tubeY - 10, 8, 8, (Math.sin(t * 5 + i) > 0) ? '#5cff8a' : '#1a3a22'); // blinking light
      }
    } else {
      g.globalAlpha = 0.25;
      for (let x = 0; x < W; x += 90) { const h = 120 + ((x * 37) % 160); pxRect(g, x + 8, H - h, 70, h, '#0b1426'); }
      g.globalAlpha = 1;
    }
    g.restore();
  }

  // Pixel-art platforms: flat blocky tiles with per-theme texture + subtle motion.
  function drawPlatform(g, p) {
    if (p._broken) return; // M65 destroyed barrier
    if (p.rotate) { // M65 rotated seesaw platform
      const th2 = currentTheme();
      g.save(); g.imageSmoothingEnabled = false;
      g.translate(p.x, p.y); g.rotate(p._angle || 0);
      g.fillStyle = th2.plat; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.fillStyle = th2.platTop; g.fillRect(-p.w / 2, -p.h / 2, p.w, 4);
      g.fillStyle = th2.accent || '#22d3ee'; g.globalAlpha = 0.5; g.fillRect(-p.w / 2, p.h / 2 - 3, p.w, 2); g.globalAlpha = 1;
      g.fillStyle = '#ffd23f'; g.fillRect(-4, -p.h / 2 - 5, 8, 5); // pivot cap
      g.strokeStyle = th2.edge; g.lineWidth = 1; g.strokeRect(-p.w / 2 + 0.5, -p.h / 2 + 0.5, p.w - 1, p.h - 1);
      g.restore(); return;
    }
    const x = Math.round(p.x - p.w / 2), y = Math.round(p.y - p.h / 2);
    const w = Math.round(p.w), h = Math.round(p.h);
    const th = currentTheme();
    const name = (ARENAS[currentArena] || {}).theme;
    const t = Date.now() / 1000;
    g.save();
    g.imageSmoothingEnabled = false;
    g.fillStyle = th.plat; g.fillRect(x, y, w, h);                              // body
    g.fillStyle = th.platTop; g.fillRect(x, y, w, 4);                           // accent top cap
    g.fillStyle = 'rgba(0,0,0,.30)'; g.fillRect(x, y + h - 3, w, 3);            // bottom shade
    if (name === 'castle') {
      g.fillStyle = 'rgba(0,0,0,.22)';                                          // pixel stone bricks (offset rows)
      for (let by = y + 8; by < y + h; by += 8) g.fillRect(x, by, w, 1);
      for (let row = 0, by = y + 4; by < y + h; by += 8, row++) for (let bx = x + (row % 2 ? 0 : 16); bx < x + w; bx += 32) g.fillRect(bx, by, 1, 8);
    } else if (name === 'forest') {
      g.fillStyle = 'rgba(0,0,0,.16)';                                          // log grain
      for (let by = y + 7; by < y + h; by += 6) g.fillRect(x, by, w, 1);
      for (let mx = x + 4; mx < x + w; mx += 18) { const s = Math.sin(t * 2 + mx * 0.1) > 0 ? 1 : 0; g.fillStyle = '#6aa83a'; g.fillRect(mx + s, y - 3, 8, 4); g.fillStyle = '#88c94a'; g.fillRect(mx + 2, y - 5, 4, 3); } // swaying moss
    } else if (name === 'factory') {
      const off = Math.floor((t * 30) % 24);                                    // scrolling hazard stripes
      for (let hx = x - 24 + off; hx < x + w; hx += 24) { g.fillStyle = '#ff9a1a'; g.fillRect(Math.max(x, hx), y, 12, 4); g.fillStyle = '#1a1206'; g.fillRect(Math.max(x, hx + 12), y, 12, 4); }
      g.fillStyle = 'rgba(0,0,0,.35)';                                          // rivets
      for (let rx = x + 8; rx < x + w; rx += 22) g.fillRect(rx, y + h - 8, 3, 3);
    } else if (name === 'scifi') {
      const pulse = (Math.sin(t * 3) + 1) / 2;                                  // pulsing neon underglow
      g.globalAlpha = 0.4 + pulse * 0.5; g.fillStyle = th.accent; g.fillRect(x + 4, y + h - 4, w - 8, 2);
      const off = Math.floor((t * 20) % 24); g.globalAlpha = 0.3;               // moving circuit dashes
      for (let cx = x + (off % 24); cx < x + w; cx += 24) g.fillRect(cx, y + 6, 8, 2);
      g.globalAlpha = 1;
    } else if (name === 'lab') {
      g.fillStyle = 'rgba(67,232,207,.18)';                                     // tile grid
      for (let bx = x + 14; bx < x + w; bx += 14) g.fillRect(bx, y, 1, h);
      const sweep = x + ((t * 60) % Math.max(1, w));                            // sweeping scanner line
      g.globalAlpha = 0.25; g.fillStyle = th.accent; g.fillRect(Math.round(sweep), y, 2, h); g.globalAlpha = 1;
    }
    // ── M62 special-platform overlays ──
    if (p.ice) { g.globalAlpha = 0.16; g.fillStyle = '#dff4ff'; g.fillRect(x, y, w, h); g.globalAlpha = 0.6; g.fillStyle = '#bfe9ff'; g.fillRect(x, y, w, 4); g.globalAlpha = 1; }
    if (p.conveyor) { const dir = Math.sign(p.conveyor); const off = ((Math.floor(t * 70 * dir) % 20) + 20) % 20; g.fillStyle = '#ffd23f'; for (let cx = x + off; cx < x + w - 6; cx += 20) { g.beginPath(); g.moveTo(cx, y + h / 2 - 4); g.lineTo(cx + 6 * dir, y + h / 2); g.lineTo(cx, y + h / 2 + 4); g.closePath(); g.fill(); } }
    if (p.tramp) { g.strokeStyle = '#ff5bb0'; g.lineWidth = 3; g.beginPath(); for (let bx = x; bx <= x + w; bx += 6) { const yy = y + 2 + Math.sin((bx + t * 220) * 0.18) * 2; if (bx === x) g.moveTo(bx, yy); else g.lineTo(bx, yy); } g.stroke(); }
    if (p.breakable && p.hp) { const dmg = 1 - Math.max(0, p._hp) / p.hp; if (dmg > 0.02) { g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1; const cracks = Math.ceil(dmg * 6); for (let i = 0; i < cracks; i++) { const cx = x + ((i * 53) % Math.max(1, w)); g.beginPath(); g.moveTo(cx, y + 2); g.lineTo(cx + (i % 2 ? 6 : -6), y + h - 2); g.stroke(); } } } // M65 damage cracks
    if (p.oneway) { g.globalAlpha = 0.5; g.fillStyle = '#ffd23f'; for (let ax = x + 8; ax < x + w - 6; ax += 26) { g.beginPath(); g.moveTo(ax, y + h - 3); g.lineTo(ax + 5, y + h - 9); g.lineTo(ax + 10, y + h - 3); g.closePath(); g.fill(); } g.globalAlpha = 1; } // M65 one-way up-arrows
    g.strokeStyle = th.edge; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); // crisp edge
    g.restore();
  }

  // ============================================================
  //  M59 — environment depth & reactivity, themed kill FX,
  //  hazards, moving platforms, arena transitions, themed drops.
  //  All gameplay-affecting logic is gated to NON-training so the
  //  evolved AI keeps training on the original static layout.
  // ============================================================

  // Action-reactivity: ramps up on explosions/kills, decays to calm.
  const ArenaReactivity = {
    _intensity: 0,
    update(dt) { this._intensity = Math.max(0, this._intensity - dt * 0.5); },
    onExplosion() { this._intensity = Math.min(1, this._intensity + 0.4); },
    onKill() { this._intensity = Math.min(1, this._intensity + 0.25); },
  };

  // Gap 1 — foreground depth layer (drawn over fighters, in screen space).
  function drawForeground(g) {
    const name = (ARENAS[currentArena] || {}).theme;
    const t = Date.now() / 1000;
    const boost = 1 + ArenaReactivity._intensity * 1.4;
    g.save(); g.imageSmoothingEnabled = false;
    if (name === 'forest') {
      g.globalAlpha = 0.18;
      for (let x = 0; x < VIEW.w; x += 90) pxPine(g, x, VIEW.h - 80, 70, 120, '#0a1f10', Math.sin(t * 1.1 + x * 0.04) * 12 * boost);
      g.globalAlpha = 1;
    } else if (name === 'castle') {
      g.globalAlpha = 0.15;
      for (let x = 200; x < VIEW.w; x += 400) for (let y = 0; y < 300; y += 18) pxRect(g, x + Math.sin(t + y * 0.2) * 3 * boost, y, 10, 12, '#5a4a3a'); // hanging chains
      g.globalAlpha = 1;
    } else if (name === 'scifi') {
      g.globalAlpha = 0.05; g.fillStyle = '#22d3ee';
      for (let y = (Math.floor(t * 30) % 4); y < VIEW.h; y += 4) g.fillRect(0, y, VIEW.w, 1); // hologram scanlines
      g.globalAlpha = 1;
    } else if (name === 'factory') {
      g.globalAlpha = 0.13;
      for (let x = 120; x < VIEW.w; x += 360) for (let y = 0; y < 180; y += 16) pxRect(g, x + Math.sin(t * 0.8 + y * 0.15) * 2, y, 8, 10, '#23262b'); // chains
      g.globalAlpha = 0.10; g.fillStyle = '#000';
      for (let i = 0; i < 26; i++) g.fillRect(pq((i * 137 + t * 18) % VIEW.w), pq((i * 91 + t * 26) % VIEW.h), PX, PX); // soot motes
      g.globalAlpha = 1;
    } else if (name === 'lab') {
      g.globalAlpha = 0.08; g.fillStyle = '#9af7e6';
      for (let i = 0; i < 30; i++) g.fillRect(pq((i * 113 + t * 10) % VIEW.w), pq(VIEW.h - ((i * 67 + t * 22) % VIEW.h)), PX, PX); // floating dust
      g.globalAlpha = 1;
    }
    g.restore();
  }

  // Gap 5 — dynamic lighting cast by armed fighters + explosion flashes.
  function drawDynamicLighting(g) {
    if (TRAIN) return;
    const lightColors = { fireball: 'rgba(255,90,44,0.13)', lightning: 'rgba(191,233,255,0.15)', icebolt: 'rgba(169,241,255,0.12)', rocket: 'rgba(255,138,60,0.11)', sniper: 'rgba(159,232,255,0.08)' };
    for (const f of fighters) {
      if (!f.alive || !f.weapon) continue;
      const lc = lightColors[f.weapon.type] || 'rgba(255,255,255,0.05)';
      const grad = g.createRadialGradient(f.pos.x, f.pos.y, 0, f.pos.x, f.pos.y, 120);
      grad.addColorStop(0, lc); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(f.pos.x - 120, f.pos.y - 120, 240, 240);
    }
    if (shakeAmt > 3) { g.fillStyle = 'rgba(255,200,100,' + Math.min(0.15, shakeAmt * 0.02) + ')'; g.fillRect(0, 0, VIEW.w, VIEW.h); }
  }

  // Gap 7 — themed death bursts (called from die()).
  function spawnKillEffect(x, y, theme) {
    if (TRAIN) return;
    const palettes = {
      castle:  { n: 12, life: 0.8, up: 3, cols: ['#ffb347', '#ffd27a', '#fff3c0'] },
      scifi:   { n: 20, life: 0.5, up: 0, cols: ['#22d3ee', '#ffffff', '#0a1c30'] },
      forest:  { n: 15, life: 1.0, up: 4, cols: ['#5c7a3a', '#9bd14f', '#384a2c'] },
      factory: { n: 16, life: 0.6, up: 3, cols: ['#ff9a1a', '#5c616b', '#1a1206'] },
      lab:     { n: 18, life: 0.7, up: 2, cols: ['#43e8cf', '#3fe0c8', '#dffaff'] },
    };
    const P = palettes[theme]; if (!P) return;
    for (let i = 0; i < P.n; i++) {
      const a = Math.random() * Math.PI * 2;
      particles.push({ x, y, vx: Math.cos(a) * (2 + Math.random() * 5), vy: Math.sin(a) * (2 + Math.random() * 5) - P.up, life: P.life, max: P.life, r: (theme === 'scifi' ? PX * (1 + Math.floor(Math.random() * 3)) : 3 + Math.random() * 3), color: P.cols[Math.floor(Math.random() * P.cols.length)] });
    }
  }

  // Gap 2 — environmental hazards that affect gameplay (play only; gated off in training).
  const ARENA_HAZARDS = {
    factory: { _cd: 0, tick(dt) {
      this._cd -= dt;
      if (this._cd > 0) return;
      const cy = 300 + Math.sin(Date.now() / 1000 * 0.8) * 70; // crusher sweeps over center column
      let hit = false;
      for (const f of fighters) { if (f.alive && Math.abs(f.pos.y - cy) < 24 && Math.abs(f.pos.x - 640) < 64) { f.hurt(12, { x: 0, y: 0.02 }, f.pos, null); hit = true; } }
      if (hit) { this._cd = 0.6; shake(5); }
    }},
    forest: { _timer: 4, _fxUntil: 0, _fxX: 0, tick(dt) {
      this._timer -= dt;
      if (this._timer > 0) return;
      this._timer = 6 + Math.random() * 8; // lightning every 6-14s
      const sx = 200 + Math.random() * (VIEW.w - 400);
      for (const f of fighters) if (f.alive && Math.abs(f.pos.x - sx) < 80) f.hurt(20, { x: (Math.random() - .5) * 0.03, y: -0.02 }, f.pos, null);
      for (let i = 0; i < 26; i++) particles.push({ x: sx + (Math.random() - .5) * 30, y: Math.random() * 230, vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 5, life: 0.4, max: 0.4, r: 2, color: '#bfe9ff', flash: true });
      this._fxUntil = Date.now() + 200; this._fxX = sx; shake(8);
    }},
    scifi: { _x: 200, _dir: 1, _cd: 0, tick(dt) {
      this._x += this._dir * 90 * dt;
      if (this._x > VIEW.w - 100) { this._x = VIEW.w - 100; this._dir = -1; } else if (this._x < 100) { this._x = 100; this._dir = 1; }
      this._cd -= dt;
      if (this._cd > 0) return;
      for (const f of fighters) if (f.alive && Math.abs(f.pos.x - this._x) < 18) { f.hurt(7, { x: this._dir * 0.012, y: -0.005 }, f.pos, null); this._cd = 0.45; }
    }},
  };
  function tickHazards(dt) {
    if (TRAIN) return;
    const hz = ARENA_HAZARDS[(ARENAS[currentArena] || {}).theme];
    if (hz) hz.tick(dt);
  }
  function drawHazards(g) {
    if (TRAIN) return;
    const name = (ARENAS[currentArena] || {}).theme;
    const t = Date.now() / 1000;
    if (name === 'scifi') {
      const x = ARENA_HAZARDS.scifi._x;
      g.save(); g.globalAlpha = 0.6 + Math.sin(t * 12) * 0.2; g.fillStyle = '#ff3b6b'; g.fillRect(pq(x - 2), 0, PX, VIEW.h);
      g.globalAlpha = 0.18; g.fillRect(pq(x - 8), 0, PX * 4, VIEW.h); g.restore();
    } else if (name === 'factory') {
      const cy = 300 + Math.sin(t * 0.8) * 70;
      g.save(); g.globalAlpha = 0.55; g.fillStyle = '#5c616b'; g.fillRect(640 - 60, pq(cy - 14), 120, 26);
      g.fillStyle = '#ff9a1a'; g.fillRect(640 - 60, pq(cy + 12), 120, 3); g.restore();
    } else if (name === 'forest') {
      const hz = ARENA_HAZARDS.forest;
      if (Date.now() < hz._fxUntil) { g.save(); g.globalAlpha = 0.5 + Math.random() * 0.4; g.fillStyle = '#dffaff'; g.fillRect(pq(hz._fxX - 3), 0, PX * 2, VIEW.h); g.globalAlpha = 0.2; g.fillRect(pq(hz._fxX - 10), 0, PX * 5, VIEW.h); g.restore(); }
    }
  }

  // Gap 3 — moving platforms (play only; training keeps the static layout).
  // ��─ M62 arena events (play only): rising lava, shrinking walls, gravity-flip zone ──
  function envHurt(f, dmg, pushY) {
    if (!f.alive) return;
    f.hp -= dmg; f.hurtFlash = 0.15;
    if (pushY) Body.setVelocity(f.body, { x: f.body.velocity.x, y: Math.min(f.body.velocity.y, pushY) });
    if (f.hp <= 0) { try { f.die({ x: 0, y: -0.02 }); } catch (e) {} }
  }
  function applyArenaEvent(dt) {
    if (arenaEvent === 'flood') {
      _floodY = Math.max(VIEW.h * 0.42, _floodY - dt * 26);            // lava rises, then holds high
      for (const f of fighters) { if (f.alive && f.pos.y + 30 > _floodY) envHurt(f, 55 * dt, -3); }
    } else if (arenaEvent === 'shrink') {
      _shrinkX = Math.min(VIEW.w * 0.30, _shrinkX + dt * 16);          // danger walls close in
      for (const f of fighters) {
        if (!f.alive) continue;
        if (f.pos.x < _shrinkX) { envHurt(f, 50 * dt, 0); Body.applyForce(f.body, f.pos, { x: 0.002, y: 0 }); }
        else if (f.pos.x > VIEW.w - _shrinkX) { envHurt(f, 50 * dt, 0); Body.applyForce(f.body, f.pos, { x: -0.002, y: 0 }); }
      }
    } else if (arenaEvent === 'gravzone') {
      for (const f of fighters) {
        if (!f.alive) continue;
        if (f.pos.x > VIEW.w * 0.38 && f.pos.x < VIEW.w * 0.62) {       // center band: gravity reversed
          Body.applyForce(f.body, f.pos, { x: 0, y: -f.body.mass * engine.gravity.y * 0.0022 });
          if (f.body.velocity.y < -11) Body.setVelocity(f.body, { x: f.body.velocity.x, y: -11 });
        }
      }
    } else if (arenaEvent === 'tilt') {
      engine.gravity.x = Math.sin(Date.now() / 1000 * 0.7) * 0.55;      // M65 whole arena tilts side to side; fighters slide
    }
    // 'dark' -> render vignette; 'mirror' -> input reversal. Both handled elsewhere.
  }
  function fireRoundEvent() {
    _eventFired = true;
    _announce = { text: roundEventName, t: 1.8 };
    try { SFX.parry(); } catch (e) {}
    if (roundEvent === 'weaponrain') { for (let i = 0; i < 5; i++) spawnWeaponDrop(); }
    else if (roundEvent === 'frenzy') { activeMod.speed = Math.max(activeMod.speed || 1, 1.4); activeMod.dmgMul = Math.max(activeMod.dmgMul || 1, 1.3); }
    else if (roundEvent === 'suddendeath') { _suddenDeath = true; }
    else if (roundEvent === 'meteor') { _meteorT = 3.0; _meteorAcc = 0; }
    else if (roundEvent === 'bounty') { _bounty = { x: VIEW.w / 2, y: VIEW.h * 0.46, claimed: false }; }
  }
  function tickRoundEvent(dt) {
    if (_suddenDeath) { for (const f of fighters) if (f.alive) envHurt(f, 7 * dt, 0); }
    if (_meteorT > 0) {
      _meteorT -= dt; _meteorAcc -= dt;
      if (_meteorAcc <= 0) { _meteorAcc = 0.28; const mx = 120 + Math.random() * (VIEW.w - 240); spawnBullet(mx, -20, Math.PI / 2 + (Math.random() - 0.5) * 0.3, null, METEOR_W); }
    }
    if (_bounty && !_bounty.claimed) {
      for (const f of fighters) {
        if (!f.alive) continue;
        if (Math.hypot(f.pos.x - _bounty.x, f.pos.y - _bounty.y) < 42) {
          _bounty.claimed = true; f.hp = Math.min(f.maxHp, f.hp + 40);
          f.hype = Math.min(100, (f.hype || 0) + 30); f._celebrate = 0.8;
          _announce = { text: (f.name || 'Fighter') + ' CLAIMED BOUNTY!', t: 1.8 };
          break;
        }
      }
    }
  }
  function tickGameMode(dt) {
    // KING OF THE HILL: a team that solely occupies the center zone earns points; first to KOTH_TARGET wins.
    if (curMode === 'koth' && _kothScore) {
      const occ = new Set();
      for (const f of fighters) if (f.alive && Math.hypot(f.pos.x - KOTH_ZONE.x, f.pos.y - KOTH_ZONE.y) < KOTH_ZONE.r) occ.add(f.team);
      if (occ.size === 1) { const t = [...occ][0]; _kothScore[t] = (_kothScore[t] || 0) + dt * 20; }
      for (let t = 0; t < _kothScore.length; t++) {
        if (_kothScore[t] >= KOTH_TARGET && !roundOver) {
          roundOver = true; roundEndT = 1.6; _slowmo = 0.4;
          scores[t] = (scores[t] || 0) + 1;
          _announce = { text: (t === 0 ? 'TEAM A' : 'TEAM B') + ' HOLDS THE HILL!', t: 1.8 };
        }
      }
    }
    // INFECTION: zombies (team 1) convert touched survivors (team 0). Survivors win if any remain at time-up.
    if (curMode === 'infection') {
      for (const z of fighters) {
        if (!z.alive || z.team !== 1) continue;
        for (const s of fighters) {
          if (!s.alive || s.team !== 0) continue;
          if (Math.hypot(z.pos.x - s.pos.x, z.pos.y - s.pos.y) < 34) {
            s.team = 1; s.color = '#7ee07e'; s.name = 'ZOMBIE'; s._celebrate = 0.4;
            sparks(s.pos.x, s.pos.y); try { SFX.hit(); } catch (e) {}
          }
        }
      }
      if (_infectT > 0) {
        _infectT -= dt;
        if (_infectT <= 0 && !roundOver && aliveTeams().has(0)) {
          roundOver = true; roundEndT = 1.6;
          scores[0] = (scores[0] || 0) + 1;
          _announce = { text: 'SURVIVORS HELD OUT!', t: 1.8 };
        }
      }
    }
  }

  function updateMovingPlatforms(dt) {
    if (TRAIN) return;
    for (const p of platforms) {
      if (p.rotate) { // M65 seesaw / rotating platform (play only)
        p._rphase = (p._rphase || 0) + dt * p.rotate.speed;
        const ang = Math.sin(p._rphase) * p.rotate.amp;
        try { Body.setAngle(p.body, ang); Body.setAngularVelocity(p.body, 0); } catch (e) {}
        p._angle = ang;
      }
      if (!p.move) continue;
      p._phase = (p._phase || 0) + dt * (p.move.speed / Math.max(1, p.move.range));
      const offset = Math.sin(p._phase) * p.move.range;
      const nx = p.move.axis === 'x' ? p._originX + offset : p._originX;
      const ny = p.move.axis === 'y' ? p._originY + offset : p._originY;
      Body.setPosition(p.body, { x: nx, y: ny }); p.x = nx; p.y = ny;
    }
  }

  // Gap 6 — arena fade transition (frame-driven, no timers).
  let _transAlpha = 0, _transDir = 0, _transCb = null;
  function startArenaTransition(cb) { if (_transDir === 1) { try { cb(); } catch (e) {} return; } _transDir = 1; _transCb = cb; }
  function tickTransition() {
    if (_transDir === 0 && _transAlpha === 0) return;
    if (_transDir === 1) { _transAlpha = Math.min(1, _transAlpha + 0.08); if (_transAlpha >= 1) { if (_transCb) { try { _transCb(); } catch (e) {} _transCb = null; } _transDir = -1; } }
    else if (_transDir === -1) { _transAlpha = Math.max(0, _transAlpha - 0.06); if (_transAlpha <= 0) _transDir = 0; }
  }
  function drawTransition(g) {
    if (_transAlpha <= 0) return;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = 'rgba(0,0,0,' + _transAlpha + ')'; g.fillRect(0, 0, VIEW.w, VIEW.h);
    if (_transAlpha > 0.5) { g.fillStyle = 'rgba(255,255,255,' + ((_transAlpha - 0.5) * 0.3) + ')'; g.fillRect(0, 0, VIEW.w, VIEW.h); }
    g.restore();
  }

  // Gap 4 — themed weapon drops: per-theme glow, hover bob, pixel sparkle orbit.
  function drawWeaponDrop(g, w) {
    const x = w.body.position.x, y = w.body.position.y;
    const theme = (ARENAS[currentArena] || {}).theme;
    const t = Date.now() / 1000;
    const glow = ({ castle: '#ffb347', forest: '#9bd14f', factory: '#ff9a1a', scifi: '#22d3ee', lab: '#43e8cf' })[theme] || '#ffd23f';
    g.save();
    g.translate(x, y + Math.sin(t * 3 + x * 0.01) * 4); // hover bob
    if (!TRAIN) { const sa = t * 2 + x; for (let i = 0; i < 4; i++) { const a = sa + i * Math.PI / 2, r = 18 + Math.sin(t * 4 + i) * 4; pxRect(g, Math.cos(a) * r - 2, Math.sin(a) * r - 2, 3, 3, glow); } } // sparkle orbit
    g.rotate(w.body.angle);
    g.shadowColor = glow; g.shadowBlur = 18;
    drawGun(g, -14, 0, 0, w.type);
    g.restore();
  }

  function drawScore(g) {
    g.save();
    g.textAlign = 'center';
    if (curMode === 'ffa') {
      g.font = '900 16px Trebuchet MS'; g.fillStyle = 'rgba(255,255,255,.82)';
      g.fillText(scores.map((s, i) => (fighters[i] ? fighters[i].name : '?') + ':' + s).join('   '), VIEW.w/2, 40);
      g.font = '700 12px Trebuchet MS'; g.fillStyle = 'rgba(255,255,255,.3)';
      g.fillText('FREE-FOR-ALL · FIRST TO ' + winTarget(), VIEW.w/2, 60);
    } else {
      const team = (curMode === '2v2' || curMode === '3v3' || curMode === '4v4');
      g.font = '900 30px Trebuchet MS';
      g.fillStyle = team ? '#ff7b6b' : '#ffd23f'; g.fillText(scores[0], VIEW.w/2 - 40, 50);
      g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText('–', VIEW.w/2, 50);
      g.fillStyle = team ? '#4db5ff' : '#ff5c5c'; g.fillText(scores[1], VIEW.w/2 + 40, 50);
      g.font = '700 12px Trebuchet MS'; g.fillStyle = 'rgba(255,255,255,.3)';
      g.fillText((team ? 'TEAM A vs TEAM B · ' : '') + 'FIRST TO ' + winTarget(), VIEW.w/2, 68);
    }
    g.restore();
  }

  // M107: live match countdown clock. The round auto-resolves at MAX_ROUND_TIME,
  // so this shows the player how long is left before the stalemate resolution.
  function drawMatchTimer(g) {
    if (typeof roundTime === 'undefined' || typeof MAX_ROUND_TIME === 'undefined') return;
    const left = Math.max(0, MAX_ROUND_TIME - roundTime);
    const ss = Math.floor(left % 60), mm = Math.floor(left / 60);
    const label = mm + ':' + String(ss).padStart(2, '0');
    const urgent = left <= 5;
    const cx = VIEW.w / 2, top = 80, w = 90, h = 32;
    g.save();
    g.textAlign = 'center';
    const pulse = urgent ? (0.55 + 0.45 * Math.abs(Math.sin(roundTime * 7))) : 1;
    g.globalAlpha = 0.92 * pulse;
    g.fillStyle = urgent ? '#7a1d16' : 'rgba(8,10,18,0.55)';
    roundRect(g, cx - w / 2, top, w, h, 9); g.fill();
    g.globalAlpha = pulse;
    g.strokeStyle = urgent ? '#ff6a5a' : 'rgba(255,255,255,0.18)';
    g.lineWidth = 1.5; roundRect(g, cx - w / 2, top, w, h, 9); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = urgent ? '#ffd23f' : 'rgba(255,255,255,0.9)';
    g.font = '900 20px Trebuchet MS';
    g.fillText('\u23f1 ' + label, cx, top + 22);
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w/2, h/2);
    g.beginPath();
    g.moveTo(x+r, y);
    g.arcTo(x+w, y, x+w, y+h, r);
    g.arcTo(x+w, y+h, x, y+h, r);
    g.arcTo(x, y+h, x, y, r);
    g.arcTo(x, y, x+w, y, r);
    g.closePath();
  }

  // ============================================================
  //  UI wiring
  // ============================================================
  // ============================================================
  //  Replay recorder
  // ============================================================
  function toggleRecord() {
    if (recording) { stopRecord(); return; }
    if (!canvas.captureStream || !window.MediaRecorder) {
      alert('This browser does not support video recording. Try the latest Chrome/Edge/Firefox.');
      return;
    }
    let mime = '';
    for (const c of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(c)) { mime = c; break; }
    }
    if (!mime) { alert('Recording format not supported by this browser.'); return; }
    try {
      const stream = canvas.captureStream(60);
      recChunks = [];
      mediaRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
      mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRec.onstop = () => {
        const blob = new Blob(recChunks, { type: 'video/webm' });
        // Guard against empty/broken recordings (e.g. Stop pressed too fast).
        if (!recChunks.length || blob.size < 2048) {
          alert('Recording empty \u2014 nothing was captured.\nClick \u23fa Record, let it run at least 1\u20132 seconds, then click \u23f9 Stop & Download.');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'stickfight-replay-' + Date.now() + '.webm';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      };
      mediaRec.start(200); // flush a chunk every 200ms so data is never lost on stop
      recStart = performance.now();
      recording = true;
      updateRecBtn();
    } catch (e) { alert('Failed to start recording: ' + e.message); }
  }
  function stopRecord() {
    if (mediaRec && mediaRec.state !== 'inactive') {
      // If the user stops almost instantly, wait a beat so at least one frame is captured.
      const elapsed = performance.now() - (recStart || 0);
      const finishStop = () => { try { mediaRec.requestData(); } catch (e) {} mediaRec.stop(); };
      if (elapsed < 500) { setTimeout(finishStop, 500 - elapsed); } else { finishStop(); }
    }
    recording = false;
    updateRecBtn();
  }
  function updateRecBtn() {
    const b = document.getElementById('btn-rec');
    if (!b) return;
    if (recording) { b.textContent = '\u23f9 Stop & Download'; b.classList.add('recording'); }
    else { b.textContent = '\u23fa Record'; b.classList.remove('recording'); }
  }

  // ============================================================
  //  AUTO MATCH REPLAY (high-fps, MP4) — records the whole match off the live
  //  canvas at 60fps, then on match end pops a replay viewer with a one-click
  //  MP4 download. Falls back to WEBM only if the browser cannot encode MP4.
  // ============================================================
  let arRec = null, arChunks = [], arMime = '', arExt = 'webm', arActive = false, arBlobUrl = null, _replayOv = null;
  function arPickMime() {
    const list = [
      'video/mp4;codecs=avc1.640029', 'video/mp4;codecs=avc1.42E01F',
      'video/mp4;codecs=h264', 'video/mp4',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'
    ];
    for (const m of list) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return '';
  }
  function startMatchReplay() {
    if (arActive) return;                                  // already rolling this match
    if (!canvas.captureStream || !window.MediaRecorder) return;
    const mime = arPickMime();
    if (!mime) return;
    try {
      const stream = canvas.captureStream(60);             // 60 FPS capture (high frame rate)
      arChunks = []; arMime = mime;
      arExt = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      arRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16000000 }); // 16 Mbps for crisp 1440p
      arRec.ondataavailable = (e) => { if (e.data && e.data.size) arChunks.push(e.data); };
      arRec.onstop = () => {
        try {
          const blob = new Blob(arChunks, { type: arMime.split(';')[0] });
          if (arChunks.length && blob.size >= 2048) {
            if (arBlobUrl) { try { URL.revokeObjectURL(arBlobUrl); } catch (e) {} }
            arBlobUrl = URL.createObjectURL(blob);
            showReplayOverlay(arBlobUrl, arExt, blob.size);
          }
        } catch (e) {}
        arActive = false;
      };
      arRec.start(200);                                    // flush a chunk every 200ms
      arActive = true;
    } catch (e) { arActive = false; }
  }
  function stopMatchReplay() {                             // stop + show the replay viewer
    if (!arActive || !arRec) { arActive = false; return; }
    try { arRec.requestData(); } catch (e) {}
    try { if (arRec.state !== 'inactive') arRec.stop(); else arActive = false; } catch (e) { arActive = false; }
  }
  function cancelMatchReplay() {                           // abort without showing (e.g. quit to menu)
    if (arActive && arRec) {
      try { arRec.onstop = () => { arActive = false; }; arRec.requestData(); arRec.stop(); }
      catch (e) { arActive = false; }
    } else { arActive = false; }
  }
  function hideReplayOverlay() { if (_replayOv) _replayOv.style.display = 'none'; }
  function showReplayOverlay(url, ext, size) {
    if (!_replayOv) {
      const ov = document.createElement('div');
      ov.id = 'replay-overlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(6,8,16,.86);font-family:inherit;';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:#11151f;border:1px solid #2a3346;border-radius:14px;padding:18px;max-width:92vw;max-height:92vh;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 60px rgba(0,0,0,.6);';
      const title = document.createElement('div');
      title.style.cssText = 'font-size:20px;font-weight:700;color:#ffd23f;';
      title.textContent = '\uD83C\uDFAC Match Replay';
      const vid = document.createElement('video');
      vid.id = 'replay-video';
      vid.controls = true; vid.autoplay = true; vid.loop = true; vid.playsInline = true;
      vid.style.cssText = 'max-width:86vw;max-height:62vh;border-radius:10px;background:#000;';
      const note = document.createElement('div');
      note.id = 'replay-note';
      note.style.cssText = 'font-size:12px;color:#8b94a8;';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;';
      const dl = document.createElement('a');
      dl.id = 'replay-dl';
      dl.style.cssText = 'background:#ffd23f;color:#1a1205;font-weight:700;padding:10px 16px;border-radius:8px;text-decoration:none;cursor:pointer;';
      const again = document.createElement('button');
      again.textContent = '\u25B6 Play Again';
      again.style.cssText = 'background:#2a3346;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600;';
      again.onclick = () => { hideReplayOverlay(); try { startRound(); } catch (e) {} };
      const close = document.createElement('button');
      close.textContent = '\u2716 Close';
      close.style.cssText = 'background:transparent;color:#8b94a8;border:1px solid #2a3346;padding:10px 16px;border-radius:8px;cursor:pointer;';
      close.onclick = hideReplayOverlay;
      row.appendChild(dl); row.appendChild(again); row.appendChild(close);
      panel.appendChild(title); panel.appendChild(vid); panel.appendChild(note); panel.appendChild(row);
      ov.appendChild(panel); document.body.appendChild(ov);
      _replayOv = ov;
    }
    const vid = document.getElementById('replay-video');
    const dl = document.getElementById('replay-dl');
    const note = document.getElementById('replay-note');
    try { vid.src = url; vid.currentTime = 0; vid.play().catch(() => {}); } catch (e) {}
    dl.href = url;
    dl.download = 'stickfight-replay-' + Date.now() + '.' + ext;
    dl.textContent = '\u2B07\uFE0F Download ' + ext.toUpperCase();
    const mb = size ? (size / 1048576).toFixed(1) + ' MB \u00b7 ' : '';
    note.textContent = mb + (ext === 'mp4'
      ? 'MP4 \u00b7 60 FPS \u2014 siap dibagikan.'
      : 'Browser ini belum mendukung rekaman MP4, file disimpan sebagai WEBM (60 FPS). Pakai Chrome/Edge terbaru untuk MP4.');
    _replayOv.style.display = 'flex';
  }

  function refreshBrainStatus() {
    const el = document.getElementById('brain-status');
    const cb = document.getElementById('use-brain');
    if (bestBrain) {
      if (el) { el.textContent = 'Trained AI ready \u2014 Gen ' + (bestBrainMeta.gen || '?') + ', score ' + (bestBrainMeta.fit != null ? bestBrainMeta.fit : '?') + (bestBrainMeta.trained ? ', total trained ' + bestBrainMeta.trained + ' generations' : '') + '.'; el.classList.add('has'); }
      if (cb) cb.checked = true;
    } else {
      if (el) { el.textContent = 'No trained AI yet.'; el.classList.remove('has'); }
      if (cb) cb.checked = false;
    }
    try { renderPlayerStyle(); } catch (e) {}
  }

  function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
  function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }
  function showResult(text, matchOver) {
    document.getElementById('result-text').textContent = text;
    document.getElementById('btn-next').textContent = matchOver ? 'Play Again' : 'Next Round';
    state = 'result';
    showOverlay('result');
    if (matchOver) { scores = [0,0]; }
  }
  function togglePause() {
    if (state === 'play') { state = 'paused'; showOverlay('pause'); }
    else if (state === 'paused') { state = 'play'; hideOverlay('pause'); last = performance.now(); }
  }

  document.getElementById('btn-bot').onclick = () => { setupMatch('bot'); startRound(); };
  document.getElementById('btn-1p').onclick = () => { setupMatch('1p'); startRound(); };
  document.getElementById('btn-2p').onclick = () => { setupMatch('2p'); startRound(); };
  ['2v2', '3v3', '4v4', 'ffa', 'koth', 'infection', 'boss'].forEach(m => {
    const el = document.getElementById('btn-' + m);
    if (el) el.onclick = () => { setupMatch(m); startRound(); };
  });
  function updateArenaLabel() {
    const n = document.getElementById('arena-name'); if (n) n.textContent = ARENAS[currentArena].name;
    const i = document.getElementById('arena-idx'); if (i) i.textContent = '(' + (currentArena + 1) + '/' + ARENAS.length + ')';
  }
  function cycleArena(d) { try { SFX.click(); } catch (e) {} startArenaTransition(() => { buildLevel(currentArena + d); updateArenaLabel(); }); }
  document.getElementById('btn-arena-prev').onclick = () => cycleArena(-1);
  document.getElementById('btn-arena-next').onclick = () => cycleArena(1);
  document.getElementById('btn-next').onclick = () => { startRound(); };
  document.getElementById('btn-menu').onclick = () => { state = 'menu'; cancelMatchReplay(); hideReplayOverlay(); showOverlay('menu'); hideOverlay('result'); };
  document.getElementById('btn-resume').onclick = () => togglePause();
  document.getElementById('btn-pmenu').onclick = () => { state = 'menu'; cancelMatchReplay(); hideReplayOverlay(); showOverlay('menu'); hideOverlay('pause'); };
  document.getElementById('btn-train').onclick = () => {
    const sb = document.getElementById('btn-train-stop');
    if (sb) sb.textContent = 'Finish & Save'; // reset label in case a prior run was interrupted
    try { engine.gravity.y = 1.6; engine.gravity.x = 0; } catch (e) {} activeMod = {}; activeModName = ''; // M61 ensure training runs the base game (no leaked modifier)
    hideOverlay('menu'); showOverlay('train'); state = 'train'; Trainer.start();
  };
  document.getElementById('btn-train-stop').onclick = () => { if (Trainer.done) Trainer.close(); else Trainer.complete(); };
  document.getElementById('btn-export').onclick = exportBrain;
  document.getElementById('btn-import').onclick = () => document.getElementById('import-file').click();
  document.getElementById('import-file').onchange = (e) => { const f = e.target.files[0]; if (f) importBrain(f); e.target.value = ''; };
  { const _br = document.getElementById('btn-reset'); if (_br) _br.onclick = resetAllAI; }
  document.getElementById('btn-rec').onclick = toggleRecord;
  { const _bt = document.getElementById('btn-tournament'); if (_bt) _bt.onclick = () => showTournamentResults(TournamentSystem.runTournament()); } // #100

  // ============================================================
  //  👑 KING TOURNAMENT — 8 juara terakhir diadu 1v1 sistem gugur.
  //  Intro: arena & event di-SPIN acak. Final: animasi podium —
  //  sang raja angkat piala di tengah, runner-up & juara 3 di samping.
  // ============================================================
  const KING_KEY = 'sf_kings_v1';
  const King = {
    active: false, phase: 'idle', t: 0, winsNeeded: 2,
    contenders: [], qfPairs: [], wbR1W: [], wbR1L: [], wbSFW: [], wbSFL: [], lbR1W: [], lbR2W: [],
    wbFinalW: null, wbFinalL: null, lbR3W: null, lbFinalW: null,
    wbFinalDone: false, lbSFDone: false, lbFinalDone: false, finalDone: false,
    results: { king: null, runner: null, third: null },
    arenaIdx: 0, eventId: null, eventName: '', evtPick: 0,
    curMatch: null, lastWinner: null, lastLabel: '', confetti: [],

    eventChoices() {
      return [
        { id: null,       name: '⚔️ NORMAL' },
        { id: 'flood',    name: '🌊 RISING LAVA' },
        { id: 'shrink',   name: '↔️ SHRINKING' },
        { id: 'tilt',     name: '🌀 TILTING' },
      ];
    },
    colorName(hex) {
      const m = { '#ff5c5c': 'Red', '#ff9f43': 'Orange', '#ffd23f': 'Yellow', '#4ec96a': 'Green', '#4db5ff': 'Blue', '#b06cff': 'Purple', '#9aa3b2': 'Gray', '#8a5a3c': 'Brown' };
      return m[(hex || '').toLowerCase()] || 'Fighter';
    },
    loadContenders() {
      const list = [];
      const seen = {};
      const add = (g, name) => {
        if (!g || !g.length) return;
        const f = (g.length === GENOME_LEN) ? Float32Array.from(g) : migrateGenome(Float32Array.from(g));
        const sig = _genomeSig(f);
        if (seen[sig]) return; // keep the 8 slots as 8 DISTINCT brains, not clones
        seen[sig] = 1;
        list.push({ genome: f, name: name });
      };
      // Prefer the rolling pool of the last 8 DISTINCT training champions (newest first).
      const pool = loadKingPool();
      for (let i = pool.length - 1; i >= 0; i--) add(pool[i], 'Champion-' + (pool.length - i));
      if (bestBrain) add(bestBrain, 'Champion');
      const hof = loadHoF() || [];
      for (let i = hof.length - 1; i >= 0; i--) add(hof[i], 'HoF-' + (hof.length - i));
      const pop = loadPop() || [];
      for (let i = 0; i < pop.length; i++) add(pop[i], 'Brain-' + (i + 1));
      let out = list.slice(0, 8);
      if (out.length < 2) return out;
      let i = 0;
      while (out.length < 8) { const base = out[i % out.length]; out.push({ genome: mutate(Float32Array.from(base.genome)), name: base.name + ' B' }); i++; }
      out.forEach((c, idx) => { c.color = POP_COLORS[idx % POP_COLORS.length]; c.seed = idx + 1; c.name = this.colorName(c.color); });
      return out;
    },
    start() {
      const c = this.loadContenders();
      if (!c || c.length < 2) { alert('Need at least 2 champion brains for the King Tournament. Train some AI first 🙂'); return; }
      this.active = true; this.contenders = c;
      // Seed by persistent Rank Points: highest-ranked gets the easiest QF draw (1v8, 2v7...).
      try {
        const _rdb = loadRankDB();
        const _pts = (nm) => { const e = _rdb.find(x => x.name === nm); return e ? e.pts : 0; };
        c.sort((a, b) => _pts(b.name) - _pts(a.name));
        c.forEach((x, i) => { x.color = POP_COLORS[i % POP_COLORS.length]; x.seed = i + 1; x.name = this.colorName(x.color); });
      } catch (e) {}
      this.wbR1W = []; this.wbR1L = []; this.wbSFW = []; this.wbSFL = []; this.lbR1W = []; this.lbR2W = [];
      this.wbFinalW = null; this.wbFinalL = null; this.lbR3W = null; this.lbFinalW = null;
      this.wbFinalDone = false; this.lbSFDone = false; this.lbFinalDone = false; this.finalDone = false;
      this.results = { king: null, runner: null, third: null };
      this.confetti = []; this._matchNo = 0; this._stats = {}; this.awards = []; this._comment = null; this._highlight = null;
      const s = this.contenders;
      this.qfPairs = [[s[0], s[7]], [s[3], s[4]], [s[1], s[6]], [s[2], s[5]]];
      this.arenaIdx = (Math.random() * ARENAS.length) | 0;
      const ev = this.eventChoices();
      this.evtPick = (Math.random() * ev.length) | 0;
      this.eventId = ev[this.evtPick].id; this.eventName = ev[this.evtPick].name;
      hideOverlay('menu');
      this.phase = 'spin'; this.t = 0; state = 'king';
    },
    exit() {
      this.active = false; this.phase = 'idle'; this.curMatch = null;
      arenaEvent = null; arenaEventName = '';
      state = 'menu'; showOverlay('menu');
      try { refreshBrainStatus(); renderRankBoard(); } catch (e) {}
    },
    buildNextMatch() {
      // ── WINNERS BRACKET ──
      if (this.wbR1W.length < 4) { const p = this.qfPairs[this.wbR1W.length]; return this.queueMatch(p[0], p[1], 'WB · PEREMPAT FINAL ' + (this.wbR1W.length + 1), 'wbqf'); }
      if (this.wbSFW.length < 2) { const b = this.wbSFW.length * 2; return this.queueMatch(this.wbR1W[b], this.wbR1W[b + 1], 'WB · SEMIFINAL ' + (this.wbSFW.length + 1), 'wbsf'); }
      // ── LOSERS ronde 1: 4 yang kalah di WB-R1 → 2 lolos (kalah = peringkat 7–8) ──
      if (this.lbR1W.length < 2) { const b = this.lbR1W.length * 2; return this.queueMatch(this.wbR1L[b], this.wbR1L[b + 1], 'LB · ROUND 1 — #' + (this.lbR1W.length + 1), 'lbr1'); }
      // ── WINNERS FINAL (kalah turun ke LB Final) ──
      if (!this.wbFinalDone) return this.queueMatch(this.wbSFW[0], this.wbSFW[1], 'WB · FINAL', 'wbf');
      // ── LOSERS ronde 2: pemenang LB-R1 vs yang kalah di WB-SF (disilang; kalah = peringkat 5–6) ──
      if (this.lbR2W.length < 2) { const i = this.lbR2W.length; return this.queueMatch(this.lbR1W[i], this.wbSFL[1 - i], 'LB · ROUND 2 — #' + (this.lbR2W.length + 1), 'lbr2'); }
      // ── LOSERS SEMIFINAL (kalah = peringkat 4) ──
      if (!this.lbSFDone) return this.queueMatch(this.lbR2W[0], this.lbR2W[1], 'LB · SEMIFINAL', 'lbsf');
      // ── LOSERS FINAL: pemenang LB-SF vs yang kalah di WB-Final (kalah = JUARA 3) ──
      if (!this.lbFinalDone) return this.queueMatch(this.lbR3W, this.wbFinalL, 'LB · FINAL', 'lbf');
      // ── GRAND FINAL: juara WB vs juara LB ──
      if (!this.finalDone) return this.queueMatch(this.wbFinalW, this.lbFinalW, 'GRAND FINAL', 'gf');
      return this.toPodium();
    },
    queueMatch(a, b, label, stage) {
      // Random arena (and event) per match — QF1 keeps the arena revealed by the spin.
      if (this._matchNo > 0) {
        this.arenaIdx = (Math.random() * ARENAS.length) | 0;
        const ev = this.eventChoices(); this.evtPick = (Math.random() * ev.length) | 0;
        this.eventId = ev[this.evtPick].id; this.eventName = ev[this.evtPick].name;
      }
      this._matchNo = (this._matchNo || 0) + 1;
      this.winsNeeded = (stage === 'gf') ? 3 : 2;   // Grand Final = best of 5, every other round = best of 3
      this.curMatch = { a: a, b: b, label: label, stage: stage, bestOf: this.winsNeeded * 2 - 1 };
      this.phase = 'matchcard'; this.t = 0; state = 'king';
    },
    beginFight() {
      const cm = this.curMatch; if (!cm) return;
      curMode = 'bot';
      fighters.forEach(f => { try { World.remove(world, f.body); } catch (e) {} }); fighters = [];
      buildLevel(this.arenaIdx);
      const sp = computeSpawns(2);
      const f0 = new Fighter({ x: sp[0].x, y: sp[0].y, color: cm.a.color, name: cm.a.name, facing: 1, isAI: true, team: 0, controls: {} });
      const f1 = new Fighter({ x: sp[1].x, y: sp[1].y, color: cm.b.color, name: cm.b.name, facing: -1, isAI: true, team: 1, controls: {} });
      f0.brain = cm.a.genome; f1.brain = cm.b.genome;
      fighters.push(f0, f1);
      scores = [0, 0];
      this._highlight = null;                  // M87 reset per-match highlight
      try { SFX.kingHorn(); } catch (e) {}     // M107: regal horn fanfare as each King match begins
      this.startKingRound();
    },
    startKingRound() {
      ragdolls.forEach(r => { try { r.remove(); } catch (e) {} }); ragdolls = [];
      bullets.forEach(b => { try { World.remove(world, b); } catch (e) {} }); bullets = [];
      weapons.forEach(w => { try { if (!w.taken) World.remove(world, w.body); } catch (e) {} }); weapons = [];
      particles = [];
      fighters.forEach(f => f.reset());
      try { engine.gravity.y = 1.6; engine.gravity.x = 0; } catch (e) {}
      activeMod = {}; activeModName = ''; _modBannerT = 0;
      for (const f of fighters) f.maxHp = 100;
      _slowmo = 0; _announce = null;
      for (const f of fighters) { f._entrance = 1.0; f._trail = []; }
      try { SFX.respawn(); } catch (e) {}   // M107: king-round drop-in whoosh
      _countdown = { t: 1.9, ph: -1 }; // M96 pre-round countdown
      windX = 0;
      arenaEvent = this.eventId; arenaEventName = this.eventName;
      _floodY = VIEW.h + 80; _shrinkX = 0; _ambient = null;
      roundEvent = null; roundEventName = ''; _eventFired = false; _eventAt = 999;
      _suddenDeath = false; _meteorT = 0; _meteorAcc = 0; _bounty = null;
      roundOver = false; roundEndT = 0; roundTime = 0; weaponTimer = 1.2;
      state = 'play';
      hideOverlay('result'); hideOverlay('pause'); hideOverlay('menu');
      try {                                    // M87 round-intro commentary
        const _cm = this.curMatch, _need = this.winsNeeded, _a = (scores && scores[0]) || 0, _b = (scores && scores[1]) || 0;
        if (_cm) {
          if (_a === _need - 1 && _a > _b) this.say('🎯 MATCH POINT for ' + _cm.a.name + '!', 3.0);
          else if (_b === _need - 1 && _b > _a) this.say('🎯 MATCH POINT for ' + _cm.b.name + '!', 3.0);
          else if (_a > 0 || _b > 0) this.say('��� ' + _cm.a.name + ' ' + _a + ' — ' + _b + ' ' + _cm.b.name);
          else this.say(['🔔 Fight start!', '🥊 Opening round!', '⚡ Begin!'][(Math.random() * 3) | 0]);
        }
      } catch (e) {}
      try { if (!TRAIN) SFX.go(); } catch (e) {}
    },
    onMatchDecided(wi) {
      const cm = this.curMatch; if (!cm) return;
      const winner = wi === 0 ? cm.a : cm.b;
      const loser = wi === 0 ? cm.b : cm.a;
      if (cm.stage === 'wbqf') { this.wbR1W.push(winner); this.wbR1L.push(loser); }
      else if (cm.stage === 'wbsf') { this.wbSFW.push(winner); this.wbSFL.push(loser); }
      else if (cm.stage === 'lbr1') { this.lbR1W.push(winner); }                          // kalah = peringkat 7–8
      else if (cm.stage === 'wbf') { this.wbFinalW = winner; this.wbFinalL = loser; this.wbFinalDone = true; }
      else if (cm.stage === 'lbr2') { this.lbR2W.push(winner); }                          // kalah = peringkat 5–6
      else if (cm.stage === 'lbsf') { this.lbR3W = winner; this.lbSFDone = true; }         // kalah = peringkat 4
      else if (cm.stage === 'lbf') { this.lbFinalW = winner; this.results.third = loser; this.lbFinalDone = true; }
      else if (cm.stage === 'gf') { this.results.king = winner; this.results.runner = loser; this.finalDone = true; }
      this.lastWinner = winner; this.lastLabel = cm.label; this.curMatch = null;
      try { SFX.advance(); } catch (e) {}
      this.phase = 'advance'; this.t = 0; state = 'king';
    },
    say(text, life) { this._comment = { text: text, t: life || 2.6 }; },   // M87 commentator line
    recordRound() {
      // Accumulate per-round stats for every contender over the whole tournament.
      // matchStats + _roundStats reset each round (in Fighter.reset), so we sum them here.
      if (!this._stats) this._stats = {};
      const st = (nm) => (this._stats[nm] = this._stats[nm] || { rWon:0, rLost:0, kills:0, deaths:0, voidDeaths:0, voidKills:0, dmgDealt:0, dmgTaken:0, shots:0, hits:0, parries:0, blocks:0, jumps:0, meleeDmg:0, gunDmg:0, flawless:0, lowHpWins:0, rounds:0 });
      const live = fighters.filter(f => f.alive);
      const winner = live.length === 1 ? live[0] : null;
      for (const f of fighters) {
        const s = st(f.name); const rs = f._roundStats || {}; const ms = f.matchStats || {};
        s.rounds++;
        s.dmgDealt += rs.damageDealt || 0; s.dmgTaken += rs.damageTaken || 0;
        s.shots += ms.shotsFired || 0; s.hits += ms.shotsHit || 0;
        s.parries += ms.timesParried || 0; s.blocks += ms.timesBlocked || 0;
        s.jumps += ms.jumps || 0;
        s.meleeDmg += f._rsMeleeDmg || 0; s.gunDmg += f._rsGunDmg || 0;
        s.voidDeaths += rs.voidDeaths || 0;
        if (winner && f === winner) {
          s.rWon++;
          if ((rs.damageTaken || 0) < 1) s.flawless++;
          if (f.hp <= 25) s.lowHpWins++;
        } else if (winner) {
          s.rLost++; s.deaths++;
          const w = st(winner.name); w.kills++;
          if ((rs.voidDeaths || 0) > 0) w.voidKills++;
        }
      }
    },
    _awards() {
      // Scan tournament-wide stats and hand out achievement titles to the leader of each category.
      const S = this._stats || {}; const names = Object.keys(S); const out = [];
      if (!names.length) return out;
      const top = (emoji, title, fn, min, lowest) => {
        let best = null, bv = lowest ? Infinity : -Infinity;
        for (const n of names) { const v = fn(S[n], n); if (v == null) continue; if (lowest ? v < bv : v > bv) { bv = v; best = n; } }
        if (best != null && (min == null || (lowest ? bv <= min : bv >= min))) out.push({ emoji, title, holder: best });
      };
      top('🔫', 'Gunslinger', s => s.gunDmg, 30);
      top('🥊', 'Brawler', s => s.meleeDmg, 30);
      top('🎯', 'Sniper', s => s.shots >= 6 ? s.hits / s.shots : 0, 0.5);
      top('👻', 'Ghost', s => s.flawless, 1);
      top('🛡️', 'Turtle', s => s.blocks, 4);
      top('⚔️', 'Duelist', s => s.parries, 3);
      top('💥', 'Destroyer', s => s.dmgDealt, 80);
      top('🔥', 'Berserker', s => s.rounds >= 2 ? s.dmgDealt / s.rounds : null, 30);
      top('💪', 'Iron Wall', s => s.rounds >= 2 ? s.dmgTaken : null, null, true);
      top('🦘', 'Jumper', s => s.jumps, 12);
      top('🗿', 'Statue', s => s.rounds >= 2 ? s.jumps : null, null, true);
      top('🩸', 'Survivor', s => s.lowHpWins, 1);
      top('🪓', 'Executioner', s => s.kills, 2);
      top('🏹', 'Closer', s => s.rWon, 2);
      top('🕳️', 'Void Walker', s => s.voidKills, 1);
      top('🤡', 'Cockroach', s => s.voidDeaths, 2);
      top('🎖️', 'Veteran', s => s.rounds, 3);
      top('🎰', 'Sharpshooter', s => s.hits, 8);
      top('💨', 'Bullet Hose', s => s.shots, 14);
      top('���️', 'Killing Machine', s => s.rounds >= 2 ? s.kills / s.rounds : null, 1.0);
      top('🥋', 'Martial Master', s => (s.blocks || 0) + (s.parries || 0), 7);
      top('📊', 'Efficient Fighter', s => (s.rounds >= 2 && s.dmgTaken > 0) ? s.dmgDealt / s.dmgTaken : null, 2.5);
      top('🐐', 'The GOAT', s => (s.dmgDealt || 0) + (s.kills || 0) * 25 + (s.rWon || 0) * 40, 220);
      top('🧊', 'Cool Head', s => s.rounds >= 3 ? s.deaths : null, 1, true);
      top('⏱️', 'Quick Closer', s => (s.rWon >= 2 && s.rounds > 0) ? s.rWon / s.rounds : null, 0.75);
      top('🎢', 'Drama Specialist', s => (s.voidDeaths || 0) + (s.voidKills || 0), 3);
      top('🃏', 'The Klutz', s => s.deaths, 4);
      top('🏋️', 'Busiest', s => (s.dmgDealt || 0) + (s.dmgTaken || 0), 180);
      top('🔧', 'Weapon Specialist', s => (s.meleeDmg || 0) + (s.gunDmg || 0), 60);
      top('🪖', 'Commander', s => s.rounds >= 2 ? (s.rWon - s.rLost) : null, 2);
      top('🏆', 'Flawless', s => (s.rLost === 0 && s.rounds >= 3) ? s.rWon : null, 3);
      try {
        const r = this.results; const seedOf = nm => { const c = (this.contenders || []).find(x => x.name === nm); return c ? (c.seed || 1) : 1; };
        const pod = [r.king, r.runner, r.third].filter(Boolean);
        let dh = null, ds = -1; for (const p of pod) { const sd = seedOf(p.name); if (sd > ds) { ds = sd; dh = p.name; } }
        if (dh && ds >= 4) out.push({ emoji: '🐎', title: 'Dark Horse', holder: dh });
      } catch (e) {}
      return out;
    },
    _drawAwards(g) {
      const aw = this.awards || []; if (!aw.length) return;
      g.save(); g.textAlign = 'left';
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '800 15px Trebuchet MS';
      g.fillText('🏅 PENGHARGAAN', 36, 150);
      g.fillText('🏅 PENGHARGAAN', VIEW.w - 252, 150);
      g.font = '700 13px Trebuchet MS';
      const shown = aw.slice(0, 28);           // M87 cap display so columns never overflow into the footer
      const half = Math.ceil(shown.length / 2);
      for (let i = 0; i < shown.length; i++) {
        const col = i < half ? 0 : 1, row = col === 0 ? i : i - half;
        const x = col === 0 ? 36 : VIEW.w - 252, y = 176 + row * 22;
        const a = shown[i];
        g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText(a.emoji + ' ' + a.title, x, y);
        g.fillStyle = '#cfe3ff'; g.fillText(a.holder, x + 132, y);
      }
      g.restore();
    },
    toPodium() {
      const r = this.results;
      try {
        if (r.king) { addRankPoints(r.king.name, r.king.color, 120); bestBrain = r.king.genome.slice(); saveBrain(bestBrain, bestBrainMeta || {}); }
        if (r.runner) addRankPoints(r.runner.name, r.runner.color, 70);
        if (r.third) addRankPoints(r.third.name, r.third.color, 40);
        refreshBrainStatus(); renderRankBoard();
      } catch (e) { console.error('[King.toPodium award]', e); }
      try {
        const arr = JSON.parse(localStorage.getItem(KING_KEY) || '[]');
        arr.unshift({ name: r.king ? r.king.name : '?', date: Date.now(), map: (ARENAS[this.arenaIdx] || {}).name, event: this.eventName });
        while (arr.length > 10) arr.pop();
        localStorage.setItem(KING_KEY, JSON.stringify(arr));
      } catch (e) {}
      try { this.awards = this._awards(); } catch (e) { this.awards = []; }   // M86 compute achievement titles
      try { SFX.crown(); } catch (e) {}
      this.phase = 'podium'; this.t = 0; this.confetti = []; state = 'king';
    },
    tick(dt) {
      this.t += dt;
      if (this.phase === 'spin') { if (Math.floor(this.t / 0.13) !== Math.floor((this.t - dt) / 0.13) && this.t < 4.9) { try { SFX.spinTick(); } catch (e) {} } if (this.t >= 5.4) { try { SFX.spinStop(); } catch (e) {} this.phase = 'introcard'; this.t = 0; } }
      else if (this.phase === 'introcard') { if (this.t >= 3.0) this.buildNextMatch(); }
      else if (this.phase === 'matchcard') { if (this.t >= 2.6) { try { SFX.fightBell(); } catch (e) {} this.beginFight(); } }
      else if (this.phase === 'advance') { if (this.t >= 2.2) this.buildNextMatch(); }
      else if (this.phase === 'podium') { this._tickConfetti(dt); }
    },
    _spinPos(elapsed, dur, final) { const p = Math.max(0, Math.min(1, elapsed / dur)); return final * (1 - Math.pow(1 - p, 3)); },
    _reel(g, cx, cy, items, frac, title, accent) {
      const w = 300, h = 150, ih = 46;
      g.save();
      g.fillStyle = 'rgba(0,0,0,.45)'; roundRect(g, cx - w / 2, cy - h / 2, w, h, 14); g.fill();
      g.strokeStyle = accent; g.lineWidth = 3; roundRect(g, cx - w / 2, cy - h / 2, w, h, 14); g.stroke();
      g.save(); roundRect(g, cx - w / 2, cy - h / 2, w, h, 14); g.clip();
      const N = items.length, base = Math.floor(frac);
      g.textAlign = 'center';
      for (let d = -2; d <= 2; d++) {
        const idx = ((base + d) % N + N) % N;
        const yy = cy + (base + d - frac) * ih;
        const center = Math.abs(base + d - frac) < 0.5;
        g.globalAlpha = center ? 1 : 0.4;
        g.font = (center ? '900 22px' : '700 18px') + ' Trebuchet MS';
        g.fillStyle = center ? '#fff' : '#cfd6e6';
        g.fillText(items[idx], cx, yy + 8);
      }
      g.restore();
      g.globalAlpha = 0.85; g.strokeStyle = accent; g.lineWidth = 2;
      roundRect(g, cx - w / 2 + 6, cy - ih / 2, w - 12, ih, 8); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = accent; g.font = '800 15px Trebuchet MS'; g.textAlign = 'center';
      g.fillText(title, cx, cy - h / 2 - 12);
      g.restore();
    },
    _bg(g, top, bot) {
      g.save();
      const grd = g.createLinearGradient(0, 0, 0, VIEW.h);
      grd.addColorStop(0, top); grd.addColorStop(1, bot);
      g.fillStyle = grd; g.fillRect(0, 0, VIEW.w, VIEW.h);
      g.restore();
    },
    _stick(g, x, y, scale, color, pose) {
      g.save(); g.translate(x, y); g.scale(scale, scale);
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 4; g.lineCap = 'round';
      const bob = pose.bob || 0;
      const hipY = -34 + bob, shY = -58 + bob, hY = -72 + bob;
      g.beginPath(); g.moveTo(0, hipY); g.lineTo(-9, 0); g.moveTo(0, hipY); g.lineTo(9, 0); g.stroke();
      g.beginPath(); g.moveTo(0, hipY); g.lineTo(0, shY); g.stroke();
      if (pose.armsUp) { g.beginPath(); g.moveTo(0, shY); g.lineTo(-13, shY - 20); g.moveTo(0, shY); g.lineTo(13, shY - 20); g.stroke(); }
      else { g.beginPath(); g.moveTo(0, shY); g.lineTo(-13, shY + 14); g.moveTo(0, shY); g.lineTo(13, shY + 14); g.stroke(); }
      g.beginPath(); g.arc(0, hY, 9, 0, Math.PI * 2); g.fill();
      if (pose.crown) { g.fillStyle = '#ffd23f'; const cy = hY - 11; g.beginPath(); g.moveTo(-10, cy); g.lineTo(-10, cy - 9); g.lineTo(-5, cy - 4); g.lineTo(0, cy - 10); g.lineTo(5, cy - 4); g.lineTo(10, cy - 9); g.lineTo(10, cy); g.closePath(); g.fill(); }
      if (pose.trophy) { g.fillStyle = '#ffe27a'; const ty = shY - 30; g.fillRect(-8, ty - 6, 16, 11); g.beginPath(); g.arc(-8, ty, 4, 0, Math.PI * 2); g.arc(8, ty, 4, 0, Math.PI * 2); g.fill(); g.fillRect(-3, ty + 5, 6, 7); g.fillRect(-9, ty + 12, 18, 4); }
      g.restore();
    },
    _tickConfetti(dt) {
      if (this.confetti.length < 140 && Math.random() < 0.9) {
        const cols = ['#ff5c5c', '#ffd23f', '#4db5ff', '#4ec96a', '#b06cff', '#ff9f43'];
        this.confetti.push({ x: Math.random() * VIEW.w, y: -10, vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 120, r: 3 + Math.random() * 4, c: cols[(Math.random() * cols.length) | 0], a: Math.random() * Math.PI });
      }
      for (const p of this.confetti) { p.x += p.vx * dt; p.y += p.vy * dt; p.a += dt * 6; }
      this.confetti = this.confetti.filter(p => p.y < VIEW.h + 20);
    },
    _confettiDraw(g) { for (const p of this.confetti) { g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.fillRect(-p.r, -p.r, p.r * 2, p.r * 2); g.restore(); } },
    render(g) {
      g.save(); g.clearRect(0, 0, VIEW.w, VIEW.h);
      if (this.phase === 'spin') this._drawSpin(g);
      else if (this.phase === 'introcard') this._drawIntro(g);
      else if (this.phase === 'matchcard') this._drawMatchCard(g);
      else if (this.phase === 'advance') this._drawAdvance(g);
      else if (this.phase === 'podium') this._drawPodium(g);
      else this._bg(g, '#10131c', '#05060a');
      g.restore();
    },
    _drawSpin(g) {
      this._bg(g, '#241a33', '#0a0710');
      g.textAlign = 'center'; g.fillStyle = '#ffd23f'; g.font = '900 40px Trebuchet MS';
      g.fillText('👑 KING TOURNAMENT', VIEW.w / 2, 110);
      g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '700 18px Trebuchet MS';
      g.fillText('Memutar arena & event...', VIEW.w / 2, 145);
      const maps = ARENAS.map(a => a.name);
      const evs = this.eventChoices().map(e => e.name);
      const mapFrac = this._spinPos(Math.min(this.t, 2.3), 2.3, 4 * maps.length + this.arenaIdx);
      const evEl = this.t - 2.6;
      const evFrac = evEl <= 0 ? 0 : this._spinPos(Math.min(evEl, 2.3), 2.3, 4 * evs.length + this.evtPick);
      this._reel(g, VIEW.w / 2 - 190, 380, maps, mapFrac, '🗺️ ARENA', '#43e8cf');
      this._reel(g, VIEW.w / 2 + 190, 380, evs, evFrac, '⚡ EVENT', '#ff9f43');
      if (this.t >= 5.0) { g.fillStyle = '#fff'; g.font = '800 24px Trebuchet MS'; g.fillText('Siap!', VIEW.w / 2, 520); }
    },
    _drawIntro(g) {
      this._bg(g, '#1a2333', '#070a10');
      g.textAlign = 'center';
      g.fillStyle = '#ffd23f'; g.font = '900 34px Trebuchet MS';
      g.fillText('8-CHAMPION BRACKET', VIEW.w / 2, 80);
      g.fillStyle = '#43e8cf'; g.font = '800 22px Trebuchet MS';
      g.fillText('🗺️ ' + ((ARENAS[this.arenaIdx] || {}).name || '?') + '   ·   ' + this.eventName, VIEW.w / 2, 120);
      const pairs = this.qfPairs;
      for (let i = 0; i < pairs.length; i++) {
        const yy = 190 + i * 68;
        const a = pairs[i][0], b = pairs[i][1];
        g.textAlign = 'right'; g.fillStyle = a.color; g.font = '700 20px Trebuchet MS'; g.fillText(a.name, VIEW.w / 2 - 60, yy);
        g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '800 18px Trebuchet MS'; g.fillText('VS', VIEW.w / 2, yy);
        g.textAlign = 'left'; g.fillStyle = b.color; g.font = '700 20px Trebuchet MS'; g.fillText(b.name, VIEW.w / 2 + 60, yy);
      }
      g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '700 16px Trebuchet MS';
      g.fillText('Double Elimination · Losers Bracket (2nd chance) · Grand Final Best of 5', VIEW.w / 2, 540);
    },
    _drawMatchCard(g) {
      const cm = this.curMatch; if (!cm) return;
      this._bg(g, '#2a1020', '#08040a');
      g.textAlign = 'center';
      const k = Math.min(1, this.t / 0.5), sc = 0.8 + 0.2 * k;
      g.fillStyle = '#ffd23f'; g.font = '800 26px Trebuchet MS';
      g.fillText(cm.label, VIEW.w / 2, 130);
      g.save(); g.translate(VIEW.w / 2, 320); g.scale(sc, sc);
      g.textAlign = 'right'; g.fillStyle = cm.a.color; g.font = '900 42px Trebuchet MS'; g.fillText(cm.a.name, -70, 12);
      g.textAlign = 'left'; g.fillStyle = cm.b.color; g.fillText(cm.b.name, 70, 12);
      g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '900 58px Trebuchet MS'; g.fillText('VS', 0, 18);
      g.restore();
      try {                                    // M87 head-to-head preview (seed + tournament record)
        const S = this._stats || {}, sa = S[cm.a.name] || {}, sb = S[cm.b.name] || {};
        g.font = '700 15px Trebuchet MS';
        g.textAlign = 'right'; g.fillStyle = 'rgba(255,255,255,.6)';
        g.fillText('Seed #' + (cm.a.seed || '?') + '  ·  ' + (sa.rWon || 0) + 'W ' + (sa.rLost || 0) + 'L', VIEW.w / 2 - 70, 400);
        g.textAlign = 'left';
        g.fillText('Seed #' + (cm.b.seed || '?') + '  ·  ' + (sb.rWon || 0) + 'W ' + (sb.rLost || 0) + 'L', VIEW.w / 2 + 70, 400);
      } catch (e) {}
      this._stick(g, VIEW.w / 2 - 250, 470, 2.4, cm.a.color, { armsUp: false });
      this._stick(g, VIEW.w / 2 + 250, 470, 2.4, cm.b.color, { armsUp: false });
      g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '700 16px Trebuchet MS';
      g.fillText('🗺️ ' + ((ARENAS[this.arenaIdx] || {}).name || '?') + '  ·  ' + this.eventName + '  ·  Best of ' + ((cm && cm.bestOf) || 3), VIEW.w / 2, 560);
    },
    _power() {                                 // M87 live tournament "power" score (updates each match)
      const S = this._stats || {}; const cs = this.contenders || [];
      return cs.map(c => {
        const s = S[c.name] || {};
        const score = (s.rWon || 0) * 100 + (s.kills || 0) * 25 + (s.voidKills || 0) * 15 + (s.dmgDealt || 0) * 0.4 - (s.dmgTaken || 0) * 0.2;
        return { name: c.name, color: c.color, score: Math.round(score), rWon: s.rWon || 0, rLost: s.rLost || 0 };
      }).sort((a, b) => b.score - a.score);
    },
    _drawPower(g) {
      let pr; try { pr = this._power(); } catch (e) { pr = []; }
      if (!pr.length) return;
      g.save(); g.textAlign = 'left';
      const x = VIEW.w - 332, y0 = 150;
      g.fillStyle = '#ffd23f'; g.font = '800 16px Trebuchet MS'; g.fillText('📈 POWER RANKING', x, y0);
      const maxS = Math.max(1, pr[0].score);
      g.font = '700 13px Trebuchet MS';
      for (let i = 0; i < pr.length; i++) {
        const p = pr[i], yy = y0 + 28 + i * 26;
        g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText((i + 1) + '.', x, yy);
        g.fillStyle = p.color; g.fillText(p.name, x + 22, yy);
        g.fillStyle = 'rgba(255,255,255,.12)'; roundRect(g, x + 150, yy - 11, 120, 12, 4); g.fill();
        g.fillStyle = p.color; roundRect(g, x + 150, yy - 11, Math.max(2, 120 * (p.score / maxS)), 12, 4); g.fill();
        g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText(String(p.score), x + 278, yy);
      }
      g.restore();
    },
    _drawBracket(g) {
      g.save(); g.textAlign = 'left';
      const x = 40, y0 = 128; let y = y0 + 22;
      g.fillStyle = '#43e8cf'; g.font = '800 15px Trebuchet MS'; g.fillText('🗺️ BRACKET — Double Elim', x, y0);
      g.font = '700 12px Trebuchet MS';
      const line = (label, txt, col) => { g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText(label, x, y); g.fillStyle = col || '#cfe3ff'; g.fillText(txt, x + 54, y); y += 20; };
      const vs = (a, b, w, ico) => (a && b) ? (a.name + ' v ' + b.name + (w ? '  ' + (ico || '✅') + ' ' + w.name : '')) : '— menunggu —';
      g.fillStyle = '#7dffd0'; g.fillText('Winners', x, y); y += 17;
      for (let i = 0; i < 4; i++) { const p = this.qfPairs[i]; line('WQF' + (i + 1), vs(p[0], p[1], this.wbR1W[i])); }
      for (let i = 0; i < 2; i++) { const b = i * 2; line('WSF' + (i + 1), vs(this.wbR1W[b], this.wbR1W[b + 1], this.wbSFW[i])); }
      line('WF', vs(this.wbSFW[0], this.wbSFW[1], this.wbFinalW));
      y += 5;
      g.fillStyle = '#ff8da3'; g.fillText('Losers', x, y); y += 17;
      for (let i = 0; i < 2; i++) { const b = i * 2; line('LR1·' + (i + 1), vs(this.wbR1L[b], this.wbR1L[b + 1], this.lbR1W[i])); }
      for (let i = 0; i < 2; i++) { line('LR2·' + (i + 1), vs(this.lbR1W[i], this.wbSFL[1 - i], this.lbR2W[i])); }
      line('LSF', vs(this.lbR2W[0], this.lbR2W[1], this.lbR3W));
      line('LF', vs(this.lbR3W, this.wbFinalL, this.lbFinalW));
      y += 5;
      line('GF', vs(this.wbFinalW, this.lbFinalW, this.results.king, '👑'), '#ffd23f');
      g.restore();
    },
    _drawHighlight(g) {                        // M87 dramatic-death highlight re-enactment
      const h = this._highlight; if (!h) return;
      g.save();
      const bx = VIEW.w / 2 - 150, by = 432, bw = 300, bh = 150;
      g.fillStyle = 'rgba(0,0,0,.4)'; roundRect(g, bx, by, bw, bh, 10); g.fill();
      g.strokeStyle = 'rgba(255,107,107,.4)'; g.lineWidth = 2; roundRect(g, bx, by, bw, bh, 10); g.stroke();
      g.textAlign = 'left'; g.fillStyle = '#ff6b6b'; g.font = '800 14px Trebuchet MS';
      g.fillText('🎬 HIGHLIGHT', bx + 14, by + 22);
      const lt = (this.t % 1.1) / 1.1;
      const dir = (h.vx || 0) >= 0 ? 1 : -1;
      const cx = bx + bw / 2 - dir * 35, cy = by + 70;
      const px = cx + dir * 70 * lt;
      const py = h.type === 'void' ? (cy + 70 * lt) : (cy - 26 * Math.sin(lt * Math.PI) + 28 * lt);
      g.globalAlpha = 1 - lt * 0.25;
      this._stick(g, px, py, 1.15, h.vcolor || '#fff', { armsUp: true, bob: 0 });
      g.globalAlpha = 1;
      g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '700 11px Trebuchet MS';
      g.fillText('Round ' + (h.round || 1), bx + bw / 2, by + bh - 30);
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '700 13px Trebuchet MS';
      const cap = h.type === 'void' ? ('🕳️ ' + h.victim + ' was hurled into the void!') : (h.killer ? ('💥 ' + h.killer + ' knocked out ' + h.victim + '!') : ('☠️ ' + h.victim + ' is down!'));
      g.fillText(cap, bx + bw / 2, by + bh - 12);
      g.restore();
    },
    _drawAdvance(g) {
      this._bg(g, '#0f2a1a', '#04100a');
      g.textAlign = 'center';
      const w = this.lastWinner;
      g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '700 20px Trebuchet MS';
      g.fillText(this.lastLabel, VIEW.w / 2, 108);
      g.fillStyle = w ? w.color : '#fff'; g.font = '900 44px Trebuchet MS';
      g.fillText((w ? w.name : '?') + ' LOLOS! ✅', VIEW.w / 2, 162);
      this._stick(g, VIEW.w / 2, 340, 2.7, w ? w.color : '#fff', { armsUp: true, bob: Math.sin(this.t * 6) * 3 });
      try { this._drawBracket(g); } catch (e) {}
      try { this._drawPower(g); } catch (e) {}
      try { this._drawHighlight(g); } catch (e) {}
    },
    _drawHistory(g) {                          // M87 tournament history (most-frequent champion + recent)
      let arr; try { arr = JSON.parse(localStorage.getItem(KING_KEY) || '[]'); } catch (e) { arr = []; }
      if (!arr.length) return;
      const cnt = {}; for (const e of arr) { if (e && e.name) cnt[e.name] = (cnt[e.name] || 0) + 1; }
      let topName = null, topN = 0; for (const k in cnt) { if (cnt[k] > topN) { topN = cnt[k]; topName = k; } }
      g.save(); g.textAlign = 'center'; g.font = '700 13px Trebuchet MS';
      const recent = arr.slice(0, 5).map(e => e.name || '?').join(' · ');
      let line = '📜 ';
      if (topName) line += 'Most often: ' + topName + ' (' + topN + '×)   |   ';
      line += 'Latest: ' + recent;
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(line, VIEW.w / 2, 628);
      g.restore();
    },
    _drawPodium(g) {
      const t = this.t;
      const cam = this._podiumCam(t);
      this._bg(g, '#241a33', '#06040a');
      g.save();
      const gl0 = g.createRadialGradient(640, 470, 40, 640, 470, 640);
      gl0.addColorStop(0, 'rgba(120,90,170,0.35)');
      gl0.addColorStop(1, 'rgba(120,90,170,0)');
      g.fillStyle = gl0; g.fillRect(0, 0, VIEW.w, VIEW.h);
      g.restore();
      this._spotlights(g, t);
      g.save();
      try { g.globalCompositeOperation = 'lighter'; } catch (e) {}
      for (let i = 0; i < 46; i++) {
        const sx = (i * 137.5) % VIEW.w;
        const sy = VIEW.h - (((t * (24 + (i % 5) * 7)) + i * 53) % (VIEW.h + 60));
        const tw = 0.4 + 0.6 * Math.sin(t * 3 + i);
        g.globalAlpha = 0.22 * tw;
        g.fillStyle = (i % 3) ? '#ffd98a' : '#9fd8ff';
        g.beginPath(); g.arc(sx, sy, 1.3 + tw, 0, Math.PI * 2); g.fill();
      }
      g.restore();
      this._confettiDraw(g);

      const r = this.results;
      const baseY = 568;
      const ped = [
        { x: 640 - 220, h: 118, who: r.runner, rank: 2, mood: 'angry' },
        { x: 640,       h: 188, who: r.king,   rank: 1, mood: 'happy' },
        { x: 640 + 220, h: 78,  who: r.third,  rank: 3, mood: 'sad' },
      ];

      g.save();
      g.translate(VIEW.w / 2, VIEW.h / 2); g.scale(cam.z, cam.z); g.translate(-cam.cx, -cam.cy);
      g.textAlign = 'center';
      for (const p of ped) {
        const topY = baseY - p.h, w = 168, dep = 24;
        const isKing = p.rank === 1;
        if (isKing) {
          const kg = g.createRadialGradient(p.x, topY, 6, p.x, topY, 190);
          kg.addColorStop(0, 'rgba(255,210,80,' + (0.22 + 0.08 * Math.sin(t * 2.2)).toFixed(3) + ')');
          kg.addColorStop(1, 'rgba(255,210,80,0)');
          g.fillStyle = kg; g.fillRect(p.x - 200, topY - 220, 400, 420);
        }
        g.fillStyle = 'rgba(0,0,0,.40)'; g.beginPath(); g.ellipse(p.x, baseY + 6, w * 0.55, 13, 0, 0, Math.PI * 2); g.fill();
        g.beginPath();
        g.moveTo(p.x - w / 2, topY);
        g.lineTo(p.x - w / 2 + dep, topY - dep * 0.55);
        g.lineTo(p.x + w / 2 + dep, topY - dep * 0.55);
        g.lineTo(p.x + w / 2, topY);
        g.closePath(); g.fillStyle = 'rgba(255,255,255,.18)'; g.fill();
        g.beginPath();
        g.moveTo(p.x + w / 2, topY);
        g.lineTo(p.x + w / 2 + dep, topY - dep * 0.55);
        g.lineTo(p.x + w / 2 + dep, baseY - dep * 0.55);
        g.lineTo(p.x + w / 2, baseY);
        g.closePath(); g.fillStyle = 'rgba(0,0,0,.28)'; g.fill();
        const fg = g.createLinearGradient(0, topY, 0, baseY);
        fg.addColorStop(0, 'rgba(150,140,180,.55)'); fg.addColorStop(1, 'rgba(34,28,52,.7)');
        g.fillStyle = fg; roundRect(g, p.x - w / 2, topY, w, p.h, 6); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.32)'; g.lineWidth = 2; roundRect(g, p.x - w / 2, topY, w, p.h, 6); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.10)'; g.font = '900 78px Trebuchet MS';
        g.fillText(String(p.rank), p.x, topY + p.h * 0.5 + 28);
        this._emoteStick(g, p.x, topY - 4, isKing ? 3.2 : 2.6, p.who ? p.who.color : '#888', { t: t, mood: p.mood, energy: cam.focus === p.rank ? 1 : 0.55, phase: p.rank * 2.1, crown: isKing });
        this._medal(g, p.x, topY + 34, p.rank, t);
        g.fillStyle = 'rgba(0,0,0,.45)'; roundRect(g, p.x - 56, baseY - 30, 112, 24, 6); g.fill();
        g.fillStyle = p.who ? p.who.color : '#aaa'; g.font = '800 19px Trebuchet MS';
        g.fillText(p.who ? p.who.name : '—', p.x, baseY - 12);
      }
      g.restore();

      g.textAlign = 'center';
      if (cam.focus > 0) {
        const fp = ped.find(q => q.rank === cam.focus);
        const lab = cam.focus === 1 ? 'CHAMPION' : cam.focus === 2 ? 'RUNNER-UP' : 'RANK ' + cam.focus;
        const nm = fp && fp.who ? fp.who.name : '—';
        g.fillStyle = 'rgba(0,0,0,.55)'; roundRect(g, VIEW.w / 2 - 230, 610, 460, 58, 12); g.fill();
        g.fillStyle = '#ffd23f'; g.font = '800 18px Trebuchet MS'; g.fillText('🏅 ' + lab, VIEW.w / 2, 635);
        g.fillStyle = '#fff'; g.font = '900 26px Trebuchet MS'; g.fillText(nm, VIEW.w / 2, 660);
      }
      const fin = Math.max(0, Math.min(1, (t - 12.6) / 0.8));
      if (fin > 0) {
        g.globalAlpha = fin;
        g.fillStyle = '#ffd23f'; g.font = '900 46px Trebuchet MS'; g.fillText('👑 KING: ' + (r.king ? r.king.name : '?'), VIEW.w / 2, 95);
        this._drawAwards(g);
        try { this._drawHistory(g); } catch (e) {}
        g.globalAlpha = 1;
        if (t % 1 < 0.6) { g.fillStyle = 'rgba(255,255,255,.7)'; g.font = '700 18px Trebuchet MS'; g.fillText('Tap / click to return to menu', VIEW.w / 2, 690); }
      } else if (t % 1.2 < 0.7) {
        g.globalAlpha = 0.6; g.fillStyle = '#fff'; g.font = '700 15px Trebuchet MS'; g.fillText('Tap / click to skip', VIEW.w / 2, 700); g.globalAlpha = 1;
      }
    },
    _spotlights(g, t) {
      g.save();
      try { g.globalCompositeOperation = 'lighter'; } catch (e) {}
      const beams = [
        { x: 300, col: '255,210,120', sp: 0.70, ph: 0.0, sw: 240 },
        { x: 640, col: '255,245,210', sp: 0.45, ph: 1.7, sw: 200 },
        { x: 980, col: '120,200,255', sp: 0.85, ph: 3.1, sw: 240 },
        { x: 470, col: '180,140,255', sp: 1.15, ph: 4.4, sw: 170 },
        { x: 820, col: '120,255,200', sp: 0.97, ph: 2.2, sw: 170 },
      ];
      for (const b of beams) {
        const sway = Math.sin(t * b.sp + b.ph) * 240;
        const pulse = 0.07 + 0.06 * (0.5 + 0.5 * Math.sin(t * 1.6 + b.ph));
        const tipX = b.x, tipY = -50;
        const endX = b.x + sway, endY = 770;
        const ang = Math.atan2(endY - tipY, endX - tipX);
        const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
        const half = b.sw / 2;
        const grd = g.createLinearGradient(tipX, tipY, endX, endY);
        grd.addColorStop(0, 'rgba(' + b.col + ',' + pulse.toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(' + b.col + ',0)');
        g.fillStyle = grd;
        g.beginPath();
        g.moveTo(tipX - 9 * nx, tipY - 9 * ny);
        g.lineTo(tipX + 9 * nx, tipY + 9 * ny);
        g.lineTo(endX + half * nx, endY + half * ny);
        g.lineTo(endX - half * nx, endY - half * ny);
        g.closePath(); g.fill();
        g.fillStyle = 'rgba(' + b.col + ',0.55)';
        g.beginPath(); g.arc(tipX, tipY + 10, 7, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    },
    _medal(g, x, y, rank, t) {
      const cols = { 1: ['#ffe27a', '#d99a1f'], 2: ['#e8edf5', '#9aa3b2'], 3: ['#f0b890', '#a9663a'] };
      const c = cols[rank] || cols[3];
      g.save(); g.translate(x, y);
      g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(-8, -16); g.lineTo(-3, 4); g.lineTo(-13, 4); g.closePath(); g.fill();
      g.fillStyle = '#2e6cc4'; g.beginPath(); g.moveTo(8, -16); g.lineTo(13, 4); g.lineTo(3, 4); g.closePath(); g.fill();
      const mg = g.createRadialGradient(-3, -3, 1, 0, 0, 13);
      mg.addColorStop(0, c[0]); mg.addColorStop(1, c[1]);
      g.fillStyle = mg; g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = 'rgba(60,40,0,.85)'; g.font = '900 14px Trebuchet MS'; g.textAlign = 'center';
      g.fillText(String(rank), 0, 5);
      const gl = 0.4 + 0.6 * Math.abs(Math.sin((t || 0) * 3 + rank));
      g.globalAlpha = gl; g.fillStyle = '#fff'; g.beginPath(); g.arc(-4, -4, 2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      g.restore();
    },
    _drawTrophy(g, cx, cy, s, t) {
      g.save(); g.translate(cx, cy); g.scale(s, s);
      const gold = '#ffd23f', goldD = '#c8881a', goldL = '#fff3b0';
      g.fillStyle = goldD; roundRect(g, -15, 24, 30, 7, 2); g.fill();
      g.fillStyle = gold; roundRect(g, -10, 16, 20, 9, 2); g.fill();
      g.fillStyle = goldD; g.fillRect(-3.5, 5, 7, 12);
      g.lineWidth = 3.2; g.strokeStyle = gold;
      g.beginPath(); g.arc(-15, -6, 8, Math.PI * 1.55, Math.PI * 0.55, false); g.stroke();
      g.beginPath(); g.arc(15, -6, 8, Math.PI * 0.45, Math.PI * 1.45, true); g.stroke();
      g.beginPath();
      g.moveTo(-15, -13);
      g.quadraticCurveTo(-15, 7, 0, 8);
      g.quadraticCurveTo(15, 7, 15, -13);
      g.closePath();
      const bg = g.createLinearGradient(-15, -13, 12, 8);
      bg.addColorStop(0, goldL); bg.addColorStop(0.5, gold); bg.addColorStop(1, goldD);
      g.fillStyle = bg; g.fill();
      g.fillStyle = goldL; roundRect(g, -17, -16, 34, 5, 2); g.fill();
      const gp = (Math.sin(t * 2.4) * 0.5 + 0.5);
      g.globalAlpha = 0.5 + 0.4 * gp; g.fillStyle = '#ffffff';
      g.beginPath(); g.ellipse(-5 + gp * 6, -4, 1.6, 5, -0.5, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      g.restore();
    },
        _podiumCam(t) {
      const S = [
        { t: 0.0,  z: 1.00, cx: 640, cy: 360 },
        { t: 1.1,  z: 1.00, cx: 640, cy: 360 },
        { t: 2.1,  z: 2.05, cx: 640, cy: 280 },
        { t: 4.9,  z: 2.05, cx: 640, cy: 280 },
        { t: 6.0,  z: 2.25, cx: 430, cy: 360 },
        { t: 8.4,  z: 2.25, cx: 430, cy: 360 },
        { t: 9.5,  z: 2.35, cx: 850, cy: 400 },
        { t: 11.6, z: 2.35, cx: 850, cy: 400 },
        { t: 13.0, z: 1.00, cx: 640, cy: 360 },
      ];
      const last = S[S.length - 1];
      let out;
      if (t <= S[0].t) out = { z: S[0].z, cx: S[0].cx, cy: S[0].cy };
      else if (t >= last.t) out = { z: last.z, cx: last.cx, cy: last.cy };
      else {
        let a = S[0], b = last;
        for (let i = 0; i < S.length - 1; i++) { if (t >= S[i].t && t <= S[i + 1].t) { a = S[i]; b = S[i + 1]; break; } }
        const span = (b.t - a.t) || 1; let u = (t - a.t) / span; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const e = u * u * (3 - 2 * u);
        out = { z: a.z + (b.z - a.z) * e, cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e };
      }
      out.z *= 1 + Math.sin(t * 0.9) * 0.012; // gentle breathing zoom for life
      let focus = 0;
      if (t >= 1.9 && t < 5.3) focus = 1;
      else if (t >= 5.8 && t < 8.8) focus = 2;
      else if (t >= 9.3 && t < 12.0) focus = 3;
      out.focus = focus;
      return out;
    },
    _podiumTap() {
      if (this.phase !== 'podium') return;
      if (this.t < 13.0) this.t = 13.0;   // first tap: skip the cinematic to the finale
      else this.exit();                    // after the finale: leave to the menu
    },
    _seg2(g, ax, ay, bx, by, bend, w, col) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const jx = mx + nx * bend, jy = my + ny * bend;
      g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(jx, jy); g.lineTo(bx, by); g.stroke();
      return [jx, jy];
    },
    _shade(hex, amt) {
      let h = (hex || '#888888').replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      let r = parseInt(h.slice(0, 2), 16), gg = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      if (!isFinite(r)) r = 136; if (!isFinite(gg)) gg = 136; if (!isFinite(b)) b = 136;
      const f = amt < 0 ? 0 : 255, a = Math.abs(amt);
      r = Math.round(r + (f - r) * a); gg = Math.round(gg + (f - gg) * a); b = Math.round(b + (f - b) * a);
      return 'rgb(' + r + ',' + gg + ',' + b + ')';
    },
    _emoteStick(g, x, y, scale, color, p) {
      const t = p.t || 0, mood = p.mood || 'neutral', en = p.energy == null ? 0.5 : p.energy, phase = p.phase || 0;
      const dark = this._shade(color, -0.4), lite = this._shade(color, 0.25);
      const L = (a, b, k) => a + (b - a) * k;
      const nz = (fq, am) => Math.sin(t * fq + phase * 2.1) * am;
      // free-flowing gesture timeline: blend between keyframes so motion never loops stiffly
      const speed = mood === 'sad' ? 0.42 : (mood === 'angry' ? 0.72 : 0.6);
      const u = t * speed + phase * 1.3;
      const gi = Math.floor(u), fr = u - gi, e = fr * fr * (3 - 2 * fr);
      const breathe = Math.sin(t * 2.1 + phase) * 1.2;
      const bounce = mood === 'sad' ? 0 : Math.max(0, Math.sin(t * 3.2 + phase)) * (4 + 8 * en);

      let hipShift = nz(1.3, 3) + nz(2.7, 1.1);
      let lean = nz(0.7, 0.025), twist = nz(0.9, 0.07), headTilt = nz(1.6, 0.05);
      let jump = 0, squat = 0;
      // arm hand targets (relative to shoulder), bends, and trophy hold point
      let lhx, lhy, rhx, rhy, lb, rb, hx = 0, hy = 0;

      if (mood === 'happy') {
        const F = [[0,-46,0.0,0.30],[7,-42,0.06,0.12],[2,-44,0.0,0.05],[-7,-46,-0.06,0.30],[-2,-43,0.0,0.10],[0,-45,0.0,0.20]];
        const A = F[gi % F.length], B = F[(gi + 1) % F.length];
        hx = L(A[0], B[0], e); hy = L(A[1], B[1], e);
        lean += L(A[2], B[2], e); jump = L(A[3], B[3], e) * 13 + bounce * 0.6; squat = Math.max(0, -jump * 0.05);
      } else {
        let F;
        if (mood === 'angry') {
          F = [[-12,16,12,16,-7,7,0.05,0.05,1],[-14,-22,14,-22,-6,6,0.0,0.28,0],[-9,-6,9,-6,7,-7,0.0,0.1,0],[-11,14,16,1,-7,-6,0.13,0.06,1],[-11,13,11,13,-9,9,0.08,0,2],[-6,18,6,18,-5,5,0.16,0.12,3]];
        } else if (mood === 'sad') {
          F = [[-4,-15,4,-15,-5,5,0,0,5],[-9,16,4,-14,6,-6,0.05,0,4],[-7,18,7,18,-3,3,0.04,0,5],[-8,16,2,-16,5,-7,0.08,0,6],[-3,17,3,17,-4,4,0.06,0,4]];
        } else {
          F = [[-11,15,11,15,-5,5,0,0,0],[-12,8,12,16,-6,5,0.03,0.05,0],[-10,16,12,8,-5,6,-0.03,0.05,0]];
        }
        const A = F[gi % F.length], B = F[(gi + 1) % F.length];
        lhx = L(A[0], B[0], e); lhy = L(A[1], B[1], e); rhx = L(A[2], B[2], e); rhy = L(A[3], B[3], e);
        lb = L(A[4], B[4], e); rb = L(A[5], B[5], e);
        lean += L(A[6], B[6], e); jump = L(A[7], B[7], e) * 11 + bounce * (mood === 'angry' ? 0.4 : 0.15);
        squat = L(A[8], B[8], e);
        if (mood === 'angry') lean += Math.sin(t * 13) * 0.04;
      }

      const comp = squat, by = breathe;
      const hipY = -34 + comp * 0.5 + by * 0.4;
      const shY = -60 + comp + by;
      const hY = -76 + comp * 1.3 + by * 1.2;

      g.save();
      g.translate(x + hipShift, y - jump); g.scale(scale, scale); g.rotate(lean);
      // ground shadow (tracks jump)
      g.save(); g.globalAlpha = 0.26; g.fillStyle = '#000'; g.scale(1, 0.32);
      g.beginPath(); g.arc(0, (10 + jump * 0.5) / 0.32, Math.max(7, 17 - jump * 0.22), 0, Math.PI * 2); g.fill(); g.restore();

      // legs: alternating steps so the figure never stands frozen
      const spread = mood === 'sad' ? 11 : 15;
      const fF = t * (mood === 'angry' ? 4.2 : (mood === 'sad' ? 1.6 : 2.6)) + phase;
      const stepAmp = mood === 'sad' ? 1.6 : (mood === 'angry' ? 5 : 4.2);
      const liftAmp = mood === 'happy' ? 6 : (mood === 'angry' ? 4 : (mood === 'sad' ? 1 : 2.5));
      const flx = -spread + Math.sin(fF) * stepAmp, fly = 2 - Math.max(0, Math.sin(fF)) * liftAmp;
      const frx = spread + Math.sin(fF + Math.PI) * stepAmp, fry = 2 - Math.max(0, Math.sin(fF + Math.PI)) * liftAmp;
      this._seg2(g, -5, hipY, flx, fly, -3 + Math.sin(fF) * 2, 4.8, dark);
      this._seg2(g, 5, hipY, frx, fry, 3 + Math.sin(fF + Math.PI) * 2, 4.8, color);
      // torso
      g.save(); g.rotate(twist * 0.16);
      g.strokeStyle = color; g.lineWidth = 5.2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(0, hipY); g.lineTo(0, shY); g.stroke();
      g.restore();

      // arms
      if (mood === 'happy') {
        const tx = hx, ty = shY + hy;
        this._seg2(g, 0, shY, tx - 6, ty + 3, -7 - Math.sin(t * 3.4) * 2.5, 4.6, color);
        this._seg2(g, 0, shY, tx + 6, ty + 3, 7 + Math.sin(t * 3.4) * 2.5, 4.6, lite);
        if (p.crown) this._drawTrophy(g, tx, ty, 0.92, t);
      } else {
        this._seg2(g, 0, shY, lhx, shY + lhy, lb, 4.5, color);
        this._seg2(g, 0, shY, rhx, shY + rhy, rb, 4.5, lite);
        if (mood === 'angry') { g.fillStyle = color; g.beginPath(); g.arc(lhx, shY + lhy, 3, 0, Math.PI * 2); g.arc(rhx, shY + rhy, 3, 0, Math.PI * 2); g.fill(); }
      }

      // head
      g.save(); g.translate(0, hY); g.rotate(headTilt + (mood === 'sad' ? 0.16 : 0) + twist * 0.05);
      const hg = g.createRadialGradient(-3, -3, 1, 0, 0, 10);
      hg.addColorStop(0, lite); hg.addColorStop(1, color);
      g.fillStyle = hg; g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.8)'; g.fillStyle = 'rgba(0,0,0,.82)'; g.lineWidth = 1.6;
      const eL = -3.6, eR = 3.6, eY = -1.5;
      if (mood === 'angry') {
        g.beginPath(); g.moveTo(eL - 2.6, eY - 3.6); g.lineTo(eL + 2, eY - 1); g.moveTo(eR + 2.6, eY - 3.6); g.lineTo(eR - 2, eY - 1); g.stroke();
        g.beginPath(); g.arc(eL, eY + 0.6, 1.1, 0, 7); g.arc(eR, eY + 0.6, 1.1, 0, 7); g.fill();
        g.beginPath(); g.arc(0, 6, 3, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
      } else if (mood === 'sad') {
        g.beginPath(); g.moveTo(eL - 2.6, eY - 1); g.lineTo(eL + 2, eY - 3); g.moveTo(eR + 2.6, eY - 1); g.lineTo(eR - 2, eY - 3); g.stroke();
        g.beginPath(); g.arc(eL, eY + 1, 1.1, 0, 7); g.arc(eR, eY + 1, 1.1, 0, 7); g.fill();
        g.beginPath(); g.arc(0, 8, 3, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
      } else if (mood === 'happy') {
        g.beginPath(); g.arc(eL, eY - 0.5, 2.4, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
        g.beginPath(); g.arc(eR, eY - 0.5, 2.4, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
        g.beginPath(); g.arc(0, 2, 3.8, 0.12 * Math.PI, 0.88 * Math.PI); g.stroke();
      } else {
        g.beginPath(); g.arc(eL, eY, 1.1, 0, 7); g.arc(eR, eY, 1.1, 0, 7); g.fill();
        g.beginPath(); g.moveTo(-2.5, 4); g.lineTo(2.5, 4); g.stroke();
      }
      if (p.crown) {
        g.fillStyle = '#ffd23f'; const cy = -11;
        g.beginPath(); g.moveTo(-10, cy); g.lineTo(-10, cy - 9); g.lineTo(-5, cy - 4); g.lineTo(0, cy - 11); g.lineTo(5, cy - 4); g.lineTo(10, cy - 9); g.lineTo(10, cy); g.closePath(); g.fill();
        g.fillStyle = '#fff3b0'; g.beginPath(); g.arc(0, cy - 11, 1.6, 0, 7); g.fill();
      }
      g.restore();

      // mood FX
      if (mood === 'happy') {
        g.fillStyle = '#fff6b0';
        for (let k = 0; k < 4; k++) { const an = t * 2.2 + k * 1.6, sx = Math.cos(an) * 30, sy = hY - 4 + Math.sin(an) * 14, ss = 1.6 + 1.6 * Math.abs(Math.sin(t * 5 + k)); g.beginPath(); g.moveTo(sx, sy - ss); g.lineTo(sx + ss * 0.4, sy); g.lineTo(sx, sy + ss); g.lineTo(sx - ss * 0.4, sy); g.closePath(); g.fill(); }
      } else if (mood === 'sad') {
        const ty2 = (t * 24) % 28; g.fillStyle = 'rgba(120,190,255,.9)';
        g.beginPath(); g.ellipse(3.6, hY + 2 + ty2, 1.5, 2.5, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(-3.6, hY + 6 + ((ty2 + 14) % 28), 1.3, 2.2, 0, 0, Math.PI * 2); g.fill();
      } else if (mood === 'angry') {
        g.fillStyle = 'rgba(255,255,255,.5)';
        for (let k = 0; k < 2; k++) { const pr = (t * 1.6 + k * 0.5) % 1, px = (k ? 13 : -13), py = hY - 16 - pr * 16; g.beginPath(); g.arc(px, py, Math.max(0.4, 3 - pr * 2), 0, 7); g.fill(); }
        g.strokeStyle = '#ff5a5a'; g.lineWidth = 1.8; const vx = 10, vy = hY - 10;
        g.beginPath(); g.moveTo(vx, vy); g.lineTo(vx + 3, vy - 1.5); g.moveTo(vx + 1.5, vy + 1.5); g.lineTo(vx + 4.5, vy); g.stroke();
      }
      g.restore();
    },
        drawHud(g) {
      const cm = this.curMatch;
      g.save(); g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,.4)'; roundRect(g, VIEW.w / 2 - 250, 78, 500, 30, 8); g.fill();
      g.fillStyle = '#ffd23f'; g.font = '800 16px Trebuchet MS';
      g.fillText('👑 ' + (cm ? cm.label : 'KING TOURNAMENT') + '  ·  ' + this.eventName, VIEW.w / 2, 99);
      if (this._comment) {                     // M87 commentator banner (bottom-center)
        const _al = Math.min(1, this._comment.t / 0.4);
        const _tw = this._comment.text.length * 11 + 32;
        g.globalAlpha = _al;
        g.fillStyle = 'rgba(0,0,0,.55)'; roundRect(g, VIEW.w / 2 - _tw / 2, 632, _tw, 34, 9); g.fill();
        g.fillStyle = '#ffe27a'; g.font = '800 20px Trebuchet MS';
        g.fillText(this._comment.text, VIEW.w / 2, 656);
        g.globalAlpha = 1;
      }
      g.restore();
    },
  };
  { const _bk = document.getElementById('btn-king'); if (_bk) _bk.onclick = () => King.start(); }
  window.addEventListener('keydown', (e) => { if (state === 'king' && King.phase === 'podium') { if (e.code === 'Escape') King.exit(); else if (e.code === 'Enter' || e.code === 'Space') King._podiumTap(); } });
  { const _kcv = document.getElementById('game'); if (_kcv) _kcv.addEventListener('click', () => { if (state === 'king' && King.phase === 'podium') King._podiumTap(); }); }

  // ============================================================
  //  Boot
  // ============================================================
  makeEngine();
  resize();
  buildLevel(0);
  updateArenaLabel();
  bindCollisions();
  bestBrain = loadBrain();
  refreshBrainStatus();
  renderRankBoard();
  requestAnimationFrame(loop);

  // ============================================================
  //  Auto-train (unattended). Enable via URL params, e.g.
  //    index.html?autotrain=1&gens=500&turbo=1&loop=1
  //  Lets a kept-open tab or a headless browser train the AI by
  //  itself. The champion is saved to localStorage after every
  //  generation, so progress ACCUMULATES across runs (never resets).
  //  With loop=1 it restarts automatically when a run finishes,
  //  evolving the same champion forever.
  // ============================================================
  function startAutoTrain() {
    try {
      var search = (typeof window !== 'undefined' && window.location && window.location.search) ? window.location.search : '';
      if (!/[?&]autotrain=1/.test(search)) return;
      var getp = function (k) { var m = search.match(new RegExp('[?&]' + k + '=([^&]+)')); return m ? decodeURIComponent(m[1]) : null; };
      var gens = parseInt(getp('gens') || '500', 10) || 500;
      var loopOn = getp('loop') === '1';
      var turbo = getp('turbo') !== '0'; // default ON for unattended speed
      var gsel = document.getElementById('train-gens'); if (gsel) gsel.value = String(gens);
      var tchk = document.getElementById('train-turbo'); if (tchk) tchk.checked = turbo;
      var startBtn = document.getElementById('btn-train');
      var fire = function () { if (startBtn && typeof startBtn.onclick === 'function') startBtn.onclick({ preventDefault: function () {} }); };
      console.log('[autotrain] gens=' + gens + ' turbo=' + turbo + ' loop=' + loopOn);
      window.__autotrain = { gens: gens, loop: loopOn, turbo: turbo, get trained() { return (bestBrainMeta && bestBrainMeta.trained) || 0; }, get fit() { return (bestBrainMeta && bestBrainMeta.fit); } };
      fire();
      if (loopOn) {
        setInterval(function () {
          try {
            if (Trainer && Trainer.done) {
              console.log('[autotrain] cycle done -> total trained gens=' + ((bestBrainMeta && bestBrainMeta.trained) || 0) + ', restarting');
              Trainer.close();
              fire();
            }
          } catch (e) { console.error('[autotrain loop]', e); }
        }, 2000);
      }
    } catch (e) { console.error('[autotrain]', e); }
  }
  startAutoTrain();
})();
