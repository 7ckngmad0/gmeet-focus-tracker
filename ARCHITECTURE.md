# GMeet Focus Tracker: Architecture Overview

This document describes the current implementation of the session-based tracker.

## 1. What the project does

Students install a Chrome extension. During an active professor-created Meet session, it records join/leave, tab focus and idle events in Firestore. Professors use the bundled dashboard to create, pause, resume and end sessions and view a live roster.

There is no custom backend server. Everything is Chrome extension APIs, Firebase Auth and Firestore, plus a static dashboard page.

## 2. Tech stack

| Part | Technology |
|---|---|
| Extension | Chrome Manifest V3, plain JavaScript (ES modules), bundled with webpack 5 |
| Extension Firebase SDK | `firebase` npm package v12.x (Auth and Firestore) |
| Dashboard | Static HTML, CSS and JS bundled with webpack and the Firebase SDK. No framework. |
| Auth | Google sign-in via Firebase Auth, shared between extension and dashboard. |
| Database | Cloud Firestore collections `sessions` and `events` |
| Build | `npm run build` (webpack) outputs to `dist/` |
| Tests | Node-based tests for content events, dashboard aggregation, and background behavior |

## 3. Repository layout

```
gmeet-focus-tracker/
├── src/                     # Chrome extension source
│   ├── manifest.json        # MV3 manifest: permissions, OAuth client, content script, popup
│   ├── background.js        # Service worker: auth, Firestore writes, idle detection
│   ├── content.js           # Injected into meet.google.com: focus/visibility events
│   ├── popup.html           # Toolbar popup UI
│   ├── popup.css            # Popup styles (dark glass theme, colour per mode)
│   ├── popup.js             # Popup logic: sign-in, consent, live status display
│   ├── firebase.js          # Firebase config + init (GITIGNORED, each dev creates it)
│   └── firebase.example.js  # Template for firebase.js
├── dashboard/               # Professor dashboard, bundled into the extension
│   ├── index.html           # Single page layout
│   ├── style.css            # PUP maroon/gold theme
│   ├── app.js               # Firebase init, auth, live query, aggregation, rendering, timer
│   └── assets/              # Logo and start/pause/end button images
├── dist/                    # Build output, loaded via "Load unpacked" (GITIGNORED)
├── webpack.config.js        # Bundles extension scripts and dashboard app
├── package.json
├── README.md                # Empty apart from the title
└── SETUP-GUIDE.md           # Local setup notes (currently untracked)
```

`firestore.rules` is versioned in the repo but must also be published in Firebase Console. `src/firebase.js` is local configuration and is not committed.

## 4. Components

### 4.1 Content script (`src/content.js`)

- Runs on every `https://meet.google.com/*` page.
- Polls the Meet page and sends `JOINED` only after detecting an in-call UI.
- Listens to `blur`, `focus` and `visibilitychange`. When `document.hidden || !document.hasFocus()` changes, it sends `AWAY` or `RETURNED`.
- On `pagehide`, it sends `LEFT`.
- Each message is `{ type, time: Date.now(), meetingCode: location.pathname.slice(1) }`, sent with `chrome.runtime.sendMessage`.
- It ignores the lobby/home page and reports the Meet room code with each event.

### 4.2 Background service worker (`src/background.js`)

- `ensureAuth()` restores Firebase Auth and verifies it still matches the student's saved profile.
- Events are associated with the matching active Firestore session and queued in a bounded local outbox before upload.
- Event documents include session ID, client event time, open-tab count and a trusted server `receivedAt` timestamp.
- Firestore rules require events to come from the student's verified account and reference an active session for that Meet.
- Idle detection saves `IDLE`, `LOCKED` or `ACTIVE` only while a Meet is active.

### 4.3 Popup (`src/popup.html`, `popup.js`, `popup.css`)

There are three cards:
1. **Title/description**: "Focus Tracker".
2. **Current Status**: shows `currentMode` (default `UNKNOWN`). The page background changes colour for JOINED (blue), RETURNED (green), AWAY (amber) and IDLE (red). `LOCKED` and `ACTIVE` have no colour.
3. **Auth section**: "Signed in as" email, a consent checkbox ("Enable tracking during class"), the Google sign-in button (which becomes "Save Settings" after sign-in), and a status line ("Tracking is ON/OFF").

Logic:
- Sign-in and role selection run through the extension background service worker.
- The student profile, consent, event outbox and current status are stored in `chrome.storage.local`.
- It listens to `chrome.storage.onChanged` so the status updates live.

### 4.4 Professor dashboard (`dashboard/`)

This is a single page with these sections:

1. **Navbar**: PUP logo and "PUP iSEENTA" branding, with professor sign-in/sign-out.
2. **Session setup**: Meet code, course and class label inputs.
3. **Stat cards**:
   - Attendance: students not "Left" out of total students.
   - Focused: students with status Active.
   - Away: students with status Away.
4. **Main panel**:
   - Start, Pause and End controls create/update Firestore session documents and show shared elapsed time.
   - **Legend**: Active, Away, Idle, Left.
   - **Roster table**: Student (name and email), Status, Focus Duration (minutes and switch count), Last Event (readable label and time).

Logic in `app.js`:
- `onAuthStateChanged`. Professors subscribe to today's events and the selected Meet's sessions.
- Roster events are filtered to the latest session for the selected Meet.
- `buildStudentRows(events)` groups events by `email` and replays them in time order as a state machine:
  - `JOINED`: inMeet, not away, not idle
  - `RETURNED`: inMeet, not away
  - `AWAY`: inMeet, away, switches += 1
  - `LEFT`: not inMeet
  - `IDLE` / `LOCKED`: idle
  - `ACTIVE`: not idle
  - Focus time adds up while the student is `inMeet && !away && !idle`.
  - Students with no JOINED, AWAY or RETURNED events are hidden.
  - Status is `Left`, `Away`, `Idle` or `Active`.
- Focus time is based on tab/idle events and freezes when a session is paused or ended.
- If Firestore returns `permission-denied`, the table shows "This account isn't authorized to view the dashboard."

## 5. Data model

Collection `sessions` stores professor-created class sessions. Session documents contain status, Meet code, course/class label, elapsed time, timestamps and the owning professor UID.

Collection `events` stores one document per student activity event.

| Field | Type | Notes |
|---|---|---|
| `type` | string | `JOINED`, `AWAY`, `RETURNED`, `LEFT`, `IDLE`, `LOCKED`, or `ACTIVE` |
| `time` | number (ms since epoch) | Used by the dashboard for the "today only" filter, ordering and focus calculation |
| `clientTime` | integer (ms since epoch) | Must match `time` |
| `receivedAt` | Firestore server timestamp | Trusted server receive time |
| `sessionId` | string | Must reference an active session for the same Meet when written |
| `tabCount` | integer | Open-tab count at event time |
| `meetingCode` | string | Meet path, for example `nou-chby-cqq` |
| `student` | string | Google display name |
| `email` | string | Student Google email (the grouping key on the dashboard) |
| `uid` | string | Firebase Auth uid |

Extension local storage (`chrome.storage.local`):
- `profile`: `{ uid, email, name, role, consent }`
- `outbox`: queued events waiting to sync
- `activeMeeting`: the current meeting code, or `null`
- `currentMode`: the last saved event type, shown in the popup

Firestore rules are maintained in `firestore.rules` and published through Firebase Console. Professors can create and update their own sessions and read the roster; students can discover active sessions and create events only under their verified account and a matching active session.

## 6. Workflows

### 6.1 Developer setup

1. `npm ci`
2. Copy `src/firebase.example.js` to `src/firebase.js` and fill in the Firebase web config.
3. Publish `firestore.rules` in Firebase Console.
4. `npm run build`
5. Open `chrome://extensions`, turn on Developer mode, click Load unpacked and select `dist/`.
   The extension ID is fixed by `key` in the manifest, and it must match the OAuth client registered in Google Cloud.
6. After code changes: rebuild, reload the extension and refresh any Meet tabs. Open the dashboard from the extension popup.

Each teammate builds their own `dist/`. Changes only reach other teammates once they're merged to `main` and each teammate pulls and rebuilds.

### 6.2 Student flow

1. Open the extension popup and tick consent.
2. Click **Sign in with Google**. This saves `student` to local storage.
3. Join a Google Meet while the professor's matching class session is active. The content script sends `JOINED`, which the background links to that Firestore session.
4. Switching tabs or windows saves `AWAY`, and coming back saves `RETURNED`.
5. Browser idle/lock changes save `IDLE`, `LOCKED` or `ACTIVE`.
6. Closing or leaving the Meet tab saves `LEFT` and clears `activeMeeting`.
7. The popup's "Current Status" reflects the last saved event.

### 6.3 Professor flow

1. Open the dashboard from the extension popup and sign in with an allow-listed professor account.
2. Enter the Meet code, course and class label.
3. Click **Start** to create a Firestore session; student events are linked to that session.
4. **Pause** blocks new event writes and freezes elapsed/focus time; **Start** resumes; **End** closes the session.
5. The roster shows session students' status, estimated focus time, switches and last event.

### 6.4 Event sequence

```
Professor dashboard --create/update--> Firestore "sessions"
Meet tab (content.js) --sendMessage--> background.js --queued setDoc--> Firestore "events"
chrome.idle -------------------------> background.js --queued setDoc--> Firestore "events"
background.js --storage.local.currentMode--> popup.js (status colour)
Firestore "sessions" --active room lookup--> background.js
Firestore "events" + "sessions" --onSnapshot--> dashboard/app.js --> stats + roster table
```

## 7. Known limitations and gaps (useful for a redesign)

**Session management**
- Sessions are stored in Firestore and started from the professor dashboard.
- There is no expected-attendee roster or history browsing UI yet.

**No roster**
- Attendance is "students who sent an event" out of "students who sent an event". Expected students who never joined aren't counted.

**Measurement and trust limitations**
- `JOINED` fires on any meet.google.com page, including the lobby or home page, not only when a student is actually in a call.
- Closing the browser or a crash may never send `LEFT`.
- While in a call, the content script sends `HEARTBEAT` every 30 seconds. If a `LEFT` event is missed, the dashboard stops counting after 75 seconds without a signal and shows `Not detected`; this is a fallback, not an exact leave timestamp.

**Popup**
- `currentMode` only updates when the Firestore write succeeds, so the popup can stay `UNKNOWN` if writes fail.
- `LOCKED` and `ACTIVE` have no theme colour.

**Config and infra**
- The Firebase config is duplicated: hardcoded in `dashboard/app.js`, and in a gitignored `src/firebase.js` in the extension.
- The extension and dashboard use different Firebase SDK versions (12 vs 10).
- Firestore rules and the teacher allow-list live only in the console. Adding a teacher means editing the rules.

**Process**
- No tests, linting or CI.
- No hosted dashboard; it runs locally only.
- There is no consent or privacy notice beyond the checkbox.
