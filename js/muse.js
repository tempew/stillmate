// Muse 2 over Web Bluetooth, and a test stream with the same interface.
// The Bluetooth protocol follows muse-js (MIT licence, Uri Shaked, github.com/urish/muse-js): service 0xfe8d, a control
// characteristic that takes short text commands, one characteristic per EEG channel carrying 12 samples of 12 bits per
// packet, and one for the accelerometer carrying 3 samples of x, y, z. Nothing leaves the browser tab.

export const MUSE_SERVICE = 0xfe8d;
const UUID = (n) => `273e00${n}-4c4d-454d-96be-f03bac821358`;
const CONTROL = UUID("01"), TELEMETRY = UUID("0b"), ACCEL = UUID("0a");
const EEG_UUIDS = [UUID("03"), UUID("04"), UUID("05"), UUID("06")];
export const CHANNELS = ["TP9", "AF7", "AF8", "TP10"];
export const EEG_HZ = 256, EEG_PER_PACKET = 12, ACCEL_HZ = 52, ACCEL_PER_PACKET = 3;
const UV_PER_LSB = 0.48828125;           // muse-js: µV = 0.48828125 × (raw − 2048)
const ACCEL_G_PER_LSB = 0.0000610352;    // muse-js

// ---------------- packets ----------------
export function encodeCommand(cmd) {
  const e = new TextEncoder().encode(`X${cmd}\n`);
  e[0] = e.length - 1;
  return e;
}
// One EEG packet: a 16-bit sequence number, then 12 samples of 12 bits (two samples in every three bytes).
export function decodeEeg(view) {
  const index = view.getUint16(0);
  const b = new Uint8Array(view.buffer, view.byteOffset + 2, view.byteLength - 2);
  const samples = [];
  for (let i = 0; i < b.length; i++) {
    if (i % 3 === 0) samples.push((b[i] << 4) | (b[i + 1] >> 4));
    else { samples.push(((b[i] & 0xf) << 8) | b[i + 1]); i++; }
  }
  return { index, samples: samples.map((n) => UV_PER_LSB * (n - 0x800)) };
}
// The inverse, used only by the test stream so its packets pass through the same decoder as the headband's.
export function encodeEeg(index, samplesUv) {
  const raw = samplesUv.map((v) => Math.max(0, Math.min(4095, Math.round(v / UV_PER_LSB + 0x800))));
  const out = new Uint8Array(2 + (raw.length / 2) * 3);
  out[0] = (index >> 8) & 0xff; out[1] = index & 0xff;
  for (let k = 0, j = 2; k < raw.length; k += 2, j += 3) {
    const a = raw[k], c = raw[k + 1];
    out[j] = a >> 4; out[j + 1] = ((a & 0xf) << 4) | (c >> 8); out[j + 2] = c & 0xff;
  }
  return new DataView(out.buffer);
}
function decodeImu(view, scale) {
  const s = (o) => ({ x: scale * view.getInt16(o), y: scale * view.getInt16(o + 2), z: scale * view.getInt16(o + 4) });
  return [s(2), s(8), s(14)];
}
function encodeImu(index, samples, scale) {
  const v = new DataView(new ArrayBuffer(20));
  v.setUint16(0, index & 0xffff);
  samples.forEach((s, k) => { v.setInt16(2 + 6 * k, Math.round(s.x / scale)); v.setInt16(4 + 6 * k, Math.round(s.y / scale)); v.setInt16(6 + 6 * k, Math.round(s.z / scale)); });
  return v;
}

// ---------------- the headband ----------------
// Callbacks: onEeg(channel, index, samples), onAccel(samples), onBattery(percent), onInfo(object), onDisconnect().
export class MuseDevice {
  constructor() { this.kind = "muse"; this.name = null; this.gatt = null; this._text = ""; }
  static available() { return typeof navigator !== "undefined" && !!navigator.bluetooth; }
  async connect() {
    const device = this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [MUSE_SERVICE] }] });
    device.addEventListener("gattserverdisconnected", () => { this.gatt = null; this.onDisconnect?.(); });
    this.name = device.name || "Muse";
    await this._open();
  }
  // After a drop: the same headband again, with no chooser, and the stream restarted.
  async reconnect() {
    if (!this.device) throw new Error("never connected");
    try { this.device.gatt.disconnect(); } catch {}
    await this._open(); await this.start();
  }
  async _open() {
    const device = this.device;
    // Chrome may hand back the same characteristic objects after a reconnect: drop the old listeners, or every sample
    // would arrive twice.
    for (const { ch, h } of this._subs || []) ch.removeEventListener("characteristicvaluechanged", h);
    this._subs = [];
    // Windows often refuses the first GATT connection to a Muse ("Connection attempt failed"); try three times.
    let svc = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !svc; attempt++) {
      try {
        this.gatt = await device.gatt.connect();
        svc = await this.gatt.getPrimaryService(MUSE_SERVICE);
      } catch (e) {
        lastErr = e; try { device.gatt.disconnect(); } catch {}
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!svc) throw lastErr || new Error("no Muse service");
    const listen = async (uuid, fn) => {
      const ch = await svc.getCharacteristic(uuid);
      const h = (e) => fn(e.target.value);
      ch.addEventListener("characteristicvaluechanged", h); this._subs.push({ ch, h });
      await ch.startNotifications();
      return ch;
    };
    this.control = await listen(CONTROL, (v) => this._controlText(v));
    await listen(TELEMETRY, (v) => this.onBattery?.(v.getUint16(2) / 512));
    await listen(ACCEL, (v) => this.onAccel?.(decodeImu(v, ACCEL_G_PER_LSB)));
    for (let c = 0; c < 4; c++) await listen(EEG_UUIDS[c], (v) => { const p = decodeEeg(v); this.onEeg?.(c, p.index, p.samples); });
  }
  // The muse-js start sequence: halt, preset p21 (four EEG channels, no auxiliary), start, resume. Then ask for the version.
  async start() { for (const c of ["h", "p21", "s", "d"]) await this.send(c); try { await this.send("v1"); } catch {} }
  async send(cmd) { await this.control.writeValue(encodeCommand(cmd)); }
  async stop() { try { await this.send("h"); } catch {} }
  disconnect() { try { this.gatt?.disconnect(); } catch {} }
  // Control replies arrive as JSON split over several packets; the first byte of each packet is its text length.
  _controlText(view) {
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this._text += new TextDecoder().decode(b.subarray(1, 1 + b[0]));
    const end = this._text.indexOf("}");
    if (end >= 0) {
      const start = this._text.lastIndexOf("{", end);
      if (start >= 0) { try { this.onInfo?.(JSON.parse(this._text.slice(start, end + 1))); } catch {} }
      this._text = this._text.slice(end + 1);
    }
  }
}

// ---------------- the test stream ----------------
// A made-up Muse with the same callbacks. Each channel is 1/f-like background, an alpha rhythm, some theta and beta,
// mains hum and drift, plus the artefacts the gates must catch: blinks, jaw clench, head movement, a lost electrode.
// Its state can be set by hand or by the check page. Every packet is encoded to bytes and decoded like the real one.
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
export class FakeMuse {
  constructor() {
    this.kind = "fake"; this.name = "Test stream";
    this.state = { eyesClosed: false, counting: false, clench: false, drowsy: false, deep: false, lost: [false, false, false, false], spontaneousBlinks: true };
    this.blinkAt = [];        // sample numbers where a blink starts
    this.moveAt = -1e9;
    this.ch = CHANNELS.map((_, c) => ({ ar: 0, hp: 0, aPh: Math.random() * 6.28, tPh: Math.random() * 6.28, bPh: [0, 1, 2].map(() => Math.random() * 6.28), env: 1, phase: Math.random() * 6.28, lostWalk: 0 }));
    this.nextSpont = 256 * (2 + Math.random() * 3);
  }
  static available() { return true; }
  async connect() {}
  async start() {
    this.t0 = performance.now(); this.sent = 0; this.accSent = 0;
    this.timer = setInterval(() => this.pump(), 20);
    setTimeout(() => { this.onBattery?.(82); this.onInfo?.({ fw: "test stream", hw: "none" }); }, 50);
  }
  async stop() { clearInterval(this.timer); }
  disconnect() { clearInterval(this.timer); this.onDisconnect?.(); }
  set(partial) { Object.assign(this.state, partial); }
  blink(delayS = 0) { this.blinkAt.push(this.sent * EEG_PER_PACKET + Math.round(delayS * EEG_HZ)); }
  moveHead() { this.moveAt = this.sent * EEG_PER_PACKET; }
  pump() {
    const elapsed = (performance.now() - this.t0) / 1000;
    const dueEeg = Math.floor(elapsed * EEG_HZ / EEG_PER_PACKET), dueAcc = Math.floor(elapsed * ACCEL_HZ / ACCEL_PER_PACKET);
    while (this.sent < dueEeg) { this._eegPacket(); this.sent++; }
    while (this.accSent < dueAcc) { this._accPacket(); this.accSent++; }
  }
  _sample(c, i) {
    const s = this.state, k = this.ch[c], t = i / EEG_HZ, tp = c === 0 || c === 3;
    if (s.lost[c]) { k.lostWalk = 0.995 * k.lostWalk + 25 * gauss(); return 300 * Math.sin(2 * Math.PI * 1.3 * t) + k.lostWalk; }
    k.ar = 0.97 * k.ar + 1.6 * gauss();
    let alphaAmp = (tp ? 5 : 2.5) * (1 + 0.3 * Math.sin(2 * Math.PI * t / 7 + k.phase));
    if (s.eyesClosed) alphaAmp *= 2.6;
    if (s.counting) alphaAmp *= 0.85;   // counting and deep sized to Kit's first real session (27 Oct): busy about 2 steps
    if (s.drowsy) alphaAmp *= 0.8;
    if (s.deep) alphaAmp *= 1.15;       // below rest, deep calm about 1.5 steps above it
    k.aPh += 2 * Math.PI * (10 + 0.2 * Math.sin(t / 3)) / EEG_HZ;
    let thetaAmp = 1.5 * (s.drowsy ? 2.6 : 1) * (s.counting ? 1.2 : 1);
    k.tPh += 2 * Math.PI * 6 / EEG_HZ;
    const betaAmp = 1.2 * (s.counting ? 1.25 : 1) * (s.deep ? 0.9 : 1);
    let beta = 0;
    [15, 19, 23].forEach((f, j) => { k.bPh[j] += 2 * Math.PI * f / EEG_HZ + 0.05 * gauss(); beta += Math.sin(k.bPh[j]); });
    let x = k.ar + 1.5 * gauss() + alphaAmp * Math.sin(k.aPh) + thetaAmp * Math.sin(k.tPh) + betaAmp * beta
      + 1.5 * Math.sin(2 * Math.PI * 50 * t) + 15 * Math.sin(2 * Math.PI * t / 40 + c);
    // jaw clench: broadband muscle noise, strongest at the ear sites next to the temporalis
    const w = gauss(); const emg = w - k.hp; k.hp = w;
    x += emg * (s.clench ? (tp ? 18 : 6) : 0.4);
    // blinks: a smooth deflection of about 250 ms, huge on the forehead channels, small at the ears
    const L = s.drowsy ? 200 : 64;      // drowsy blinks last about 0.8 s, alert ones about 0.25 s
    for (const b of this.blinkAt) if (i >= b && i < b + L) x += (c === 1 ? -180 : c === 2 ? -170 : 12) * 0.5 * (1 - Math.cos(2 * Math.PI * (i - b) / L));
    // head movement: electrodes shift on the skin for about 1.5 s
    const dm = i - this.moveAt; if (dm >= 0 && dm < 384) x += 70 * Math.sin(Math.PI * dm / 384) * (c % 2 ? 1 : -1);
    return x;
  }
  _eegPacket() {
    const i0 = this.sent * EEG_PER_PACKET;
    if (this.state.spontaneousBlinks && !this.state.eyesClosed && i0 >= this.nextSpont) {
      this.blinkAt.push(i0); this.nextSpont = i0 + EEG_HZ * (this.state.drowsy ? 2 + Math.random() * 2 : 3 + Math.random() * 3);
    }
    this.blinkAt = this.blinkAt.filter((b) => b > i0 - 400);
    for (let c = 0; c < 4; c++) {
      const samples = []; for (let j = 0; j < EEG_PER_PACKET; j++) samples.push(this._sample(c, i0 + j));
      const p = decodeEeg(encodeEeg(this.sent & 0xffff, samples));
      this.onEeg?.(c, p.index, p.samples);
    }
  }
  _accPacket() {
    const samples = [];
    for (let j = 0; j < ACCEL_PER_PACKET; j++) {
      const i = Math.round((this.accSent * ACCEL_PER_PACKET + j) * EEG_HZ / ACCEL_HZ), dm = i - this.moveAt;
      const tilt = dm >= 0 && dm < 384 ? 0.25 * Math.sin(Math.PI * dm / 384) : 0;
      samples.push({ x: tilt + 0.003 * gauss(), y: 0.003 * gauss(), z: 1 - tilt * 0.3 + 0.003 * gauss() });
    }
    this.onAccel?.(decodeImu(encodeImu(this.accSent, samples, ACCEL_G_PER_LSB), ACCEL_G_PER_LSB));
  }
}
