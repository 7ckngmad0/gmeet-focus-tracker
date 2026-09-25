importScripts("config.js");

async function saveEvent(evt) {
  const { student, events = [] } = await chrome.storage.local.get(["student", "events"]);
  if (!student || !student.consent) return;
  const fullEvent = { ...evt, student: student.name };
  events.push(fullEvent);
  await chrome.storage.local.set({ events });
  console.log("[Meet Focus Tracker]", student.name, evt.type, new Date(evt.time).toLocaleTimeString());
  sendToFirestore(fullEvent);
}

chrome.runtime.onMessage.addListener((msg) => {
  saveEvent(msg);
});

chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener((state) => {
  saveEvent({ type: state.toUpperCase(), time: Date.now() });
});

async function sendToFirestore(evt) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/events?key=${FIREBASE_API_KEY}`;

  const body = {
    fields: {
      student: { stringValue: evt.student },
      type: { stringValue: evt.type },
      time: { integerValue: evt.time },
      meetingCode: { stringValue: evt.meetingCode || "" }
    }
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error("Firestore write failed", await res.text());
    }
  } catch (e) {
    console.error("Firestore write error", e);
  }
}