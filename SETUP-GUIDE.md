# iSEENTA Setup and Class Guide

This guide covers project-owner setup, installing the extension, then what students and professors do during class.

## 1. One-time setup (project owner)

### Configure Firebase

1. In the Firebase Console, create or select the project and register a **Web app**.
2. Copy the app's Firebase config values into `src/firebase.js`. If it does not exist yet, make it from the example:

   ```powershell
   Copy-Item src\firebase.example.js src\firebase.js
   ```

   `src/firebase.js` is ignored by Git; follow the project team's policy for sharing it. Firebase web config is not a password—the Firestore rules enforce data access—but keep local config out of commits.
3. In Firebase Authentication, enable **Google** sign-in.
4. In Firestore Database, create the database if needed. Publish `firestore.rules` from the Firebase Console's **Rules** tab.
5. Deploy the indexes from the project root, or create them when Firestore supplies a link after a missing-index error:

   ```powershell
   firebase deploy --only firestore:indexes
   ```

   Use the Firebase CLI login and select the correct project first. Wait for indexes to finish building before testing quick checks.

The project uses an allowlist for professor accounts. When adding or removing a professor, update all three places and publish the rules:

- `PROFESSOR_EMAILS` in `src/config.js`
- the professor allowlist in `dashboard/src/App.tsx`
- the email list in `firestore.rules`

Students use a verified Google account; their email does not need to be on the professor allowlist.

### Build and package a release (project maintainer)

The project maintainer does this when creating a release. Students and professors can skip this section; they do not need Node.js or npm.

```powershell
npm ci
npm --prefix dashboard ci
npm run build
Compress-Archive -Path .\dist\* -DestinationPath .\iSEENTA-extension.zip -Force
```

Distribute `iSEENTA-extension.zip` to the class using a trusted channel, or publish the extension on the Chrome Web Store. A Web Store listing is recommended for a one-click install and automatic updates. Do not distribute `src/firebase.js` or source files; the built extension already includes the Firebase web app configuration.

### Install the extension (students and professors)

**From the Chrome Web Store:** open the extension's listing and click **Add to Chrome**. The browser installs updates automatically.

**From the class ZIP:**

1. Download and extract `iSEENTA-extension.zip` to a folder you can keep (for example, `Documents\iSEENTA`).
2. In Chrome, open `chrome://extensions`; in Brave or Edge, open `brave://extensions` or `edge://extensions`.
3. Turn on **Developer mode**, click **Load unpacked**, and choose the extracted folder containing `manifest.json` (not the ZIP itself).
4. Keep that folder in place. The extension ID should be `kkffkfcdgbgjklhejknjphjiaekopdhj`; the manifest pins this ID for Google sign-in.

ZIP installs do not update automatically. When the maintainer shares a new ZIP, extract the new files into the same folder, then click **Reload** on the extension card and refresh open Meet tabs. If updating by replacing the folder is inconvenient, remove the old unpacked extension and load the newly extracted folder.

## 2. Student: join and participate

1. Open the Google Meet link in the same browser profile where iSEENTA is installed. Join the call; being in the waiting room is not enough to start tracking.
2. Click the iSEENTA extension icon, choose **I am a Student**, tick **Enable activity and focus tracking**, then sign in with the Google account you use for class.
3. Leave the extension installed and stay signed in. The extension tracks presence while you are in the active class Meet.
4. To tell the professor you are stepping away, open the extension popup and use **Send AFK notice**. Pick a reason and submit.
5. To answer a quick check, open the extension popup while the response window is open. Type the requested word or phrase and submit once. Matching ignores capitalization and spaces at the beginning or end (for example, `Programming` and `ProGRAMming` match).

The professor sees the answer you submit and whether it matches. If you do not submit before the timer ends, the dashboard records **No response** for that check. The extension does not read or send messages in Google Meet chat.

## 3. Professor: start and run a class

1. Open the class Google Meet in the same browser profile where iSEENTA is installed.
2. Click the extension icon, choose **I am a Professor**, and sign in using an email on the professor allowlist. The dashboard opens in a tab.
3. The dashboard uses the current Meet tab's room code when available. Otherwise, enter the class Meet link or code and choose **Set link**.
4. Click **Start** to create the active class session. Students can only be recorded against an active session for that same Meet room.
5. Wait for students to sign in, join the call, and appear in **Student activity**. Only students visible in the roster when a quick check starts are included in that check.
6. To run a quick check, enter a word or short phrase in **Quick response check**, choose 30 seconds, 1 minute, 2 minutes, or 5 minutes, then click **Start quick check**. Students see the prompt in their extension popup. The dashboard updates counts for correct, incorrect, and no response.
7. **Notify away** sends a fixed reminder to students currently marked Away. It is not a Meet chat message or quick check. **Pause** temporarily pauses session tracking; **Start** resumes it. Use the stop control to end the session.

## 4. Optional setup

### Account chooser in the dashboard, Brave, and Edge

Chrome's normal extension sign-in does not require this. To use the dashboard's explicit Google account chooser, or to sign in from Brave/Edge:

1. In Google Cloud Console → **APIs & Services** → **Credentials**, create an OAuth client ID of type **Web application**.
2. Add this authorized redirect URI:

   ```text
   https://kkffkfcdgbgjklhejknjphjiaekopdhj.chromiumapp.org/
   ```

3. Put the client ID in `GOOGLE_WEB_CLIENT_ID` in `src/firebase.js`, then rebuild.
4. If Firebase requests it, add the client ID to Firebase Authentication → Google provider → **Safelist client IDs from external projects**.

### 30-day data cleanup (project owner)

The optional scheduled function removes expired class data and quick-check responses. Deploy it after signing in to the Firebase CLI and selecting the correct project:

```powershell
npm --prefix functions install
firebase deploy --only functions:pruneExpiredActivity
```

Scheduled Cloud Functions require the Blaze plan and Cloud Scheduler. Review Firebase pricing before enabling them. If the cleanup function changes, deploy it again.

## 5. Updating the extension

After pulling code changes:

```powershell
npm ci
npm --prefix dashboard ci
npm run build
```

Then go to the extension management page, click **Reload** on iSEENTA, and refresh open Meet tabs. Students should reopen the extension popup and sign in again if their account or sync status is stale.

## 6. Troubleshooting

| What you see | What to check |
|---|---|
| Student is not appearing in the dashboard | Confirm they joined the call (not just the lobby), signed in as a student, enabled consent, and joined the same Meet room as the active professor session. |
| Student events are rejected or not syncing | Publish the current `firestore.rules`. Have the student reopen the popup and sign in again with their verified Google account. |
| Quick check does not appear or students cannot submit | Confirm the class session is active, the student is in its roster, Firestore rules are published, and composite indexes are ready. Reload the extension and refresh Meet. |
| Dashboard says the professor is not authorized | Sign in with a whitelisted email, or update and publish all three professor allowlists. |
| Notify away seems to do nothing | It only targets students currently marked Away. The reminder appears in the extension popup; system notifications also require browser notification permission. |
| No activity at all | On `chrome://extensions`, open the iSEENTA **service worker** link and check the console for `[Meet Focus Tracker]` errors. |
| Brave/Edge sign-in is unavailable | Configure `GOOGLE_WEB_CLIENT_ID` as described above. |
