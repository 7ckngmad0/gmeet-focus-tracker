# PUP iSEENTA Class Activity Tracker

iSEENTA is a Chrome-compatible extension and professor dashboard for a Google Meet class. With student consent, it records Meet presence, idle state, and the number of open browser tabs. It does not collect tab titles, URLs, or favicons. Professors can also run timed word checks; students submit answers in the extension popup, and capitalization does not matter.

## Get it running

The project owner configures Firebase and publishes the Firestore rules and indexes once. See the [setup guide](SETUP-GUIDE.md) for those steps and the student/professor walkthrough.

### For students and professors

Students and professors do **not** need Node.js, npm, or the project source. [Download the latest iSEENTA extension ZIP](https://github.com/7ckngmad0/gmeet-focus-tracker/releases/latest/download/iSEENTA-extension.zip), then:

1. Extract the ZIP. Keep the extracted folder in a location you won't move or delete.
2. Open `chrome://extensions` in Chrome. For Brave or Edge, open `brave://extensions` or `edge://extensions`.
3. Turn on **Developer mode**, click **Load unpacked**, and choose the extracted folder that directly contains `manifest.json`. Do not choose the ZIP file or the project folder.
4. Complete any permission prompts. Click the iSEENTA icon, choose **I am a Student** or **I am a Professor**, and sign in with your Google account.

The professor account must be authorized by the project owner. Students should install the same release and use the Google account they use for class. The extension needs to be installed in the browser profile where Google Meet is open.

This developer-mode ZIP installation does not update automatically. To update, get and extract the new ZIP, remove the old iSEENTA entry from `chrome://extensions`, then click **Load unpacked** and select the new extracted folder. For each code update, the maintainer should build and distribute a new ZIP. A Chrome Web Store release can provide a simpler install and automatic updates.

### For the project maintainer

The maintainer needs Node.js/npm and runs these commands once for each release:

```powershell
if (-not (Test-Path .\src\firebase.js)) { Copy-Item src\firebase.example.js src\firebase.js }
npm ci
npm --prefix dashboard ci
npm run build
Compress-Archive -Path .\dist\* -DestinationPath .\iSEENTA-extension.zip -Force
```

Share `iSEENTA-extension.zip` privately with the class, or publish it to the Chrome Web Store. Do not include `src/firebase.js` or source files in the release ZIP.

## During class

- **Students:** Sign in using **I am a Student**, enable tracking consent, and join the active Google Meet call. Open the extension popup to send an away notice or respond to a professor's quick check.
- **Professors:** Sign in using **I am a Professor** and use the dashboard to start a session for the class Meet. Quick checks are available while the session is active. Answers can differ in letter case or have extra spaces around them and still match.

The professor dashboard reports **Not detected** after a student's presence heartbeat has stopped for 75 seconds. Focus time stops at that point.

## Development

Run the dashboard by itself while working on its UI:

```powershell
npm --prefix dashboard run dev
```

For full feature use, load the built extension; the dashboard is packaged inside it.

Keep the professor allowlists in `src/config.js`, `dashboard/src/App.tsx`, and `firestore.rules` aligned. Firestore rules—not the dashboard allowlist—enforce access.
