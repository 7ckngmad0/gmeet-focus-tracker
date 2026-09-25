import { collection, addDoc } from "firebase/firestore";
import { db } from "./firebase";

async function saveEvent(evt) {
  const { student } = await chrome.storage.local.get(["student"]);
  if (!student || !student.consent) return;
  
  try {
    await addDoc(collection(db, "focus_events"), {
      ...evt,
      student: student.name,
      email: student.email,
      uid: student.uid,
      timestamp: evt.time
    });
    console.log("[Meet Focus Tracker]", student.email, evt.type, new Date(evt.time).toLocaleTimeString());
    
    // Also save current mode for the popup UI
    await chrome.storage.local.set({ currentMode: evt.type });
  } catch (e) {
    console.error("Error adding document: ", e);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  saveEvent(msg);
});

chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener((state) => {
  saveEvent({ type: state.toUpperCase(), time: Date.now() });
});