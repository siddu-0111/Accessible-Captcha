"use strict";

const $ = (s) => document.querySelector(s);
const el = {
  prompt:   $("#prompt"),
  play:     $("#play"),
  fresh:    $("#fresh"),
  answer:   $("#answer"),
  check:    $("#check"),
  status:   $("#status"),
  form:     $("#captcha"),
  pad:      $("#pad"),
  padFb:    $("#pad-feedback"),
  undo:     $("#undo"),
  clear:    $("#clear"),
  novib:    $("#novib"),
};

let cur = null;
let replays = 0;
let timers = [];

/* Long-press threshold in ms. Tweak if users find it too short/long. */
const LONG_PRESS_MS = 450;

/* Pad state */
let padDownAt = 0;
let padTimer = null;
let padArmed = false;      // true once we've committed to "L"
let padActive = false;     // true while pointer is down

const say = (msg, kind = "") => {
  el.status.textContent = msg;
  el.status.className = "status" + (kind ? " " + kind : "");
};

const setBusy = (busy) => {
  const off = busy || !cur;
  el.play.disabled = off;
  el.answer.disabled = off;
  el.check.disabled = off;
  el.pad.disabled = off;
  updateTools();
};

function updateTools() {
  const hasText = el.answer.value.length > 0;
  el.undo.disabled  = !hasText;
  el.clear.disabled = !hasText;
}

function updatePadFeedback() {
  if (!cur) {
    el.padFb.textContent = "Waiting for challenge…";
    return;
  }
  el.padFb.textContent = "Quick tap → S · Hold → L";
}

const canVibrate = "vibrate" in navigator;

if (!canVibrate) {
  el.novib.hidden = false;
  el.fresh.disabled = true;
  el.prompt.textContent = "Vibration isn't available on this device.";
  say("Try again on an Android phone with Chrome or Firefox.", "bad");
}

function clearTimers() { timers.forEach(clearTimeout); timers = []; }

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, retry: r.headers.get("Retry-After") };
}

async function loadChallenge(announce = "") {
  if (!canVibrate) return;
  clearTimers();
  setBusy(true);
  cur = null;
  replays = 0;
  el.answer.value = "";
  updateTools();
  updatePadFeedback();
  el.prompt.textContent = "Loading challenge\u2026";

  const { status, data, retry } = await post("/api/challenge", {});

  if (status === 429) {
    el.prompt.textContent = "Too many attempts.";
    say(`Please wait about ${retry} seconds, then choose New challenge.`, "bad");
    el.fresh.disabled = false;
    return;
  }
  if (status !== 200) {
    say("Something went wrong. Choose New challenge to try again.", "bad");
    return;
  }

  cur = data;
  el.prompt.textContent = data.prompt;
  setBusy(false);
  el.prompt.focus();
  say(announce || "Challenge ready. Choose Feel pattern, then tap or hold to answer.");

  timers.push(setTimeout(
    () => say("30 seconds left. Choose New challenge if you need more time."),
    (data.expires_in - 30) * 1000
  ));
  timers.push(setTimeout(() => {
    cur = null;
    setBusy(true);
    el.fresh.disabled = false;
    say("This challenge has expired. Choose New challenge.", "bad");
    el.fresh.focus();
  }, data.expires_in * 1000));
}

/* -------- Playback -------- */

el.play.addEventListener("click", () => {
  if (!cur) return;
  replays++;
  const { short, long, gap } = cur.pulse_ms;
  const seq = [];
  [...cur.pattern].forEach((c, i) => {
    if (i) seq.push(gap);
    seq.push(c === "L" ? long : short);
  });
  navigator.vibrate(seq);
});

/* -------- Answer entry -------- */

function appendSymbol(symbol) {
  if (!cur) return;
  if (el.answer.value.length >= 16) return;
  el.answer.value += symbol;
  updateTools();

  // Confirm the committed symbol with a short haptic burst.
  if (canVibrate) {
    navigator.vibrate(symbol === "L" ? [40, 60, 40] : 30);
  }

  // Visual flash on the pad
  el.pad.classList.add("is-committed");
  setTimeout(() => el.pad.classList.remove("is-committed"), 300);
}

el.undo.addEventListener("click", () => {
  el.answer.value = el.answer.value.slice(0, -1);
  updateTools();
  el.answer.focus();
});

el.clear.addEventListener("click", () => {
  el.answer.value = "";
  updateTools();
  el.answer.focus();
});

el.answer.addEventListener("input", () => {
  const cleaned = el.answer.value.toUpperCase().replace(/[^SL]/g, "").slice(0, 16);
  if (cleaned !== el.answer.value) {
    const pos = el.answer.selectionStart;
    el.answer.value = cleaned;
    try { el.answer.setSelectionRange(pos, pos); } catch (_) {}
  }
  updateTools();
});

/* -------- Pad handling (tap = S, hold = L) -------- */

function padDown(e) {
  if (!cur || el.pad.disabled) return;
  e.preventDefault();
  padActive = true;
  padDownAt = performance.now();
  padArmed = false;
  el.pad.classList.add("is-pressed");
  el.pad.classList.remove("is-armed");

  // Fire the "armed for long" state after the threshold
  padTimer = setTimeout(() => {
    if (!padActive) return;
    padArmed = true;
    el.pad.classList.remove("is-pressed");
    el.pad.classList.add("is-armed");
    if (canVibrate) navigator.vibrate(35);   // "you've held long enough" cue
  }, LONG_PRESS_MS);
}

function padUp(e) {
  if (!padActive) return;
  if (e) e.preventDefault();
  padActive = false;
  clearTimeout(padTimer);
  padTimer = null;

  const held = performance.now() - padDownAt;
  const isLong = padArmed || held >= LONG_PRESS_MS;

  el.pad.classList.remove("is-pressed", "is-armed");
  padArmed = false;

  // Only commit if the press was on the pad (pointerup could land elsewhere
  // if the user dragged off — this is fine; treat it as the same gesture).
  appendSymbol(isLong ? "L" : "S");
}

function padCancel() {
  if (!padActive) return;
  padActive = false;
  clearTimeout(padTimer);
  padTimer = null;
  padArmed = false;
  el.pad.classList.remove("is-pressed", "is-armed");
}

el.pad.addEventListener("pointerdown", padDown);
el.pad.addEventListener("pointerup", padUp);
el.pad.addEventListener("pointercancel", padCancel);
el.pad.addEventListener("pointerleave", padCancel);

/* Keyboard fallback for the pad: Space/Enter = S, Shift+Space/Shift+Enter = L,
   or press-and-hold Space for LONG_PRESS_MS to enter L. */
el.pad.addEventListener("keydown", (e) => {
  if (!cur || el.pad.disabled) return;
  if (e.key !== " " && e.key !== "Enter") return;
  if (e.repeat) return;
  e.preventDefault();
  padActive = true;
  padDownAt = performance.now();
  padArmed = false;
  el.pad.classList.add("is-pressed");
  padTimer = setTimeout(() => {
    if (!padActive) return;
    padArmed = true;
    el.pad.classList.remove("is-pressed");
    el.pad.classList.add("is-armed");
    if (canVibrate) navigator.vibrate(35);
  }, LONG_PRESS_MS);
});

el.pad.addEventListener("keyup", (e) => {
  if (!padActive) return;
  if (e.key !== " " && e.key !== "Enter") return;
  e.preventDefault();
  padActive = false;
  clearTimeout(padTimer);
  padTimer = null;
  const held = performance.now() - padDownAt;
  const isLong = padArmed || held >= LONG_PRESS_MS;
  el.pad.classList.remove("is-pressed", "is-armed");
  padArmed = false;
  appendSymbol(isLong ? "L" : "S");
});

/* Prevent the browser's native long-press context menu on the pad */
el.pad.addEventListener("contextmenu", (e) => e.preventDefault());

/* -------- Submit -------- */

el.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cur || !el.answer.value.trim()) {
    say("Enter your answer first — tap or hold the pad, or type it.", "bad");
    el.answer.focus();
    return;
  }
  setBusy(true);
  clearTimers();

  const { data } = await post("/api/verify", {
    token: cur.token,
    answer: el.answer.value,
    replays,
  });

  if (data.ok) {
    say("Verified. You're human.", "ok");
    el.fresh.focus();
    return;
  }

  const why = data.reason === "expired"
    ? "That challenge expired."
    : "That answer didn't match.";
  await loadChallenge(`${why} A new challenge is ready.`);
});

el.fresh.addEventListener("click", () => loadChallenge());

/* -------- Boot -------- */

if (canVibrate) loadChallenge();