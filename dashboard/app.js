// ===== Firebase setup (bundled with the extension, shares its sign-in) =====
import {
  addDoc, collection, doc, onSnapshot, orderBy, query, serverTimestamp,
  updateDoc, where
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth/web-extension";
import { auth, db } from "../src/firebase";
import { signInWithGoogle } from "../src/auth";
import { isProfessorEmail, MEET_CODE_RE } from "../src/config";

// The extension writes to "events" (see background.js)
const EVENTS_COLLECTION = "events";

// The popup opens this page as dashboard/index.html?room=abc-defg-hij.
// Without a valid room, every meeting from today is shown.
const params = new URLSearchParams(window.location.search);
const roomParam = (params.get("room") || params.get("meetingCode") || "").trim().toLowerCase();
let ROOM = MEET_CODE_RE.test(roomParam) ? roomParam : null;

let rawEvents = [];
let todayEvents = [];
let studentData = [];
let eventsUnsubscribe = null;
let sessionsUnsubscribe = null;
let roomSessions = [];
let currentSession = null;
let signedInProfessor = false;
let sessionBusy = false;
const PRESENCE_TIMEOUT_MS = 75000;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function buildStudentRows(events, asOf = Date.now()) {
  const byStudent = new Map();
  events.forEach(evt => {
    if (!evt.email) return;
    if (!byStudent.has(evt.email)) byStudent.set(evt.email, []);
    byStudent.get(evt.email).push(evt);
  });

  const rows = [];

  byStudent.forEach((evts, email) => {
    evts.sort((a, b) => a.time - b.time);

    let inMeet = false, away = false, idle = false, everJoined = false;
    let switches = 0, activeMs = 0, focusedSince = null;
    let name = email;

    const settle = t => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = t;
      if (!focused && focusedSince !== null) {
        activeMs += t - focusedSince;
        focusedSince = null;
      }
    };

    evts.forEach(evt => {
      if (evt.student) name = evt.student;
      switch (evt.type) {
        case "JOINED":   inMeet = true; away = false; idle = false; everJoined = true; break;
        case "RETURNED": inMeet = true; away = false; everJoined = true; break;
        case "AWAY":     inMeet = true; away = true; switches += 1; everJoined = true; break;
        case "LEFT":     inMeet = false; away = false; idle = false; break;
        case "IDLE":
        case "LOCKED":   idle = true; break;
        case "ACTIVE":   idle = false; break;
      }
      settle(evt.time);
    });

    if (!everJoined) return;

    const last = evts[evts.length - 1];
    const presenceExpired = inMeet && asOf > last.time + PRESENCE_TIMEOUT_MS;
    if (focusedSince !== null) {
      const effectiveAsOf = inMeet ? Math.min(asOf, last.time + PRESENCE_TIMEOUT_MS) : asOf;
      activeMs += Math.max(0, effectiveAsOf - focusedSince);
    }

    const status = !inMeet ? "Left" : presenceExpired ? "Not detected" : away ? "Away" : idle ? "Idle" : "Active";
    const lastVisibleEvent = evts.slice().reverse().find(evt => evt.type !== "HEARTBEAT") || last;

    rows.push({
      name,
      email,
      status,
      focusDuration: `${Math.round(activeMs / 60000)} m focus`,
      switches,
      lastEvent: humanizeEventType(lastVisibleEvent.type),
      lastTime: new Date(lastVisibleEvent.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    });
  });

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeStudentActivity(events, asOf = Date.now()) {
  const sorted = events.slice().sort((a, b) => a.time - b.time);
  const counts = new Map();
  let inMeet = false;
  let away = false;
  let idle = false;
  let switches = 0;
  let meetingMs = 0;
  let focusedMs = 0;
  let awayMs = 0;
  let idleMs = 0;
  let previousTime = null;

  const accumulate = time => {
    if (previousTime === null || !inMeet) return;
    const duration = Math.max(0, time - previousTime);
    meetingMs += duration;
    if (away) awayMs += duration;
    else if (idle) idleMs += duration;
    else focusedMs += duration;
  };

  for (const evt of sorted) {
    accumulate(evt.time);
    counts.set(evt.type, (counts.get(evt.type) || 0) + 1);
    switch (evt.type) {
      case "JOINED":
      case "RETURNED":
        inMeet = true;
        away = false;
        if (evt.type === "JOINED") idle = false;
        break;
      case "AWAY":
        inMeet = true;
        away = true;
        switches += 1;
        break;
      case "LEFT":
        inMeet = false;
        away = false;
        idle = false;
        break;
      case "IDLE":
      case "LOCKED":
        idle = true;
        break;
      case "ACTIVE":
        idle = false;
        break;
    }
    previousTime = evt.time;
  }
  const last = sorted[sorted.length - 1];
  const presenceExpired = inMeet && last && asOf > last.time + PRESENCE_TIMEOUT_MS;
  accumulate(inMeet && last ? Math.min(asOf, last.time + PRESENCE_TIMEOUT_MS) : asOf);

  return {
    counts,
    switches,
    meetingMs,
    focusedMs,
    awayMs,
    idleMs,
    presenceExpired,
    focusPercent: meetingMs ? Math.round(focusedMs / meetingMs * 100) : 0,
    events: sorted
  };
}

function humanizeEventType(type) {
  switch (type) {
    case "JOINED": return "Joined the Google Meet";
    case "RETURNED": return "Returned to Google Meet";
    case "AWAY": return "Switched Tab";
    case "IDLE": return "No Movements";
    case "ACTIVE": return "Active again";
    case "LOCKED": return "Screen Locked";
    case "LEFT": return "Left the meeting";
    case "TABS_UPDATED": return "Open tab count changed";
    case "HEARTBEAT": return "Presence check";
    default: return type;
  }
}

function refresh() {
  const cutoff = sessionAsOfTime();
  let events = rawEvents;
  if (currentSession?.status === "ended") {
    events = rawEvents
      .filter(evt => evt.time <= cutoff)
      .concat([...new Set(rawEvents.map(evt => evt.email).filter(Boolean))].map(email => ({
        type: "LEFT",
        time: cutoff,
        email,
        student: rawEvents.find(evt => evt.email === email)?.student || email
      })));
  }
  studentData = buildStudentRows(events, cutoff);
  renderTable();
  updateStats();
  updateSessionControls();
}

function sessionAsOfTime() {
  return currentSession?.status === "paused"
    ? currentSession.pausedAtMs
    : currentSession?.status === "ended"
      ? currentSession.endedAt?.toMillis?.()
        ?? currentSession.startedAtMs + currentSession.elapsedMs
      : Date.now();
}

// ===== Live subscription (today's events only) =====
function startListening() {
  if (eventsUnsubscribe) eventsUnsubscribe();
  eventsUnsubscribe = null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const since = startOfToday.getTime();

  // A room filter uses a single-field query so no composite index is needed;
  // today's events are then picked out on the client.
  const q = ROOM
    ? query(collection(db, EVENTS_COLLECTION), where("meetingCode", "==", ROOM))
    : query(
        collection(db, EVENTS_COLLECTION),
        where("time", ">=", since),
        orderBy("time", "asc")
      );

  eventsUnsubscribe = onSnapshot(q, snapshot => {
    todayEvents = snapshot.docs
      .map(d => d.data())
      .filter(e => typeof e.time === "number" && e.time >= since);
    rawEvents = ROOM
      ? currentSession
        ? todayEvents.filter(e => e.sessionId === currentSession.id)
        : []
      : todayEvents;
    refresh();
  }, err => {
    console.error("Failed to load events:", err);
    showTableMessage(
      err.code === "permission-denied"
        ? "This account isn't authorized to view the dashboard."
        : "Couldn't load events. Check the console."
    );
  });
}

function startSessionListening() {
  if (sessionsUnsubscribe) sessionsUnsubscribe();
  sessionsUnsubscribe = null;
  roomSessions = [];
  currentSession = null;
  rawEvents = ROOM ? [] : todayEvents;
  refresh();
  if (!ROOM || !signedInProfessor) {
    updateSessionControls();
    return;
  }

  const q = query(collection(db, "sessions"), where("meetingCode", "==", ROOM));
  sessionsUnsubscribe = onSnapshot(q, snapshot => {
    roomSessions = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    currentSession = roomSessions[0] || null;
    rawEvents = currentSession
      ? todayEvents.filter(e => e.sessionId === currentSession.id)
      : [];
    refresh();
    setSessionMessage(currentSession
      ? `${currentSession.course} · ${currentSession.classLabel} · ${currentSession.status}`
      : "Enter a Meet code, then start a class session.");
  }, err => {
    console.error("Failed to load class sessions:", err);
    setSessionMessage("Couldn't load class sessions. Check the console.");
  });
}

function stopListening() {
  if (eventsUnsubscribe) eventsUnsubscribe();
  if (sessionsUnsubscribe) sessionsUnsubscribe();
  eventsUnsubscribe = null;
  sessionsUnsubscribe = null;
  roomSessions = [];
  currentSession = null;
  todayEvents = [];
  rawEvents = [];
  studentData = [];
  signedInProfessor = false;
  updateSessionControls();
}

function showTableMessage(msg) {
  const tbody = document.getElementById("student-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="4">${escapeHtml(msg)}</td></tr>`;
}

function getDotClass(status) {
  switch (status.toLowerCase()) {
    case 'active': return 'dot-active';
    case 'away': return 'dot-away';
    case 'idle': return 'dot-idle';
    case 'left': return 'dot-left';
    case 'not detected': return 'dot-left';
    default: return '';
  }
}

function renderTable() {
  const tbody = document.getElementById("student-tbody");
  if (!tbody) return;

  if (studentData.length === 0) {
    showTableMessage(ROOM ? `No student activity in ${ROOM} today.` : "No student activity yet.");
    return;
  }

  tbody.innerHTML = studentData.map(s => {
    const isLeft = ['left', 'not detected'].includes(s.status.toLowerCase());
    return `
      <tr class="${isLeft ? 'row-left' : ''}">
        <td class="student-col">
          <button type="button" class="student-detail-trigger" data-student-email="${escapeHtml(s.email)}"
            aria-label="View activity details for ${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>
          <div class="email">${escapeHtml(s.email)}</div>
        </td>
        <td>
          <div class="status-cell">
            <span class="table-dot ${getDotClass(s.status)}"></span>
            ${escapeHtml(s.status)}
          </div>
        </td>
        <td>
          <div class="duration-primary">${escapeHtml(s.focusDuration)}</div>
          <div class="duration-secondary">${s.switches} Switch/s</div>
        </td>
        <td>
          <div class="event-name">${escapeHtml(s.lastEvent)}</div>
          <div class="event-time">${escapeHtml(s.lastTime)}</div>
        </td>
      </tr>
    `;
  }).join('');
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} h ${minutes} m` : `${minutes} m`;
}

function formatEventTime(milliseconds) {
  return new Date(milliseconds).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function showStudentDetails(email) {
  const events = rawEvents.filter(evt => evt.email === email);
  const student = studentData.find(item => item.email === email);
  const dialog = document.getElementById("student-details");
  const name = document.getElementById("student-detail-name");
  const studentEmail = document.getElementById("student-detail-email");
  const content = document.getElementById("student-detail-content");
  if (!student || !dialog || !name || !studentEmail || !content) return;

  const stats = summarizeStudentActivity(events, sessionAsOfTime());
  name.textContent = student.name;
  studentEmail.textContent = student.email;

  const switchEvents = stats.events.filter(evt => evt.type === "AWAY").reverse();
  const timeline = stats.events.slice().reverse().slice(0, 100);
  const eventCounts = ["JOINED", "RETURNED", "AWAY", "IDLE", "LOCKED", "ACTIVE", "LEFT", "TABS_UPDATED"];
  content.innerHTML = `
    <p class="detail-status">Current status: <strong>${escapeHtml(student.status)}</strong></p>
    <div class="detail-stats">
      <div><span>Tab switches</span><strong>${stats.switches}</strong></div>
      <div><span>Estimated active</span><strong>${escapeHtml(formatDuration(stats.focusedMs))}</strong></div>
      <div><span>Active share</span><strong>${stats.focusPercent}%</strong></div>
      <div><span>Away</span><strong>${escapeHtml(formatDuration(stats.awayMs))}</strong></div>
      <div><span>Idle / locked</span><strong>${escapeHtml(formatDuration(stats.idleMs))}</strong></div>
      <div><span>Time in meeting</span><strong>${escapeHtml(formatDuration(stats.meetingMs))}</strong></div>
    </div>
    <p class="detail-disclaimer">Activity estimates come from browser tab visibility and idle signals; they don't measure attention.</p>
    <section class="detail-section">
      <h3>Activity counts</h3>
      <ul class="detail-counts">
        ${eventCounts.map(type => `<li>${escapeHtml(humanizeEventType(type))}<strong>${stats.counts.get(type) || 0}</strong></li>`).join("")}
      </ul>
    </section>
    <section class="detail-section">
      <h3>Tab switches</h3>
      ${switchEvents.length
        ? `<ol class="detail-timeline">${switchEvents.map(evt => `<li><time>${escapeHtml(formatEventTime(evt.time))}</time><span>Switched away from the Meet tab</span></li>`).join("")}</ol>`
        : '<p class="detail-empty">No tab switches recorded for this session.</p>'}
    </section>
    <section class="detail-section">
      <h3>Recent activity (${timeline.length}${stats.events.length > timeline.length ? ` of ${stats.events.length}` : ""})</h3>
      ${timeline.length
        ? `<ol class="detail-timeline">${timeline.map(evt => `<li><time>${escapeHtml(formatEventTime(evt.time))}</time><span>${escapeHtml(humanizeEventType(evt.type))}</span></li>`).join("")}</ol>`
        : '<p class="detail-empty">No events recorded.</p>'}
    </section>
  `;
  dialog.showModal();
}

function initStudentDetails() {
  document.getElementById("student-tbody")?.addEventListener("click", event => {
    const trigger = event.target.closest("[data-student-email]");
    if (trigger) showStudentDetails(trigger.dataset.studentEmail);
  });
  document.getElementById("close-student-details")?.addEventListener("click", () => {
    document.getElementById("student-details")?.close();
  });
  document.getElementById("student-details")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
}

// ===== Stat cards (Attendance / Focused / Away) =====
function updateStats() {
  const total = studentData.length;
  const present = studentData.filter(s => !['left', 'not detected'].includes(s.status.toLowerCase())).length;
  const focusedCount = studentData.filter(s => s.status.toLowerCase() === 'active').length;
  const awayCount = studentData.filter(s => s.status.toLowerCase() === 'away').length;

  const attendanceEl = document.getElementById('stat-attendance');
  const focusedEl = document.getElementById('stat-focused');
  const awayEl = document.getElementById('stat-away');

  if (attendanceEl) attendanceEl.textContent = `${present}/${total}`;
  if (focusedEl) focusedEl.textContent = focusedCount;
  if (awayEl) awayEl.textContent = awayCount;
}

// ===== Session header (room + date) =====
function renderSessionMeta() {
  const roomInput = document.getElementById("session-meet-code");
  if (roomInput) roomInput.value = ROOM || "";

  const codeEl = document.getElementById('meet-code');
  if (codeEl) {
    if (ROOM) {
      codeEl.textContent = ROOM;
      codeEl.href = `https://meet.google.com/${ROOM}`;
    } else {
      codeEl.textContent = 'All meetings today';
      codeEl.removeAttribute('href');
    }
  }

  const dateEl = document.getElementById('session-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString([], {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  document.title = ROOM ? `${ROOM} | PUP iSEENTA` : 'PUP iSEENTA | Focus Dashboard';
}

function setSessionMessage(message) {
  const status = document.getElementById("session-message");
  if (status) status.textContent = message;
}

function sessionIsOwned() {
  return !!currentSession && currentSession.teacherUid === auth.currentUser?.uid;
}

function updateTimerDisplay() {
  const timerEl = document.getElementById('timer-value');
  if (!timerEl) return;
  const elapsedMs = (currentSession?.elapsedMs || 0)
    + (currentSession?.status === "active"
      ? Math.max(0, Date.now() - currentSession.startedAtMs)
      : 0);
  timerEl.textContent = formatTime(Math.floor(elapsedMs / 1000));
}

function updateSessionControls() {
  const owned = sessionIsOwned();
  const status = currentSession?.status;
  const busy = sessionBusy;
  const roomInput = document.getElementById("session-meet-code");
  const courseInput = document.getElementById("session-course");
  const labelInput = document.getElementById("session-class-label");
  const startButton = document.getElementById("btn-start");
  const pauseButton = document.getElementById("btn-pause");
  const endButton = document.getElementById("btn-end");
  const sessionLocked = owned && (status === "active" || status === "paused");

  if (roomInput) roomInput.disabled = sessionLocked;
  if (courseInput) courseInput.disabled = sessionLocked;
  if (labelInput) labelInput.disabled = sessionLocked;
  if (startButton) {
    startButton.disabled = !signedInProfessor || busy || !ROOM
      || status === "active";
  }
  if (pauseButton) pauseButton.disabled = !owned || busy || status !== "active";
  if (endButton) endButton.disabled = !owned || busy || !["active", "paused"].includes(status);
  updateTimerDisplay();
}

function formatTime(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function startSession() {
  if (!signedInProfessor) throw new Error("Sign in with an authorized professor account first.");
  if (!ROOM || !MEET_CODE_RE.test(ROOM)) throw new Error("Enter a valid Google Meet code first.");
  if (currentSession?.status === "active") throw new Error("A class session is already active for this Meet.");

  const now = Date.now();
  if (sessionIsOwned() && currentSession.status === "paused") {
    await updateDoc(doc(db, "sessions", currentSession.id), {
      status: "active",
      startedAtMs: now,
      elapsedMs: currentSession.elapsedMs,
      pausedAtMs: null,
      updatedAt: serverTimestamp()
    });
    setSessionMessage("Class session resumed.");
    return;
  }

  const course = document.getElementById("session-course")?.value.trim() || "";
  const classLabel = document.getElementById("session-class-label")?.value.trim() || "";
  if (!course || !classLabel) throw new Error("Enter both a course and class label before starting.");

  await addDoc(collection(db, "sessions"), {
    status: "active",
    meetingCode: ROOM,
    course,
    classLabel,
    startedAtMs: now,
    elapsedMs: 0,
    startedAt: serverTimestamp(),
    teacherUid: auth.currentUser.uid
  });
  setSessionMessage("Class session started. Students in this Meet can now be tracked.");
}

async function pauseSession() {
  if (!sessionIsOwned() || currentSession.status !== "active") return;
  const now = Date.now();
  const elapsedMs = currentSession.elapsedMs + Math.max(0, now - currentSession.startedAtMs);
  await updateDoc(doc(db, "sessions", currentSession.id), {
    status: "paused",
    elapsedMs,
    pausedAtMs: now,
    updatedAt: serverTimestamp()
  });
  setSessionMessage("Class session paused.");
}

async function endSession() {
  if (!sessionIsOwned() || !["active", "paused"].includes(currentSession.status)) return;
  const now = Date.now();
  const elapsedMs = currentSession.elapsedMs + (currentSession.status === "active"
    ? Math.max(0, now - currentSession.startedAtMs)
    : 0);
  await updateDoc(doc(db, "sessions", currentSession.id), {
    status: "ended",
    elapsedMs,
    endedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  setSessionMessage("Class session ended.");
}

async function runSessionAction(action) {
  if (sessionBusy) return;
  sessionBusy = true;
  updateSessionControls();
  try {
    await action();
  } catch (err) {
    console.error("Failed to update class session:", err);
    setSessionMessage(err.message || "Couldn't update the class session.");
  } finally {
    sessionBusy = false;
    updateSessionControls();
  }
}

// ===== Professor sign-in =====
function initAuth() {
  const link = document.getElementById('nav-signin');

  link?.addEventListener('click', async e => {
    e.preventDefault();
    try {
      if (auth.currentUser) {
        await chrome.runtime.sendMessage({ cmd: 'signOut' });
      } else {
        await signInWithGoogle({ interactive: true });
      }
    } catch (err) {
      console.error(err);
      showTableMessage(err.message || 'Sign-in failed. Try again.');
    }
  });

  onAuthStateChanged(auth, user => {
    if (link) link.textContent = user ? 'SIGN OUT' : 'SIGN IN';

    if (user && isProfessorEmail(user.email)) {
      signedInProfessor = true;
      // Don't overwrite an active student profile on the same browser — that would
      // silently stop their event sync (saveEvent requires role 'student')
      chrome.storage.local.get("profile").then(({ profile }) => {
        if (profile?.role === "student") return;
        chrome.storage.local.set({
          profile: { role: 'professor', uid: user.uid, email: user.email, name: user.displayName || user.email }
        });
      });
      startListening();
      startSessionListening();
      return;
    }

    stopListening();
    updateStats();
    showTableMessage(user
      ? `${user.email} isn't recognized as a professor. Sign out and use a professor account.`
      : 'Sign in with your professor account to view activity.');
  });

  setInterval(() => { if (rawEvents.length) refresh(); }, 30000);
}

function initControlButtons() {
  document.getElementById('btn-start')?.addEventListener('click', () => runSessionAction(startSession));
  document.getElementById('btn-pause')?.addEventListener('click', () => runSessionAction(pauseSession));
  document.getElementById('btn-end')?.addEventListener('click', () => runSessionAction(endSession));

  document.getElementById("session-meet-code")?.addEventListener("change", event => {
    const value = event.currentTarget.value.trim().toLowerCase();
    if (value && !MEET_CODE_RE.test(value)) {
      ROOM = null;
      renderSessionMeta();
      if (signedInProfessor) {
        startListening();
        startSessionListening();
      }
      setSessionMessage("Enter a valid Meet code in the format abc-defg-hij.");
      return;
    }
    ROOM = value || null;
    renderSessionMeta();
    if (signedInProfessor) {
      startListening();
      startSessionListening();
    } else {
      updateSessionControls();
    }
  });

  updateSessionControls();
  setInterval(updateTimerDisplay, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  renderSessionMeta();
  updateTimerDisplay();
  initControlButtons();
  initStudentDetails();
  initAuth();
});