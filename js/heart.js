// Chest strap heart signal for Stillmate: any strap with the standard Bluetooth heart rate service (Polar H10,
// Garmin HRM-Dual, HRM-Pro Plus, and others) and a test stream. Kit, 27 Oct: the heart becomes the main signal,
// the Muse an optional layer. 8 Nov: Garmin straps made explicit.
// The strap sends the standard Heart Rate Measurement (0x2A37) about once a second: heart rate plus the RR intervals,
// the times between beats in 1/1024 s. RR intervals give heart rate variability; the game uses RMSSD, the standard
// short-term vagal measure (Task Force 1996; Shaffer and Ginsberg 2017), over the last 30 s. Some straps send the
// rate with no intervals (the HRM-Pro Plus over Bluetooth, by reports), and some fill the interval field with
// 60000 / rate, which carries no variability; both count as "no intervals", and the game then reads the rate alone.

const HR_SERVICE = "heart_rate", HR_MEASUREMENT = "heart_rate_measurement";

// Flags bit 0: heart rate as uint16 (else uint8); bit 3: energy expended present; bit 4: RR intervals present.
export function parseHeartRate(v) {
  const flags = v.getUint8(0); let i = 1;
  const hr = flags & 1 ? v.getUint16(i, true) : v.getUint8(i); i += flags & 1 ? 2 : 1;
  if (flags & 8) i += 2;
  const rr = [];
  if (flags & 16) for (; i + 1 < v.byteLength; i += 2) rr.push(v.getUint16(i, true) * 1000 / 1024);
  return { hr, rr };
}

// Callbacks: onBeats(rrMs[], hr), onDisconnect().
export class HeartStrap {
  constructor() { this.kind = "h10"; this.name = null; this.device = null; this._h = null; }
  static available() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }
  async connect() {
    // the chooser lists every device that offers the heart rate service, whatever its make
    const device = this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }] });
    device.addEventListener("gattserverdisconnected", () => this.onDisconnect?.());
    this.name = device.name || "Chest strap";
    // Windows often refuses the first connection, as with the Muse (js/muse.js): try three times.
    let ch = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !ch; attempt++) {
      try {
        const gatt = await device.gatt.connect();
        ch = await (await gatt.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
      } catch (e) { lastErr = e; try { device.gatt.disconnect(); } catch {} await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (!ch) throw lastErr || new Error("no heart rate service");
    this._ch = ch; this._h = (e) => { const m = parseHeartRate(e.target.value); this.onBeats?.(m.rr, m.hr); };
    ch.addEventListener("characteristicvaluechanged", this._h);
    await ch.startNotifications();
  }
  start() {}
  async stop() {}
  disconnect() { try { this._ch?.removeEventListener("characteristicvaluechanged", this._h); this.device?.gatt.disconnect(); } catch {} }
}

// A test strap: calm drifts slowly (mean-reverting, about 30 s to wander back), and calm lowers the heart rate,
// slows the breath and deepens the breath's swing in the heartbeat, as in real recordings. set({calm}) pins it;
// set({breathMs}) pins the breath's length (the webcam check's paced breathing); set({intervals}) chooses what the
// packets carry: "real" beat intervals, "none" (rate only, as some Garmin straps), or "synthetic" (60000 / rate).
export class FakeHeartStrap {
  constructor() { this.kind = "fake"; this.name = "Test strap"; this.calm = 0.5; this.pinned = null; this.breathMs = null; this.intervals = "real"; this.t = 0; this.next = 0; }
  set({ calm, breathMs, intervals }) {
    if (calm !== undefined) this.pinned = calm === null ? null : calm;
    if (breathMs !== undefined) this.breathMs = breathMs;
    if (intervals !== undefined) this.intervals = intervals;
  }
  async connect() {}
  start() {
    this._timer = setInterval(() => this._second(), 1000);
  }
  _second() {
    const dt = 1, theta = 1 / 30, gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
    this.calm += theta * (0.5 - this.calm) * dt + 0.25 * Math.sqrt(2 * theta * dt) * gauss();
    this.calm = Math.min(1, Math.max(0, this.calm));
    const c = this.pinned ?? this.calm, rr = [];
    const end = this.t + 1000;
    while (this.next < end) {
      const breath = this.breathMs ?? 4000 + 4000 * c;                 // 15 breaths a minute when busy, 7.5 when calm
      const hr = 82 - 22 * c + (2 + 8 * c) * Math.sin(2 * Math.PI * this.next / breath) + gauss() * 0.8;
      const beat = 60000 / hr; this.next += beat; rr.push(beat);
    }
    this.t = end;
    if (!rr.length) return;
    const hr = Math.round(60000 / rr[rr.length - 1]);
    if (this.intervals === "none") this.onBeats?.([], hr);
    else if (this.intervals === "synthetic") this.onBeats?.(rr.map(() => 60000 / hr), hr);
    else this.onBeats?.(rr, hr);
  }
  async stop() {}
  disconnect() { clearInterval(this._timer); this.onDisconnect?.(); }
}

// Beats with arrival times, cleaned of artefacts: an RR outside 300 to 2000 ms, or more than 20% from the previous
// clean beat (a missed or extra beat), is dropped (the standard percentage filter, Malik 1989).
export class BeatBuffer {
  constructor() { this.beats = []; this.last = null; this.dropped = 0; this.run = 0; this.rates = []; this.fakeRun = 0; this.synthetic = false; }
  // hr: the rate the packet carried. Intervals that all equal 60000 / rate, three packets running, are the strap
  // filling the field from the rate; they are dropped and the buffer reads "no intervals" until real ones return.
  add(rrList, now, hr) {
    if (Number.isFinite(hr) && hr > 0) { this.rates.push({ t: now, hr }); while (this.rates.length && this.rates[0].t < now - 120000) this.rates.shift(); }
    if (rrList.length && Number.isFinite(hr) && rrList.every((rr) => Math.abs(rr - 60000 / hr) < 1)) {
      if (++this.fakeRun >= 3) this.synthetic = true;
      if (this.synthetic) return;
    } else if (rrList.length) { this.fakeRun = 0; this.synthetic = false; }
    let t = now - rrList.slice(1).reduce((a, b) => a + b, 0);        // the last beat lands now; earlier ones before it
    for (const rr of rrList) {
      const inRange = rr >= 300 && rr <= 2000;
      // three rejects in a row mean the rhythm itself has moved, not a stray beat: follow it again
      const ok = inRange && (this.last === null || Math.abs(rr - this.last) <= 0.2 * this.last || this.run >= 3);
      if (ok) { this.beats.push({ t, rr }); this.last = rr; this.run = 0; } else { this.dropped++; if (inRange) this.run++; }
      t += rr;
    }
    const cut = now - 120000; while (this.beats.length && this.beats[0].t < cut) this.beats.shift();
  }
  since(now, secs) { return this.beats.filter((b) => b.t > now - secs * 1000 && b.t <= now); }
  // Whether real beat intervals arrived in the last `secs`: false for a rate-only strap or synthesised intervals.
  hasIntervals(now, secs = 10) { return !this.synthetic && this.since(now, secs).length >= 3; }
  // Heart rate from the beats when there are any, else from the rate the strap reports.
  hr(now, secs = 5) {
    const b = this.since(now, secs); if (b.length) return 60000 / (b.reduce((a, x) => a + x.rr, 0) / b.length);
    const r = this.rates.filter((x) => x.t > now - secs * 1000 && x.t <= now);
    return r.length ? r.reduce((a, x) => a + x.hr, 0) / r.length : NaN;
  }
  rmssd(now, secs = 30) {
    const b = this.since(now, secs); if (b.length < 8) return NaN;
    let s = 0; for (let i = 1; i < b.length; i++) s += (b[i].rr - b[i - 1].rr) ** 2;
    return Math.sqrt(s / (b.length - 1));
  }
}
