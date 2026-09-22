const nameInput = document.getElementById("name");
const consentBox = document.getElementById("consent");
const status = document.getElementById("status");

const modeDisplay = document.getElementById("currentMode");

chrome.storage.local.get(["student", "currentMode"], ({ student, currentMode }) => {
  if (student) {
    nameInput.value = student.name;
    consentBox.checked = student.consent;
    status.textContent = student.consent ? "Tracking is ON in Meet." : "Tracking is OFF.";
  }
  if (currentMode) {
    modeDisplay.textContent = currentMode;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.currentMode) {
    modeDisplay.textContent = changes.currentMode.newValue;
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    status.textContent = "Please enter your name.";
    return;
  }
  await chrome.storage.local.set({
    student: { name, consent: consentBox.checked }
  });
  status.textContent = consentBox.checked
    ? "Saved. Tracking is ON in Meet."
    : "Saved. Tracking is OFF.";
});