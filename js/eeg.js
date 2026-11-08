// EEG processing for a four-channel Muse: Welch spectra on 1 s segments, the gates and the mind index of
// reports/EEG markers of meditative depth for Stillmate.md, section 6. Every constant below names its source there;
// "engineering choice" marks the ones no paper derived. The game and the check page both use this module.

export const FS = 256;                 // samples per second
export const SEG = 256;                // 1 s segments ...
export const STEP = 128;               // ... at 50 percent overlap
export const WIN_SEGS = 9;             // a 5 s read window holds nine segments (Cannard 2021; design section 9)
export const NAMES = ["TP9", "AF7", "AF8", "TP10"];
const TP = [0, 3], AF = [1, 2];
export const GATE = {
  FLAT_UV: 0.5,                        // G1 stuck channel (one LSB is 0.488 µV)
  AMP_UV: 100,                         // G1 amplitude (Krigolson 2017)
  DEV_Z: 5,                            // G1 robust z against the player's baseline (PREP)
  BLINK_UV: 70, BLINK_MIN_MS: 50,      // G2 blink (MED 2022; BLINKER 2017)
  BLINK_MASK_MS: 400,                  // G2 mask centred on the blink peak
  BLINK_REFRACTORY_MS: 300,            // engineering choice: one blink is never counted twice
  BLINK_EDGE: 0.1,                     // engineering choice: blink length runs between the 10 percent points of its height
  DROWSY_TA_S: 10,                     // engineering choice: the theta vote averages the last 10 s of valid windows
  DROWSY_SLOPE_S: 20,                  // engineering choice: the slope vote averages the last 20 s, single windows are noisy
  EMG_RISE: Math.log10(3),             // G3 three-fold rise over baseline in 30 to 45 Hz (Goncharova 2003, starting point)
  MIN_VALID: 5,                        // a window needs five of its nine segments (engineering choice)
  SIGMA_FLOOR: 0.1,                    // floor on a baseline SD in log10 units, for the index and the theta vote (engineering choice;
                                       // overlapping baseline windows understate the spread)
  MOTION_SHIFT_G: 0.05, MOTION_SD_G: 0.02, // head movement from the accelerometer (engineering choice)
  DROWSY_TA_Z: 2, DROWSY_BLINK_MS: 500, DROWSY_SLOPE: 0.5,  // G5 votes (Minhas 2024; PMC4418540; Kozhemiako 2022)
  CLOSED_MIN_RISE: Math.log10(1.5),    // G4 uses an ear channel only if its calibrated eyes-closed rise is 1.5-fold or more
  CLOSED_SHARE: 0.75,                  // G4 alpha must sit three quarters of the way to the eyes-closed level ...
  CLOSED_SHARE_BLIND: 0.9,             // ... nine tenths when the forehead has shown no blink for 60 s (blinks unseen)
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const sdOf = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const median = (xs) => { if (!xs.length) return NaN; const s = Float64Array.from(xs).sort(); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

// ---------------- filters ----------------
// Biquads from the RBJ audio cookbook, transposed direct form II. A missing sample resets the filter.
class Biquad {
  constructor(type, f0, q = Math.SQRT1_2, fs = FS) {
    const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    if (type === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
    else if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
    else { b0 = 1; b1 = -2 * cw; b2 = 1; }          // notch
    Object.assign(this, { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0, z2: 0 });
  }
  step(x) {
    if (!Number.isFinite(x)) { this.z1 = this.z2 = 0; return NaN; }
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
class Ring {
  constructor(cap) { this.buf = new Float64Array(cap); this.cap = cap; this.n = 0; }
  push(v) { this.buf[this.n % this.cap] = v; this.n++; }
  get(i) { return i < this.n - this.cap || i >= this.n || i < 0 ? NaN : this.buf[i % this.cap]; }
  slice(a, b) { const out = new Float64Array(b - a); for (let i = a; i < b; i++) out[i - a] = this.get(i); return out; }
}

// ---------------- spectra ----------------
const HAM = Float64Array.from({ length: SEG }, (_, i) => 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (SEG - 1)));
const U = HAM.reduce((a, w) => a + w * w, 0);
const LOG2 = Math.log2(SEG);
const REV = Uint16Array.from({ length: SEG }, (_, i) => { let r = 0; for (let b = 0; b < LOG2; b++) r |= ((i >> b) & 1) << (LOG2 - 1 - b); return r; });
const COS = Float64Array.from({ length: SEG / 2 }, (_, k) => Math.cos(2 * Math.PI * k / SEG));
const SIN = Float64Array.from({ length: SEG / 2 }, (_, k) => -Math.sin(2 * Math.PI * k / SEG));
// One-sided power spectral density of a 1 s segment in µV²/Hz with 1 Hz bins: linear detrend, Hamming window, FFT.
export function psdOf(x) {
  const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[REV[i]] = (x[i] - icpt - slope * i) * HAM[i];
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, step = n / size;
    for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
      const wr = COS[k * step], wi = SIN[k * step], a = s + k, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) / (FS * U) * (k > 0 && k < n / 2 ? 2 : 1);
  return out;
}
const bandMean = (p, lo, hi, loIncl = true, hiIncl = true) => {
  let s = 0, m = 0;
  for (let k = Math.max(1, Math.floor(lo)); k <= Math.min(p.length - 1, Math.ceil(hi)); k++) {
    if ((loIncl ? k >= lo : k > lo) && (hiIncl ? k <= hi : k < hi)) { s += p[k]; m++; }
  }
  return m ? s / m : NaN;
};
const avgPsd = (list) => { if (!list.length) return null; const out = new Float64Array(list[0].length); for (const p of list) for (let k = 0; k < p.length; k++) out[k] += p[k] / list.length; return out; };
// Least-squares slope of log10 power against log10 frequency over 30 to 45 Hz (the aperiodic slope, G5 vote d).
const slopeOf = (p) => { const xs = [], ys = []; for (let k = 30; k <= 45; k++) { xs.push(Math.log10(k)); ys.push(Math.log10(p[k])); } const mx = mean(xs), my = mean(ys); let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; }); return num / den; };

// ---------------- the processor ----------------
export class EegProcessor {
  constructor() {
    this.cap = FS * 60;
    this.raw = NAMES.map(() => new Ring(this.cap));
    this.clean = NAMES.map(() => new Ring(this.cap));
    this.eyeSlow = AF.map(() => new Ring(this.cap));
    this.cleanF = NAMES.map(() => [new Biquad("highpass", 1), new Biquad("notch", 50, 10), new Biquad("lowpass", 45)]);
    this.eyeSlowF = AF.map(() => [new Biquad("highpass", 0.1), new Biquad("lowpass", 20)]);
    this.lastIndex = [null, null, null, null]; this.lostPackets = [0, 0, 0, 0];
    this.accel = []; this.accelCount = 0;
    this.nextSeg = 0; this.scanPos = 0; this.run = null; this.refractoryUntil = -1;
    this.blinks = []; this.pending = []; this.eyeUse = AF.map(() => true);
    this.segs = []; this.windows = [];
    this.iaf = 10; this.base = null; this.closed = null;
  }
  // stream time in seconds: the shortest channel decides
  time() { return Math.min(...this.raw.map((r) => r.n)) / FS; }

  pushEeg(c, index, samples) {
    const last = this.lastIndex[c];
    if (last !== null) {
      const gap = (index - last + 65536) % 65536;
      if (gap > 1 && gap < 200) { for (let g = 0; g < (gap - 1) * samples.length; g++) this._push(c, NaN); this.lostPackets[c] += gap - 1; }
    }
    this.lastIndex[c] = index;
    for (const v of samples) this._push(c, v);
  }
  _push(c, v) {
    this.raw[c].push(v);
    let y = v; for (const f of this.cleanF[c]) y = f.step(y); this.clean[c].push(y);
    const a = AF.indexOf(c);
    if (a >= 0) {
      let q = v; for (const f of this.eyeSlowF[a]) q = f.step(q); this.eyeSlow[a].push(q);
    }
  }
  pushAccel(samples) {
    for (const s of samples) this.accel.push({ t: this.accelCount++ / 52, x: s.x, y: s.y, z: s.z });
    if (this.accel.length > 52 * 60) this.accel.splice(0, this.accel.length - 52 * 60);
  }

  // Call a few times a second. Returns the new read windows.
  process() {
    const n = Math.min(...this.raw.map((r) => r.n));
    this._scanBlinks(Math.min(this.eyeSlow[0].n, this.eyeSlow[1].n));
    const lag = 80;                              // segments wait 0.3 s so a blink at their edge is already found
    const made = [];
    while (this.nextSeg + SEG <= Math.min(n, this.scanPos) - lag) {
      if (this.nextSeg < n - this.cap + SEG) this.nextSeg = Math.ceil((n - this.cap + SEG) / STEP) * STEP;
      this.segs.push(this._segment(this.nextSeg));
      if (this.segs.length > 2 * 60 * 5) this.segs.shift();
      this.nextSeg += STEP;
      const w = this._window(); if (w) { this._updateEyeUse(); this.windows.push(w); made.push(w); if (this.windows.length > 2 * 60 * 5) this.windows.shift(); }
    }
    return made;
  }

  // G2: blinks on the mean of AF7 and AF8 (saccades cancel in the mean, blinks add up), filtered 0.1 to 20 Hz.
  // A blink is a deflection of 70 µV or more from the running mean (MED 2022) lasting 50 ms (BLINKER 2017). The running
  // mean follows the signal with a 1 s time constant and pauses during a deflection, so slow, drowsy blinks keep their shape.
  // A front sensor with poor contact drops out of the mean (below 40% clean, back at 80%), so one bad sensor neither
  // halves the blinks nor drowns them in noise (Kit's AF7, 26 Oct). With both poor, both stay in.
  _slowAt(i) {
    const use = AF.map((_, a) => a).filter((a) => this.eyeUse[a]), pick = use.length ? use : [0, 1];
    return pick.reduce((sum, a) => sum + this.eyeSlow[a].get(i), 0) / pick.length;
  }
  _updateEyeUse() {
    // judged between blinks, since a firm blink passes the contact gate's 100 µV on a good sensor too
    const segs = this.segs.slice(-WIN_SEGS).filter((s) => !s.blink && !s.ch.some((ch) => ch.loss));
    if (segs.length < WIN_SEGS / 2) return;
    const next = AF.map((c, a) => { const k = segs.filter((s) => s.ch[c].contact).length / segs.length; return this.eyeUse[a] ? k >= 0.4 : k >= 0.8; });
    if (next.some((u, a) => u !== this.eyeUse[a])) { this.eyeUse = next; this.ema = undefined; this.run = null; }
  }
  _scanBlinks(upto) {
    const minLen = Math.round(GATE.BLINK_MIN_MS * FS / 1000), refr = Math.round(GATE.BLINK_REFRACTORY_MS * FS / 1000), k = 1 / FS;
    for (let i = this.scanPos; i < upto; i++) {
      const e = this._slowAt(i);
      if (!Number.isFinite(e)) { this.run = null; continue; }
      if (this.ema === undefined) this.ema = e;
      const d = e - this.ema;
      if (Math.abs(d) >= GATE.BLINK_UV) {
        // a deflection held over 2 s is drift or a lost sensor, never a blink: follow it again
        if (this.run && i - this.run.start > 2 * FS) { this.run = null; this.ema = e; this.refractoryUntil = i + refr; continue; }
        if (!this.run) this.run = { start: i, peak: i, val: Math.abs(d), sign: Math.sign(d), level: this.ema };
        else if (Math.sign(d) === this.run.sign && Math.abs(d) > this.run.val) { this.run.peak = i; this.run.val = Math.abs(d); }
      } else {
        this.ema += k * d;
        if (this.run) {
          const r = this.run; this.run = null;
          if (i - r.start >= minLen && r.start >= this.refractoryUntil) {
            const b = { start: r.start, end: i, peak: r.peak, t: r.peak / FS, amp: r.val, sign: r.sign, level: r.level, durMs: null };
            this.blinks.push(b); this.pending.push(b);
          }
          this.refractoryUntil = i + refr;
        }
      }
    }
    this.scanPos = upto;
    // length: between the 10 percent points of the blink's height above the running mean where it began
    this.pending = this.pending.filter((b) => {
      if (upto < b.peak + 1.5 * FS) return true;
      const edge = GATE.BLINK_EDGE * b.amp, rel = (i) => b.sign * (this._slowAt(i) - b.level);
      let a = b.peak; while (a > b.peak - 1.5 * FS && rel(a) >= edge) a--;
      let z = b.peak; while (z < b.peak + 1.5 * FS && rel(z) >= edge) z++;
      b.durMs = (z - a) * 1000 / FS;
      return false;
    });
    if (this.blinks.length > 400) this.blinks.splice(0, this.blinks.length - 400);
  }
  // The mask covers the whole deflection, and at least 400 ms centred on the peak.
  _masked(s0, s1) {
    const half = Math.round(GATE.BLINK_MASK_MS * FS / 2000);
    return this.blinks.some((b) => Math.max(b.end, b.peak + half) >= s0 && Math.min(b.start, b.peak - half) < s1) || (this.run && this.run.start < s1);
  }
  _motion(t0, t1) {
    const inSeg = this.accel.filter((a) => a.t >= t0 && a.t < t1), before = this.accel.filter((a) => a.t >= t0 - 1 && a.t < t0);
    if (inSeg.length < 10) return false;
    const m = (arr, k) => mean(arr.map((a) => a[k]));
    const shift = before.length >= 10 ? Math.hypot(m(inSeg, "x") - m(before, "x"), m(inSeg, "y") - m(before, "y"), m(inSeg, "z") - m(before, "z")) : 0;
    const sd = Math.max(sdOf(inSeg.map((a) => a.x)), sdOf(inSeg.map((a) => a.y)), sdOf(inSeg.map((a) => a.z)));
    return shift > GATE.MOTION_SHIFT_G || sd > GATE.MOTION_SD_G;
  }

  _segment(s0) {
    const blink = this._masked(s0, s0 + SEG), motion = this._motion(s0 / FS, (s0 + SEG) / FS), b = this.base;
    const ch = NAMES.map((_, c) => {
      const raw = this.raw[c].slice(s0, s0 + SEG), clean = this.clean[c].slice(s0, s0 + SEG);
      if (raw.some((v) => !Number.isFinite(v)) || clean.some((v) => !Number.isFinite(v))) return { loss: true, ok: false };
      const sd = sdOf(clean), med = median(clean);
      let maxDev = 0; for (const v of clean) maxDev = Math.max(maxDev, Math.abs(v - med));
      const psd = psdOf(raw), emgLog = Math.log10(bandMean(psd, 30, 45));
      const flat = sd < GATE.FLAT_UV, amp = maxDev > GATE.AMP_UV;
      const dev = !!(b && b.sdMad[c] > 0 && (sd - b.sdMed[c]) / (1.4826 * b.sdMad[c]) > GATE.DEV_Z);
      const emg = !!(b && Number.isFinite(b.emg[c]) && emgLog - b.emg[c] > GATE.EMG_RISE);
      const contact = !(flat || amp || dev);
      return { loss: false, sd, maxDev, psd, emgLog, flat, amp, dev, emg, contact, ok: contact && !emg && !blink && !motion };
    });
    return { s0, t: (s0 + SEG) / FS, blink, motion, ch };
  }

  // Band edges from the individual alpha frequency (Klimesch 1999); beta capped at 20 Hz below the temporalis peak.
  bands(p) {
    const f = this.iaf;
    return { theta: Math.log10(bandMean(p, f - 6, f - 2, true, false)), alpha: Math.log10(bandMean(p, f - 2, f + 2)), beta: Math.log10(bandMean(p, f + 2, 20, false, true)) };
  }

  _window() {
    const segs = this.segs.slice(-WIN_SEGS); if (segs.length < WIN_SEGS) return null;
    const t = segs[segs.length - 1].t, t0 = t - 5;
    const w = { t, psd: [], psdAll: [], validSegs: [], contact: [], m: null, mind: null };
    const mc = [], ta = [], sl = [];
    NAMES.forEach((_, c) => {
      const good = segs.filter((s) => s.ch[c].ok), any = segs.filter((s) => !s.ch[c].loss);
      w.validSegs[c] = good.length;
      const open = segs.filter((s) => !s.blink);       // contact is judged between blinks; blinks are expected on the forehead
      w.contact[c] = open.length ? open.filter((s) => s.ch[c].contact).length / open.length : null;
      w.psdAll[c] = any.length >= GATE.MIN_VALID ? avgPsd(any.map((s) => s.ch[c].psd)) : null;
      w.psd[c] = good.length >= GATE.MIN_VALID ? avgPsd(good.map((s) => s.ch[c].psd)) : null;
      if (TP.includes(c) && w.psd[c]) { const bd = this.bands(w.psd[c]); mc.push(bd.alpha - bd.beta); ta.push(bd.theta - bd.alpha); sl.push(slopeOf(w.psd[c])); }
    });
    w.valid = mc.length > 0;
    if (w.valid) { w.m = mean(mc); w.ta = mean(ta); w.slope = mean(sl); }
    const b = this.base;
    if (w.valid && b && Number.isFinite(b.mu)) w.mind = clamp((w.m - b.mu) / Math.max(b.sigma, GATE.SIGMA_FLOOR), -3, 3);
    // G4: eyes closed when alpha at the ear channels sits three quarters of the way to the player's eyes-closed level,
    // with no blink for 5 s. Stricter from 27 Oct: Kit's first sessions flagged a third of eyes-open readings, since
    // relaxed eyes-open alpha crossed the old half-way line, the forehead channels (noisy) took part, and unseen blinks
    // left "no blink" always true. Now only ear channels with a clear calibrated rise count, and when the forehead has
    // shown no blink for a minute the bar rises to nine tenths.
    const recentBlink = this.blinks.some((bl) => bl.t > t0 && bl.t <= t);
    const blinksSeen = this.blinks.some((bl) => bl.t > t - 60 && bl.t <= t);
    if (this.closed) {
      const chans = TP.filter((c) => this.closed.d[c] >= GATE.CLOSED_MIN_RISE && w.psdAll[c]);
      const share = blinksSeen ? GATE.CLOSED_SHARE : GATE.CLOSED_SHARE_BLIND;
      w.eyesClosed = chans.length >= 1 && !recentBlink && chans.every((c) => this.bands(w.psdAll[c]).alpha - this.closed.open[c] > share * this.closed.d[c]);
    } else w.eyesClosed = false;
    // G5: drowsiness votes (c, slow eye movements, and e, move latency, come later)
    const recent = this.blinks.filter((bl) => Number.isFinite(bl.durMs) && bl.t > t - 60);
    const slopes = this.windows.filter((x) => x.valid && x.t > t - GATE.DROWSY_SLOPE_S).map((x) => x.slope).concat(w.valid ? [w.slope] : []);
    w.slopeAvg = slopes.length ? mean(slopes) : NaN;
    const tas = this.windows.filter((x) => x.valid && x.t > t - GATE.DROWSY_TA_S).map((x) => x.ta).concat(w.valid ? [w.ta] : []);
    w.taAvg = tas.length ? mean(tas) : NaN;
    w.votes = {
      a: !!(b && Number.isFinite(w.taAvg) && Number.isFinite(b.taMu) && (w.taAvg - b.taMu) / Math.max(b.taSd, GATE.SIGMA_FLOOR) > GATE.DROWSY_TA_Z),
      b: recent.length >= 3 && mean(recent.map((bl) => bl.durMs)) >= GATE.DROWSY_BLINK_MS,
      d: !!(b && Number.isFinite(w.slopeAvg) && Number.isFinite(b.slope) && w.slopeAvg < b.slope - GATE.DROWSY_SLOPE),
    };
    w.drowsy = [w.votes.a, w.votes.b, w.votes.d].filter(Boolean).length >= 2;
    w.motion = segs.some((s) => s.motion);
    w.blinkMasked = segs.filter((s) => s.blink).length;
    return w;
  }

  // The player's own eyes-open baseline over a stretch of stream time: contact statistics, muscle level, and the index.
  setBaseline(t0, t1) {
    const segs = this.segs.filter((s) => s.t > t0 && s.t <= t1);
    const sdMed = [], sdMad = [], emg = [];
    NAMES.forEach((_, c) => {
      const sds = segs.filter((s) => !s.ch[c].loss && !s.ch[c].amp).map((s) => s.ch[c].sd);
      sdMed[c] = median(sds); sdMad[c] = median(sds.map((v) => Math.abs(v - sdMed[c])));
      emg[c] = mean(segs.filter((s) => !s.ch[c].loss && s.ch[c].contact && !s.blink && !s.motion).map((s) => s.ch[c].emgLog));
    });
    const base = { t0, t1, sdMed, sdMad, emg, mu: NaN, sigma: NaN, taMu: NaN, taSd: NaN, slope: NaN };
    const wins = this.windows.filter((w) => w.t - 5 >= t0 && w.t <= t1);
    const ms = [], tas = [], sls = [];
    for (const w of wins) {
      const mc = [], tc = [], sc = [];
      for (const c of TP) if (w.psd[c]) { const bd = this.bands(w.psd[c]); mc.push(bd.alpha - bd.beta); tc.push(bd.theta - bd.alpha); sc.push(slopeOf(w.psd[c])); }
      if (mc.length) { ms.push(mean(mc)); tas.push(mean(tc)); sls.push(mean(sc)); }
    }
    if (ms.length) { base.mu = mean(ms); base.sigma = sdOf(ms); base.taMu = mean(tas); base.taSd = sdOf(tas); base.slope = mean(sls); }
    base.windows = ms.length; base.cleanSeconds = segs.filter((s) => TP.some((c) => s.ch[c].ok)).length / 2;
    this.base = base;
    return base;
  }

  // Eyes-closed calibration: the individual alpha frequency, and the alpha rise per channel for gate G4.
  setEyesClosed(openRange, closedRange) {
    const inR = (s, [a, b]) => s.t > a && s.t <= b;
    const closedSegs = this.segs.filter((s) => inR(s, closedRange));
    const tpPsd = avgPsd(closedSegs.flatMap((s) => TP.filter((c) => s.ch[c].contact && !s.ch[c].emg).map((c) => s.ch[c].psd)));
    if (tpPsd) this.iaf = findIaf(tpPsd);
    const winIn = (r) => this.windows.filter((w) => w.t - 5 >= r[0] && w.t <= r[1]);
    const alphaMean = (wins, c) => mean(wins.filter((w) => w.psdAll[c]).map((w) => this.bands(w.psdAll[c]).alpha));
    const open = NAMES.map((_, c) => alphaMean(winIn(openRange), c)), closed = NAMES.map((_, c) => alphaMean(winIn(closedRange), c));
    this.closed = { open, closed, d: NAMES.map((_, c) => closed[c] - open[c]) };
    return { iaf: this.iaf, rise: this.closed.d };
  }
}

// The largest alpha peak standing above a 1/f fit (Klimesch convention); 10 Hz when no peak stands out.
export function findIaf(p) {
  const fitK = [3, 4, 5, 6, 14, 15, 16, 18, 20, 22, 25, 28, 30];
  const xs = fitK.map((k) => Math.log10(k)), ys = fitK.map((k) => Math.log10(p[k]));
  const mx = mean(xs), my = mean(ys); let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  const sl = num / den, ic = my - sl * mx;
  const r = (k) => Math.log10(p[k]) - (ic + sl * Math.log10(k));
  let best = 7; for (let k = 7; k <= 13; k++) if (r(k) > r(best)) best = k;
  if (r(best) < 0.1 || best === 7 || best === 13) return 10;   // a peak at the search edge is slow eye movement or muscle, not alpha (Kit's 7.0 Hz, 26 Oct)
  const y0 = r(best - 1), y1 = r(best), y2 = r(best + 1), den2 = y0 - 2 * y1 + y2;
  return clamp(best + (den2 ? 0.5 * (y0 - y2) / den2 : 0), 7, 13);
}
