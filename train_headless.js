// train_headless.js
// Headless trainer untuk Stick Fight AI - dipanggil oleh train_agent.py
// Usage: node train_headless.js [--gens 60] [--output brain.json] [--input brain.json] [--pop 8] [--rounds 1]

'use strict';
const fs   = require('fs');
const path = require('path');
const args = process.argv.slice(2);

function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i+1] ? args[i+1] : def;
}

const GENS       = parseInt(getArg('--gens',   '60'),  10);
const OUT_FILE   = getArg('--output', 'brain_export.json');
const IN_FILE    = getArg('--input',  '');
const POP_SIZE   = parseInt(getArg('--pop',    '8'),   10);
const VERBOSE    = args.includes('--verbose');
const SAVE_DIR   = path.dirname(path.resolve(OUT_FILE));
const STATE_FILE = path.join(SAVE_DIR, '.sf_state.json');

// ─── file-based localStorage ───────────────────────────────────────────────
let _store = {};
try { _store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { _store = {}; }
const localStorage = {
  getItem:    (k)    => Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : null,
  setItem:    (k, v) => { _store[k] = v; try { fs.writeFileSync(STATE_FILE, JSON.stringify(_store)); } catch(e) {} },
  removeItem: (k)    => { delete _store[k]; try { fs.writeFileSync(STATE_FILE, JSON.stringify(_store)); } catch(e) {} },
  key:        (i)    => Object.keys(_store)[i] || null,
  get length()       { return Object.keys(_store).length; },
};

// ─── minimal stubs ──────────────────────────────────────────────────────────
const errors = [];
console.error = (...a) => errors.push(a.map(x => x && x.stack ? x.stack : String(x)).join(' '));
console.warn = () => {};
let _t = 0;
function absorber() {
  const fn = function(){ return proxy; };
  const proxy = new Proxy(fn, {
    get(_, p) {
      if (p === 'width')           return 10;
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'length')          return 0;
      if (p === 'value')           return '';
      if (p === 'currentTime')     return 0;
      if (p === 'destination')     return proxy;
      return proxy;
    },
    set()      { return true; },
    apply()    { return proxy; },
    construct(){ return proxy; },
  });
  return proxy;
}
const CTX = absorber();
const elements = {};
function makeEl(id) {
  const ls = {};
  const el = {
    id, onclick: null, onchange: null,
    textContent: '', innerHTML: '', value: id === 'train-gens' ? String(GENS) : '',
    checked: id === 'train-turbo',
    style: {}, files: [],
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    addEventListener(ev, cb){ (ls[ev] = ls[ev]||[]).push(cb); },
    removeEventListener(){},
    appendChild(){}, removeChild(){}, append(){}, prepend(){},
    querySelector(){ return makeEl('q'); },
    querySelectorAll(){ return []; },
    getContext(){ return CTX; },
    getBoundingClientRect(){ return { left:0, top:0, width:1280, height:720 }; },
    click(){ if (typeof this.onclick === 'function') this.onclick({ preventDefault(){} }); },
    setAttribute(){}, getAttribute(){ return null; }, remove(){},
    width: 1280, height: 720, _listeners: ls,
  };
  return el;
}
function getEl(id){ return (elements[id] = elements[id] || makeEl(id)); }
const winListeners = {};
let _raf = null;
global.window = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener(ev, cb){ (winListeners[ev] = winListeners[ev]||[]).push(cb); },
  removeEventListener(){},
  AudioContext: function(){ return absorber(); },
  webkitAudioContext: function(){ return absorber(); },
  MediaRecorder: Object.assign(function(){ return absorber(); }, { isTypeSupported: ()=>false }),
  requestAnimationFrame: (cb) => { _raf = cb; return 1; },
  cancelAnimationFrame: () => {},
  performance: { now: () => _t },
  localStorage,
};
global.document = {
  body: makeEl('body'),
  documentElement: makeEl('html'),
  head: makeEl('head'),
  getElementById: (id) => getEl(id),
  createElement: (tag) => makeEl(tag),
  querySelector: () => makeEl('q'),
  querySelectorAll: () => [],
  createDocumentFragment: () => makeEl('frag'),
  addEventListener(){}, removeEventListener(){},
  exitPointerLock(){},
};
try { Object.defineProperty(global, "navigator", { value: { userAgent: "node", getGamepads: ()=>[] }, configurable: true, writable: true }); } catch(e) {}
global.Image = function(){ return { onload: null, src: '' }; };
global.AudioContext = global.webkitAudioContext = function(){ return absorber(); };
global.requestAnimationFrame  = (cb) => { _raf = cb; return 1; };
global.cancelAnimationFrame   = () => {};
global.performance = { now: () => _t };
global.localStorage = localStorage;
global.devicePixelRatio = 1;
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
global.Blob = function(){ return {}; };
global.Image = function(){ return makeEl('img'); };
global.alert = () => {};
global.MediaRecorder = global.window.MediaRecorder;
global.AudioContext = global.window.AudioContext;
// canvas
global.HTMLCanvasElement = function(){};

// ─── minimal Matter.js ───────────────────────────────────────────────────────
let _gid = 1, _group = -1;
function mkBody(x, y, opts) {
  return Object.assign({
    id: _gid++, position: { x, y }, positionPrev: { x, y },
    velocity: { x:0, y:0 }, force: { x:0, y:0 },
    angle: 0, angularVelocity: 0, isStatic: false,
    collisionFilter: { group: 0, mask: 0xFFFFFFFF, category: 1 },
    frictionAir: 0.01, restitution: 0, label: '',
    bounds: { min: { x:0, y:0 }, max: { x:0, y:0 } },
    plugin: {}, parts: [], isSleeping: false, sleepThreshold: 60,
    vertices: [], axes: [], area: 0,
  }, opts || {});
}
global.Matter = {
  Engine:    { create: (o)=>({ gravity:{ x:0, y:1, scale:0.001 }, world:{ bodies:[], constraints:[] }, ...o }), run:()=>{}, clear:()=>{} },
  Runner:    { create:()=>({}), run:()=>{}, stop:()=>{} },
  Render:    { create:()=>({}), run:()=>{}, stop:()=>{}, lookAt:()=>{} },
  World:     { add:()=>{}, remove:()=>{}, clear:()=>{}, addBody:()=>{}, addConstraint:()=>{} },
  Bodies:    { rectangle:(x,y,w,h,o)=>mkBody(x,y,o), circle:(x,y,r,o)=>mkBody(x,y,o) },
  Body:      {
    setPosition:(b,p)=>{ b.position.x=p.x; b.position.y=p.y; },
    setVelocity:(b,v)=>{ b.velocity.x=v.x; b.velocity.y=v.y; },
    setAngle:(b,a)=>{ b.angle=a; }, setAngularVelocity:(b,v)=>{ b.angularVelocity=v; },
    setStatic:(b,s)=>{ b.isStatic=s; }, applyForce:()=>{}, nextGroup:()=>(--_group),
  },
  Composite: { allBodies:(w)=>w.bodies||[], add:()=>{}, remove:()=>{} },
  Constraint:{ create:(o)=>o||{} },
  Events:    { on:()=>{}, off:()=>{} },
  Vector:    { normalise:(v)=>{ const m=Math.hypot(v.x,v.y)||1; return {x:v.x/m,y:v.y/m}; }, magnitude:(v)=>Math.hypot(v.x,v.y) },
  Query:     { region:()=>[], point:()=>[], ray:()=>[] },
};

// ─── optional: load existing brain ─────────────────────────────────────────
if (IN_FILE) {
  try {
    const raw = fs.readFileSync(IN_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj.w) localStorage.setItem('sf_brain_v1', JSON.stringify({ w: obj.w, meta: obj.meta || {} }));
    if (obj.pop && obj.pop.length) localStorage.setItem('sf_pop_v1', JSON.stringify(obj.pop));
    if (obj.hof && obj.hof.length) localStorage.setItem('sf_hof_v1', JSON.stringify(obj.hof));
    process.stdout.write(JSON.stringify({ type:'info', msg: 'Brain loaded from ' + IN_FILE }) + '\n');
  } catch(e) {
    process.stdout.write(JSON.stringify({ type:'warn', msg: 'Could not load input: ' + e.message }) + '\n');
  }
}

// ─── override train-gens to our value ──────────────────────────────────────
getEl('train-gens').value = String(GENS);
getEl('train-turbo').checked = true;

// ─── load game ─────────────────────────────────────────────────────────────
const gameCode = fs.readFileSync(path.join(__dirname, 'js/game.js'), 'utf8');
try { (0, eval)(gameCode); }
catch(e) { process.stderr.write('BOOT ERROR: ' + (e && e.stack || e) + '\n'); process.exit(2); }

function frames(n) {
  for (let i = 0; i < n; i++) {
    _t += 16;
    if (typeof _raf === 'function') { const cb = _raf; _raf = null; try { cb(_t); } catch(e) { errors.push(String(e)); } }
  }
}

// ─── hook console.log to capture gen progress ────────────────────────────
const origLog = console.log.bind(console);
let lastGen = 0, lastFit = 0;
console.log = (msg, ...rest) => {
  if (typeof msg === 'string') {
    const mGen = msg.match(/[Gg]en(?:eration)?\s*[:#]?\s*(\d+)/);
    const mFit = msg.match(/[Ff]it(?:ness)?\s*[:#]?\s*([\d.]+)/);
    if (mGen) lastGen = parseInt(mGen[1], 10);
    if (mFit) lastFit = parseFloat(mFit[1]);
    if (VERBOSE) origLog(msg, ...rest);
  }
};

// ─── progress reporter ───────────────────────────────────────────────────
let _lastReportedGen = -1;
function maybeReport() {
  const lsKey = 'sf_brain_v1';
  const raw = localStorage.getItem(lsKey);
  let gen = lastGen, fit = lastFit;
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o.meta) {
        if (o.meta.gen > gen) gen = o.meta.gen;
        if (o.meta.fit > fit) fit = o.meta.fit;
      }
    } catch(e) {}
  }
  if (gen !== _lastReportedGen) {
    _lastReportedGen = gen;
    process.stdout.write(JSON.stringify({ type:'progress', gen, fit: Math.round(fit), total: GENS }) + '\n');
  }
}

// ─── boot + run ─────────────────────────────────────────────────────────
frames(5);
getEl('btn-train').onclick && getEl('btn-train').onclick({ preventDefault(){} });

const FRAMES_PER_GEN = 200;
const TOTAL_FRAMES   = GENS * FRAMES_PER_GEN + 500;
const REPORT_EVERY   = FRAMES_PER_GEN;

for (let f = 0; f < TOTAL_FRAMES; f++) {
  _t += 16;
  if (typeof _raf === 'function') { const cb = _raf; _raf = null; try { cb(_t); } catch(e) { errors.push(String(e)); } }
  if (f % REPORT_EVERY === 0) maybeReport();
}
maybeReport();

// ─── export final brain ─────────────────────────────────────────────────
const raw = localStorage.getItem('sf_brain_v1');
const rawPop = localStorage.getItem('sf_pop_v1');
const rawHof = localStorage.getItem('sf_hof_v1');

if (raw) {
  try {
    const brain = JSON.parse(raw);
    const pop   = rawPop ? JSON.parse(rawPop) : [];
    const hof   = rawHof ? JSON.parse(rawHof) : [];
    const out   = { w: brain.w, meta: brain.meta || {}, pop, hof, exported_at: new Date().toISOString() };
    fs.writeFileSync(OUT_FILE, JSON.stringify(out));
    process.stdout.write(JSON.stringify({
      type:    'done',
      output:  OUT_FILE,
      gen:     (brain.meta && brain.meta.gen)   || 0,
      trained: (brain.meta && brain.meta.trained) || 0,
      fit:     Math.round((brain.meta && brain.meta.fit) || 0),
      pop_size: pop.length,
      hof_size: hof.length,
    }) + '\n');
  } catch(e) {
    process.stdout.write(JSON.stringify({ type:'error', msg: 'Export failed: ' + e.message }) + '\n');
    process.exit(1);
  }
} else {
  process.stdout.write(JSON.stringify({ type:'error', msg: 'No brain in localStorage after training' }) + '\n');
  process.exit(1);
}

if (errors.length > 0 && VERBOSE) {
  const uniq = [...new Set(errors)];
  process.stderr.write('Runtime warnings: ' + uniq.slice(0, 5).join(' | ') + '\n');
}
