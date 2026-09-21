async function saveEvent(evt) {
  const { events = [] } = await chrome.storage.local.get("events");
  events.push(evt);
  await chrome.storage.local.set({ events });
  console.log("[Meet Focus Tracker]", evt.type, new Date(evt.time).toLocaleTimeString());
}

chrome.runtime.onMessage.addListener((msg) => {
  saveEvent(msg);
});

chrome.idle.setDetectionInterval(15);
chrome.idle.onStateChanged.addListener((state) => {
  saveEvent({ type: state.toUpperCase(), time: Date.now() });
});