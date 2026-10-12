# GMeet Focus Tracker: Architecture Overview

This document describes the current state of the `main` branch (commit `8cc4545`), plus open PR #5 (`fix/readable-timestamp`). Its purpose is to give enough context to plan a workflow redesign.

## 1. What the project does

Students install a Chrome extension. During a Google Meet class, it records when a student joins, leaves, switches tabs or windows, or goes idle or locks the screen. Each event is written to Firebase Firestore. A professor opens a separate web dashboard ("PUP iSEENTA"), signs in with Google, and sees a live table of today's students with their status, focus time and tab-switch count.

There is no custom backend server. Everything is Chrome extension APIs, Firebase Auth and Firestore, plus a static dashboard page.

## 2. Tech stack

| Part | Technology |
|---|---|
| Extension | Chrome Manifest V3, plain JavaScript (ES modules), bundled with webpack 5 |
| Extension Firebase SDK | `firebase` npm package v12.x (Auth and Firestore) |
| Dashboard | Static HTML, CSS and JS. Firebase SDK 10.12.2 loaded from the gstatic CDN as ES modules. No framework. |
| Auth | Google sign-in. In the extension, `chrome.identity.getAuthToken` is exchanged for a Firebase credential. On the dashboard, Firebase `signInWithPopup`. |
| Database | Cloud Firestore, project `gmeet-focus-tracker`, single collection `events` |
| Build | `npm run build` (webpack) outputs to `dist/` |
| Tests | None (`npm test` is a placeholder) |

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
├── dashboard/               # Professor web dashboard (served separately)
│   ├── index.html           # Single page layout
│   ├── style.css            # PUP maroon/gold theme
│   ├── app.js               # Firebase init, auth, live query, aggregation, rendering, timer
│   └── assets/              # Logo and start/pause/end button images
├── dist/                    # Build output, loaded via "Load unpacked" (GITIGNORED)
├── webpack.config.js        # 3 entries: background, content, popup; copies manifest/html/css
├── package.json
├── README.md                # Empty apart from the title
└── SETUP-GUIDE.md           # Local setup notes (currently untracked)
```

Not in the repo: the Firestore security rules (set by hand in the Firebase console) and `src/firebase.js`.

## 4. Components

### 4.1 Content script (`src/content.js`)

- Runs on every `https://meet.google.com/*` page.
- On load, sends `JOINED`.
- Listens to `blur`, `focus` and `visibilitychange`. When `document.hidden || !document.hasFocus()` changes, it sends `AWAY` or `RETURNED`.
- On `pagehide`, it sends `LEFT`.
- Each message is `{ type, time: Date.now(), meetingCode: location.pathname.slice(1) }`, sent with `chrome.runtime.sendMessage`.
- It doesn't check whether the user is actually in a call. Opening the Meet home page also sends `JOINED`, with an empty or non-meeting code.

### 4.2 Background service worker (`src/background.js`)

- `ensureAuth()` signs into Firebase silently with `chrome.identity.getAuthToken({ interactive: false })` and `GoogleAuthProvider.credential`. It caches the user and de-duplicates concurrent sign-in attempts.
- `saveEvent(evt)`:
  1. Reads `student` from `chrome.storage.local`. If there's no student or `consent` is false, it skips the event silently.
  2. Signs in. If that fails, it logs a warning and skips the event.
  3. Calls `addDoc(collection(db, "events"), { ...evt, student, email, uid, timestamp })`.
  4. Only after the write succeeds, sets `chrome.storage.local.currentMode = evt.type`. The popup reads this.
- Message listener: for each content-script message, it sets `activeMeeting` in storage (`null` on `LEFT`), then calls `saveEvent`.
- Idle detection: `chrome.idle.setDetectionInterval(15)`. When the state changes, and only if there's an `activeMeeting`, it saves `IDLE`, `LOCKED` or `ACTIVE`.

### 4.3 Popup (`src/popup.html`, `popup.js`, `popup.css`)

There are three cards:
1. **Title/description**: "Focus Tracker".
2. **Current Status**: shows `currentMode` (default `UNKNOWN`). The page background changes colour for JOINED (blue), RETURNED (green), AWAY (amber) and IDLE (red). `LOCKED` and `ACTIVE` have no colour.
3. **Auth section**: "Signed in as" email, a consent checkbox ("Enable tracking during class"), the Google sign-in button (which becomes "Save Settings" after sign-in), and a status line ("Tracking is ON/OFF").

Logic:
- Signing in uses `chrome.identity.getAuthToken({ interactive: true })` and then `signInWithCredential`.
- It saves `student = { uid, email, name, consent }` to `chrome.storage.local`.
- It listens to `chrome.storage.onChanged` so the status updates live.

### 4.4 Professor dashboard (`dashboard/`)

This is a single page with these sections:

1. **Navbar**: PUP logo and "PUP iSEENTA" branding. A **HISTORY** link (not wired up) and **SIGN IN/SIGN OUT**.
2. **Session meta**: course title, section, class time and Meet code. All of these are hardcoded in the HTML (for example `INTE 301`, `BSIT 3-5`, `imi-ssy-ouo`) and not tied to data.
3. **Stat cards**:
   - Attendance: students not "Left" out of total students.
   - Focused: students with status Active.
   - Away: students with status Away.
4. **Main panel**:
   - Start, Pause and End buttons plus a "Time Elapsed" timer. These only drive a client-side `setInterval` timer and don't affect data.
   - **Legend**: Active, Away, Idle, Left.
   - **SHOW SWITCHERS** toggle: filters the table to students with 3 or more switches.
   - **Roster table**: Student (name and email), Status, Focus Duration (minutes and switch count), Last Event (readable label and time).

Logic in `app.js`:
- `onAuthStateChanged`. When signed in, `startListening()` runs an `onSnapshot` query: `events where time >= local midnight today, orderBy time asc`.
- `FILTER_MEET_CODE` constant (currently `null`): filters events to one meeting on the client side.
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
- The data re-aggregates every 30 seconds so focus time keeps ticking.
- If Firestore returns `permission-denied`, the table shows "This account isn't authorized to view the dashboard."

## 5. Data model

Collection `events`. There is one document per event, with an auto-generated ID.

| Field | Type | Notes |
|---|---|---|
| `type` | string | `JOINED`, `AWAY`, `RETURNED`, `LEFT`, `IDLE`, `LOCKED`, or `ACTIVE` |
| `time` | number (ms since epoch) | Used by the dashboard for the "today only" filter, ordering and focus calculation |
| `timestamp` | number on `main`; Firestore `Timestamp` after PR #5 | For readability in the console only; nothing reads it |
| `meetingCode` | string | Meet path, for example `nou-chby-cqq` |
| `student` | string | Google display name |
| `email` | string | Student Google email (the grouping key on the dashboard) |
| `uid` | string | Firebase Auth uid |

Extension local storage (`chrome.storage.local`):
- `student`: `{ uid, email, name, consent }`
- `activeMeeting`: the current meeting code, or `null`
- `currentMode`: the last saved event type, shown in the popup

Firestore rules, set in the console and not in the repo:
- Signed-in users can `create` events only where `uid == auth.uid`.
- Only allow-listed teacher emails can `read`.
- No one can `update` or `delete`.

There are no collections for classes, sessions, rosters or teachers. A "class" exists only as a `meetingCode` string plus hardcoded dashboard text.

## 6. Workflows

### 6.1 Developer setup

1. `npm ci`
2. Copy `src/firebase.example.js` to `src/firebase.js` and fill in the Firebase web config.
3. `npm run build`
4. Open `chrome://extensions`, turn on Developer mode, click Load unpacked and select `dist/`.
   The extension ID is fixed by `key` in the manifest, and it must match the OAuth client registered in Google Cloud.
5. Dashboard: run `npx serve dashboard` and open `http://localhost:3000`. `localhost` must be an authorized domain in Firebase Auth.
6. After code changes: rebuild, reload the extension and refresh any Meet tabs.

Each teammate builds their own `dist/`. Changes only reach other teammates once they're merged to `main` and each teammate pulls and rebuilds.

### 6.2 Student flow

1. Open the extension popup and tick consent.
2. Click **Sign in with Google**. This saves `student` to local storage.
3. Join a Google Meet. The content script sends `JOINED`, and the background saves it and sets `activeMeeting`.
4. Switching tabs or windows saves `AWAY`, and coming back saves `RETURNED`.
5. 15 seconds of no input saves `IDLE` (or `LOCKED` if the screen is locked), and resuming saves `ACTIVE`.
6. Closing or leaving the Meet tab saves `LEFT` and clears `activeMeeting`.
7. The popup's "Current Status" reflects the last saved event.

### 6.3 Professor flow

1. Open the dashboard and click **SIGN IN** (Google popup). The account must be allow-listed in the Firestore rules.
2. The table fills live with today's students: status, focus minutes, switches and last event.
3. Optionally use **SHOW SWITCHERS** to see frequent tab-switchers.
4. Start, Pause and End only run a visual timer.

### 6.4 Event sequence

```
Meet tab (content.js) --sendMessage--> background.js --addDoc--> Firestore "events"
chrome.idle ------------------------->  background.js --addDoc--> Firestore "events"
background.js --storage.local.currentMode--> popup.js (status colour)
Firestore "events" --onSnapshot (today, by time)--> dashboard/app.js --> stats + roster table
```

## 7. Known limitations and gaps (useful for a redesign)

**No concept of class or session**
- The course, section, time and Meet code in the dashboard are hardcoded.
- Start, Pause and End don't create or close a session in the data.
- HISTORY isn't implemented.
- The dashboard shows every student from every meeting today unless `FILTER_MEET_CODE` is edited in the code.

**No roster**
- Attendance is "students who sent an event" out of "students who sent an event". Expected students who never joined aren't counted.

**Detection gaps**
- `JOINED` fires on any meet.google.com page, including the lobby or home page, not only when a student is actually in a call.
- Closing the browser or a crash may never send `LEFT`.

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
