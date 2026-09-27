"use strict";

/* =========================================================
   Haptic Verify — single-pad CAPTCHA (tap/hold only, no mic)
   Flow:
     page loads  →  silent, waits for the user's first tap
     first tap   →  instructions → "Starting CAPTCHA" → pattern
       →  answer (tap/hold or keyboard)  →  auto-submit
     wrong       →  "didn't match"  →  replay pattern (no new instructions)
     2x wrong    →  "new CAPTCHA"   →  new pattern, input fully reset
     25s time    →  "time's up"     →  new pattern
   ========================================================= */

const $ = (s) => document.querySelector(s);
const display = $("#display");
const srStatus = $("#sr-status");

/* ------------- Tunables ------------- */
const LONG_PRESS_MS = 450;
const MAX_WRONG_TRIES = 2;
const TTL_SECONDS = 25;

/* ------------- State ------------- */
let cur = null;
let answer = "";
let wrongTries = 0;
let busy = false;
let expired = false;
let firstRun = true;
let sessionStarted = false;

let padDownAt = 0;
let padTimer = null;
let padActive = false;
let padArmed = false;

let ttlTimer = null;
let ttlDeadline = 0;
let submitInFlight = false;

/* ------------- Speech synthesis ------------- */
const synth = ("speechSynthesis" in window) ? window.speechSynthesis : null;
let lastSpoken = "";
let lastSpokenAt = 0;

function speak(text, { rate = 1, pitch = 1, force = false } = {}) {
  if (!synth || !text) return;
  const now = performance.now();
  if (!force && text === lastSpoken && now - lastSpokenAt < 400) return;
  lastSpoken = text;
  lastSpokenAt = now;
  if (force) { try { synth.cancel(); } catch (_) {} }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate;
  u.pitch = pitch;
  u.lang = "en-US";
  try { synth.speak(u); } catch (_) {}
}

function stopSpeaking() {
  if (synth) { try { synth.cancel(); } catch (_) {} }
}

/**
 * Returns a Promise that resolves when speech finishes — or when a safety
 * timeout expires. Some browsers silently drop utterances; the timeout
 * ensures the boot sequence never hangs waiting for onend.
 */
function speakAsync(text, opts = {}) {
  return new Promise((resolve) => {
    if (!synth) { resolve(); return; }

    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? 1;
    u.pitch = opts.pitch ?? 1;
    u.lang = "en-US";

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    u.onend = finish;
    u.onerror = finish;

    // Safety net: estimate duration from text length (~15 chars/sec) plus
    // generous slack. Guarantees the promise settles even if the engine
    // silently swallows the utterance.
    const estimatedMs = Math.max(4000, (text.length / 15) * 1000 + 4000);
    const safety = setTimeout(finish, estimatedMs);

    // Only cancel when explicitly asked. Calling cancel() here in the past
    // was eating the very first utterance the user was supposed to hear.
    if (opts.force) {
      try { synth.cancel(); } catch (_) {}
    }

    try {
      synth.speak(u);
    } catch (_) {
      clearTimeout(safety);
      finish();
    }
  });
}

function announce(text, opts = {}) {
  srStatus.textContent = text;
  speak(text, opts);
}

/* ------------- Vibration ------------- */
const canVibrate = "vibrate" in navigator;
function buzzPattern(seq) { if (canVibrate) { try { navigator.vibrate(seq); } catch (_) {} } }
function buzzShort()   { buzzPattern(25); }
function buzzLong()    { buzzPattern([40, 60, 40]); }
function buzzArm()     { buzzPattern(35); }
function buzzError()   { buzzPattern([80, 50, 80, 50, 80]); }
function buzzSuccess() { buzzPattern([40, 40, 40, 40, 120]); }

/* ------------- Display ------------- */
function renderAnswer() {
  if (!answer) { display.textContent = ""; return; }
  display.innerHTML = answer
    .split("")
    .map((c) => `<span class="${c === "L" ? "l" : "s"}">${c}</span>`)
    .join("");
}

function appendSymbol(sym) {
  if (!sessionStarted) return;
  if (busy || expired || !cur) return;
  if (answer.length >= 16) return;
  answer += sym;
  renderAnswer();
  if (sym === "L") buzzLong(); else buzzShort();
  maybeAutoSubmit();
}

function clearAnswer() { answer = ""; renderAnswer(); }

function resetInputState() {
  clearAnswer();
  padActive = false;
  padArmed = false;
  if (padTimer) { clearTimeout(padTimer); padTimer = null; }
  display.classList.remove("is-bad", "is-ok", "is-armed", "is-pressed");
}

/* ------------- API ------------- */
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

/* ------------- Instructions (played once, at start) ------------- */
async function announceInstructions() {
  // No `force: true` here — letting the priming utterance finish on its
  // own and queueing behind it avoids the Android Chrome bug where a
  // cancel() right before a speak() silently drops the utterance.
  await speakAsync(
    "This is a CAPTCHA. " +
    "A pattern of vibrations will be played first. " +
    "Remember the pattern. " +
    "Tap the screen for a short pulse. " +
    "Hold for one second for a long pulse. " +
    "Then repeat the pattern back. Ready?"
  );
}

/* ------------- Challenge lifecycle ------------- */
async function loadChallenge({ introText = "", replayPattern = false } = {}) {
  if (!canVibrate) {
    announce("Vibration is not available on this device. " +
             "Try an Android phone with Chrome or Firefox.", { force: true });
    display.classList.add("is-bad");
    return;
  }

  clearTimers();
  busy = true;
  expired = false;
  submitInFlight = false;
  cur = null;
  resetInputState();

  const { status, data, retry } = await post("/api/challenge", {});

  if (status === 429) {
    announce(`Too many attempts. Please wait ${retry} seconds.`, { force: true });
    display.classList.add("is-bad");
    setTimeout(() => {
      display.classList.remove("is-bad");
      loadChallenge();
    }, Math.min(retry, 60) * 1000);
    return;
  }
  if (status !== 200) {
    announce("Something went wrong. Trying again.", { force: true });
    setTimeout(() => loadChallenge(), 2000);
    return;
  }

  cur = data;

  const preamble = introText ? introText + " " : "";
  // Same reasoning as announceInstructions: no force cancel here.
  await speakAsync(`${preamble}Starting CAPTCHA.`);

  await sleep(350);
  playPattern();

  const patternDuration = computePatternDuration();
  await sleep(patternDuration + 300);

  busy = false;
  startTTLTimer();
}

function computePatternDuration() {
  if (!cur) return 0;
  const { short, long, gap } = cur.pulse_ms;
  let total = 0;
  [...cur.pattern].forEach((c, i) => {
    if (i) total += gap;
    total += c === "L" ? long : short;
  });
  return total;
}

function playPattern() {
  if (!cur || expired) return;
  const { short, long, gap } = cur.pulse_ms;
  const seq = [];
  [...cur.pattern].forEach((c, i) => {
    if (i) seq.push(gap);
    seq.push(c === "L" ? long : short);
  });
  buzzPattern(seq);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------- Timer ------------- */
function startTTLTimer() {
  clearTimers();
  ttlDeadline = performance.now() + TTL_SECONDS * 1000;
  ttlTimer = setTimeout(async () => {
    if (busy || expired) return;
    expired = true;
    display.classList.add("is-bad");
    buzzError();
    await speakAsync("Time's up. Starting a new CAPTCHA.", { force: true });
    display.classList.remove("is-bad");
    loadChallenge();
  }, TTL_SECONDS * 1000);
}

function clearTimers() {
  if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
}

/* ------------- Auto-submit ------------- */
function maybeAutoSubmit() {
  if (!cur || busy || expired) return;
  if (answer.length < cur.pattern.length) return;
  if (submitInFlight) return;
  submitInFlight = true;
  setTimeout(submitAnswer, 400);
}

async function submitAnswer() {
  if (!cur || expired) { submitInFlight = false; return; }
  clearTimers();
  busy = true;

  const submittedAnswer = answer;
  const token = cur.token;

  const { data } = await post("/api/verify", {
    token,
    answer: submittedAnswer,
    replays: 1,
  });

  if (data.ok) {
    display.classList.add("is-ok");
    buzzSuccess();
    await speakAsync("Verification succeeded. You're human.", { force: true });
    busy = true;
    expired = true;
    submitInFlight = false;
    return;
  }

  wrongTries++;
  display.classList.add("is-bad");
  buzzError();

  let preamble;
  if (wrongTries >= MAX_WRONG_TRIES) {
    wrongTries = 0;
    preamble = "Too many incorrect tries. Starting a new CAPTCHA.";
  } else {
    preamble = "That answer didn't match. Here's the pattern again.";
  }

  await sleep(300);
  display.classList.remove("is-bad");
  submitInFlight = false;

  loadChallenge({ introText: preamble, replayPattern: true });
}

/* ------------- Pad: whole screen ------------- */
function onDown(event) {
  if (!sessionStarted) return;              // ignore taps before boot
  if (busy || expired || !cur) return;
  if (event && event.cancelable) event.preventDefault();
  padActive = true;
  padDownAt = performance.now();
  padArmed = false;
  display.classList.add("is-pressed");
  display.classList.remove("is-armed");

  padTimer = setTimeout(() => {
    if (!padActive) return;
    padArmed = true;
    display.classList.remove("is-pressed");
    display.classList.add("is-armed");
    buzzArm();
  }, LONG_PRESS_MS);
}

function onUp(event) {
  if (!padActive) return;
  if (event && event.cancelable) event.preventDefault();
  padActive = false;
  clearTimeout(padTimer);
  padTimer = null;
  const held = performance.now() - padDownAt;
  const isLong = padArmed || held >= LONG_PRESS_MS;
  display.classList.remove("is-pressed", "is-armed");
  padArmed = false;
  appendSymbol(isLong ? "L" : "S");
}

function onCancel() {
  if (!padActive) return;
  padActive = false;
  clearTimeout(padTimer);
  padTimer = null;
  padArmed = false;
  display.classList.remove("is-pressed", "is-armed");
}

document.addEventListener("pointerdown", (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  onDown(e);
}, { passive: false });

document.addEventListener("pointerup", (e) => onUp(e), { passive: false });
document.addEventListener("pointercancel", onCancel);
document.addEventListener("pointerleave", onCancel);
document.addEventListener("contextmenu", (e) => e.preventDefault());

/* ------------- Keyboard ------------- */
document.addEventListener("keydown", (e) => {
  if (!sessionStarted) return;
  if (busy || expired || !cur) return;
  if (e.repeat) return;
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); onDown(null); }
});
document.addEventListener("keyup", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); onUp(null); }
});

/* ------------- Visibility ------------- */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopSpeaking();
});

/* ------------- Boot sequence ------------- */

function voicesReady() {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    if (synth.getVoices().length) return resolve();
    const done = () => {
      synth.removeEventListener("voiceschanged", done);
      resolve();
    };
    synth.addEventListener("voiceschanged", done);
    setTimeout(resolve, 800);
  });
}

async function bootSequence() {
  if (sessionStarted) return;
  sessionStarted = true;

  await voicesReady();

  if (firstRun) {
    firstRun = false;
    await announceInstructions();
    await sleep(250);
  }

  loadChallenge();
}

/* ------------- Start trigger: the user's first tap -------------
   Attached with capture=true so it fires before any other handler.
   Also listens on touchstart as a fallback because some Android Chrome
   builds have been observed not to emit pointerdown on the very first
   tap during scroll-intent detection.                             */
let bootTriggered = false;
function triggerBoot() {
  if (bootTriggered) return;
  bootTriggered = true;
  document.removeEventListener("pointerdown", onFirstPointer, true);
  document.removeEventListener("touchstart",  onFirstTouch,   true);
  document.removeEventListener("keydown",     onFirstKey,     true);
  bootSequence();
}

function onFirstPointer(e) {
  // e.button can be -1 on some Android builds during gesture detection.
  if (typeof e.button === "number" && e.button > 0) return;
  triggerBoot();
}
function onFirstTouch() { triggerBoot(); }
function onFirstKey()   { triggerBoot(); }

document.addEventListener("pointerdown", onFirstPointer, true);
document.addEventListener("touchstart",  onFirstTouch,   true);
document.addEventListener("keydown",     onFirstKey,     true);

// Prime the speech engine with a silent utterance. Some WebKit/iOS builds
// drop the very first utterance of a page. No cancel — let it finish.
if (synth) {
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch (_) {}
}

srStatus.textContent = "Tap anywhere to begin.";