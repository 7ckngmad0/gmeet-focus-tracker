import { GoogleAuthProvider, signInWithCredential, signOut } from "firebase/auth/web-extension";
import { auth, GOOGLE_WEB_CLIENT_ID } from "./firebase";

// Brave exposes navigator.brave; its chrome.identity.getAuthToken fails or never resolves
const isBrave = typeof navigator !== "undefined" && !!navigator.brave;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms))
  ]);
}

// chrome.identity.getAuthToken uses the Google account signed into Chrome.
// Only Google Chrome supports it; Brave, Edge and other Chromium browsers don't.
async function tokenFromChromeIdentity(interactive) {
  if (isBrave || !chrome.identity?.getAuthToken) return null;
  try {
    const result = await withTimeout(
      chrome.identity.getAuthToken({ interactive }),
      interactive ? 120000 : 5000
    );
    return result?.token || null;
  } catch (e) {
    console.warn("[Meet Focus Tracker] getAuthToken failed, trying web auth flow:", e?.message || e);
    return null;
  }
}

// Works in any Chromium browser. Needs a "Web application" OAuth client whose
// redirect URI is chrome.identity.getRedirectURL() (see SETUP-GUIDE.md).
async function tokenFromWebAuthFlow(interactive) {
  if (!GOOGLE_WEB_CLIENT_ID) {
    if (!interactive) return null;
    throw new Error("Google sign-in isn't set up for this browser. Add GOOGLE_WEB_CLIENT_ID to src/firebase.js (see SETUP-GUIDE.md).");
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_WEB_CLIENT_ID,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "openid email profile"
  });
  if (interactive) params.set("prompt", "select_account");

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive
    });
    const result = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    if (result.get("error")) throw new Error(`Google sign-in failed: ${result.get("error")}`);
    return result.get("access_token");
  } catch (e) {
    if (!interactive) return null;
    throw e;
  }
}

// Signs into Firebase with a Google access token. Throws if interactive sign-in fails;
// returns null if a silent (non-interactive) sign-in isn't possible.
export async function signInWithGoogle({ interactive }) {
  const token = (await tokenFromChromeIdentity(interactive)) || (await tokenFromWebAuthFlow(interactive));
  if (!token) {
    if (interactive) throw new Error("Google sign-in was cancelled.");
    return null;
  }
  const { user } = await signInWithCredential(auth, GoogleAuthProvider.credential(null, token));
  return user;
}

export async function signOutGoogle() {
  await signOut(auth);
  try {
    await chrome.identity.clearAllCachedAuthTokens?.();
  } catch {
    // Not supported outside Chrome; nothing cached there anyway
  }
}
