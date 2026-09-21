const nameInput = document.getElementById("name");
const consentBox = document.getElementById("consent");
const status = document.getElementById("status");

chrome.storage.local.get("student", ({ student }) => {
  if (student) {
    nameInput.value = student.name;
    consentBox.checked = student.consent;
    status.textContent = student.consent ? "Tracking is ON in Meet." : "Tracking is OFF.";
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