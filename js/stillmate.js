// Stillmate: a chess game your mind plays for you. See docs/STILLMATE - Design v1.md.
// Nobody moves a piece. Pressing your clock commits whatever move your measured depth earned.
// Solo: you against Stockfish. Two players: both at one table, each with a signal and a clock button.
import { Chess } from "../node_modules/chess.js/dist/esm/chess.js";
import { Chessboard, FEN, COLOR } from "../node_modules/cm-chessboard/src/Chessboard.js";
import { MuseDevice, FakeMuse } from "./muse.js";
import { EegProcessor, NAMES } from "./eeg.js";
import { runStroop, practiseStroop, stroopVerified, STROOP_KEYS_TEXT } from "./stroop.js";
import { HeartStrap, FakeHeartStrap, BeatBuffer } from "./heart.js";
import { LocalEngine } from "./still-engine.js";

const SERVER = "http://127.0.0.1:5318";
const LOSS_BUDGET_B = 300;      // budget = B * (1 - depth)^2 centipawns
// Rating: Glicko-2 (Glickman), one rating period per game, from 1500 with a spread of 350 that narrows as games are
// played (Kit, 31 Oct: "start at 1500, the more games the more precise, then pair me with the computer nearest my
// rating"). The engine opponent counts as a settled player (spread 50) at its Elo. The old K = 40 Elo numbers are
// left in storage untouched; everyone starts again here.
const GLICKO = { start: 1500, rd: 350, vol: 0.06, tau: 0.5, engineRd: 50, scale: 173.7178 };
function glicko2(p, results) {
  const S = GLICKO.scale, mu = (p.r - 1500) / S, phi = p.rd / S; let sigma = p.vol;
  if (!results.length) return { r: p.r, rd: Math.sqrt(phi * phi + sigma * sigma) * S, vol: sigma };
  const g = (ph) => 1 / Math.sqrt(1 + 3 * ph * ph / (Math.PI * Math.PI));
  const E = (m, ph) => 1 / (1 + Math.exp(-g(ph) * (mu - m)));
  let v = 0, d = 0;
  for (const x of results) { const m = (x.r - 1500) / S, ph = x.rd / S, e = E(m, ph), gg = g(ph); v += gg * gg * e * (1 - e); d += gg * (x.score - e); }
  v = 1 / v; const delta = v * d;
  const a = Math.log(sigma * sigma), tau = GLICKO.tau, eps = 1e-6;   // the new volatility, by the Illinois algorithm
  const f = (x) => (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) / (2 * (phi * phi + v + Math.exp(x)) ** 2) - (x - a) / (tau * tau);
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B);
  while (Math.abs(B - A) > eps) { const C = A + (A - B) * fA / (fB - fA), fC = f(C); if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2; B = C; fB = fC; }
  sigma = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma), phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  return { r: (mu + phiNew * phiNew * d) * S + 1500, rd: phiNew * S, vol: sigma };
}
// The automatic opponent: Stockfish at the rating itself, within what UCI_Elo allows.
const nearestElo = (r) => Math.round(clamp(r, 1320, 3190) / 10) * 10;
const PAUSE_MS = 1000;          // press, pause, then the piece moves
const SAMPLE_MS = 250;          // signal sample period
const PRESS_WINDOW_MS = 5000;   // the press and the board's colour read the same last five seconds
const REACTION_MS = 2000;       // the two seconds after the opponent's move lands
// The four colours sit on depth, from..to below. Each holds three shades (SHADES); a band's strength here is its
// middle shade, used only where a colour needs one number (the review chart's labels).
const BANDS = [
  { name: "red", from: 0, to: 0.294, strength: 1450, rgb: [214, 72, 62] },
  { name: "orange", from: 0.294, to: 0.529, strength: 2250, rgb: [240, 160, 48] },
  { name: "blue", from: 0.529, to: 0.706, strength: 3050, rgb: [70, 140, 230] },
  { name: "purple", from: 0.706, to: 1, strength: 3600, rgb: [150, 90, 220] },
];
// The twelve shades (Kit, 27 Oct). The colour comes from the average depth of the last 10 s; the shade from how long
// the player has held that colour: the first on entering (the window landing there), the second 10 s later, the third
// 10 s after that. Red runs the other way, so staying busy costs more. Each shade is a bot measured in the rating
// tournament (tools/still_tournament.py, round r2; docs/DECISIONS.md), listed in the order the shades are reached;
// the move server plays them (/still_bot).
const SHADES = {
  red: [[1700, "maia3_1175"], [1450, "maia3_780"], [1200, "maia3_570"]],
  orange: [[2000, "maia3_1770"], [2250, "maia3_2180"], [2550, "leela_p037"]],
  blue: [[2800, "leela_n1"], [3050, "leela_n12"], [3300, "leela_n48"]],
  purple: [[3500, "leela_n200"], [3600, "leela_n400"], [3700, "leela_n3200"]],
};
const COLOUR_WINDOW_MS = 10000, SHADE_STEP_MS = 10000;
const SHADE_PALE = [0.4, 0.2, 0];   // each later shade is a deeper tone of its colour
function shadeAt(bandIdx, i) {
  const b = BANDS[bandIdx], [strength, bot] = SHADES[b.name][i];
  return { name: b.name, shade: i, strength, bot, rgb: mixRgb(b.rgb, [255, 255, 255], SHADE_PALE[i]) };
}
function shadeOf(bandIdx, heldMs) { return shadeAt(bandIdx, Math.min(2, Math.floor(heldMs / SHADE_STEP_MS))); }
// Headband and strap together (Kit, 31 Oct): the headband sets the colour (it follows attention within seconds) and
// the strap sets the shade (the breath is slow, steady and learnable), in place of the time held. The strap's own
// colour scale is the shade: red or orange on the strap is the pale shade, blue the middle, purple the deep. Red is
// reversed on the time rule (longer in red gets worse); on the breath rule a calm breath always helps, so red's deep
// shade (1200) goes with an agitated breath and its pale shade (1700) with a settled one.
function shadeFromBreath(bandIdx, breathIdx) {
  const i = breathIdx === null || breathIdx === undefined ? 0 : Math.max(0, breathIdx - 1);   // strap red/orange 0, blue 1, purple 2
  return shadeAt(bandIdx, bandIdx === 0 ? 2 - i : i);
}
const BAND_BLEND = 0.012;       // colours blend over a sliver of depth either side of a band edge, never a muddy in-between
const WANDER_MEAN_DEPTH = 0.62;    // the wandering signal is centred here, in blue (calibrated 22 Oct, see the design doc)
const BAND_HOLD = 0.05;         // a colour holds until the reading is this far past its edge, so noise never flickers it
const TOP_BAND = 0.706;         // purple counts as the top band for entry and hold
const strengthFor = (d) => ladder(d).elo;
const bandIndex = (d) => { const i = BANDS.findIndex((b) => d < b.to); return i < 0 ? BANDS.length - 1 : i; };
// The held colour: it changes only once the reading is clearly inside another band. The board shows it and the press plays it.
function holdBand(cur, d) { if (cur === null || cur === undefined) return bandIndex(d); const b = BANDS[cur]; return d >= b.from - BAND_HOLD && d < b.to + BAND_HOLD ? cur : bandIndex(d); }
const RING_ENDING_MS = 5000;    // the free window's last five seconds are drawn brighter
const KEYS = { w: ["KeyA", "ShiftLeft"], b: ["KeyL", "ShiftRight"] };   // a clock button per player, wired as these keys
const LS = { sessions: "stillmate.sessions", glicko: "stillmate.glicko", pool: "stillmate.pool." };
const SIDES = ["w", "b"];
const SIDE_NAME = { w: "White", b: "Black" };
const other = (s) => (s === "w" ? "b" : "w");

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const fmtClock = (ms) => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); const m = Math.floor(s / 60); return ms < 10000 && ms > 0 ? `${m}:${String(s % 60).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}` : `${m}:${String(s % 60).padStart(2, "0")}`; };
const fmtS = (ms) => `${(ms / 1000).toFixed(1)} s`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------- virtual time ----------------
// Everything in the game loop reads T.now() and waits with T.sleep(), so a synthetic session can run at ten times speed.
const T = {
  speed: 1, _real0: performance.now(), _virt0: 0,
  now() { return this._virt0 + (performance.now() - this._real0) * this.speed; },
  setSpeed(s) { this._virt0 = this.now(); this._real0 = performance.now(); this.speed = s; },
  sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms) / this.speed)); },
  every(ms, fn) { const id = setInterval(fn, Math.max(16, ms / this.speed)); return () => clearInterval(id); },
};

// ---------------- signal adapters ----------------
// Every adapter emits samples {t, hr, hrv} (heart rate in bpm, variability as RMSSD in ms); a headband adds ab (alpha/beta).
// The slider and the synthetic trace share one mapping from a settled fraction s (0..1) to what a chest strap would give.
function channelsFrom(s) {
  return { hr: 90 - 35 * s + gauss() * 3, hrv: 15 + 70 * s + gauss() * 6 };
}
class SliderSignal {
  constructor(input) { this.device = "slider"; this.input = input; this.hasMind = false; }
  // The slider stands in for a sensor, so its baseline is fixed at the middle: full right always reads 1.0, full left 0.
  fixedBaseline() { return Array.from({ length: 240 }, () => ({ t: 0, ...channelsFrom(0.5) })); }
  start(onSample) { this._stop = T.every(SAMPLE_MS, () => onSample({ t: T.now(), ...channelsFrom(this.input.value / 1000) })); }
  stop() { this._stop?.(); }
}
// A generated story: settles in over a minute and a half, with dips every forty to seventy seconds that recover.
class SyntheticSignal {
  constructor() { this.device = "synthetic"; this.hasMind = false; this.t0 = null; this.dips = []; this.next = 40 + Math.random() * 30; this.phase = Math.random() * 10; }
  value(t) {
    const s = (t - this.t0) / 1000;
    if (s > this.next) { this.dips.push({ at: s, depth: 0.1 + Math.random() * 0.3, len: 10 + Math.random() * 10 }); this.next = s + 40 + Math.random() * 30; }
    let v = 0.45 + 0.35 * Math.min(1, s / 90) + 0.05 * Math.sin(s / 7 + this.phase);
    for (const d of this.dips) { const x = s - d.at; if (x >= 0 && x < d.len) v = Math.min(v, d.depth + (v - d.depth) * (x / d.len) ** 2); }
    return clamp(v, 0, 1);
  }
  start(onSample) { this.t0 = T.now(); this._stop = T.every(SAMPLE_MS, () => onSample({ t: T.now(), ...channelsFrom(this.value(T.now())) })); }
  stop() { this._stop?.(); }
}

// A chest strap (js/heart.js; Kit, 27 Oct: the heart becomes the main signal): heart rate over the last 5 s and
// RMSSD over the last 30 s, sampled like the slider, into the same body model. The beat buffer lives on the strap,
// so the 30 s window is already full when the next game's sit begins. A strap that sends no beat intervals (8 Nov:
// Garmin straps) gives samples with the rate alone (hrv NaN), and the model reads depth from the rate.
class HeartSignal {
  constructor(dev) { this.dev = dev; this.device = dev.kind === "fake" ? "h10-test" : "h10"; this.heart = true; this.hasMind = false; this.buf = attachBeats(dev); }
  start(onSample) {
    this._stop = T.every(SAMPLE_MS, () => {
      const now = T.now(), hr = this.buf.hr(now), hrv = this.buf.hasIntervals(now) ? this.buf.rmssd(now) : NaN;
      if (Number.isFinite(hr)) onSample({ t: now, hr, hrv });
    });
  }
  stop() { this._stop?.(); }                       // the strap stays connected for the next game
  intervals() { return this.buf.hasIntervals(T.now(), 30); }   // beat intervals in the last 30 s, or rate only
}
function attachBeats(dev) { if (!dev.buf) { dev.buf = new BeatBuffer(); dev.onBeats = (rr, hr) => dev.buf.add(rr, T.now(), hr); } return dev.buf; }

// A wandering mind for play without a sensor: the state drifts on its own around an average of about 2000, so the
// board's colour moves through the bands by itself and the player chooses the moment to press.
// Mean-reverting drift (Ornstein-Uhlenbeck): about eight seconds to wander back, spread chosen so red and purple both visit.
const DEPTH_GAIN = 1.458;       // how strongly the settled fraction moves depth under the fixed middle baseline
const WANDER_TAU_S = 24, WANDER_SD = 0.22, WANDER_BIAS = 0;   // slowed 22 Oct (was 8 s): a colour now holds about 12 s
class WanderSignal {
  constructor() { this.device = "wander"; this.hasMind = false; this.mu = WANDER_MEAN_DEPTH + WANDER_BIAS; this.x = this.mu + (Math.random() - 0.5) * 0.2; this.last = null; }
  fixedBaseline() { return Array.from({ length: 240 }, () => ({ t: 0, ...channelsFrom(0.5) })); }
  step(now) {
    const dt = this.last === null ? 0 : Math.max(0, now - this.last) / 1000; this.last = now;
    const theta = 1 / WANDER_TAU_S;
    this.x += theta * (this.mu - this.x) * dt + WANDER_SD * Math.sqrt(2 * theta * dt) * gauss();
    this.x = clamp(this.x, -0.15, 1.15);
    return this.x;
  }
  sampleAt(now) { const d = this.step(now); return { t: now, ...channelsFrom(0.5 + (d - 0.5) / DEPTH_GAIN) }; }
  start(onSample) { this._stop = T.every(SAMPLE_MS, () => onSample(this.sampleAt(T.now()))); }
  stop() { this._stop?.(); }
}

// ---------------- the headband ----------------
// A Muse 2 through js/eeg.js (reports/EEG markers of meditative depth for Stillmate.md, section 6). It gives a depth
// directly: the mind index of the last 5 s window, measured up from the player's own busy mind (the Stroop task).
// Busy sits in lower orange (0.35), and each step above it (the larger of rest's spread and 0.1) adds 0.09 of depth:
// blue starts 2.0 steps above busy, purple 4.0, and purple needs no drowsiness vote; red means a mind busier than the
// Stroop. A player whose quiet mind sits far above their busy mind starts high: a deeply calm player is no longer
// pinned to orange at rest (Kit, 27 Oct; until then rest itself sat mid-orange). The busy point moved from 0.23 to
// 0.35 when the Stroop replaced counting: its gap below rest is smaller (Kit 0.7 steps, against 2 for counting), and
// 0.35 puts his rest back at mid-orange. If the task did not register (gap under half a step, or too little effort),
// rest anchors the scale as before. The scale constants are the product's own, to be tuned on real sessions.
const MUSE_CAL = { full: { closed: 20, open: 60, busy: 30 }, quick: { closed: 8, open: 20, busy: 20 } };  // a busy reading needs 5 clean seconds after a 2 s settle
// muse-check.html shows players where they reach on this scale; js/muse-check.js keeps a copy (GAME) in step.
const MUSE_DEPTH_BUSY = 0.35, MUSE_DEPTH_REST = 0.41, MUSE_DEPTH_PER_SD = 0.09, MUSE_SD_FLOOR = 0.1, MUSE_MIN_GAP = 0.5;  // busy in lower orange; rest is the fallback anchor
const NO_SIGNAL_HOLD_MS = 10000;  // gate G6: hold the last colour 10 s when the signal drops, then no colour
const DROPPED_MS = 3000;          // no packet from the headband for this long: it has stopped sending
const NO_COLOUR_TEXT = { "eyes closed": "No colour: eyes closed.", "no signal": "No colour: no clean signal. Sit still and check the fit.", dropped: "No colour: the headband stopped sending. Check it is on and in range.", calibrating: "No colour yet." };
const PURPLE_CAP = 0.706 - 0.05 - 0.01;  // below purple's hold edge, so a drowsy vote always takes purple away
class MuseSignal {
  constructor(dev) {
    this.dev = dev; this.device = dev.kind === "fake" ? "muse-test" : "muse"; this.eeg = true; this.hasMind = true;
    this.proc = new EegProcessor(); this.cal = null; this.lastGood = null; this.lastEegAt = performance.now();
    dev.onEeg = (c, i, s) => { this.lastEegAt = performance.now(); this.proc.pushEeg(c, i, s); };
    dev.onAccel = (s) => this.proc.pushAccel(s);
  }
  start() { this._stop = setInterval(() => this.proc.process(), 250); this.tallyT = null; this.tally = { windows: 0, contact: [0, 0, 0, 0], contactN: [0, 0, 0, 0], bothEars: 0 }; }
  stop() { clearInterval(this._stop); }            // the headband stays connected for the next game
  // Contact during play (Kit, 31 Oct: "all those AFs should be firing, shall we track that?"): each window once,
  // the share of its segments with electrode contact per channel, and whether both ear channels gave a reading.
  count() {
    const w = this.proc.windows[this.proc.windows.length - 1]; if (!w || w.t === this.tallyT) return;
    this.tallyT = w.t; const t = this.tally; t.windows++;
    w.contact.forEach((c, i) => { if (c !== null) { t.contact[i] += c; t.contactN[i]++; } });
    if (w.psd[0] && w.psd[3]) t.bothEars++;
  }
  contactReport() {
    const t = this.tally; if (!t || !t.windows) return null;
    return { windows: t.windows, contact: Object.fromEntries(NAMES.map((n, i) => [n, t.contactN[i] ? Math.round(100 * t.contact[i] / t.contactN[i]) : null])), bothEars: Math.round(100 * t.bothEars / t.windows) };
  }
  mOf(w) {                                          // the index of a window with the current alpha frequency
    const ms = [0, 3].filter((c) => w.psd[c]).map((c) => { const b = this.proc.bands(w.psd[c]); return b.alpha - b.beta; });
    return ms.length ? mean(ms) : NaN;
  }
  calibrate(m) {
    const p = this.proc, closed = [m.closed[0] + 3, m.closed[1]], open = [m.open[0] + 5, m.open[1]], busy = [m.busy[0] + 2, m.busy[1]];
    const ec = p.setEyesClosed(open, closed);
    const base = p.setBaseline(open[0], open[1]);
    if (!Number.isFinite(base.mu) || base.windows < 3) { this.cal = null; return false; }
    const bw = p.windows.filter((w) => w.t - 5 >= busy[0] && w.t <= busy[1] && w.valid).map((w) => this.mOf(w)).filter(Number.isFinite);
    const mBusy = bw.length ? mean(bw) : NaN, gap = base.mu - mBusy;
    // a Stroop run must show real effort before its reading may anchor the scale (two players count silently, unasked)
    const effort = this.task ? this.task.verified : true;
    const s = Math.max(base.sigma, MUSE_SD_FLOOR), fromBusy = effort && Number.isFinite(gap) && gap >= MUSE_MIN_GAP * s;
    const anchor = fromBusy ? mBusy : base.mu, anchorDepth = fromBusy ? MUSE_DEPTH_BUSY : MUSE_DEPTH_REST;
    const restDepth = anchorDepth + MUSE_DEPTH_PER_SD * (base.mu - anchor) / s;
    this.cal = { mu: base.mu, sigma: base.sigma, s, mBusy, gap, fromBusy, task: this.task || null, anchor, anchorDepth, restDepth, iaf: p.iaf, rise: ec.rise, windows: base.windows, cleanSeconds: base.cleanSeconds };
    return true;
  }
  // The reading now: {depth} or {none, why}.
  read() {
    const w = this.proc.windows[this.proc.windows.length - 1], now = performance.now();
    if (!this.cal || !w) return { none: true, why: "calibrating" };
    // a headband that stops sending leaves the last window in place; without this check its colour would freeze
    if (now - this.lastEegAt > DROPPED_MS) {
      if (this.lastGood && now - this.lastGood.at < NO_SIGNAL_HOLD_MS) return { ...this.lastGood.r, held: true };
      return { none: true, why: "dropped" };
    }
    if (w.eyesClosed) return { none: true, why: "eyes closed" };
    if (!w.valid) {
      if (this.lastGood && now - this.lastGood.at < NO_SIGNAL_HOLD_MS) return { ...this.lastGood.r, held: true };
      return { none: true, why: "no signal" };
    }
    const c = this.cal, z = (w.m - c.mu) / c.s;               // z: steps from rest, kept for the tuning report
    let depth = c.anchorDepth + MUSE_DEPTH_PER_SD * (w.m - c.anchor) / c.s;
    if (w.drowsy) depth = Math.min(depth, c.restDepth);        // drowsy never reads deeper than the player's own rest
    depth = clamp(depth, 0, 1);
    const awake = !(w.votes.a || w.votes.b || w.votes.d);
    if (!awake) depth = Math.min(depth, PURPLE_CAP);
    const r = { depth, z, drowsy: w.drowsy, awake, m: w.m };
    this.lastGood = { at: now, r };
    return r;
  }
}
let actx = null;
function tone(high = false) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.frequency.value = high ? 660 : 523; g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.65);
  } catch {}
}

// ---------------- depth ----------------
// Each term is a z-score against the player's own baseline; printed formulas, no classifier.
// A chest strap uses the headband's scale (rest mid-orange, 0.09 of depth a step, blue about 1.3 steps up, purple
// about 3.3) and wider floors on the sit's spread: a 20 s sit barely moves a 30 s RMSSD, and with the slider's floors
// (1 bpm, 3 ms) a test strap sat in purple within a minute (27 Oct). Floors and scale are first settings, to be tuned
// on Kit's H10 sessions.
const HEART_SCALE = { rest: 0.41, perStep: 0.09, hrFloor: 3, hrvFloorShare: 0.15, hrvFloor: 5 };
class DepthModel {
  constructor(device, hasMind) { this.device = device; this.hasMind = hasMind; this.baseline = null; this.heart = device === "h10" || device === "h10-test"; }
  fitBaseline(samples) {
    const hr = samples.map((s) => s.hr), hrv = samples.map((s) => s.hrv).filter(Number.isFinite), H = HEART_SCALE;
    const hrFloor = this.heart ? H.hrFloor : 1, hrvFloor = this.heart ? Math.max(H.hrvFloor, H.hrvFloorShare * mean(hrv)) : 3;
    this.baseline = {
      hr: { mean: mean(hr), sd: Math.max(hrFloor, sd(hr)) },
      hrv: hrv.length >= 4 ? { mean: mean(hrv), sd: Math.max(hrvFloor, sd(hrv)) } : null,   // null: a rate-only strap
      sigma: Math.max(hrFloor, sd(hr)), n: samples.length,
    };
    if (this.hasMind) { const ab = samples.map((s) => s.ab); this.baseline.ab = { mean: mean(ab), sd: Math.max(0.05, sd(ab)) }; }
    return this.baseline;
  }
  // window: the samples of the measurement window; before/after: samples around the opponent's move landing (non-reaction).
  terms(window, before, after) {
    const b = this.baseline; if (!b || !window.length) return null;
    const z = (xs, ref) => (mean(xs) - ref.mean) / ref.sd;
    const hr = window.map((s) => s.hr), hrv = window.map((s) => s.hrv).filter(Number.isFinite);
    // variability counts when the sit and the window both have it; a rate-only strap reads the rate alone
    const body = b.hrv && hrv.length ? (-z(hr, b.hr) + z(hrv, b.hrv)) / 2 : -z(hr, b.hr);
    const mind = this.hasMind ? z(window.map((s) => s.ab), b.ab) : null;
    const stability = -(sd(hr) - b.sigma) / b.sigma;
    const nonreaction = before.length && after.length ? -Math.abs(mean(after.map((s) => s.hr)) - mean(before.map((s) => s.hr))) / b.sigma : 0;
    const parts = [[0.4, body], [0.2, mind], [0.2, stability], [0.2, nonreaction]].filter(([, v]) => v !== null);
    const wsum = parts.reduce((a, [w]) => a + w, 0);
    const zc = parts.reduce((a, [w, v]) => a + w * v, 0) / wsum;
    const depth = this.heart ? clamp(HEART_SCALE.rest + HEART_SCALE.perStep * zc, 0, 1) : clamp((zc + 2) / 4, 0, 1);
    return { body, mind, stability, nonreaction, z: zc, depth };
  }
}

// Strength and band for a depth.
function ladder(depth) {
  const band = BANDS.find((b) => depth < b.to) || BANDS[BANDS.length - 1];
  return { band: band.name, elo: band.strength };
}
// Typical centipawn loss per move by rating (approximate, from online play), interpolated.
const ACPL = [[1000, 110], [1500, 70], [1900, 48], [2200, 36], [2700, 20]];
function acplFor(elo) {
  for (let i = 1; i < ACPL.length; i++) if (elo <= ACPL[i][0]) { const [e0, a0] = ACPL[i - 1], [e1, a1] = ACPL[i]; return a0 + (a1 - a0) * (elo - e0) / (e1 - e0); }
  return ACPL[ACPL.length - 1][1];
}
// The move: a target loss drawn from an exponential with that rating's mean, so most moves are sound and a few slip,
// then the move from the full list whose loss is closest to the target (the better move on a tie).
function chooseMove(moves, bandObj, full) {
  if (moves.length === 1) return { move: moves[0], loss: 0, forced: true };
  const best = moves[0].cp; const band = bandObj.name, elo = bandObj.strength;
  if (band === "purple") {   // Stockfish's own full-strength choice
    const m = (full && moves.find((x) => x.uci === full.uci)) || moves[0];
    return { move: m, loss: Math.max(0, best - m.cp), budget: 0 };
  }
  const target = Math.min(600, -acplFor(elo) * Math.log(1 - Math.random()));
  let pick = moves[0], gap = Infinity;
  for (const m of moves) { const loss = best - m.cp; const g = Math.abs(loss - target); if (g < gap - 1e-9 || (Math.abs(g - gap) < 1e-9 && m.cp > pick.cp)) { pick = m; gap = g; } }
  return { move: pick, loss: best - pick.cp, budget: Math.round(target) };
}

// ---------------- colour ----------------
// Red when depth is low (monkey mind), orange in the middle, blue when the mind is quiet; blended continuously.
const SQUARE_LIGHT = [236, 218, 185], SQUARE_DARK = [197, 160, 118];   // cm-chessboard's default squares
const TINT_STRENGTH = 0.42;
const mixRgb = (a, b, x) => a.map((v, i) => Math.round(v + (b[i] - v) * x));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
// Red 1000 to 1500, orange 1500 to 1900, blue 1900 to 2200, purple 2200 to 2700; each band one colour, blended at its edges.
function depthColour(d) {
  d = clamp(d, 0, 1);
  for (let i = 0; i < BANDS.length - 1; i++) {
    const edge = BANDS[i].to;
    if (d < edge - BAND_BLEND) return BANDS[i].rgb;
    if (d <= edge + BAND_BLEND) return mixRgb(BANDS[i].rgb, BANDS[i + 1].rgb, (d - (edge - BAND_BLEND)) / (2 * BAND_BLEND));
  }
  return BANDS[BANDS.length - 1].rgb;
}

// ---------------- server ----------------
async function post(path, body) {
  const r = await fetch(SERVER + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
// Two backends (8 Nov): the coach server when it answers (the measured bots, sessions saved to the laptop), else the
// in-browser engine (js/still-engine.js: Stockfish lite, the strength limiter standing in for the bots, sessions in
// the browser only). The probe at page load decides; a game started before it answers waits for it.
let backend = null;
const local = new LocalEngine();
const ENGINE_NOTE = "The coach server is off, so moves come from the in-browser engine: Stockfish's strength limiter plays the shades in place of the measured bots, and purple's top shades are the unthrottled engine. Sessions save in this browser only.";
const probe = post("/still_moves", { fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", nodes: 20000 })
  .then(() => { backend = "server"; })
  .catch(() => { backend = "browser"; $("server-note").textContent = ENGINE_NOTE; $("server-note").hidden = false; $("lead-engine").textContent = " Moves come from the in-browser engine while the coach server is off."; local.init(); });
const stillMoves = (fen, nodes, bestNodes) => backend === "browser" ? local.moves(fen) : post("/still_moves", { fen, ...(nodes ? { nodes } : {}), ...(bestNodes ? { best_nodes: bestNodes } : {}) });
const stillReply = (fen, elo) => backend === "browser" ? local.reply(fen, elo) : post("/still_reply", { fen, elo });
const stillBot = (moves, bandObj) => backend === "browser" ? local.bot(moves, bandObj.strength) : post("/still_bot", { moves, bot: bandObj.bot });

// ---------------- storage ----------------
const store = {
  glickos() { try { return JSON.parse(localStorage.getItem(LS.glicko) || "{}"); } catch { return {}; } },
  glicko(name) { return store.glickos()[name] || { r: GLICKO.start, rd: GLICKO.rd, vol: GLICKO.vol, games: 0 }; },
  setGlicko(name, g) { const all = store.glickos(); all[name] = g; localStorage.setItem(LS.glicko, JSON.stringify(all)); },
  rating(name) { return Math.round(store.glicko(name).r); },
  sessions() { try { return JSON.parse(localStorage.getItem(LS.sessions) || "[]"); } catch { return []; } },
  addSession(s) { const all = store.sessions(); all.unshift(s); localStorage.setItem(LS.sessions, JSON.stringify(all.slice(0, 50))); },
  pool(device) { try { return JSON.parse(localStorage.getItem(LS.pool + device) || "[]"); } catch { return []; } },
  addToPool(device, readings) { const p = store.pool(device).concat(readings).slice(-5000); localStorage.setItem(LS.pool + device, JSON.stringify(p)); },
};

// ---------------- the table ----------------
const ui = {
  screens: ["setup", "table", "review", "history"],
  show(name) { for (const s of ui.screens) $(`screen-${s}`).hidden = s !== name; },
  setEval(cpWhite, mateWhite) {
    const bar = $("eval-bar"); const pct = clamp(winPct(cpWhite), 2, 98);
    bar.querySelector(".fill").style.height = pct + "%";
    bar.querySelector(".label").textContent = mateWhite ? `M${Math.abs(mateWhite)}` : (Math.abs(cpWhite) / 100).toFixed(1);
  },
  setDepth(d, band) {
    const bar = $("depth-bar"); bar.querySelector(".fill").style.height = (d === null ? 0 : clamp(d, 0, 1) * 100) + "%";
    bar.querySelector(".fill").style.background = d === null ? "" : rgb(band.rgb);
    bar.querySelector(".label").textContent = d === null ? "" : String(band.strength);
  },
  chip(pos, band) {
    const el = $(`chip-${pos}`); if (!band) { el.hidden = true; return; }
    el.hidden = false; el.textContent = String(band.strength); el.style.background = rgb(band.rgb);
  },
  // The board's squares and frame take the held colour, so the player can feel the state and choose the press.
  tint(c) {
    const board = $("board");
    board.style.setProperty("--sq-light", rgb(mixRgb(SQUARE_LIGHT, c, TINT_STRENGTH)));
    board.style.setProperty("--sq-dark", rgb(mixRgb(SQUARE_DARK, c, TINT_STRENGTH)));
    $("board-wrap").style.boxShadow = `0 0 46px 6px rgba(${c[0]},${c[1]},${c[2]},0.45)`;
  },
  untint() { const board = $("board"); board.style.removeProperty("--sq-light"); board.style.removeProperty("--sq-dark"); $("board-wrap").style.boxShadow = ""; },
  glow(square, depth, orientation, c) {
    const wrap = $("board-wrap"), g = $("glow"); const size = wrap.clientWidth / 8;
    const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1;
    const x = orientation === "w" ? file : 7 - file, y = orientation === "w" ? 7 - rank : rank;
    g.style.left = `${x * size - size * 0.25}px`; g.style.top = `${y * size - size * 0.25}px`;
    g.style.width = g.style.height = `${size * 1.5}px`;
    g.style.background = `radial-gradient(circle, rgba(${c[0]},${c[1]},${c[2]},${(0.4 + 0.5 * depth).toFixed(3)}) 0%, rgba(${c[0]},${c[1]},${c[2]},0) 70%)`;
    g.classList.add("on"); g.style.opacity = "1";
    requestAnimationFrame(() => requestAnimationFrame(() => { g.classList.remove("on"); g.style.opacity = "0"; }));
  },
};
for (const b of BANDS.slice(0, -1)) { const t = document.createElement("i"); t.style.bottom = `${b.to * 100}%`; $("depth-bar").querySelector(".ticks").appendChild(t); }

// ---------------- the game ----------------
class Game {
  constructor(opts) {
    // opts: {tc, tcLabel, duo, elo, humanSide, names, signals, baselineS, synthetic}
    this.opts = opts;
    this.chess = new Chess();
    this.players = {};
    for (const side of SIDES) {
      const signal = opts.signals[side];
      this.players[side] = {
        side, human: !!signal, name: opts.names[side] || SIDE_NAME[side], signal,
        model: signal ? new DepthModel(signal.device, signal.hasMind) : null,
        samples: [], instant: [], lastLanding: null, bandIdx: null,
        trace: [], avg: null, shade: null, held: 0, prevT: null, why: "calibrating", followN: 0, whyCounts: {},
        // a strap beside the headband: its own samples, model and held colour, which set the shade
        breath: signal?.breath || null, breathModel: signal?.breath ? new DepthModel(signal.breath.device, false) : null,
        breathSamples: [], breathIdx: null, breathDepth: null,
      };
    }
    this.bottom = opts.duo ? "w" : opts.humanSide;
    this.moves = [];                       // per ply: {ply, san, side, human, t, depth, terms, loss, band, elo, cpWhite, auto, thinkMs}
    this.evalSeries = [];                  // {t, cpWhite}
    this.state = "sit"; this.busy = false; this.over = null; this.escAt = 0; this.turnStart = null;
    const tc = opts.tc;
    // Delay: every move starts with a free window; only time past it comes off the bank. Increment: a chess clock.
    this.clock = tc.mode === "delay"
      ? { mode: "delay", window: tc.window, total: tc.bank, w: tc.bank, b: tc.bank, inc: 0, running: null, since: 0 }
      : { mode: "inc", window: 0, total: tc.main, w: tc.main, b: tc.main, inc: tc.inc, running: null, since: 0 };
    this.id = new Date().toISOString().replace(/[:.]/g, "-");
  }
  humans() { return SIDES.filter((s) => this.players[s].human); }
  pos(side) { return side === this.bottom ? "bottom" : "top"; }
  label(side) { return this.opts.duo ? this.players[side].name : (this.players[side].human ? "You" : "Stockfish"); }

  async start() {
    ui.show("table");
    for (const side of SIDES) {
      const p = this.players[side], pos = this.pos(side);
      $(`name-${pos}`).textContent = p.human ? (this.opts.duo ? p.name : "You") : "Stockfish";
      $(`rating-${pos}`).textContent = p.human ? store.rating(p.name) : this.opts.elo;
      $(`clock-${pos}`).className = "clock";
      $(`bank-${pos}`).hidden = this.clock.mode !== "delay";
      ui.chip(pos, null);
    }
    $("depth-bar").hidden = this.opts.duo;      // two players: each name carries its own depth
    $("eval-bar").classList.toggle("flipped", this.bottom === "b");
    ui.setEval(0, null); ui.setDepth(null, null); ui.untint();
    $("hint").textContent = "";
    this.drawClocks();
    this.board = new Chessboard($("board"), {
      position: FEN.start, orientation: this.bottom === "w" ? COLOR.white : COLOR.black,
      assetsUrl: "node_modules/cm-chessboard/assets/", style: { pieces: { file: "pieces/staunty.svg" }, animationDuration: 320 },
    });
    for (const side of this.humans()) {
      const p = this.players[side];
      const fixed = p.signal.fixedBaseline?.(); if (fixed) p.model.fitBaseline(fixed);
      p.signal.start((s) => p.samples.push(s));
      p.breath?.start((s) => p.breathSamples.push(s));
    }
    this.defaultHint = this.opts.duo ? "Your clock: White A, Black L. Enter presses for whoever is on move." : "Enter is your clock.";
    if (backend === "server") post("/still_warm", {}).catch(() => {});     // the bots load during the sit (Maia-3 takes about 20 s)
    this.stopLive = T.every(SAMPLE_MS, () => this.follow());
    await this.sit();
    if (this.over) return;
    // a strap that gave no beat intervals through the sit: the colour comes from the rate alone, and the hint says so
    const rateOnly = this.humans().filter((s) => { const p = this.players[s]; const sg = p.signal.heart ? p.signal : p.breath; return sg && !sg.intervals(); });
    for (const s of rateOnly) this.players[s].rateOnly = true;
    if (rateOnly.length) this.defaultHint += ` Heart rate only: ${this.opts.duo ? rateOnly.map((s) => this.players[s].name).join(" and ") + "'s strap sends" : "your strap sends"} no beat intervals, so variability is unavailable.`;
    this.state = "play"; this.playStart = T.now();
    $("hint").textContent = this.defaultHint;
    this.stopTick = T.every(100, () => this.tick());
    this.stopInstant = T.every(1000, () => this.recordInstant());
    this.beginTurn("w");
  }

  samplesBetween(side, a, b) { return this.players[side].samples.filter((s) => s.t > a && s.t <= b); }

  // The baseline: an eyes-open sit at the board before the clock starts. The slider's baseline is fixed.
  async sit() {
    const eegSides = this.humans().filter((s) => this.players[s].signal.eeg);
    if (eegSides.length) return this.ritual(eegSides);
    const veil = $("sit-veil"); veil.hidden = false; const t0 = T.now(); const len = this.opts.baselineS * 1000;
    $("sit-text").textContent = this.opts.duo ? "Both sit. Eyes open. Nothing to do." : "Sit. Eyes open. Nothing to do.";
    let early = false; const btn = $("btn-sit-now"); btn.onclick = () => { if (T.now() - t0 >= 3000) early = true; };
    while (T.now() - t0 < len && !early && !this.over) { $("sit-count").textContent = Math.ceil((len - (T.now() - t0)) / 1000); await T.sleep(200); }
    veil.hidden = true; btn.onclick = null;
    for (const side of this.humans()) {
      const p = this.players[side];
      if (!p.signal.fixedBaseline) p.model.fitBaseline(this.samplesBetween(side, t0, T.now()));
    }
    const silent = this.humans().filter((s) => this.players[s].signal.heart && !(this.players[s].model.baseline?.n >= 8));
    if (silent.length) this.abort(`No heartbeat from ${silent.map((s) => (this.opts.duo ? this.players[s].name + "'s" : "your")).join(" or ")} chest strap. Wet the strap's pads, fasten it snugly just below the chest, and start again.`);
  }

  // The headband ritual: eyes shut (closed-eye gate, alpha frequency), eyes open on the board (the baseline), then
  // the busy end of the scale: the Stroop colour task for one player (js/stroop.js; back on 27 Oct, see js/count.js),
  // silent counting from 300 for two players at one keyboard
  // at one keyboard. A soft tone marks each change; the test stream follows it.
  async ritual(eegSides) {
    const L = this.opts.baselineS <= 10 ? MUSE_CAL.quick : MUSE_CAL.full;
    const veil = $("sit-veil"); veil.hidden = false; $("btn-sit-now").hidden = true;
    const sigs = eegSides.map((s) => this.players[s].signal), marks = sigs.map(() => ({})); let openAt = null;
    for (const sg of sigs) sg.task = null;             // the headband stays connected between games
    const steps = [
      { key: "closed", secs: L.closed, text: "Close your eyes. Breathe naturally. Open them at the tone.", fake: { eyesClosed: true } },
      { key: "open", secs: L.open, text: "Eyes open. A soft gaze on the board.", fake: {} },
      this.opts.duo
        ? { key: "busy", secs: L.busy, text: "Count back from 300 in sevens, silently.", fake: { counting: true } }
        : { key: "busy", secs: L.busy, text: `Name the ink colour, not the word. Press ${STROOP_KEYS_TEXT}, fast and accurate.`, fake: { counting: true }, stroop: true },
    ];
    for (const st of steps) {
      if (st.stroop) {                                  // practice words first (until 4 of 5 right), outside the measured time
        tone(); $("sit-text").textContent = `Practice: name the ink colour of five words. Press ${STROOP_KEYS_TEXT}.`; $("sit-count").textContent = "";
        await practiseStroop($("sit-task"), { now: () => T.now(), sleep: (ms) => T.sleep(ms) });
      }
      tone(); $("sit-text").textContent = (this.opts.duo ? "Both players. " : "") + st.text;
      for (const sg of sigs) if (sg.dev.kind === "fake") sg.dev.set({ eyesClosed: !!st.fake.eyesClosed, counting: !!st.fake.counting });
      const t0s = sigs.map((sg) => sg.proc.time()), t0 = T.now();
      const task = st.stroop ? runStroop($("sit-task"), st.secs, { now: () => T.now(), sleep: (ms) => T.sleep(ms) }) : null;
      while (T.now() - t0 < st.secs * 1000 && !this.over) { $("sit-count").textContent = Math.ceil((st.secs * 1000 - (T.now() - t0)) / 1000); await T.sleep(200); }
      sigs.forEach((sg, i) => { marks[i][st.key] = [t0s[i], sg.proc.time()]; });
      if (st.key === "open") openAt = [t0, T.now()];   // the eyes-open sit is also the strap's rest
      if (task) { const r = await task; for (const sg of sigs) sg.task = { ...r, verified: stroopVerified(r, st.secs) }; }
    }
    // a strap beside the headband takes its baseline from the eyes-open sit, as a strap alone would from its sit
    const quiet = [];
    for (const s of eegSides) {
      const p = this.players[s]; if (!p.breath) continue;
      p.breathModel.fitBaseline(p.breathSamples.filter((x) => x.t > openAt[0] && x.t <= openAt[1]));
      if (!(p.breathModel.baseline?.n >= 8)) quiet.push(s);
    }
    if (quiet.length) { veil.hidden = true; $("btn-sit-now").hidden = false; return this.abort(`No heartbeat from ${quiet.map((s) => (this.opts.duo ? this.players[s].name + "'s" : "your")).join(" or ")} chest strap. Wet the strap's pads, fasten it snugly just below the chest, and start again.`); }
    for (const sg of sigs) if (sg.dev.kind === "fake") sg.dev.set({ eyesClosed: false, counting: false });
    tone(true); $("sit-text").textContent = "Reading your baseline."; $("sit-count").textContent = "";
    await T.sleep(1500);
    const failed = eegSides.filter((s, i) => { sigs[i].proc.process(); return !sigs[i].calibrate(marks[i]); });
    veil.hidden = true; $("btn-sit-now").hidden = false;
    if (failed.length) this.abort(`No clean reading from ${failed.map((s) => (this.opts.duo ? this.players[s].name + "'s" : "your")).join(" or ")} headband. Check the fit: band across the forehead, ear pieces on skin, hair moved away. Then start again.`);
  }
  abort(msg) {
    this.over = { aborted: true }; this.stopLive?.(); ui.untint();
    for (const s of this.humans()) { this.players[s].signal.stop(); this.players[s].breath?.stop(); }
    ui.show("setup"); setupMsg(msg);
  }

  // ---- depth now: one reading serves the board's colour, the press and the trace ----
  readingAt(side, t) {
    const p = this.players[side];
    if (p.signal?.eeg) return p.signal.read();
    if (!p.model?.baseline) return null;
    const window = this.samplesBetween(side, t - PRESS_WINDOW_MS, t);
    if (p.signal?.heart && !window.length) return { none: true, why: "no signal" };   // the strap went quiet
    const L = p.lastLanding; let before = [], after = [];
    if (L !== null && t >= L && this.chess.turn() === side) {
      before = this.samplesBetween(side, L - REACTION_MS, L);
      after = this.samplesBetween(side, L, Math.min(L + REACTION_MS, t));
    }
    return p.model.terms(window, before, after);
  }
  // Every quarter second, for each player, through both turns: the colour from the average depth of the last 10 s,
  // and the time held in it. A dip into another colour restarts the timer; a lost signal pauses it.
  follow() {
    if (this.over) return;
    const now = T.now();
    for (const side of this.humans()) {
      const p = this.players[side], r = this.readingAt(side, now);
      if (r && !r.none) p.trace.push({ t: now, depth: r.depth });
      while (p.trace.length && p.trace[0].t <= now - COLOUR_WINDOW_MS) p.trace.shift();
      const counting = this.state === "play";       // the no-colour share counts play only, never the sit
      if (counting) { p.followN++; p.signal.count?.(); }
      if (!r || r.none || !p.trace.length) { p.shade = null; p.why = r?.why || "calibrating"; if (counting) p.whyCounts[p.why] = (p.whyCounts[p.why] || 0) + 1; p.prevT = null; continue; }
      p.avg = mean(p.trace.map((x) => x.depth));
      const idx = holdBand(p.bandIdx, p.avg);
      if (idx !== p.bandIdx) { p.bandIdx = idx; p.held = 0; } else if (p.prevT !== null) p.held += now - p.prevT;
      p.prevT = now;
      if (p.breath) {                                 // the strap's held colour, from its own last five seconds
        const w = p.breathSamples.filter((x) => x.t > now - PRESS_WINDOW_MS && x.t <= now), r = p.breathModel.terms(w, [], []);
        p.breathDepth = r ? r.depth : null;
        p.breathIdx = r ? holdBand(p.breathIdx, r.depth) : null;
        p.shade = shadeFromBreath(idx, p.breathIdx);
      } else p.shade = shadeOf(idx, p.held);
    }
    this.show();
  }
  // The board shows the colour and shade of the player on move (one player: the human throughout); the waiting
  // player's shade shows beside their name.
  show() {
    const side = this.opts.duo ? this.chess.turn() : this.opts.humanSide, p = this.players[side];
    if (this.opts.duo) for (const s of SIDES) ui.chip(this.pos(s), this.players[s].shade);
    else ui.setDepth(p.shade ? p.avg : null, p.shade);
    if (!p.shade) {                                 // no colour: the board goes plain and says why
      ui.untint();
      if (this.state === "play") $("hint").textContent = (NO_COLOUR_TEXT[p.why] || "No colour.") + " Your clock plays nothing until it returns.";
      return;
    }
    if (this.state === "play" && $("hint").textContent.startsWith("No colour")) $("hint").textContent = this.defaultHint;
    ui.tint(p.shade.rgb);
  }
  recordInstant() {
    if (this.over) return;
    const now = T.now();
    for (const side of this.humans()) { const r = this.readingAt(side, now); if (r && !r.none) this.players[side].instant.push({ t: now, depth: r.depth }); }
  }

  // ---- clock ----
  startClock(side) { this.clock.running = side; this.clock.since = T.now(); }
  remaining(side) {
    const c = this.clock; if (c.running !== side) return c[side];
    const used = T.now() - c.since; return c[side] - (c.mode === "delay" ? Math.max(0, used - c.window) : used);
  }
  windowLeft() { const c = this.clock; if (c.mode !== "delay" || !c.running) return 0; return Math.max(0, c.window - (T.now() - c.since)); }
  stopClock() { const c = this.clock; if (!c.running) return; c[c.running] = Math.max(0, this.remaining(c.running)); c.running = null; }
  drawClocks() {
    const c = this.clock;
    for (const side of SIDES) {
      const pos = this.pos(side), ms = this.remaining(side), el = $(`clock-${pos}`);
      el.textContent = fmtClock(ms);
      el.classList.toggle("running", c.running === side);
      el.classList.toggle("low", c.mode === "inc" && ms < 20000);
      if (c.mode === "delay") $(`bank-${pos}`).firstElementChild.style.width = `${clamp(ms / c.total, 0, 1) * 100}%`;
    }
    // the free window drains as a ring around the board; its last five seconds are brighter
    const ring = $("ring"); const show = c.mode === "delay" && !!c.running && this.players[c.running].human;
    ring.toggleAttribute("hidden", !show);   // an SVG element has no hidden property, so set the attribute
    if (show) {
      const left = this.windowLeft();
      ring.querySelector("rect").style.strokeDasharray = `${(left / c.window) * 100} 100`;
      ring.classList.toggle("ending", left > 0 && left <= RING_ENDING_MS);
    }
  }
  tick() {
    if (this.over) return;
    this.drawClocks();
    const c = this.clock, side = c.running; if (!side || this.remaining(side) > 0) return;
    if (c.mode === "delay") {
      // bank empty: the move commits itself at the end of each free window; nobody loses on time
      if (this.players[side].human && !this.busy) this.press(side, true);
    } else {
      this.stopClock(); this.end(other(side), `${this.label(side)} ran out of time.`);
    }
  }

  // ---- turns ----
  beginTurn(side) {
    if (this.over) return;
    const p = this.players[side]; this.turnStart = T.now(); this.busy = false;
    this.startClock(side);
    if (!p.human) { this.engineMove(side); return; }
    // the full list is requested the moment the turn begins, so it is ready before the press
    this.pending = stillMoves(this.chess.fen(), this.opts.synthetic ? 150000 : undefined, this.opts.synthetic ? 300000 : undefined).then((r) => {
      this.full = r.best || null;
      if (r.moves.length) {
        const b = r.best || r.moves[0]; const cpW = side === "w" ? b.cp : -b.cp;
        this.evalSeries.push({ t: T.now(), cpWhite: cpW }); ui.setEval(cpW, b.mate ? (side === "w" ? b.mate : -b.mate) : null);
      }
      return r.moves;
    });
    this.pending.catch((e) => { $("hint").textContent = "The coach server did not answer. Is it running on 5318?"; console.error(e); });
  }

  // The press: a one-second pause, the piece moves, then the bars and numbers update.
  async press(side, auto = false) {
    if (this.state !== "play" || this.busy || this.over || this.chess.turn() !== side || !this.players[side].human) return;
    const pressAt = T.now(), p = this.players[side];
    const reading = this.readingAt(side, pressAt) || { depth: 0.5, z: 0 };
    if (!p.shade && !auto) return;                   // no colour earns no move; the hint says why
    this.busy = true; const thinkMs = pressAt - this.turnStart;
    this.stopClock();
    // the press plays the shade the board shows; the clock committing a move with no colour plays red's lowest shade
    const bandObj = p.shade || shadeOf(0, 2 * SHADE_STEP_MS), depth = p.shade ? p.avg : 0;
    const history = this.chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ""));
    const botMove = this.pending.then(() => stillBot(history, bandObj)).catch((e) => { console.error(e); return null; });
    await T.sleep(PAUSE_MS);
    let moves; try { moves = await this.pending; } catch { this.busy = false; this.startClock(side); return; }
    const bot = await botMove;
    if (this.over) return;
    let move, loss, forced, budget;
    const listed = bot && moves.find((m) => m.uci === bot.uci);
    if (moves.length === 1) { move = moves[0]; loss = 0; forced = true; }
    else if (listed) { move = listed; loss = listed.unscored ? null : Math.max(0, moves[0].cp - listed.cp); }
    else ({ move, loss, forced, budget } = chooseMove(moves, bandObj, this.full));   // no answer from the bot: a sampled move at the shade's strength
    const mv = this.chess.move(move.san); const landed = await this.animate(mv);
    ui.glow(mv.to, depth, this.bottom, bandObj.rgb);
    const cpW = side === "w" ? move.cp : -move.cp;
    this.moves.push({ ply: this.chess.history().length, san: mv.san, side, human: true, t: landed, depth, terms: reading, loss, budget, forced: !!forced, auto, thinkMs, band: bandObj.name, shade: bandObj.shade, elo: bandObj.strength, bot: (bot && bot.bot) || bandObj.bot, heldMs: p.shade ? Math.round(p.held) : null, breathDepth: p.breath ? p.breathDepth : undefined, breathBand: p.breath && p.breathIdx !== null ? BANDS[p.breathIdx].name : undefined, cpWhite: cpW, noColour: !p.shade });
    this.evalSeries.push({ t: landed, cpWhite: cpW });
    ui.setEval(cpW, move.mate ? (side === "w" ? move.mate : -move.mate) : null);
    if (this.clock.mode === "inc") this.clock[side] += this.clock.inc;
    this.players[other(side)].lastLanding = landed;
    if (this.checkOver()) return;
    this.beginTurn(other(side));
  }

  async engineMove(side) {
    this.busy = true;
    let reply; try { reply = await stillReply(this.chess.fen(), this.opts.elo); } catch (e) { $("hint").textContent = "The coach server did not answer. Is it running on 5318?"; console.error(e); return; }
    if (this.over || reply.over) return;
    this.stopClock(); if (this.clock.mode === "inc") this.clock[side] += this.clock.inc;
    const mv = this.chess.move(reply.san); const landed = await this.animate(mv);
    this.players[other(side)].lastLanding = landed;
    this.moves.push({ ply: this.chess.history().length, san: mv.san, side, human: false, t: landed });
    if (this.checkOver()) return;
    this.beginTurn(other(side));
  }

  async animate(mv) {
    const settle = (p) => Promise.race([p, T.sleep(1200)]);
    // a move that lands after the game ended and its board was taken down (8 Nov) is recorded without animation
    try {
      if (this.board?.view) await settle(this.board.movePiece(mv.from, mv.to, true));
      if (this.board?.view) await settle(this.board.setPosition(this.chess.fen(), false));
    } catch (e) { if (!this.over) console.error(e); }
    return T.now();
  }

  checkOver() {
    const c = this.chess;
    if (c.isCheckmate()) { const w = other(c.turn()); this.end(w, `Checkmate. ${this.label(w)} won.`); return true; }
    if (c.isStalemate()) { this.end(null, "Stalemate."); return true; }
    if (c.isThreefoldRepetition()) { this.end(null, "Draw by repetition."); return true; }
    if (c.isInsufficientMaterial()) { this.end(null, "Draw, insufficient material."); return true; }
    if (c.isDrawByFiftyMoves()) { this.end(null, "Draw by the fifty-move rule."); return true; }
    return false;
  }

  onEscape() {
    const now = T.now();
    if (now - this.escAt < 2000) { const loser = this.opts.duo ? this.chess.turn() : this.opts.humanSide; this.end(other(loser), `${this.label(loser)} resigned.`); }
    else { this.escAt = now; $("hint").textContent = "Esc again resigns."; }
  }

  end(winner, line) {
    if (this.over) return;
    this.over = { winner, line, t: T.now() }; this.stopClock();
    this.stopTick?.(); this.stopInstant?.(); this.stopLive?.(); ui.untint(); $("ring").setAttribute("hidden", "");
    for (const s of this.humans()) { this.players[s].signal.stop(); this.players[s].breath?.stop(); }
    this.state = "over";
    const ratings = this.rate(winner);
    for (const s of this.humans()) store.addToPool(this.players[s].signal.device, this.moves.filter((m) => m.side === s && m.human).map((m) => m.depth));
    const session = this.summary(ratings);
    store.addSession(session);
    if (backend === "server") post("/still_save", { session }).then((r) => { $("saved-note").textContent = `Saved in the browser and as ${r.file}.`; }).catch(() => { $("saved-note").textContent = "Saved in the browser."; });
    else $("saved-note").textContent = "Saved in this browser only.";
    review(session, this);
  }

  // Rating from results only: Glicko-2 against the opponent (a person's own rating and spread, or the engine's Elo).
  rate(winner) {
    const out = {}; const humans = this.humans();
    for (const s of humans) { const g = store.glicko(this.players[s].name); out[s] = { g, before: Math.round(g.r), rdBefore: Math.round(g.rd) }; }
    if (this.opts.synthetic) { for (const s of humans) { out[s].after = out[s].before; out[s].rdAfter = out[s].rdBefore; } return out; }
    const score = (s) => (winner === null ? 0.5 : winner === s ? 1 : 0);
    const next = {};
    for (const s of humans) {
      const o = this.players[other(s)].human ? { r: out[other(s)].g.r, rd: out[other(s)].g.rd } : { r: this.opts.elo, rd: GLICKO.engineRd };
      next[s] = glicko2(out[s].g, [{ ...o, score: score(s) }]);
      out[s].after = Math.round(next[s].r); out[s].rdAfter = Math.round(next[s].rd);
    }
    for (const s of humans) store.setGlicko(this.players[s].name, { ...next[s], games: (out[s].g.games || 0) + 1 });
    return out;
  }

  // The post-game numbers for one player.
  sideNumbers(s, t0, tEnd) {
    const mine = this.moves.filter((m) => m.side === s && m.human);
    const inst = this.players[s].instant;
    const peak = mine.length ? Math.max(...mine.map((m) => m.depth)) : 0;
    const composure = mean(mine.map((m) => m.depth));
    // entry: clock start to the first time the depth holds the top band for five seconds
    let entry = null;
    for (let i = 0; i < inst.length; i++) {
      if (inst[i].depth < TOP_BAND) continue;
      const j = inst.findIndex((p, k) => k > i && p.depth < TOP_BAND);
      const until = j === -1 ? tEnd : inst[j].t;
      if (until - inst[i].t >= 5000) { entry = inst[i].t - t0; break; }
    }
    const hold = inst.length ? inst.filter((p) => p.depth >= TOP_BAND).length / inst.length : 0;
    // shocks: an eval drop of 100 cp or more from this player's view; recovery: back to the level held before it
    const pov = (cpW) => (s === "w" ? cpW : -cpW);
    const shocks = [];
    for (let i = 1; i < this.evalSeries.length; i++) {
      const drop = pov(this.evalSeries[i - 1].cpWhite) - pov(this.evalSeries[i].cpWhite);
      if (drop < 100) continue;
      const at = this.evalSeries[i].t;
      const level = mean(inst.filter((p) => p.t >= at - 10000 && p.t < at).map((p) => p.depth));
      const afterPts = inst.filter((p) => p.t >= at);
      const dipped = afterPts.some((p) => p.depth < level - 0.05);
      let recovery = 0;
      if (dipped) { const back = afterPts.find((p, k) => k > 0 && p.depth >= level - 0.05 && afterPts.slice(0, k).some((q) => q.depth < level - 0.05)); recovery = back ? back.t - at : null; }
      shocks.push({ t: at - t0, drop, recovery });
    }
    const delay = this.clock.mode === "delay";
    return {
      peak, composure, entry, hold, shocks, myMoves: mine.length,
      meanThinkMs: mine.length ? mean(mine.map((m) => m.thinkMs)) : null,
      autoCommits: mine.filter((m) => m.auto).length,
      bankUsedMs: delay ? this.clock.total - this.clock[s] : null, bankTotalMs: delay ? this.clock.total : null,
    };
  }

  summary(ratings) {
    const t0 = this.playStart ?? this.over.t, tEnd = this.over.t; const rel = (t) => t - t0;
    const players = {};
    for (const s of this.humans()) {
      const p = this.players[s];
      players[s] = { name: this.opts.duo ? p.name : "You", device: p.signal.device, baseline: p.signal.eeg ? p.signal.cal : p.model.baseline, scale: p.signal.eeg ? { busy: MUSE_DEPTH_BUSY, perSd: MUSE_DEPTH_PER_SD, fromBusy: p.signal.cal?.fromBusy, restDepth: p.signal.cal?.restDepth } : null, ratingBefore: ratings[s].before, ratingAfter: ratings[s].after, rdBefore: ratings[s].rdBefore, rdAfter: ratings[s].rdAfter, noColour: { samples: p.followN, ...p.whyCounts }, breath: p.breath ? { device: p.breath.device, baseline: p.breathModel.baseline } : null, contact: p.signal.contactReport?.() || undefined, strap: strapOf(p), ...this.sideNumbers(s, t0, tEnd) };
    }
    return {
      v: 2, id: this.id, when: new Date().toISOString(), synthetic: !!this.opts.synthetic, duo: !!this.opts.duo, engine: backend,
      tc: this.opts.tcLabel, tcSpec: this.opts.tc, oppElo: this.opts.duo ? null : this.opts.elo, humanSide: this.opts.duo ? null : this.opts.humanSide,
      winner: this.over.winner, line: this.over.line, durationMs: tEnd - t0, players,
      moves: this.moves.map((m) => ({ ...m, t: rel(m.t) })),
      evalSeries: this.evalSeries.map((e) => ({ t: rel(e.t), cpWhite: e.cpWhite })),
      instant: Object.fromEntries(SIDES.map((s) => [s, this.players[s].instant.map((p) => ({ t: rel(p.t), depth: p.depth }))])),
      pgn: this.chess.pgn(),
    };
  }
}

// The strap a player wore, for the record: its name and whether it gave beat intervals or the rate alone.
function strapOf(p) {
  const sg = p.signal.heart ? p.signal : p.breath; if (!sg) return undefined;
  return { name: sg.dev.name, intervals: !p.rateOnly };
}

// ---------------- the review screen ----------------
// Sessions saved before 22 Oct (one player, "me" and "opp") are read into the same shape.
function normalize(s) {
  if (s.v === 2) return s;
  const me = s.me || "w", opp = other(me);
  const winner = s.result === "win" ? me : s.result === "loss" ? opp : null;
  return {
    v: 2, id: s.id, when: s.when, synthetic: s.synthetic, duo: false, tc: s.tc, oppElo: s.oppElo, humanSide: me, winner, line: s.line, durationMs: s.durationMs,
    players: { [me]: { name: "You", device: s.device, ratingBefore: s.ratingBefore, ratingAfter: s.ratingAfter, peak: s.peak, composure: s.composure, entry: s.entry, hold: s.hold, shocks: s.shocks || [], meanThinkMs: null, autoCommits: 0, bankUsedMs: null, bankTotalMs: null, myMoves: (s.moves || []).filter((m) => m.by === "me").length } },
    moves: (s.moves || []).map((m) => ({ ...m, side: m.by === "me" ? me : opp, human: m.by === "me" })),
    evalSeries: s.evalSeries || [], instant: { [me]: s.instant || [], [opp]: [] }, pgn: s.pgn,
  };
}
// The mean strength of a player's moves (each move counts at its colour's strength).
const moveStrength = (m) => m.elo ?? BANDS.find((b) => b.name === m.band)?.strength ?? strengthFor(m.depth);
const moveColour = (m) => { const b = BANDS.find((x) => x.name === m.band); return !b ? depthColour(m.depth) : m.shade === undefined ? b.rgb : mixRgb(b.rgb, [255, 255, 255], SHADE_PALE[m.shade]); };
function avgStrength(s, side) { const ms = s.moves.filter((m) => m.human && m.side === side); return ms.length ? Math.round(mean(ms.map(moveStrength))) : 0; }
function sessionLabel(s, side) { return s.duo ? (s.players[side]?.name || SIDE_NAME[side]) : (s.players[side] ? "You" : "Stockfish"); }

function review(s0, game) {
  const s = normalize(s0); ui.show("review");
  const humans = SIDES.filter((side) => s.players[side]);
  const pct = (x) => `${Math.round(x * 100)}%`;
  $("review-title").textContent = s.winner === null ? "Draw" : s.duo ? `${sessionLabel(s, s.winner)} won` : (s.players[s.winner] ? "You won" : "You lost");
  const ratingText = s.synthetic ? "Synthetic session, ratings unchanged."
    : humans.map((side) => { const p = s.players[side]; return `${s.duo ? p.name : "Rating"} ${p.ratingBefore} to ${p.ratingAfter}${p.rdAfter ? ` (give or take ${p.rdAfter})` : ""}.`; }).join(" ");
  $("review-line").textContent = `${s.line} ${ratingText}${s.engine === "browser" ? " Moves came from the in-browser engine, with Stockfish's strength limiter in place of the measured bots." : ""}`;
  const card = (k, v, sub) => `<div class="num"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`;
  let html = "";
  for (const side of humans) {
    const p = s.players[side]; const cards = [
      card("Entry time", p.entry === null ? "never" : fmtS(p.entry), "clock start to the first stable purple"),
      card("Hold", pct(p.hold), "share of the game in purple"),
      card("Peak", String(strengthFor(p.peak)), ladder(p.peak).band),
      card("Average strength", String(avgStrength(s, side)), `composure ${p.composure.toFixed(2)}, mean depth over the moves`),
      card("Shocks", String(p.shocks.length), p.shocks.length ? "recovery " + p.shocks.map((k) => (k.recovery === null ? "none" : fmtS(k.recovery))).join(", ") : "no eval drop of 100 cp or more"),
    ];
    if (p.meanThinkMs !== null && p.meanThinkMs !== undefined) cards.push(card("Time per move", fmtS(p.meanThinkMs), p.autoCommits ? `${p.autoCommits} committed by the clock` : "every move pressed"));
    if (p.bankUsedMs !== null && p.bankUsedMs !== undefined) cards.push(card("Bank used", fmtClock(p.bankUsedMs), `of ${fmtClock(p.bankTotalMs)}`));
    const diff = p.ratingAfter - p.ratingBefore;
    cards.push(card("Rating", String(s.synthetic ? p.ratingBefore : p.ratingAfter), s.synthetic ? "unchanged" : `${diff >= 0 ? "+" : ""}${diff} against ${s.duo ? sessionLabel(s, other(side)) : s.oppElo}${p.rdAfter ? `, give or take ${p.rdAfter}` : ""}`));
    if (!s.duo) cards.push(card("Length", `${Math.round(s.durationMs / 1000)} s`, `${p.myMoves} of your moves`));
    if (p.contact?.windows) cards.push(card("Contact", `${p.contact.bothEars}%`, `both ears reading; ${Object.entries(p.contact.contact).map(([k, v]) => `${k} ${v === null ? "none" : v + "%"}`).join(", ")}`));
    if (p.strap) cards.push(card("Strap", p.strap.intervals ? "beat intervals" : "heart rate only", p.strap.intervals ? `${p.strap.name}: rate and variability` : `${p.strap.name}: no beat intervals, variability unavailable`));
    html += `${s.duo ? `<h3 class="group">${esc(p.name)}, ${SIDE_NAME[side]}</h3>` : ""}<div class="numbers">${cards.join("")}</div>`;
  }
  if (s.duo) html += `<h3 class="group">Game</h3><div class="numbers">${card("Length", `${Math.round(s.durationMs / 60000)} min`, `${Math.ceil(s.moves.length / 2)} move${Math.ceil(s.moves.length / 2) === 1 ? "" : "s"}`)}${card("Time control", s.tc || "", "")}</div>`;
  $("numbers").innerHTML = html;
  $("move-list").innerHTML = s.moves.map((m) => {
    const head = `<span class="n">${Math.ceil(m.ply / 2)}${m.ply % 2 ? "." : "..."}</span><span class="san">${esc(m.san)}</span>`;
    if (!m.human) return `<div class="mv">${head}<span class="l">Stockfish</span></div>`;
    const col = rgb(moveColour(m));
    const detail = m.forced ? "forced" : `${BANDS.some((b) => b.name === m.band) ? m.band : ladder(m.depth).band}, loss ${m.loss} cp`;
    const time = m.thinkMs !== undefined ? `, ${fmtS(m.thinkMs)}${m.auto ? " (clock)" : ""}` : "";
    return `<div class="mv">${head}<span class="d" style="color:${col}">${moveStrength(m)}</span><span class="l">${s.duo ? esc(sessionLabel(s, m.side)) + ", " : ""}${detail}${time}</span></div>`;
  }).join("");
  $("legend").innerHTML = s.duo
    ? `<span class="sw depth"></span>White's depth <span class="sw depth dashed"></span>Black's depth <span class="sw eval"></span>eval for White <span class="sw shock"></span>shock <span class="dim">line colour is the state</span>`
    : `<span class="sw depth"></span>depth <span class="sw eval"></span>eval for you <span class="sw shock"></span>shock <span class="dim">line colour is the state</span>`;
  drawTrace($("trace"), s);
  if (game) { try { game.board?.destroy(); } catch {} game.board = null; }
}

function drawTrace(canvas, s) {
  const ctx = canvas.getContext("2d"); const W = canvas.width, H = canvas.height; const L = 44, R = 44, Tp = 18, Bm = 30;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#1f2024"; ctx.fillRect(0, 0, W, H);
  const dur = Math.max(1000, s.durationMs); const x = (t) => L + (clamp(t, 0, dur) / dur) * (W - L - R);
  const yDepth = (d) => Tp + (1 - clamp(d, 0, 1)) * (H - Tp - Bm);
  const yEval = (cp) => Tp + (1 - (clamp(cp, -500, 500) + 500) / 1000) * (H - Tp - Bm);
  const evalSide = s.duo ? "w" : s.humanSide || "w";
  const pov = (cpW) => (evalSide === "w" ? cpW : -cpW);
  // bands
  for (const b of BANDS) { const c = b.rgb; ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},.06)`; ctx.fillRect(L, yDepth(b.to), W - L - R, yDepth(b.from) - yDepth(b.to)); }
  ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = 1;
  for (const b of BANDS.slice(0, -1)) { const d = b.to; ctx.beginPath(); ctx.moveTo(L, yDepth(d)); ctx.lineTo(W - R, yDepth(d)); ctx.stroke(); }
  ctx.fillStyle = "#7d828c"; ctx.font = "11px Segoe UI, system-ui, sans-serif"; ctx.textAlign = "right";
  for (const b of BANDS) ctx.fillText(String(b.strength), L - 6, yDepth((b.from + b.to) / 2) + 4);
  ctx.textAlign = "left";
  for (const [cp, lab] of [[500, "+5"], [0, "0"], [-500, "-5"]]) ctx.fillText(lab, W - R + 6, yEval(cp) + 4);
  ctx.textAlign = "center";
  const step = dur > 1200000 ? 120000 : dur > 300000 ? 60000 : dur > 120000 ? 30000 : 10000;
  for (let t = 0; t <= dur; t += step) ctx.fillText(t >= 60000 ? `${Math.round(t / 60000)}m` : `${Math.round(t / 1000)}s`, x(t), H - 10);
  // shocks
  ctx.setLineDash([3, 4]);
  for (const side of SIDES) for (const k of s.players[side]?.shocks || []) {
    ctx.strokeStyle = "rgba(230,230,230,.55)"; ctx.beginPath(); ctx.moveTo(x(k.t), Tp); ctx.lineTo(x(k.t), H - Bm); ctx.stroke();
    if (k.recovery) { ctx.fillStyle = "rgba(255,255,255,.05)"; ctx.fillRect(x(k.t), Tp, x(k.t + k.recovery) - x(k.t), H - Tp - Bm); }
  }
  ctx.setLineDash([]);
  // eval, stepped
  if (s.evalSeries.length) {
    ctx.strokeStyle = "#8f95a0"; ctx.lineWidth = 1.5; ctx.beginPath();
    s.evalSeries.forEach((e, i) => { const X = x(e.t), Y = yEval(pov(e.cpWhite)); if (i === 0) ctx.moveTo(X, Y); else { ctx.lineTo(X, yEval(pov(s.evalSeries[i - 1].cpWhite))); ctx.lineTo(X, Y); } });
    ctx.lineTo(x(dur), yEval(pov(s.evalSeries[s.evalSeries.length - 1].cpWhite))); ctx.stroke();
  }
  // depth, each segment in the colour of its state; Black dashed when two play
  for (const side of SIDES) {
    const pts = s.instant?.[side] || []; if (!s.players[side] || pts.length < 2) continue;
    ctx.lineWidth = 2; ctx.setLineDash(side === "b" && s.duo ? [6, 4] : []);
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = rgb(depthColour((pts[i - 1].depth + pts[i].depth) / 2));
      ctx.beginPath(); ctx.moveTo(x(pts[i - 1].t), yDepth(pts[i - 1].depth)); ctx.lineTo(x(pts[i].t), yDepth(pts[i].depth)); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // each move's committed depth
  for (const m of s.moves) if (m.human) {
    ctx.fillStyle = rgb(moveColour(m)); ctx.strokeStyle = "#16171a"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x(m.t), yDepth(m.depth), 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

// ---------------- history ----------------
function showHistory() {
  ui.show("history");
  const all = store.sessions().map(normalize);
  $("history-list").innerHTML = all.length ? all.map((s, i) => {
    const humans = SIDES.filter((side) => s.players[side]);
    const result = s.winner === null ? "draw" : s.duo ? `${sessionLabel(s, s.winner)} won` : (s.players[s.winner] ? "win" : "loss");
    const who = s.duo ? `${humans.map((h) => s.players[h].name).join(" v ")}: ${result}` : `${result} vs ${s.oppElo}`;
    const peaks = humans.map((h) => `peak ${strengthFor(s.players[h].peak)}, average ${avgStrength(s, h)}`).join("; ");
    return `<div class="hist"><span>${new Date(s.when).toLocaleString()}</span><span>${esc(who)}, ${peaks}${s.synthetic ? " <span class=dim>(synthetic)</span>" : ""}</span><button class="secondary small" data-i="${i}">Open</button></div>`;
  }).join("") : `<p class="dim">No sessions yet.</p>`;
  $("history-list").querySelectorAll("button").forEach((b) => (b.onclick = () => review(all[Number(b.dataset.i)], null)));
}

// ---------------- wiring ----------------
let game = null;
function buildSliders(sides, names, duo) {
  const panel = $("signal-panel"); panel.innerHTML = ""; panel.hidden = !sides.length;
  const out = {};
  for (const s of sides) {
    const row = document.createElement("div"); row.className = "srow";
    const lab = document.createElement("label"); lab.textContent = duo ? `${names[s]} (${s === "w" ? "A" : "L"})` : "Signal";
    const input = document.createElement("input"); input.type = "range"; input.min = "0"; input.max = "1000"; input.value = "500"; input.id = `slider-${s}`;
    lab.htmlFor = input.id; row.append(lab, input); panel.append(row); out[s] = input;
  }
  if (sides.length) { const note = document.createElement("span"); note.className = "dim note"; note.textContent = "Middle is your normal. Right is full strength, left is stirred. Esc twice resigns."; panel.append(note); }
  return out;
}
function readOpts(synthetic) {
  const [mode, a, b] = $("s-tc").value.split(":");
  const tc = mode === "delay" ? { mode, window: Number(a) * 1000, bank: Number(b) * 1000 } : { mode, main: Number(a) * 1000, inc: Number(b) * 1000 };
  const oppVal = $("s-opp").value; const duo = oppVal === "human";
  const colour = $("s-colour").value;
  const humanSide = duo ? null : colour === "r" ? (Math.random() < 0.5 ? "w" : "b") : colour;
  const sides = duo ? SIDES : [humanSide];
  const names = { w: "", b: "" };
  if (duo) { names.w = $("s-name-w").value.trim() || "White"; names.b = $("s-name-b").value.trim() || "Black"; }
  else names[humanSide] = $("s-name").value.trim() || "You";
  const kind = synthetic ? "synthetic" : $("s-signal").value;
  const sliders = buildSliders(kind === "slider" ? sides : [], names, duo);
  const signals = { w: null, b: null };
  const strapFor = (s) => {
    const slot = duo ? s : "w", test = kind.includes("h10-test");
    if (!straps[slot] && test) { straps[slot] = new FakeHeartStrap(); attachBeats(straps[slot]); straps[slot].start(); }
    if (!straps[slot]) return { error: duo ? `Connect ${SIDE_NAME[slot]}'s chest strap first.` : "Connect the chest strap first." };
    return new HeartSignal(straps[slot]);
  };
  const headbandFor = (s) => {
    const slot = duo ? s : "w", test = kind.includes("muse-test");
    if (!headbands[slot] && test) { headbands[slot] = new FakeMuse(); headbands[slot].start(); }
    if (!headbands[slot]) return { error: duo ? `Connect ${SIDE_NAME[slot]}'s headband first.` : "Connect the headband first." };
    return new MuseSignal(headbands[slot]);
  };
  for (const s of sides) {
    if (kind === "h10" || kind === "h10-test") {
      const sig = strapFor(s); if (sig.error) return sig; signals[s] = sig;
    } else if (kind === "muse" || kind === "muse-test") {
      const sig = headbandFor(s); if (sig.error) return sig; signals[s] = sig;
    } else if (kind.includes("+")) {                   // headband for the colour, strap for the shade
      const hb = headbandFor(s); if (hb.error) return hb;
      const st = strapFor(s); if (st.error) return st;
      hb.breath = st; signals[s] = hb;
    } else signals[s] = kind === "synthetic" ? new SyntheticSignal() : kind === "wander" ? new WanderSignal() : new SliderSignal(sliders[s]);
  }
  const elo = duo ? null : oppVal === "auto" ? nearestElo(store.glicko(names[humanSide]).r) : Number(oppVal);
  return { tc, tcLabel: $("s-tc").selectedOptions[0].textContent, duo, elo, humanSide, names, signals, baselineS: Number($("s-baseline").value), synthetic };
}
async function startGame(synthetic) {
  if (game && !game.over) return;
  try { game?.board?.destroy(); } catch {}
  $("board").innerHTML = ""; $("saved-note").textContent = "";
  for (const slot of SIDES) stopMonitor(slot);     // the game's own signal reads the headband from here
  if (backend === null) await probe.catch(() => {});   // which engine answers, before the first move is asked for
  const opts = readOpts(synthetic);
  if (opts.error) { setupMsg(opts.error); syncSetup(); return; }
  setupMsg("");
  T.setSpeed(synthetic ? 10 : 1);
  const g = game = new Game(opts);
  if (synthetic) {
    // a presser per player: mostly within the free window, sometimes past it, so the bank gets used
    const presser = async () => {
      while (!g.over && game === g) {
        await T.sleep(400);
        const side = g.chess.turn();
        if (g.state !== "play" || g.busy || !g.players[side].human) continue;
        const turn = g.turnStart; const r = Math.random();
        const wait = r < 0.7 ? 3000 + Math.random() * 12000 : r < 0.9 ? 15000 + Math.random() * 15000 : 30000 + Math.random() * 25000;
        await T.sleep(wait);
        if (g.turnStart === turn) g.press(side);
      }
    };
    presser();
  }
  await g.start();
}
document.addEventListener("keydown", (e) => {
  if (!game || game.state !== "play" || e.repeat) return;
  if (e.target?.tagName === "INPUT" && e.target.type === "text") return;
  if (e.key === "Enter") { e.preventDefault(); game.press(game.chess.turn()); return; }
  for (const s of SIDES) if (KEYS[s].includes(e.code)) { e.preventDefault(); game.press(game.opts.duo ? s : game.opts.humanSide); return; }
  if (e.key === "Escape") game.onEscape();
});
// Headbands and chest straps stay connected between games: one for solo play, one per player at the table.
const headbands = { w: null, b: null }, straps = { w: null, b: null }, connecting = { w: false, b: false };
const isStrap = (sig) => sig === "h10" || sig === "h10-test";
const isPaired = (sig) => sig.includes("+");          // headband and strap together: the strap has its own row
const strapStatus = (slot) => $(isPaired($("s-signal").value) ? `st-${slot}` : `hb-${slot}`);
function setupMsg(t) { $("setup-msg").textContent = t; $("setup-msg").hidden = !t; }
async function connectStrap(slot) {
  const test = $("s-signal").value.includes("h10-test");
  if (!test && !HeartStrap.available()) { setupMsg("This browser has no Bluetooth access. Open the page in Chrome or Edge."); return; }
  const old = straps[slot]; if (old) { straps[slot] = null; old.disconnect(); }
  const dev = test ? new FakeHeartStrap() : new HeartStrap();
  connecting[slot] = true; strapStatus(slot).textContent = "Connecting..."; strapStatus(slot).classList.remove("ok");
  try {
    attachBeats(dev); await dev.connect(); dev.start();
    dev.onDisconnect = () => { if (straps[slot] === dev) { straps[slot] = null; syncSetup(); } };
    straps[slot] = dev; setupMsg("");
  } catch (e) { setupMsg(`Could not connect: ${e.message || e}`); }
  connecting[slot] = false; syncSetup();
}
async function connectHeadband(slot) {
  if (isStrap($("s-signal").value)) return connectStrap(slot);
  const test = $("s-signal").value.includes("muse-test");
  if (!test && !MuseDevice.available()) { setupMsg("This browser has no Bluetooth access. Open the page in Chrome or Edge."); return; }
  const old = headbands[slot]; if (old) { headbands[slot] = null; try { await old.stop(); } catch {} old.disconnect(); }
  const dev = test ? new FakeMuse() : new MuseDevice();
  connecting[slot] = true; $(`hb-${slot}`).textContent = "Connecting..."; $(`hb-${slot}`).classList.remove("ok");
  try {
    await dev.connect(); await dev.start();
    dev.onDisconnect = () => { if (headbands[slot] !== dev) return; headbands[slot] = null; syncSetup(); recoverHeadband(slot, dev); };
    headbands[slot] = dev; setupMsg("");
  } catch (e) { setupMsg(`Could not connect: ${e.message || e}`); }
  connecting[slot] = false; syncSetup();
}
// Contact lights on the setup screen (Kit, 1 Nov: "how many greens before the game starts"): while a headband is
// connected and no game runs, a processor of its own reads it and four dots show each channel's contact (green from
// 80%, amber from 40%, red below; grey until the first 5 s window). The game's own signal takes the stream over
// when a game starts, and the lights come back on the setup screen afterwards.
const monitors = { w: null, b: null };
const dotsFor = (w) => NAMES.map((n, c) => { const v = w ? w.contact[c] : null; return `<span class="dot ${v === null ? "" : v >= 0.8 ? "good" : v >= 0.4 ? "part" : "bad"}" title="${n}${v === null ? "" : ` ${Math.round(100 * v)}%`}"></span>`; }).join("");
function monitorHeadband(slot) {
  stopMonitor(slot); const dev = headbands[slot]; if (!dev) { $(`ct-${slot}`).innerHTML = ""; return; }
  const proc = new EegProcessor(); dev.onEeg = (c, i, s) => proc.pushEeg(c, i, s); dev.onAccel = (s) => proc.pushAccel(s);
  $(`ct-${slot}`).innerHTML = dotsFor(null);
  const timer = setInterval(() => { proc.process(); $(`ct-${slot}`).innerHTML = dotsFor(proc.windows[proc.windows.length - 1]); }, 500);
  monitors[slot] = { proc, timer };
}
function stopMonitor(slot) { if (monitors[slot]) { clearInterval(monitors[slot].timer); monitors[slot] = null; } }
// A headband that drops is taken back without the chooser (29 Oct: a drop mid-game lost the game). While a game
// runs it keeps trying, every few seconds, until the headband answers or the game ends; otherwise three tries.
// The game's signal keeps the same device object, so its calibration and callbacks survive the drop.
async function recoverHeadband(slot, dev) {
  if (!dev.reconnect) return;
  const live = () => game && !game.over && game.state !== "over";
  for (let attempt = 1; (live() || attempt <= 3) && headbands[slot] === null; attempt++) {
    if (live() && game.state === "play") $("hint").textContent = "The headband dropped. Reconnecting...";
    try {
      await dev.reconnect();
      headbands[slot] = dev; syncSetup();
      if (live() && game.state === "play") $("hint").textContent = game.defaultHint;
      return;
    } catch { await new Promise((r) => setTimeout(r, 4000)); }
  }
}
function syncSetup() {
  const duo = $("s-opp").value === "human", sig = $("s-signal").value, strap = isStrap(sig), paired = isPaired(sig), hb = strap || paired || sig === "muse" || sig === "muse-test";
  $("screen-setup").dataset.mode = duo ? "duo" : "solo";
  const me = store.glicko($("s-name").value.trim() || "You");
  $("setup-rating").textContent = Math.round(me.r); $("setup-rd").textContent = ` give or take ${Math.round(me.rd)}`;
  $("setup-next").textContent = $("s-opp").value === "auto" ? `Next opponent: Stockfish ${nearestElo(me.r)}.` : "";
  $("hb-row").hidden = !hb; $("st-row").hidden = !paired;
  const what = strap ? "chest strap" : "headband";
  $("btn-hb-w").textContent = duo ? `Connect White's ${what}` : `Connect ${what}`;
  $("btn-hb-b").textContent = `Connect Black's ${what}`;
  $("btn-st-w").textContent = duo ? "Connect White's chest strap" : "Connect chest strap";
  const status = (el, d) => { el.textContent = d ? `Connected: ${d.name}` : "Not connected"; el.classList.toggle("ok", !!d); };
  for (const slot of SIDES) {
    if (connecting[slot]) continue;
    status($(`hb-${slot}`), (strap ? straps : headbands)[slot]);
    if (paired) status($(`st-${slot}`), straps[slot]);
    const live = game && !game.over;                // the lights run only between games
    if (!strap && headbands[slot] && !monitors[slot] && !live) monitorHeadband(slot);
    if ((!headbands[slot] || strap) && monitors[slot]) { stopMonitor(slot); $(`ct-${slot}`).innerHTML = ""; }
  }
}
// the signal and the name survive a reload (29 Oct: a reload sent two headband games back to the wandering default)
const KEEP = { "s-signal": "stillmate.signal", "s-name": "stillmate.name" };
for (const [id, key] of Object.entries(KEEP)) {
  try { const v = localStorage.getItem(key); if (v && (id !== "s-signal" || [...$(id).options].some((o) => o.value === v))) $(id).value = v; } catch {}
  $(id).addEventListener("change", () => { try { localStorage.setItem(key, $(id).value); } catch {} });
}
$("s-opp").onchange = syncSetup; $("s-name").oninput = syncSetup; $("s-signal").onchange = syncSetup;
$("btn-hb-w").onclick = () => connectHeadband("w");
$("btn-hb-b").onclick = () => connectHeadband("b");
$("btn-st-w").onclick = () => connectStrap("w");
$("btn-st-b").onclick = () => connectStrap("b");
$("btn-sit").onclick = () => startGame(false);
$("btn-synthetic").onclick = () => startGame(true);
$("btn-again").onclick = () => startGame(false);
$("btn-again-synthetic").onclick = () => startGame(true);
$("btn-setup").onclick = () => { ui.show("setup"); syncSetup(); };
$("btn-history").onclick = showHistory;
$("btn-history-back").onclick = () => ui.show("setup");
syncSetup();
// for checking in the console
window.stillmate = { get game() { return game; }, get backend() { return backend; }, local, T, store, ladder, chooseMove, depthColour, strengthFor, WanderSignal, DepthModel, channelsFrom, BANDS, SHADES, shadeOf, shadeFromBreath, headbands, straps };
