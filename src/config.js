// Google accounts allowed to open the professor dashboard.
// This is only a UI gate: keep it in sync with isProfessor() in firestore.rules,
// which is what actually stops other accounts from reading events.
export const PROFESSOR_EMAILS = [
  "draconic788@gmail.com",
  "renzkerbysajuelaofficial@gmail.com",
  "ajosejustingabriel@gmail.com"
];

export function isProfessorEmail(email) {
  return !!email && PROFESSOR_EMAILS.includes(email.toLowerCase());
}

// Google Meet room codes look like abc-defg-hij
export const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

// Meet room URLs come in two shapes: meet.google.com/abc-defg-hij and meet.google.com/meet/abc-defg-hij
export function meetCodeFromPath(pathname) {
  const parts = String(pathname).toLowerCase().split("/").filter(Boolean);
  if (parts[0] === "meet") parts.shift();
  return parts.length === 1 && MEET_CODE_RE.test(parts[0]) ? parts[0] : null;
}

// Returns the room code for a meet.google.com room URL, or null for the home page, lobby links, etc.
export function meetCodeFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "meet.google.com") return null;
    return meetCodeFromPath(u.pathname);
  } catch {
    return null;
  }
}
