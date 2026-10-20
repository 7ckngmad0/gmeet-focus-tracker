# PUP iSEENTA Class Activity Tracker

A Chrome extension and React dashboard for tracking student focus during an active Google Meet class. The extension records Meet presence, idle state, and an open-tab count after student consent. Professors can also launch a timed quick response check from the dashboard; students submit in the extension popup, and answers are matched without regard to capitalization. The extension does not collect tab titles, URLs, or favicons.

## Configure Firebase

Copy `src/firebase.example.js` to `src/firebase.js` and fill in the Firebase web app values. `src/firebase.js` is ignored by Git and is shared by the extension and dashboard. For Brave, Edge, or another Chromium browser, set `GOOGLE_WEB_CLIENT_ID` there as described in [SETUP-GUIDE.md](SETUP-GUIDE.md).

Enable Google sign-in in Firebase Authentication. Publish the Firestore rules from `firestore.rules` and the composite indexes from `firestore.indexes.json`; these restrict session controls, event reads, and class-check responses to the appropriate professor and active Meet session.

## Build and load the extension

Install the root dependencies and the dashboard dependencies, then build:

```sh
npm install
npm --prefix dashboard install
npm run build
```

In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist` folder. The build packages the React dashboard into the extension so the professor popup can open it for the current Meet room.

The dashboard can also run in a browser during UI work:

```sh
npm --prefix dashboard run dev
```

Students must sign in through the extension popup, choose the student role, and enable tracking consent. Professors sign in through the professor role. The dashboard supports the existing Meet-session controls and reports a student as **Not detected** when presence heartbeats stop for 75 seconds; focus time stops at that point.

During a live session, professors can enter a word or short phrase in **Quick response check**, choose a response window, and start the check. Students who are in the session roster can submit once from the extension popup. The dashboard records correct answers, incorrect answers, and students who did not respond before the deadline; matching ignores capitalization and surrounding whitespace.

Keep the professor email lists in `src/config.js`, `dashboard/src/App.tsx`, and `firestore.rules` aligned when adding or removing a professor. Firestore rules are the security boundary; the dashboard check only improves the sign-in experience.
