# Review: V2 call tracking — commit a6a2adc

Scope: `git diff 269f4a7..a6a2adc` for `src/content.js`, `src/background.js`,
`src/manifest.json`, `tests/content.test.mjs`, `tests/background.test.mjs`.
Supporting file read for context: `src/config.js` (`MEET_CODE_RE`, `meetCodeFromUrl`).
All tests in `tests/content.test.mjs` and `tests/background.test.mjs` pass.

## Spec checklist

| # | Spec item | Status | Evidence |
|---|-----------|--------|----------|
| 1 | JOINED only in a real Meet room (`abc-defg-hij`) | **Met** | `roomFromLocation()` gates on `MEET_CODE_RE` (`/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/`) — src/content.js:15-18, src/config.js:15. JOINED sent only from `checkCallState` when `live && !currentRoom` — src/content.js:83-87. |
| 2 | JOINED only once the Leave-call button exists | **Met** | `inCall()` requires `[aria-label*="leave call" i]` in the DOM — src/content.js:21-23. Re-polled every 1 s — src/content.js:103. Test "in call -> JOINED" (tests/content.test.mjs:40). |
| 3 | Meet home, lobby, post-call screens must not count | **Met** | Home `/` fails the code regex; lobby/post-call share the room URL but have no Leave-call button so `inCall()` is false — src/content.js:15-23,76-95. Tests "home page sends nothing", "lobby (no leave button) sends nothing". |
| 4 | LEFT on hang-up | **Met** | Poll detects `!live && currentRoom` → `leave()` — src/content.js:88-90. Test "hang up (leave button gone) -> LEFT". |
| 5 | LEFT on room change | **Met** | `currentRoom !== room` → `leave()`, then re-JOIN for the new room — src/content.js:80-87. Backstop in `tabs.onUpdated` — src/background.js:196-204. Test "switch room -> LEFT + JOINED". |
| 6 | LEFT on pagehide/beforeunload | **Met** | src/content.js:100-101 → `leave()`; idempotent via `currentRoom = null` (src/content.js:68-74). Test "pagehide+beforeunload -> single LEFT". |
| 7 | LEFT on tab close (`tabs.onRemoved`) | **Met** | src/background.js:191-193 → `endMeeting(time, tabId)`. Test "meeting tab closed -> LEFT". |
| 8 | LEFT on navigation away (`tabs.onUpdated`) | **Met** | src/background.js:196-204; `changeInfo.url` is always populated (`tabs` permission in src/manifest.json). Same-room query churn (`?authuser=0`) correctly ignored. Tests "same-room url change keeps meeting", "navigate to home -> LEFT". |
| 9 | Stale meetings close on startup | **Partially met — see F1** | `closeStaleMeeting` on `onStartup`/`onInstalled` (src/background.js:207-223) closes the meeting only when the tab is gone or on a different URL; it is kept open when the restored tab still sits on the room URL, which is exactly what happens after a browser restart (F1). |
| 10 | LEFT clears idle so focus time stops | **Met** | `endMeeting` nulls `activeMeeting` (src/background.js:85) and the idle listener drops all events when it is null (src/background.js:229-231); the serialized queue preserves ordering. Test "idle event after leaving ignored". |
| 11 | Idle detection only while a meeting is active | **Met** | `chrome.idle.onStateChanged` reads `activeMeeting` and returns early when none — src/background.js:227-233. |

## Findings (ordered by severity)

### F1 — Stale meeting stays open when the meeting tab survives a restart (spec item 9 unmet)
**src/background.js:210-216, interacts with 69-77**

```js
const tab = await chrome.tabs.get(activeMeetingTabId);
if (meetCodeFromUrl(tab.url || "") === activeMeeting) return;   // keeps meeting open
```

A Meet call cannot survive a browser restart — WebRTC dies with the renderer and the
restored tab reloads to the lobby / "rejoin" screen **at the same room URL**. The URL
check therefore keeps a dead meeting open in exactly the scenario it exists to clean up:

- The phantom meeting stays open until the tab navigates away or closes; `IDLE`/`LOCKED`
  events keep being written against it the whole time (src/background.js:227-233 only
  gates on `activeMeeting` being set).
- If the student clicks Rejoin, the content script sends JOINED but `startMeeting`
  early-returns on same code + tabId (src/background.js:71), so the new call is never
  recorded — the meeting just silently absorbs it, inflating duration across the gap.
- The path is also untested: `tests/background.test.mjs` registers `ev('startup')` but
  never invokes `L.startup`.

**Suggested fix:** on `onStartup`/`onInstalled`, unconditionally `endMeeting(Date.now())`
— a call can never still be live after either event. (The URL check would only make sense
for service-worker restarts, which don't fire these events anyway.)

### F2 — `endMeeting` ignores `msg.meetingCode`; a stale LEFT can close the wrong meeting
**src/background.js:172, 80-87; contrast src/background.js:176**

`endMeeting` matches only on `tabId`. The AWAY/RETURNED path verifies
`msg.meetingCode === activeMeeting` (line 176) but the LEFT path does not. On a
full-reload navigation from room A to room B in the same tab, the dying document's
`pagehide` → LEFT-A and the new document's JOINED-B are sent from different documents;
cross-document message ordering isn't guaranteed FIFO. If JOINED-B lands first,
`startMeeting` writes its own LEFT-A and opens B — then the stale LEFT-A arrives and
`endMeeting` closes **B**. The content script keeps `currentRoom = B`, never resends
JOINED, and AWAY/RETURNED are filtered out by line 176 — tracking is silently dead for
the rest of the call.

**Suggested fix:** pass `msg.meetingCode` through and require it to equal
`activeMeeting` in `endMeeting`, matching the AWAY/RETURNED check.

### F3 — `meetCodeFromUrl` doesn't lowercase the path (inconsistent with content.js)
**src/config.js:22-23 vs src/content.js:16**

`roomFromLocation()` lowercases before matching; `meetCodeFromUrl` does not. A Meet URL
typed/pasted with uppercase letters (`/ABC-DEFG-HIJ`) makes the content script JOIN with
the lowercased code, while `tabs.onUpdated` sees `meetCodeFromUrl(url) === null ≠
activeMeeting` and fires a spurious LEFT (src/background.js:200). The same mismatch
weakens `closeStaleMeeting` (src/background.js:212) and `openDashboard`
(src/background.js:129). Edge-case likelihood, one-line fix (`u.pathname.slice(1).toLowerCase()`).

### F4 — `inCall()` depends on the English UI string "leave call"
**src/content.js:22**

`[aria-label*="leave call" i]` matches only English-localized Meet. For a student using
Meet in another language the Leave-call button never matches → `inCall()` stays false →
JOINED never fires → the entire tracker silently does nothing. Consider a
locale-independent selector (the hang-up button's `data-tooltip`/jsaction class, or
matching on the call-control bar). Medium severity because the failure is silent and
total for affected users.

### F5 — `setInterval` is throttled in hidden tabs; LEFT detection can lag ~60 s
**src/content.js:103**

Chrome throttles `setInterval` to once per minute in backgrounded tabs. If the call ends
while the Meet tab is hidden (host ends the meeting, student kicked, or the student
leaves from a second device), `checkCallState` detects it up to a minute late, so the
LEFT timestamp (and the meeting's recorded end) drifts. Navigations are still caught
promptly by `tabs.onUpdated`, so this only affects in-place DOM changes. Low-medium.

### F6 — LEFT while `away` leaves the AWAY interval unclosed
**src/content.js:68-74**

`leave()` clears `away`/`awayTimer` and sends only LEFT. If the student was away at
hang-up, the event stream ends `AWAY → LEFT` with no `RETURNED`. The LEFT timestamp
implicitly bounds the away period, but only if the dashboard's focus-time math treats
LEFT as closing an open AWAY — worth verifying on the dashboard side. Low.

### F7 — Mid-call JOINED replay in `handleSignIn` is not serialized
**src/background.js:112-113 (called from 143); the queue is at 63-67**

`handleSignIn` reads `activeMeeting` outside the `serialized` queue. If it runs while a
LEFT is queued/in-flight, it can read a still-set `activeMeeting` and write the replay
JOINED *after* the queued `endMeeting` writes LEFT — an out-of-order JOINED for a closed
meeting. Narrow window (student signs in exactly as the call ends); wrapping the replay
in `serialized()` closes it. Low.

### F8 — In-memory queue loses pending events on service-worker termination
**src/background.js:63-67**

MV3 can kill the service worker with work still queued (pending promises don't extend
its lifetime). A JOINED sitting behind a slow Firestore write can be dropped with no
retry — the content script won't resend it (LEFT has `tabs.onRemoved`/`onUpdated` as
backstops; JOINED has none). Rare, inherent to MV3, but worth a persisted-queue or
content-side retry if JOINED loss is ever observed. Low.

### F9 — AWAY probe chatter while the popup is open
**src/content.js:91-94 with 57-65**

After an `{ignored:true}` AWAY, the `checkCallState` fallback re-arms the debounce, so
the content script probes the background roughly every 1.5–2.5 s for as long as the
popup is open and the Meet window stays blurred. Harmless (each probe is answered with
`ignored` synchronously, src/background.js:165-168) but chatty; a backoff would be
tidier. Informational.

### F10 — Test gaps
- `tests/background.test.mjs` never invokes `L.startup` / `closeStaleMeeting` — F1 has
  zero coverage.
- The sign-out → LEFT path (src/background.js:146-153) is untested.
- No test covers the stale-LEFT scenario of F2.

## Clean areas (LGTM)

- **LEFT idempotency/dedup:** `endMeeting` no-ops once `activeMeeting` is null; late
  duplicate LEFTs are dropped — verified by test "late content LEFT after close not
  duplicated". LGTM.
- **Serialization of meeting events:** `JOINED`/`LEFT`/`AWAY`/`RETURNED` and all
  tab-event handlers funnel through `serialized()`, so storage read-modify-write can't
  interleave. LGTM (with the F7 exception outside the queue).
- **AWAY debounce + popup handshake:** 1.5 s debounce for visible-blur, immediate for
  hidden-tab, `{ignored:true}` reply with optimistic `away` rollback — coherent design,
  well covered by tests. LGTM.
- **Same-room URL churn:** `?authuser=0` / query changes don't fire LEFT (pathname-only
  comparison). LGTM, tested.
- **Idle gating & ordering vs LEFT:** idle handler is serialized and gated on
  `activeMeeting`, so an idle event can't be written after the meeting closes. LGTM,
  tested.
- **Sign-out ordering:** LEFT is recorded while the profile still exists, before
  profile removal and `signOutGoogle` (src/background.js:146-153). LGTM.
