// Back in use, 27 Oct (evening): of the three tasks Kit tried, only the Stroop moved his index the right way (0.28
// steps), and as an outward, eyes-on-screen task it suits alpha, which can rise during inward tasks like silent
// counting. Check 5 now runs it twice for a minute each.
// The Stroop colour-word task (Stroop 1935; review MacLeod 1991): a colour word printed in a different ink, and the
// player names the ink with a home-row key (D, F, J, K, as online versions do, so nobody hunts for keys), after five
// practice words. It is the busy end of the headband scale (Kit, 27 Oct), in place of silent counting in sevens:
// the mind works with the eyes open on the screen, as at the board, and the answers show the effort was real, so a
// quiet brain during a well-done Stroop counts as calm under load.
// Every trial is incongruent (word and ink differ), the classic interference form.

export const STROOP_COLOURS = [
  { word: "RED", key: "d", ink: "#e5484d" },
  { word: "GREEN", key: "f", ink: "#30a46c" },
  { word: "BLUE", key: "j", ink: "#3e8ef7" },
  { word: "YELLOW", key: "k", ink: "#f5d90a" },
];
export const STROOP_KEYS_TEXT = "D, F, J or K";
const MISS_MS = 3000, GAP_MS = 150, FEEDBACK_MS = 900;

// Effort counts as real with at least one answer every 2 s and 70 percent right (engineering choice; adults
// typically answer incongruent trials in under a second with few errors).
export function stroopVerified(r, secs) { return r.answered >= secs / 2 && r.accuracy >= 0.7; }

// Runs in `el` for `secs` seconds, or for `practice` words when that is set (untimed, results ignored by callers).
// Practice words say whether each answer was right, as standard Stroop practice does: Kit's first run scored 0 of 28,
// the exact signature of naming the word instead of the ink, since every trial is incongruent.
// `now` and `sleep` default to real time; the game passes its own clock.
export async function runStroop(el, secs, { now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), practice = 0 } = {}) {
  el.hidden = false;
  el.innerHTML = `${practice ? `<div class="stroop-practice">Practice</div>` : ""}<div class="stroop-word"></div><div class="stroop-keys">${STROOP_COLOURS.map((c) =>
    `<span class="stroop-key"><i style="background:${c.ink}"></i><b>${c.key.toUpperCase()}</b></span>`).join("")}</div>`;
  const wordEl = el.querySelector(".stroop-word"), trials = [];
  let current = null, answer = null;
  const onKey = (e) => {
    const c = STROOP_COLOURS.find((x) => x.key === e.key.toLowerCase());
    if (!c || !current || answer) return;
    e.preventDefault(); answer = { key: c.key, at: now() };
  };
  window.addEventListener("keydown", onKey);
  const t0 = now();
  let last = -1;
  try {
    while (practice ? trials.length < practice : now() - t0 < secs * 1000) {
      let ink; do { ink = Math.floor(Math.random() * 4); } while (ink === last);
      let word; do { word = Math.floor(Math.random() * 4); } while (word === ink);
      last = ink;
      current = { ink, word, shown: now() }; answer = null;
      wordEl.textContent = STROOP_COLOURS[word].word; wordEl.style.color = STROOP_COLOURS[ink].ink;
      while (!answer && now() - current.shown < MISS_MS && (practice || now() - t0 < secs * 1000)) await sleep(20);
      if (!practice && now() - t0 >= secs * 1000 && !answer) break;
      trials.push(answer ? { ok: answer.key === STROOP_COLOURS[ink].key, rt: answer.at - current.shown } : { ok: false, rt: null });
      if (practice) {
        const ok = trials[trials.length - 1].ok, inkName = STROOP_COLOURS[ink].word.toLowerCase();
        wordEl.style.color = ok ? "#e8ecf2" : "#9aa4b2"; wordEl.classList.add("fb");
        wordEl.textContent = ok ? "Right" : `The ink was ${inkName}: press ${STROOP_COLOURS[ink].key.toUpperCase()}`;
        await sleep(ok ? FEEDBACK_MS : 2 * FEEDBACK_MS); wordEl.classList.remove("fb");
      }
      wordEl.textContent = ""; current = null;
      await sleep(GAP_MS);
    }
  } finally {
    window.removeEventListener("keydown", onKey);
    el.hidden = true; el.innerHTML = "";
  }
  const answered = trials.filter((t) => t.rt !== null), rts = answered.filter((t) => t.ok).map((t) => t.rt).sort((a, b) => a - b);
  return {
    trials: trials.length, answered: answered.length,
    accuracy: answered.length ? answered.filter((t) => t.ok).length / answered.length : 0,
    medianRt: rts.length ? rts[rts.length >> 1] : NaN,
  };
}

// Practice rounds of five words until four are right, at most three rounds, so the measured run starts only once
// the player names the ink. Returns the last round's result.
export async function practiseStroop(el, opts = {}) {
  let r = null;
  for (let round = 0; round < 3; round++) {
    r = await runStroop(el, 0, { ...opts, practice: 5 });
    if (Math.round(r.accuracy * r.answered) >= 4) break;
  }
  return r;
}
