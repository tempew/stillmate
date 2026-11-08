// Stillmate's in-browser engine (8 Nov: a version Pete can play on any HTTPS host, without Kit's laptop).
// Stockfish 18 lite, single-threaded WASM in a Web Worker (the build the room's live panel uses, js/engine.js),
// giving the same four services as the coach server: every legal move scored, the full-strength best move, the
// opponent's move at a chosen Elo, and the move for a shade. The shades are approximations here: each shade's
// measured strength goes to Stockfish's strength limiter (UCI_Elo, 1320 to 3190), and purple's shades above that
// to the unthrottled engine at rising node counts; the real game plays the measured Maia and Leela bots through the
// server. Node counts are modest so a turn's work finishes within a few seconds on one thread.
import { Chess } from "../node_modules/chess.js/dist/esm/chess.js";

const ENGINE_URL = "node_modules/stockfish/bin/stockfish-18-lite-single.js";
const NODES = { moves: 30000, best: 120000, reply: 40000, purple: { 3500: 80000, 3600: 160000, 3700: 320000 } };
const ELO_RANGE = [1320, 3190];
const MATE_SCORE = 10000;                                  // as the server: a mate in n scores as 10000 - n

export class LocalEngine {
  constructor() { this.worker = null; this.ready = null; this.queue = Promise.resolve(); this.lines = null; this.resolveBest = null; this.failed = false; }
  init() { if (!this.ready) this.ready = this._init(); return this.ready; }
  async _init() {
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e) => this._onLine(typeof e.data === "string" ? e.data : e.data?.data ?? "");
    this.worker.onerror = (e) => { this.failed = true; console.error("in-browser engine failed to load", e); };
    await new Promise((r) => { this._onBanner = r; setTimeout(r, 4000); });   // the banner says the WASM is up
    await this._cmd("uci", "uciok");
    await this._cmd("isready", "readyok");
  }
  _cmd(text, until) { return new Promise((r) => { this._wait = { until, r }; this.worker.postMessage(text); setTimeout(r, 5000); }); }
  _onLine(line) {
    if (this._onBanner && /Stockfish/.test(line)) { const r = this._onBanner; this._onBanner = null; r(); return; }
    if (this._wait && line === this._wait.until) { const w = this._wait; this._wait = null; w.r(); return; }
    if (line.startsWith("bestmove")) { const r = this.resolveBest; this.resolveBest = null; r?.(line.split(/\s+/)[1]); return; }
    if (!this.lines || !line.startsWith("info") || !line.includes(" pv ")) return;
    const mpv = /\bmultipv (\d+)/.exec(line), cp = /\bscore cp (-?\d+)/.exec(line), mate = /\bscore mate (-?\d+)/.exec(line);
    const uci = line.split(" pv ")[1].trim().split(/\s+/)[0];
    const m = mate ? parseInt(mate[1], 10) : null;
    // scores are from the side to move, as the server reports them
    this.lines.set(mpv ? parseInt(mpv[1], 10) : 1, { uci, cp: m !== null ? (m > 0 ? MATE_SCORE - m : -MATE_SCORE - m) : parseInt(cp ? cp[1] : "0", 10), mate: m });
  }
  // One search at a time: options, position, go, and the lines up to the bestmove.
  _search(fen, options, go) {
    const run = async () => {
      await this.init();
      for (const [k, v] of Object.entries(options)) this.worker.postMessage(`setoption name ${k} value ${v}`);
      this.lines = new Map();
      this.worker.postMessage(`position fen ${fen}`);
      const best = await new Promise((r) => { this.resolveBest = r; this.worker.postMessage(go); });
      const lines = this.lines; this.lines = null;
      return { best, lines };
    };
    return (this.queue = this.queue.then(run, run));
  }
  static _san(fen, uci) { try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return uci; } }

  // Every legal move with its score for the side to move, and (unless withBest is false) the best move on its own
  // deeper search; the shape the server's /still_moves gives.
  async moves(fen, withBest = true) {
    const chess = new Chess(fen), legal = chess.moves({ verbose: true });
    if (!legal.length) return { fen, best: null, moves: [] };
    const { lines } = await this._search(fen, { MultiPV: legal.length, UCI_LimitStrength: "false" }, `go nodes ${NODES.moves}`);
    const seen = new Set(), out = [];
    for (const x of lines.values()) { if (seen.has(x.uci)) continue; seen.add(x.uci); out.push({ san: LocalEngine._san(fen, x.uci), uci: x.uci, cp: x.cp, mate: x.mate }); }
    for (const m of legal) { const u = m.from + m.to + (m.promotion || ""); if (!seen.has(u)) out.push({ san: m.san, uci: u, cp: -MATE_SCORE, mate: null, unscored: true }); }
    out.sort((a, b) => b.cp - a.cp);
    const best = withBest ? await this.best(fen) : null;
    return { fen, best, moves: out };
  }
  // Stockfish's own choice at full strength, all the effort on one line.
  async best(fen) {
    if (new Chess(fen).isGameOver()) return null;
    const { best, lines } = await this._search(fen, { MultiPV: 1, UCI_LimitStrength: "false" }, `go nodes ${NODES.best}`);
    const top = lines.get(1) || { cp: 0, mate: null };
    return { san: LocalEngine._san(fen, best), uci: best, cp: top.cp, mate: top.mate };
  }
  // The opponent's move at an Elo, through the strength limiter.
  async reply(fen, elo) {
    if (new Chess(fen).isGameOver()) return { over: true };
    const e = Math.max(ELO_RANGE[0], Math.min(ELO_RANGE[1], Math.round(elo || 1500)));
    const { best } = await this._search(fen, { MultiPV: 1, UCI_LimitStrength: "true", UCI_Elo: e }, `go nodes ${NODES.reply}`);
    return { san: LocalEngine._san(fen, best), uci: best, elo: e };
  }
  // The move for a shade of a given measured strength: the limiter up to 3190, the unthrottled engine above it.
  async bot(history, strength) {
    const chess = new Chess();
    for (const u of history) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    const fen = chess.fen();
    if (chess.isGameOver()) return { over: true };
    if (strength <= ELO_RANGE[1]) {
      const e = Math.max(ELO_RANGE[0], Math.round(strength));
      const { best } = await this._search(fen, { MultiPV: 1, UCI_LimitStrength: "true", UCI_Elo: e }, `go nodes ${NODES.reply}`);
      return { san: LocalEngine._san(fen, best), uci: best, bot: `sf_elo_${e}` };
    }
    const nodes = NODES.purple[strength] || NODES.purple[3700];
    const { best } = await this._search(fen, { MultiPV: 1, UCI_LimitStrength: "false" }, `go nodes ${nodes}`);
    return { san: LocalEngine._san(fen, best), uci: best, bot: `sf_nodes_${nodes}` };
  }
}
