#!/usr/bin/env node
/*
 * auto-train.js — Headless automatic trainer for Stick Fight AI.
 *
 * WHY THIS EXISTS
 *   Real training needs the REAL Matter.js physics that only runs in a
 *   browser. A pure-Node fake-physics trainer would produce a brain that
 *   does NOT transfer to the real game. So this script drives a real
 *   (headless) Chromium browser running the actual game, lets it train
 *   itself, then exports the evolved champion brain to a JSON file you can
 *   import back into the game (Menu -> Import).
 *
 * REQUIREMENTS (run on YOUR machine / a server WITH internet)
 *   npm install puppeteer
 *
 * USAGE
 *   node auto-train.js --gens 500 --out brain.json
 *   node auto-train.js --url https://your-deploy.vercel.app --gens 1000
 *   node auto-train.js --seed brain.json --gens 300          # continue a saved brain
 *   node auto-train.js --gens 200 --loop                     # train forever (Ctrl+C to stop)
 *
 * FLAGS
 *   --gens N     generations per cycle           (default 500)
 *   --url U      page to load (deployed URL)      (default: local index.html)
 *   --out F      where to write the brain JSON    (default brain.json)
 *   --seed F     import this brain before training (so it KEEPS its memory)
 *   --loop       keep training cycle after cycle, saving after each one
 *   --visible    show the browser window (debug)  (default headless)
 */
'use strict';
const fs = require('fs');
const path = require('path');
let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (e) { console.error('\nMissing dependency. Run:  npm install puppeteer\n'); process.exit(1); }

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const GENS = parseInt(arg('gens', '500'), 10) || 500;
const OUT = String(arg('out', 'brain.json'));
const SEED = arg('seed', null);
const LOOP = !!arg('loop', false);
const VISIBLE = !!arg('visible', false);
const URL_ARG = arg('url', null);
const pageUrl = URL_ARG
  ? String(URL_ARG)
  : 'file://' + path.resolve(__dirname, 'index.html');

const target = pageUrl + (pageUrl.includes('?') ? '&' : '?')
  + 'autotrain=1&gens=' + GENS + '&turbo=1' + (LOOP ? '&loop=1' : '');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('[auto-train] launching browser ->', target);
  const browser = await puppeteer.launch({
    headless: VISIBLE ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.includes('[autotrain]') || t.includes('Gen ')) console.log('  ' + t); });

  // If continuing from a saved brain, inject it into localStorage BEFORE load.
  if (SEED && fs.existsSync(SEED)) {
    const seedJson = fs.readFileSync(SEED, 'utf8');
    await page.evaluateOnNewDocument((j) => {
      try { localStorage.setItem('sf_brain_v1', j); } catch (e) {}
    }, seedJson);
    console.log('[auto-train] seeded from', SEED);
  }

  await page.goto(target, { waitUntil: 'domcontentloaded' });

  let lastTrained = -1;
  const saveBrain = async () => {
    const data = await page.evaluate(() => localStorage.getItem('sf_brain_v1'));
    if (data) { fs.writeFileSync(OUT, data); return JSON.parse(data).meta || {}; }
    return null;
  };

  // Poll until the target generation count is reached; keep saving snapshots.
  while (true) {
    await sleep(5000);
    const meta = await saveBrain();
    const trained = meta ? (meta.trained || 0) : 0;
    if (trained !== lastTrained) {
      console.log('[auto-train] trained gens=' + trained + ' fit=' + (meta ? meta.fit : '?') + ' -> saved ' + OUT);
      lastTrained = trained;
    }
    const done = await page.evaluate(() => { try { return !!(window.__trainerDone || (window.__autotrain && false)); } catch (e) { return false; } });
    // Stop condition: not looping AND we have reached >= GENS generations of NEW training this run.
    if (!LOOP && meta && trained >= GENS) {
      console.log('[auto-train] target reached (' + trained + ' gens). Final brain saved to ' + OUT);
      break;
    }
  }

  await browser.close();
  console.log('[auto-train] done. Import ' + OUT + ' in-game via Menu -> Import.');
})().catch((e) => { console.error(e); process.exit(1); });
