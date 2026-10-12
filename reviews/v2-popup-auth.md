# Review: V2 popup role-selection & sign-in (commit a6a2adc)

Scope: `git diff 269f4a7..a6a2adc` for `src/popup.js`, `src/popup.html`, `src/popup.css`, `src/auth.js`, `src/config.js`, `src/manifest.json`. `src/background.js`, `dashboard/app.js`, `src/firebase.example.js`, and `firestore.rules` were read for context only (the spec items live across the popup ↔ service-worker contract). All reviewed files are identical between a6a2adc and HEAD (76957d4), so line numbers cite the working tree.

## Spec checklist

| # | Spec item | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Popup offers role selection: Student vs Professor | **MET** | `src/popup.html:26-33` (`screen-role` with `role-student` / `role-professor`); handlers `src/popup.js:115-138`. |
| 2 | Student requires mandatory consent + Google sign-in | **MET** (UI-enforced; see F3) | Checkbox gates a `disabled` button (`src/popup.html:40-55`, `src/popup.js:141-143`), click handler rechecks (`src/popup.js:147-150`), SW rejects `role:"student"` without `consent:true` (`src/background.js:142`), consent persisted on profile (`src/background.js:105`). |
| 3 | Professor whitelist in `src/config.js`; unauthorized → signed out + back to role selection | **MET** | `src/config.js:4-12` (`PROFESSOR_EMAILS`, `isProfessorEmail`); rejection path `src/background.js:98-102` (`signOutGoogle()` + `remove("profile")` + throw); error lands on role screen via `authError` → `src/popup.js:100-106`. |
| 4 | Professor dashboard opens in new tab with `?room=<meet code>` | **MET** (with unfiltered fallback; see F4/F5) | `src/background.js:108-109` calls `openDashboard()`; `src/background.js:125-136` builds `dashboard/index.html?room=...` + `chrome.tabs.create`; dashboard consumes it at `dashboard/app.js:13-15`. Falls back to no `?room` when no Meet tab/`activeMeeting` is found. |
| 5 | Sign-in runs in the service worker, survives popup close | **MET** | Popup only sends a message (`src/popup.js:79-81`); SW runs `handleSignIn` (`src/background.js:140-144`, `return true` async contract) and persists the outcome to storage (`authError`/`profile`, `src/background.js:94-119`) so a reopened popup renders it (`src/popup.js:84-112`). Code comment `src/background.js:90-92` states the intent. |
| 6 | `launchWebAuthFlow` fallback for Brave/Edge needing `GOOGLE_WEB_CLIENT_ID` | **MET in code** (config gap F9) | `src/auth.js:16-28` (getAuthToken w/ timeout + Brave/Edge bypass), `src/auth.js:32-58` (web auth flow); `identity` permission + `oauth2.client_id` present in `src/manifest.json:11,13-19`. |

## Findings (by severity)

### F1 — MEDIUM: Sign-in and sign-out are not serialized; races can leave `profile` inconsistent
`handleSignIn` (`src/background.js:93-122`) takes no lock and is not in the `serialized()` queue that meeting events use (`src/background.js:64-68,148`). `authInFlight` (`src/background.js:6-22`) only dedupes *silent* sign-ins for `saveEvent`, not interactive sign-in vs. sign-out. Concretely:
- Student sign-in in flight → popup auto-closes → user reopens → role screen → clicks Professor → two `handleSignIn`s run concurrently; last finisher wins `profile`, so the user can end signed in under the wrong role, and two interactive Google auth UIs can spawn (popup can issue a second `requestSignIn` freely — `src/popup.js:79-80`).
- Sign-out while a sign-in is still in flight: `signOut` removes `profile` and calls `signOutGoogle` (`src/background.js:146-154`), but the in-flight `handleSignIn` then resolves `signInWithCredential` and rewrites `profile` (`src/background.js:104-106`), silently undoing the sign-out.
- `endMeeting` inside the sign-out path runs `ensureAuth` → silent `signInWithGoogle` (`src/background.js:15`) that can interleave with a concurrent interactive flow; the uid guard in `saveEvent` (`src/background.js:34`) limits damage but the profile write at `src/background.js:106` is unguarded.

Fix direction: route `handleSignIn`/signOut through `serialized()` or track a `signInInFlight` promise and ignore/cancel overlapping requests.

### F2 — MEDIUM-LOW: Interactive `getAuthToken` can stall the fallback for up to 120 s
`src/auth.js:19-22` gives interactive `getAuthToken` a 120 s timeout. On Chromium browsers where the API exists but never resolves — the exact failure mode the comment describes (`src/auth.js:4`) — sign-in hangs ~2 min before `tokenFromWebAuthFlow` runs, and if the popup closed there is zero user-visible feedback (result only surfaces as `authError` on reopen). Also note `isBrave` (`src/auth.js:5`) depends on `navigator.brave` existing in the *service-worker* context; if Brave doesn't expose it there, Brave takes the same slow path. Consider a shorter interactive timeout (e.g., 15–20 s is still generous for an account picker) or skipping `getAuthToken` by UA/vendor rather than `navigator.brave` alone.

### F3 — LOW: Consent enforcement is UI-only; the SW verifies an asserted flag, not the checkbox
`requestSignIn` hardcodes `consent: role === "student"` (`src/popup.js:80`), so the SW's `msg.consent !== true` gate (`src/background.js:142`) only verifies a value the sender chose — a user can bypass the consent UX entirely via `chrome.runtime.sendMessage({cmd:"signIn",role:"student",consent:true})` from devtools. Self-bypass only (the person consenting is the one bypassing), so impact is limited; note it so nobody treats the SW check as an independent consent record. Same pattern for the whitelist: `PROFESSOR_EMAILS` is client-side (`src/config.js:2-3` admits this) — confirmed `firestore.rules:8-9` has the real `isTeacher()` gate. LGTM on that split, but keep the two lists in sync.

### F4 — LOW: `meetCodeFromUrl` misses trailing-slash room URLs
`src/config.js:15,22-23` requires the entire post-`/` path to match `^[a-z]{3}-[a-z]{4}-[a-z]{3}$`, so `https://meet.google.com/abc-defg-hij/` (a common paste format) returns `null` → dashboard opens unfiltered and the popup hint says "Open this from a Google Meet tab" even though the professor is on one. Affects both the popup hint (`src/popup.js:66-76`) and `openDashboard` (`src/background.js:128-133`). One-line fix: strip trailing `/` before testing.

### F5 — LOW: Room lookup can target the wrong window after async sign-in
`openDashboard` queries `{active: true, lastFocusedWindow: true}` *after* the interactive auth resolves (`src/background.js:127-129`). If the user focused another window during the OAuth flow (or the auth window's focus teardown leaves a different window last-focused), the dashboard opens for the wrong room — or unfiltered. The popup's preview hint (`src/popup.js:95-98`) can likewise disagree with what `openDashboard` actually opens if focus shifts between render and click. Mitigation: capture the active tab id when the professor button is clicked (popup can include it in the `signIn` message).

### F6 — LOW: `signOutAndReset` shows the role screen even if sign-out failed
`src/popup.js:167-174`: on `sendMessage` failure it logs and still calls `show("screen-role")` while `profile` persists in storage — popup claims signed-out state that isn't true until the next storage change triggers `render()`. Calling `render()` on failure (or surfacing a message) would keep UI honest.

### F7 — LOW: Popup can render permanently blank if Firebase init/`authStateReady` fails
All screens start `hidden` (`src/popup.html:25,36,56,72`) and first paint is gated on `auth.authStateReady().then(render)` (`src/popup.js:191`). If the `firebase.js` import throws or `authStateReady()` rejects (e.g., IndexedDB unavailable), no `.catch`/`finally` fallback exists — the popup stays empty with no error. Wrap in `.finally(render)` or catch-and-render.

### F8 — LOW: Other role button stays live during a sign-in
`role-professor` click only disables itself (`src/popup.js:124-138`); `role-student` remains clickable, and vice versa. Mid-flight navigation is then overridden when `profile`/`authError` lands and `render()` switches screens — feeding F1's races. Disable both buttons (or ignore role clicks) while a request is outstanding.

### F9 — INFO: `GOOGLE_WEB_CLIENT_ID` is empty in this checkout
`src/firebase.js:19` (gitignored, deployment-specific) ships `GOOGLE_WEB_CLIENT_ID = ""`, so on Brave/Edge the fallback throws the setup error (`src/auth.js:33-35`) rather than signing in. Code path is correct — this is a per-machine config gap to flag for the team.

### F10 — NIT: `launchWebAuthFlow` request has no `state` param
`src/auth.js:38-44`. The response URL is delivered only to the extension so practical CSRF risk is minimal, but `state` (bound to a value stored before launch) is the standard hardening for OAuth implicit flows.

### F11 — NIT: No way to revoke consent while staying signed in
The student screen offers only "Sign out" (`src/popup.html:56-70`); v1's checkbox + "Save Settings" toggle is gone. Consent change requires a full sign-out (which also writes `LEFT`). Spec doesn't require a toggle — noted as a UX regression.

### F12 — NIT: `authError` written as `null` rather than removed
`src/background.js:94` stores `{authError: null}` — works, but `storage.remove` is tidier and matches usage elsewhere (`src/popup.js:116,181`).

## Explicitly clean (LGTM)

- **Popup-close survival**: side effects (profile write, `authError`, dashboard tab) happen in the SW regardless of the response port dying; `render()` on `storage.onChanged` + reopen picks them up — `src/popup.js:84-112`, `src/background.js:90-92,140-144`.
- **Async message contract**: `return true` for all async responses; `!sender.tab` guards keep content scripts / the dashboard tab from invoking `signIn`/`signOut`/`openDashboard` — `src/background.js:140-158`.
- **Unauthorized-professor path**: sign-out + `profile` removal + `authError{role:"professor"}` → role screen with the rejection message, whether the popup stayed open or is reopened — `src/background.js:98-102,119`, `src/popup.js:100-106`.
- **Consent-screen guard**: `render()` won't kick a student off `screen-student-signin` mid-flow (`src/popup.js:103-107`); consent is reset to unchecked on every entry (`src/popup.js:119-120`).
- **Role validation**: SW rejects roles other than student/professor and student sign-in without consent before any work (`src/background.js:141-142`).
- **Manifest**: `identity` permission + `oauth2.client_id` present for `getAuthToken`; `tabs` permission covers `tabs.query` URL access — `src/manifest.json:7-19`.
- **Mid-call student sign-in**: `JOINED` is re-sent after sign-in if a meeting is already open — `src/background.js:111-113`.
- **Token plumbing**: `GoogleAuthProvider.credential(null, accessToken)` is correct for both token sources; silent-path failures degrade to `null` rather than throwing — `src/auth.js:62-69`.
- **Webpack**: `popup.js` is bundled into `dist/` so the non-module `<script src="popup.js">` with `import` statements is fine.
