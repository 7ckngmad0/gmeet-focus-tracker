async function saveEvent(evt) {
  const { student, events = [] } = await chrome.storage.local.get(["student", "events"]);
  if (!student || !student.consent) return;
  events.push({ ...evt, student: student.name });
  await chrome.storage.local.set({ events });
  console.log("[Meet Focus Tracker]", student.name, evt.type, new Date(evt.time).toLocaleTimeString());
}

chrome.runtime.onMessage.addListener((msg) => {
  saveEvent(msg);
});

chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener((state) => {
  saveEvent({ type: state.toUpperCase(), time: Date.now() });
});