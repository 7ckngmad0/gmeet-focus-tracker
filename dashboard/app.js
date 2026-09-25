// Mock roster directly taken from Erick's UI mockup
const studentData = [
  {
    name: "A JOSE, JUSTIN GABRIEL",
    email: "justingabrielajose@gmail.com",
    status: "Active",
    focusDuration: "80 m / 89 m focus",
    switches: 1,
    lastEvent: "Returned to Google Meet",
    lastTime: "9:11 AM"
  },
  {
    name: "ARCEBUCHE, MAO MIGUEL",
    email: "maoarcebuche@gmail.com",
    status: "Idle",
    focusDuration: "75 m / 89 m focus",
    switches: 3,
    lastEvent: "No Movements",
    lastTime: "9:20 AM"
  },
  {
    name: "MURILLO, JANMANUEL",
    email: "janmanuelmurillo@gmail.com",
    status: "Away",
    focusDuration: "60 m / 89 m focus",
    switches: 5,
    lastEvent: "Switched Tab",
    lastTime: "10:43 AM"
  },
  {
    name: "REGALA, ERICK JAMES",
    email: "regalaerick121905@gmail.com",
    status: "Active",
    focusDuration: "85 m / 89 m focus",
    switches: 1,
    lastEvent: "Returned to Google Meet",
    lastTime: "9:58 AM"
  },
  {
    name: "SAJUELA, RENZ KERBY",
    email: "renzkerbysajuela@gmail.com",
    status: "Left",
    focusDuration: "60 m / 89 m focus",
    switches: 1,
    lastEvent: "Left the meeting",
    lastTime: "10:24 AM"
  },
  {
    name: "VILLAREZ, RODEL",
    email: "rodelvillarez@gmail.com",
    status: "Active",
    focusDuration: "89 m / 89 m focus",
    switches: 0,
    lastEvent: "Joined the Google Meet",
    lastTime: "9:00 AM"
  }
];

let showOnlySwitchers = false;

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

  const displayList = showOnlySwitchers
    ? studentData.filter(s => s.switches >= 3)
    : studentData;

  tbody.innerHTML = displayList.map(s => {
    const isLeft = s.status.toLowerCase() === 'left';
    return `
      <tr class="${isLeft ? 'row-left' : ''}">
        <td class="student-col">
          <div class="name">${s.name}</div>
          <div class="email">${s.email}</div>
        </td>
        <td>
          <div class="status-cell">
            <span class="table-dot ${getDotClass(s.status)}"></span>
            ${s.status}
          </div>
        </td>
        <td>
          <div class="duration-primary">${s.focusDuration}</div>
          <div class="duration-secondary">${s.switches} Switch/s</div>
        </td>
        <td>
          <div class="event-name">${s.lastEvent}</div>
          <div class="event-time">${s.lastTime}</div>
        </td>
      </tr>
    `;
  }).join('');
}

// ===== Stat cards (Attendance / Focused / Away) =====
function updateStats() {
  const total = studentData.length;
  const focusedCount = studentData.filter(s => s.status.toLowerCase() === 'active').length;
  const awayCount = studentData.filter(s => s.status.toLowerCase() === 'away').length;

  const attendanceEl = document.getElementById('stat-attendance');
  const focusedEl = document.getElementById('stat-focused');
  const awayEl = document.getElementById('stat-away');

  if (attendanceEl) attendanceEl.textContent = `${total}/${total}`;
  if (focusedEl) focusedEl.textContent = focusedCount;
  if (awayEl) awayEl.textContent = awayCount;
}

// ===== Show Switchers toggle =====
function initShowSwitchersButton() {
  const btn = document.getElementById('btn-show-switchers');
  if (!btn) return;

  btn.addEventListener('click', () => {
    showOnlySwitchers = !showOnlySwitchers;
    btn.textContent = showOnlySwitchers ? 'SHOW ALL' : 'SHOW SWITCHERS';
    renderTable();
  });
}

// ===== Session timer (Start / Pause / End) =====
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
  if (timerInterval) return; // already running, ignore repeated clicks
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

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  renderTable();
  updateStats();
  updateTimerDisplay();
  initShowSwitchersButton();
  initControlButtons();
});