// Runs on every meet.google.com page. Reports JOINED only once the student is actually
// in a call in a real room, then AWAY/RETURNED on focus changes and LEFT on exit.

import { MEET_CODE_RE } from "./config";

// Ignore focus changes shorter than this (e.g. opening the extension popup, a quick alt-tab)
const AWAY_DEBOUNCE_MS = 1500;
// How often to re-check call state; Meet is a single-page app, so the URL and DOM change in place
const POLL_MS = 1000;

let currentRoom = null;   // room we've reported JOINED for
let away = false;
let awayTimer = null;

function roomFromLocation() {
  const code = location.pathname.slice(1).toLowerCase();
  return MEET_CODE_RE.test(code) ? code : null;
}

// The "Leave call" button only exists once the student is in the call (not the lobby or post-call screen)
function inCall() {
  return !!document.querySelector('[aria-label*="leave call" i]');
}

function sendEvent(type, meetingCode, extra = {}) {
  try {
    return chrome.runtime.sendMessage({ type, time: Date.now(), meetingCode, ...extra }).catch(() => null);
  } catch (e) {
    // Extension was reloaded or updated; this old content script can no longer talk to it
    return Promise.resolve();
  }
}

// Visible but unfocused usually means the extension popup, DevTools or another window
// on top of Meet; only a hidden tab counts as definitely away.
function isAwayNow() {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

function onFocusChange() {
  if (!currentRoom) return;
  clearTimeout(awayTimer);

  awayTimer = null;

  if (!isAwayNow()) {
    if (away) {
      away = false;
      sendEvent("RETURNED", currentRoom);
    }
    return;
  }

  if (away) return;
  // A hidden tab is away right away; a blur with the tab still visible must last a bit
  const delay = document.visibilityState === "hidden" ? 0 : AWAY_DEBOUNCE_MS;
  awayTimer = setTimeout(async () => {
    awayTimer = null;
    if (!currentRoom || !isAwayNow() || away) return;
    away = true;
    const visible = document.visibilityState === "visible";
    const reply = await sendEvent("AWAY", currentRoom, { visible }).catch(() => null);
    // Focus went to the extension popup: not away, and no RETURNED needed later
    if (reply?.ignored) away = false;
  }, delay);
}

function leave() {
  if (!currentRoom) return;
  clearTimeout(awayTimer);
  sendEvent("LEFT", currentRoom);
  currentRoom = null;
  away = false;
}

function checkCallState() {
  const room = roomFromLocation();
  const live = room && inCall();

  // Navigated to another room without leaving the first one
  if (currentRoom && currentRoom !== room) leave();

  if (live && !currentRoom) {
    currentRoom = room;
    away = false;
    sendEvent("JOINED", room);
    onFocusChange();
  } else if (!live && currentRoom) {
    // Hung up: back on the lobby, home or "You left the meeting" screen
    leave();
  } else if (currentRoom && !away && !awayTimer && isAwayNow()) {
    // Still unfocused after an ignored blur (e.g. popup closed and student clicked another window)
    onFocusChange();
  }
}

window.addEventListener("blur", onFocusChange);
window.addEventListener("focus", onFocusChange);
document.addEventListener("visibilitychange", onFocusChange);
window.addEventListener("pagehide", leave);
window.addEventListener("beforeunload", leave);

setInterval(checkCallState, POLL_MS);
checkCallState();
