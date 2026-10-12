# Review: V2 dashboard & build — commit a6a2adc

Scope: `git diff 269f4a7..a6a2adc` for `dashboard/`, `webpack.config.js`,
`tests/dashboard.test.mjs`, `firestore.rules`, `package.json`.
Supporting files read for correctness of the shared imports: `src/firebase.js`,
`src/auth.js`, `src/config.js`, `src/background.js`, `src/popup.js`,
`src/manifest.json`, `src/content.js`.

Verified empirically: `npm test` passes (all three suites), `npm run build`
produces `dist/dashboard/{app.js,index.html,style.css,assets}` correctly; the
bundled `app.js` is a plain script (no `eval`, no `type="module"` needed) —
MV3 CSP safe.

## Spec checklist

| # | Spec item | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Dashboard bundled into the extension (`dist/dashboard`) | **Met** | Webpack entry `'dashboard/app': './dashboard/app.js'` (webpack.config.js:10) emits `dist/dashboard/app.js`; CopyPlugin moves `index.html`, `style.css`, `assets/` under `dist/dashboard/` (webpack.config.js:23-25). `<script src="app.js">` is relative to the same dir (dashboard/index.html:127). `openDashboard` navigates to `chrome.runtime.getURL("dashboard/index.html?room=…")` which resolves inside dist (src/background.js:135-136). Build verified locally. |
| 2 | Shares the extension's Firebase config and sign-in (no hardcoded copy) | **Met** | `auth`/`db` imported from `../src/firebase`, `signInWithGoogle` from `../src/auth` — the same modules the popup/SW use (dashboard/app.js:4-5). Old CDN imports + inline `firebaseConfig` deleted. `onAuthStateChanged`/`getAuth` both come from `firebase/auth/web-extension` (app.js:3, src/firebase.js:3) so it's the same auth instance/persistence. |
| 3 | HISTORY link removed | **Met** | Nav now contains only `#nav-signin` (dashboard/index.html:22-25); `#nav-history` gone from HTML and never referenced in JS. |
| 4 | SHOW SWITCHERS toggle removed; switch count stays in the table | **Met** | Button removed from HTML (was dashboard/index.html:105-107 area) and its CSS deleted (dashboard/style.css); `showOnlySwitchers` + `initShowSwitchersButton` gone from JS. Switch count still rendered as `${s.switches} Switch/s` (dashboard/app.js:187) and `switches` still counted on AWAY (app.js:58). |
| 5 | Room comes from URL `?room=<meet code>` instead of hardcoded text | **Met** | `URLSearchParams` → trim → lowercase → `MEET_CODE_RE` gate → `ROOM` (dashboard/app.js:13-15); invalid/missing → `null` → "All meetings today" fallback. Room shown in header + `<a>` to the Meet URL (app.js:218-224, index.html:33); `document.title` set (app.js:234). Producer side: `openDashboard` appends `?room=` (src/background.js:135). Legacy `?meetingCode=` alias also accepted (app.js:14). |
| 6 | Date shown dynamically (replaces hardcoded "9:00 AM – 11:30 AM" / course text) | **Met, with a wording caveat** | Date comes from `new Date().toLocaleDateString()` at render (dashboard/app.js:227-232) — i.e. the *current* day, not a URL parameter. That matches the data, which is today-only (app.js:111-113, 128). If the spec intended a `?date=` param, it's unmet; nothing else in the change references one. |
| 7 | LEFT also clears idle so focus time stops accumulating | **Met** | `case "LEFT": inMeet = false; away = false; idle = false;` (dashboard/app.js:59). Verified by trace: without it, a `LEFT → RETURNED` (or `AWAY`) rejoin sequence leaves `idle` stuck true and focus never resumes — RETURNED (app.js:57) doesn't clear idle. Also closes the open-AWAY question from the tracking review's F6: `settle(evt.time)` runs after flags update, so LEFT bounds any open focus/away streak. |

## Findings (ordered by severity)

### F1 — SIGN OUT in the dashboard is a silent no-op (`sender.tab` guard rejects tab-hosted extension pages)
**dashboard/app.js:245 interacting with src/background.js:146-162**

```js
// dashboard: await chrome.runtime.sendMessage({ cmd: 'signOut' });
// background: if (msg?.cmd === "signOut" && !sender.tab) { … }
```

The dashboard is an extension page opened in a normal tab
(`chrome.tabs.create({url: chrome.runtime.getURL(…)})`, src/background.js:136).
Messages sent from it carry `sender.tab` — `sender.tab` is populated for *any*
message sent from a tab, including extension's own pages. The handler requires
`!sender.tab` (meant to exclude content scripts), so the dashboard's `signOut`
falls through to the content-script branch, hits `!msg.type` (line 161), and
returns. `sendMessage` resolves `undefined`, the `await` succeeds, and nothing
happens — no sign-out, no error, `onAuthStateChanged` never fires.

Impact: the SIGN OUT button is dead. Worse, the not-a-professor branch tells the
user to "Sign out and use a professor account" (app.js:269) — directing them to
the dead button. (Popup sign-out still works since the popup has no tab.)

Suggested fix: allow messages from the dashboard specifically, e.g.
`!sender.tab || sender.url?.startsWith(chrome.runtime.getURL("dashboard/"))`,
or call `signOutGoogle()` directly from the dashboard (it's already imported
elsewhere in the bundle graph).

### F2 — `firestore.rules` create-rule doesn't bind `email`/`student`/`meetingCode` — trivial impersonation & pollution
**firestore.rules:19-22; read path dashboard/app.js:30-33**

```js
allow create: if request.auth != null
  && request.resource.data.uid == request.auth.uid
  && request.resource.data.type in [...]
  && request.resource.data.time is int;
```

Only `uid` is bound to the caller. Any signed-in Google account can create
events with **any** `email`, `student` name, `meetingCode`, arbitrary `time`
(past/future), and unrestricted extra fields. The dashboard groups and labels
rows by `evt.email` (app.js:30-33), so a student can fabricate rows under a
classmate's identity or inject noise into a professor's room view (room
filtering trusts `meetingCode`). For a class-attendance tool this is the main
integrity surface — a savvy student can poison the very signal being graded on.

Suggested fix: `request.resource.data.email == request.auth.token.email`, a
`MEET_CODE_RE`-style `matches()` check on `meetingCode`, a sane `time` window
(`time <= request.time.toMillis()`), and `request.resource.data.keys().hasOnly([...])`
to cap fields. Medium — exploitable by any authenticated non-professor; not a
drive-by.

### F3 — Room-filtered query is unbounded: reads the room's entire history every snapshot
**dashboard/app.js:117-128**

`where("meetingCode", "==", ROOM)` has no `time` bound; "today" is applied
client-side (app.js:128). Every snapshot therefore downloads all events ever
written for that code. Meet codes can be reused as recurring class links, so
the read grows daily and old docs are paid for then discarded. The
single-field/no-composite-index tradeoff is documented (app.js:115-116) and
correctness is fine — but the client-side `>= since` filter could at least be
mirrored server-side with a second `where` (+ the composite index it needs).
Low; cost/latency concern only.

### F4 — Dashboard test for the LEFT-clears-idle change doesn't isolate it
**tests/dashboard.test.mjs:17 vs dashboard/app.js:56,59**

`'idle then left then rejoin clears idle'` uses `JOINED` to rejoin — but JOINED
*also* clears `idle` (app.js:56), so the test passes on the old code too
(trace: IDLE@1,LEFT@2,JOINED@5 → 6 m focus either way). The only sequences that
distinguish the fix are `LEFT → RETURNED` or `LEFT → AWAY` (rejoin without
JOINED). Low — the code change is correct; coverage is misleading.

### F5 — Professor-email check is case-sensitive in rules but case-insensitive in the UI gate
**firestore.rules:8-12 vs src/config.js:10-12**

`isProfessorEmail` lowercases before comparing; the rules `in [...]` does not.
A Google account whose token email contains uppercase would pass the dashboard
gate then get `permission-denied` on every read — confusing "not authorized"
message despite being on the whitelist. Low (Google usually emits lowercase).

### F6 — Comment/identifier drift: `isTeacher()` vs `isProfessor()`
**src/config.js:2 vs firestore.rules:6**

config.js tells maintainers to sync `PROFESSOR_EMAILS` with `isTeacher()` in
firestore.rules; the function is actually named `isProfessor()`. Cosmetic, but
it's exactly the kind of mismatch that makes someone think the rules file is
out of date.

### F7 — Dashboard rewrites `profile` to professor on every auth-state change — breaks student sync on a shared install
**dashboard/app.js:258-262 vs src/background.js:27**

Whenever a professor is signed in, the dashboard persists
`profile: {role:'professor',…}` to `chrome.storage.local`. `saveEvent` hard-gates
on `profile?.role !== 'student'` (background.js:27), so on a browser where a
student profile was active, a professor opening the dashboard silently stops
the student's event sync (no `syncError` set either — the early return precedes
it). One-role-per-browser may be intended, but the overwrite happens as a
side effect of an *observer* rather than an explicit sign-in, which is
surprising. Low.

### F8 — "Today" window is fixed at listener start; pre-midnight students are invisible until a qualifying event
**dashboard/app.js:111-113, 56-58, 68**

`since` is computed once when `startListening` runs — a dashboard open past
midnight keeps yesterday's 00:00 window (minor drift). Related: a student who
JOINED before midnight and is still in the call only becomes visible if one of
today's events is JOINED/AWAY/RETURNED (they set `everJoined`); an IDLE/ACTIVE-
only day leaves `everJoined` false and the row is suppressed (app.js:68).
Overnight calls are rare; informational.

### F9 — `time is int` accepts any integer; future timestamps yield negative focus
**firestore.rules:22, dashboard/app.js:70**

No upper bound on `time`. A doc with `time > Date.now()` that ends a focus
streak makes `activeMs` contribution negative (app.js:70 `Date.now() - focusedSince`
can also go negative for a streak started in the future), rendering nonsense
minutes. Malformed writes need auth (see F2), so this is mostly belt-and-
suspenders for the rules. Low.

## Clean areas (LGTM)

- **Room param handling:** trim → lowercase → anchored `MEET_CODE_RE` → `null`
  fallback, `room`/`meetingCode` aliases, regex has no `g` flag (no `lastIndex`
  bug), URL used only in `textContent`/validated-`href` — no injection. LGTM.
- **Shared-config correctness:** imports resolve to the same `auth`/`db` module
  the popup/SW use; `firebase/auth/web-extension` consistently used everywhere
  (no dual auth instances); session shared via IndexedDB so popup sign-in is
  picked up by `onAuthStateChanged`. LGTM.
- **State machine & focus math:** `settle()` runs post-flag-update, streaks are
  bounded by event times, duplicate types don't double-count, `LEFT` bounds open
  AWAY streaks (answers tracking-review F6), `everJoined` correctly suppresses
  idle-only ghosts, per-student time sort before replay. LGTM.
- **Webpack/copy config:** entry + 3 copy patterns verified to produce
  `dist/dashboard/` completely; `type="module"` correctly dropped for the
  bundled script; relative `app.js`/`style.css`/`assets/` references all
  resolve in dist; no `eval` in the production bundle (MV3 CSP safe). LGTM.
- **Rules (non-create paths):** default-deny outside `/events`,
  `update,delete` locked, professor-only `read` covering get+list, verified
  email gate, `type` allowlist matches the 7 emitted event types, `uid` bound
  to `auth.uid`. LGTM except the field-binding gaps in F2/F9.
- **HTML/JS wiring:** every id referenced by app.js exists in index.html
  (`meet-code`, `session-date`, `nav-signin`, `student-tbody`, stat cards,
  timer controls); no-href anchor styled via `a.code-link:not([href])`;
  `escapeHtml` applied to all doc-derived values. LGTM.
- **package.json test script:** runs all three suites; all pass. LGTM.
