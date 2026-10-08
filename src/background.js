import { collection, addDoc, Timestamp } from "firebase/firestore";
import { auth, db } from "./firebase";
import { signInWithGoogle, signOutGoogle } from "./auth";
import { isProfessorEmail, meetCodeFromUrl } from "./config";

let authInFlight = null;

// Firebase keeps the session from the popup sign-in (IndexedDB), so this is usually instant.
// If that's gone, try a silent Google sign-in.
async function ensureAuth() {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  if (authInFlight) return authInFlight;

  authInFlight = signInWithGoogle({ interactive: false })
    .catch(e => {
      console.error("[Meet Focus Tracker] Background auth failed:", e);
      return null;
    })
    .finally(() => { authInFlight = null; });

  return authInFlight;
}

async function saveEvent(evt) {
  const { profile } = await chrome.storage.local.get("profile");
  if (profile?.role !== "student" || !profile.consent) return;

  // Update the popup first so it reflects reality even if the write fails
  await chrome.storage.local.set({ currentMode: evt.type });

  const user = await ensureAuth();
  // A silent sign-in can pick up whichever Google account the browser uses, not the student's
  if (!user || user.uid !== profile.uid) {
    console.warn("[Meet Focus Tracker] Not signed in as the student; skipping event.");
    await chrome.storage.local.set({ syncError: "signed out, open the popup and sign in again" });
    return;
  }

  try {
    await addDoc(collection(db, "events"), {
      type: evt.type,
      time: evt.time,
      meetingCode: evt.meetingCode,
      student: profile.name,
      email: profile.email,
      uid: user.uid,
      timestamp: Timestamp.fromMillis(evt.time)
    });
    console.log("[Meet Focus Tracker]", profile.email, evt.type, evt.meetingCode, new Date(evt.time).toLocaleTimeString());
    await chrome.storage.local.set({ syncError: null });
  } catch (e) {
    console.error("Error adding document: ", e);
    await chrome.storage.local.set({
      syncError: e.code === "permission-denied" ? "Firestore rejected the event" : "couldn't reach Firestore"
    });
  }
}

// ===== Meeting state =====
// activeMeeting / activeMeetingTabId live in storage because the service worker can be
// stopped at any time; serialize updates so a LEFT and a JOINED can't interleave.
let queue = Promise.resolve();
function serialized(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function startMeeting(meetingCode, tabId, time) {
  const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
  if (activeMeeting === meetingCode && activeMeetingTabId === tabId) return;
  // Joining a new call while another one is still recorded as open: close the old one
  if (activeMeeting) await saveEvent({ type: "LEFT", time, meetingCode: activeMeeting });

  await chrome.storage.local.set({ activeMeeting: meetingCode, activeMeetingTabId: tabId });
  await saveEvent({ type: "JOINED", time, meetingCode });
}

// Ends the active meeting. With tabId, only if that tab is the meeting tab.
async function endMeeting(time, tabId) {
  const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
  if (!activeMeeting) return;
  if (tabId !== undefined && tabId !== activeMeetingTabId) return;

  await chrome.storage.local.set({ activeMeeting: null, activeMeetingTabId: null });
  await saveEvent({ type: "LEFT", time, meetingCode: activeMeeting });
}

// ===== Sign-in (requested by the popup) =====
// Runs here rather than in the popup: in Brave/Edge the Google sign-in window steals focus
// and closes the popup, which would cancel a sign-in running there. The result is also
// written to storage so a reopened popup can show it.
async function handleSignIn(role) {
  await chrome.storage.local.set({ authError: null });
  try {
    const user = await signInWithGoogle({ interactive: true });

    if (role === "professor" && !isProfessorEmail(user.email)) {
      await signOutGoogle();
      await chrome.storage.local.remove("profile");
      throw new Error(`${user.email} isn't recognized as a professor. You can only continue as a student.`);
    }

    const profile = { role, uid: user.uid, email: user.email, name: user.displayName };
    if (role === "student") profile.consent = true;
    await chrome.storage.local.set({ profile, syncError: null });

    if (role === "professor") {
      await openDashboard();
    } else {
      // Signed in mid-call: the JOINED sent earlier was skipped, so record it now
      const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
      if (activeMeeting) await saveEvent({ type: "JOINED", time: Date.now(), meetingCode: activeMeeting });
    }
    return { ok: true };
  } catch (e) {
    console.error("[Meet Focus Tracker] Sign-in failed:", e);
    const error = e.message || "Sign-in failed. Try again.";
    await chrome.storage.local.set({ authError: { role, message: error } });
    return { ok: false, error };
  }
}

// Opens the dashboard for the Meet room in the focused tab, else the last tracked room
async function openDashboard() {
  let room = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    room = tab?.url ? meetCodeFromUrl(tab.url) : null;
  } catch {
    // No focused window
  }
  if (!room) ({ activeMeeting: room } = await chrome.storage.local.get("activeMeeting"));

  const path = room ? `dashboard/index.html?room=${encodeURIComponent(room)}` : "dashboard/index.html";
  await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === "signIn" && !sender.tab) {
    if (msg.role !== "student" && msg.role !== "professor") return;
    if (msg.role === "student" && msg.consent !== true) return;
    handleSignIn(msg.role).then(sendResponse);
    return true; // respond asynchronously
  }
  if (msg?.cmd === "signOut" && !sender.tab) {
    // Record LEFT for an open meeting while still signed in, then sign out
    serialized(() => endMeeting(Date.now()))
      .then(() => chrome.storage.local.remove(["profile", "currentMode", "syncError", "authError"]))
      .then(() => signOutGoogle())
      .catch(e => console.error("[Meet Focus Tracker] Sign-out failed:", e))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.cmd === "openDashboard" && !sender.tab) {
    openDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }

  const tabId = sender.tab?.id;
  if (!msg?.type || tabId === undefined) return;

  // Opening this extension's popup takes focus from the Meet window without hiding the tab;
  // that's not the student leaving, so tell the content script to ignore it
  if (msg.type === "AWAY" && msg.visible && popupOpen) {
    sendResponse({ ignored: true });
    return;
  }

  serialized(async () => {
    if (msg.type === "JOINED") return startMeeting(msg.meetingCode, tabId, msg.time);
    if (msg.type === "LEFT") return endMeeting(msg.time, tabId);

    // AWAY / RETURNED only count for the tab we're tracking
    const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
    if (activeMeeting && activeMeetingTabId === tabId && msg.meetingCode === activeMeeting) {
      await saveEvent({ type: msg.type, time: msg.time, meetingCode: activeMeeting });
    }
  });
});

// The popup holds a port open while it's showing
let popupOpen = false;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "popup" || port.sender?.tab) return;
  popupOpen = true;
  port.onDisconnect.addListener(() => { popupOpen = false; });
});

// Tab closed (content script may not get to send LEFT)
chrome.tabs.onRemoved.addListener(tabId => {
  serialized(() => endMeeting(Date.now(), tabId));
});

// Meeting tab navigated away from the room (to another site, the Meet home page, another room)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  serialized(async () => {
    const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
    if (activeMeeting && tabId === activeMeetingTabId && meetCodeFromUrl(changeInfo.url) !== activeMeeting) {
      await endMeeting(Date.now(), tabId);
    }
  });
});

// Browser restarted or extension reloaded: a meeting recorded as open can't still be live
async function closeStaleMeeting() {
  const { activeMeeting, activeMeetingTabId } = await chrome.storage.local.get(["activeMeeting", "activeMeetingTabId"]);
  if (!activeMeeting) return;
  try {
    const tab = await chrome.tabs.get(activeMeetingTabId);
    if (meetCodeFromUrl(tab.url || "") === activeMeeting) return;
  } catch {
    // Tab no longer exists
  }
  await endMeeting(Date.now());
}
chrome.runtime.onStartup.addListener(() => serialized(closeStaleMeeting));
chrome.runtime.onInstalled.addListener(() => serialized(async () => {
  // v1 stored the signed-in user as "student"; v2 uses "profile" with a role
  await chrome.storage.local.remove("student");
  await closeStaleMeeting();
}));

// ===== Idle detection =====
chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener(state => {
  serialized(async () => {
    const { activeMeeting } = await chrome.storage.local.get("activeMeeting");
    if (!activeMeeting) return;
    await saveEvent({ type: state.toUpperCase(), time: Date.now(), meetingCode: activeMeeting });
  });
});
