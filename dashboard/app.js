// ===== Firebase setup (bundled with the extension, shares its sign-in) =====
import { collection, query, where, orderBy, onSnapshot } from "firebase/firestore";
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
const ROOM = MEET_CODE_RE.test(roomParam) ? roomParam : null;

let rawEvents = [];
let studentData = [];
let unsubscribe = null;

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function buildStudentRows(events) {
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

    // Ignore people with only idle events (never actually in a Meet)
    if (!everJoined) return;

    if (focusedSince !== null) activeMs += Date.now() - focusedSince;

    const status = !inMeet ? "Left" : away ? "Away" : idle ? "Idle" : "Active";
    const last = evts[evts.length - 1];

    rows.push({
      name,
      email,
      status,
      focusDuration: `${Math.round(activeMs / 60000)} m focus`,
      switches,
      lastEvent: humanizeEventType(last.type),
      lastTime: new Date(last.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    });
  });

  return rows.sort((a, b) => a.name.localeCompare(b.name));
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
    default: return type;
  }
}

function refresh() {
  studentData = buildStudentRows(rawEvents);
  renderTable();
  updateStats();
}

// ===== Live subscription (today's events only) =====
function startListening() {
  stopListening();
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

  unsubscribe = onSnapshot(q, snapshot => {
    rawEvents = snapshot.docs
      .map(d => d.data())
      .filter(e => typeof e.time === "number" && e.time >= since);
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

function stopListening() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  rawEvents = [];
  studentData = [];
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
    const isLeft = s.status.toLowerCase() === 'left';
    return `
      <tr class="${isLeft ? 'row-left' : ''}">
        <td class="student-col">
          <div class="name">${escapeHtml(s.name)}</div>
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

// ===== Stat cards (Attendance / Focused / Away) =====
function updateStats() {
  const total = studentData.length;
  const present = studentData.filter(s => s.status.toLowerCase() !== 'left').length;
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
      chrome.storage.local.set({
        profile: { role: 'professor', uid: user.uid, email: user.email, name: user.displayName }
      });
      startListening();
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

let timerInterval = null;
let elapsedSeconds = 0;

function formatTime(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateTimerDisplay() {
  const timerEl = document.getElementById('timer-value');
  if (timerEl) timerEl.textContent = formatTime(elapsedSeconds);
}

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function endTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  elapsedSeconds = 0;
  updateTimerDisplay();
}

function initControlButtons() {
  document.getElementById('btn-start')?.addEventListener('click', startTimer);
  document.getElementById('btn-pause')?.addEventListener('click', pauseTimer);
  document.getElementById('btn-end')?.addEventListener('click', endTimer);
}

document.addEventListener('DOMContentLoaded', () => {
  renderSessionMeta();
  updateTimerDisplay();
  initControlButtons();
  initAuth();
});