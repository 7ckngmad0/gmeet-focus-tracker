import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { addDoc, collection, doc, getDocs, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth/web-extension";
import { signInWithPopup as webSignInWithPopup } from "firebase/auth";
import { MessagesSquare, Volume2, VolumeX, ChevronDown, Activity, ArrowRight, ArrowUpDown, Bell, LayoutDashboard, LayoutGrid, Rows3, ScrollText, BookOpen, CalendarDays, Check, Clock3, Copy, Download, History, Info, LockKeyhole, LogIn, LogOut, PanelsTopLeft, Pause, Pencil, Play, RefreshCw, Search, Square, TableProperties, Users, Video, WifiOff, X } from "lucide-react";
import { useRef } from "react";
import { auth, db, googleProvider } from "./firebase";
import { Wordmark } from "./Logo";
import { playSound, setSoundsEnabled, soundsEnabled } from "./sounds";

type EventType = "JOINED" | "RETURNED" | "AWAY" | "LEFT" | "IDLE" | "LOCKED" | "ACTIVE" | "TABS_UPDATED" | "HEARTBEAT";
type TrackerEvent = { id: string; email?: string; student?: string; uid?: string; type: EventType; time: number; tabCount?: number; meetingCode?: string; sessionId?: string; receivedAt?: { seconds?: number; nanoseconds?: number; toMillis?: () => number } | null };
type ClassSession = { id: string; meetingCode: string; status: "active" | "paused" | "ended"; startedAtMs: number; elapsedMs: number; pausedAtMs?: number; teacherUid?: string; endedAt?: { seconds?: number; nanoseconds?: number; toMillis?: () => number } | null };
type SessionDocument = { status?: string; startedAtMs?: number; elapsedMs?: number; pausedAtMs?: number | null; teacherUid?: string };
type Status = "Active" | "Idle" | "Away" | "Not detected" | "Left";
type Student = { name: string; email: string; uid: string; status: Status; focusMs: number; tabCount: number | null; lastEvent: string; lastTime: string };
type AfkNotice = { id: string; sessionId: string; teacherUid: string; studentUid: string; studentEmail: string; studentName: string; reason: "Short break" | "Urgent matter" | "Other"; status: "pending" | "acknowledged" | "returned"; createdAt?: { seconds?: number; nanoseconds?: number; toMillis?: () => number; toDate?: () => Date } | null; returnedAt?: { seconds?: number; nanoseconds?: number; toMillis?: () => number; toDate?: () => Date } | null };
type ClassActivity = { id: string; sessionId: string; teacherUid: string; question?: string; responseType?: "short-answer" | "multiple-choice"; options?: string[]; correctAnswer?: string; word?: string; targetUids: string[]; targetStudents: Array<{ uid: string; name: string; email: string }>; durationSeconds: number; startedAtMs: number; expiresAtMs: number; status: "active" | "closed" };
type ActivityResponse = { uid: string; email: string; name: string; answer: string; answeredAt?: { toDate: () => Date } };
type StudentActivityStats = { switches: number; meetingMs: number; focusedMs: number; awayMs: number; idleMs: number; focusPercent: number; counts: Map<EventType, number> };
type SessionRecap = { session: ClassSession; students: Student[]; events: TrackerEvent[]; elapsedMs: number; endedAtMs: number };
type DashboardNotification = { id: string; kind: "returned" | "reminder"; message: string; name?: string; email?: string; time: number };

const statusClass: Record<Status, string> = { Active: "active", Idle: "idle", Away: "away", "Not detected": "not-detected", Left: "left" };
const meetingCodePattern = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i;
const presenceTimeoutMs = 75_000;
const studentsPerPage = 20;
const recentEventsLimit = 10;
const dashboardNotificationLimit = 3;
const dashboardNotificationLifetimeMs = 60_000;
const dashboardNotificationExitMs = 280;
const returnedNoticeLifetimeMs = 60_000;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const historyLookbackMs = 30 * 24 * 60 * 60 * 1000;
// Explicit synthetic roster preview for local Vite and extension builds.
// Production users see real data unless they deliberately add the query flag.
const isExtensionPage = Boolean((globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);
const mockPreviewEnabled = import.meta.env.DEV || isExtensionPage;
const mockStudentCount = mockPreviewEnabled && new URLSearchParams(window.location.search).get("mockStudents") === "40" ? 40 : 0;
// Keep this dashboard gate aligned with PROFESSOR_EMAILS in src/config.js and
// the isProfessor() allowlist in firestore.rules. Firestore rules remain authoritative.
const professorEmails = new Set([
  "draconic788@gmail.com",
  "renzkerbysajuelaofficial@gmail.com",
  "ajosejustingabriel@gmail.com",
]);
const isProfessorEmail = (email: string | null | undefined) => Boolean(email && professorEmails.has(email.toLowerCase()));
function createMockStudents(now: number): Student[] {
  const statuses: Status[] = ["Active", "Away", "Idle", "Not detected", "Left"];
  const events: Record<Status, string> = { Active: "Presence check", Away: "Meet tab hidden", Idle: "No device input", "Not detected": "Last presence check", Left: "Left the meeting" };
  return Array.from({ length: mockStudentCount }, (_, index) => {
    const status = statuses[index % statuses.length];
    const email = `preview.student${String(index + 1).padStart(2, "0")}@example.test`;
    return {
      name: `Preview Student ${String(index + 1).padStart(2, "0")}`,
      email,
      uid: `preview-student-${index + 1}`,
      status,
      focusMs: (8 + (index * 7) % 53) * 60_000,
      tabCount: 3 + (index % 8),
      lastEvent: events[status],
      lastTime: new Date(now - index * 30_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    };
  });
}
const parseMeetingCode = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = trimmed.startsWith("meet.google.com/") ? `https://${trimmed}` : trimmed;
  if (candidate.includes("://")) {
    try {
      const url = new URL(candidate);
      if (url.hostname.toLowerCase() !== "meet.google.com") return "";
      const segments = url.pathname.split("/").filter(Boolean);
      const code = (segments[0]?.toLowerCase() === "meet" ? segments[1] : segments[0]) ?? "";
      return meetingCodePattern.test(code) ? code.toLowerCase() : "";
    } catch { return ""; }
  }
  return meetingCodePattern.test(trimmed) ? trimmed.toLowerCase() : "";
};
const normalizeActivityAnswer = (value: string) => value.normalize("NFKC").trim().toLowerCase();
const labelEvent = (type: EventType) => ({ JOINED: "Joined the Google Meet", RETURNED: "Returned to Google Meet", AWAY: "Meet tab hidden", LEFT: "Left the meeting", IDLE: "No device input", LOCKED: "Screen locked", ACTIVE: "Active again", TABS_UPDATED: "Browser tab count updated", HEARTBEAT: "Presence check" })[type] ?? type;
const formatClock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
const formatDuration = (milliseconds: number) => {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} hr ${minutes} min` : `${minutes} min`;
};
const formatEventTime = (milliseconds: number) => new Date(milliseconds).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const timestampMillis = (value: ClassSession["endedAt"] | null | undefined) => {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000 + (value.nanoseconds ?? 0) / 1_000_000;
  return 0;
};
const formatDate = (milliseconds: number) => new Date(milliseconds).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
const statusOrder: Status[] = ["Active", "Idle", "Away", "Not detected", "Left"];
const attentionStatuses = new Set<Status>(["Away", "Idle", "Not detected"]);

function summarizeStudentActivity(events: TrackerEvent[], asOf: number): StudentActivityStats {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const counts = new Map<EventType, number>();
  let inMeet = false, away = false, idle = false, switches = 0;
  let meetingMs = 0, focusedMs = 0, awayMs = 0, idleMs = 0;
  let previousTime: number | null = null;
  const accumulate = (time: number) => {
    if (previousTime === null || !inMeet) return;
    const duration = Math.max(0, time - previousTime);
    meetingMs += duration;
    if (away) awayMs += duration;
    else if (idle) idleMs += duration;
    else focusedMs += duration;
  };
  for (const event of sorted) {
    accumulate(event.time);
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    switch (event.type) {
      case "JOINED": inMeet = true; away = false; idle = false; break;
      case "RETURNED": inMeet = true; away = false; break;
      case "AWAY": inMeet = true; away = true; switches += 1; break;
      case "LEFT": inMeet = false; away = false; idle = false; break;
      case "IDLE": case "LOCKED": idle = true; break;
      case "ACTIVE": idle = false; break;
    }
    previousTime = event.time;
  }
  const last = sorted.at(-1);
  if (last && inMeet && previousTime !== null) {
    const effectiveAsOf = Math.min(asOf, last.time + presenceTimeoutMs);
    accumulate(effectiveAsOf);
  }
  return { switches, meetingMs, focusedMs, awayMs, idleMs, focusPercent: meetingMs ? Math.round(focusedMs / meetingMs * 100) : 0, counts };
}

const normalizeAnswer = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const activityExpected = (activity: ClassActivity) => (activity.question ? activity.correctAnswer ?? "" : activity.word ?? "").trim();
const activityLabel = (activity: ClassActivity) => activity.question?.trim() || `Type: ${activity.word ?? ""}`;
const activityKind = (activity: ClassActivity) => !activity.question ? "Word check"
  : activity.responseType === "multiple-choice" ? (activity.correctAnswer ? "Multiple choice" : "Poll")
  : (activity.correctAnswer ? "Short answer" : "Open question");
const activityVerdict = (activity: ClassActivity, response: ActivityResponse | undefined) => {
  if (!response) return "No answer";
  const expected = activityExpected(activity);
  if (!expected) return "Answered";
  return normalizeAnswer(response.answer) === normalizeAnswer(expected) ? "Correct" : "Incorrect";
};

// Build an Excel workbook with meeting, activity, and response details on separate sheets.
async function downloadSessionWorkbook(recap: SessionRecap, activities: ClassActivity[] = [], responsesByActivity: Record<string, ActivityResponse[]> = {}, note = "") {
  // Use the universal Blob writer so extension CSP / Worker URL handling cannot
  // block a recap download from the packaged dashboard.
  const { default: writeExcelFile } = await import("write-excel-file/universal");
  const rounds = [...activities].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const stamp = (milliseconds: number) => { const d = new Date(milliseconds); const pad = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const minutes = (milliseconds: number) => Math.round(milliseconds / 60000);
  const orderedEvents = [...recap.events].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

  // Everyone who either appeared in Meet or was asked a question, keyed by email.
  type Row = { name: string; email: string; uid: string; status: string; stats: StudentActivityStats | null };
  const people = new Map<string, Row>();
  for (const student of recap.students) people.set(student.email.toLowerCase(), { name: student.name, email: student.email, uid: student.uid, status: student.status, stats: summarizeStudentActivity(orderedEvents.filter(event => event.email === student.email), recap.endedAtMs) });
  for (const round of rounds) for (const target of round.targetStudents ?? []) {
    const key = target.email.toLowerCase();
    if (!people.has(key)) people.set(key, { name: target.name, email: target.email, uid: target.uid, status: "Not detected", stats: null });
  }
  const rows = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const responseFor = (round: ClassActivity, person: Row) => (responsesByActivity[round.id] ?? []).find(item => item.uid === person.uid || item.email.toLowerCase() === person.email.toLowerCase());
  const askedTo = (round: ClassActivity, person: Row) => (round.targetUids ?? []).includes(person.uid) || (round.targetStudents ?? []).some(target => target.email.toLowerCase() === person.email.toLowerCase());

  const withStats = rows.filter(row => row.stats && row.stats.meetingMs > 0);
  const averageFocus = withStats.length ? Math.round(withStats.reduce((sum, row) => sum + (row.stats?.focusPercent ?? 0), 0) / withStats.length) : "";
  const meetingRows: (string | number)[][] = [
    ["Meeting code", recap.session.meetingCode], ["Started", stamp(recap.session.startedAtMs)],
    ["Ended", stamp(recap.endedAtMs)], ["Duration", formatDuration(recap.elapsedMs)],
    ["Students in report", rows.length], ["Questions asked", rounds.length],
    ["Average focus share (%)", averageFocus],
    ...(note ? [["Note", note] as (string | number)[]] : [])
  ];
  const activityHeaders = ["Student", "Email", "Final status", "Time in Meet (min)", "Focused (min)", "Away (min)", "Idle or locked (min)", "Focus share (%)", "Tab switches", "Times away"];
  const activityRows: (string | number)[][] = [];
  for (const person of rows) {
    const stats = person.stats;
    activityRows.push([
      person.name, person.email, person.status,
      stats ? minutes(stats.meetingMs) : "", stats ? minutes(stats.focusedMs) : "", stats ? minutes(stats.awayMs) : "", stats ? minutes(stats.idleMs) : "",
      stats ? stats.focusPercent : "", stats ? stats.switches : "", stats ? stats.counts.get("AWAY") ?? 0 : ""
    ]);
  }
  const questionHeaders = ["Question #", "Question or prompt", "Format", "Correct answer", "Student", "Email", "Student answer", "Result", "Submitted at"];
  const questionRows: (string | number)[][] = [];
  if (rounds.length) {
    rounds.forEach((round, index) => {
      const expected = activityExpected(round);
      const askedStudents = rows.filter(person => askedTo(round, person));
      for (const person of askedStudents) {
        const response = responseFor(round, person);
        questionRows.push([
          index + 1, activityLabel(round), activityKind(round), expected,
          person.name, person.email, response?.answer ?? "", activityVerdict(round, response),
          response?.answeredAt?.toDate ? stamp(response.answeredAt.toDate().getTime()) : ""
        ]);
      }
    });
  }
  const date = new Date(recap.session.startedAtMs).toISOString().slice(0, 10);
  const titleStyle = { backgroundColor: "#581923", textColor: "#FFFFFF", fontWeight: "bold" as const, fontSize: 16, height: 32, alignVertical: "center" as const };
  const subtitleStyle = { backgroundColor: "#F5EAE8", textColor: "#694D4D", fontSize: 10, height: 28, wrap: true, alignVertical: "center" as const, bottomBorderStyle: "thin" as const, bottomBorderColor: "#D9C3C0" };
  const headerStyle = { backgroundColor: "#812B38", textColor: "#FFFFFF", fontWeight: "bold" as const, fontSize: 10, height: 32, wrap: true, alignVertical: "center" as const, bottomBorderStyle: "thin" as const, bottomBorderColor: "#6A202B" };
  const bodyStyle = (backgroundColor: string) => ({ backgroundColor, textColor: "#302326", fontSize: 10, height: 22, wrap: true, alignVertical: "center" as const, bottomBorderStyle: "thin" as const, bottomBorderColor: "#E6DAD8" });
  type StyledCell = { value: string | number; backgroundColor: string; textColor: string; fontWeight?: "bold"; fontSize?: number; height?: number; wrap?: boolean; alignVertical?: "center"; bottomBorderStyle?: "thin"; bottomBorderColor?: string; align?: "center"; columnSpan?: number };
  const makeSheet = (sheet: string, title: string, subtitle: string, headers: string[], data: (string | number)[][], widths: number[], statusColumn = -1) => {
    const rows: (StyledCell | null)[][] = [
      [{ value: title, columnSpan: headers.length, ...titleStyle }, ...Array.from({ length: headers.length - 1 }, () => null)],
      [{ value: subtitle, columnSpan: headers.length, ...subtitleStyle }, ...Array.from({ length: headers.length - 1 }, () => null)],
      headers.map(value => ({ value, ...headerStyle })),
      ...data.map((row, rowIndex) => {
        const questionIndex = Number(row[0]) || 0;
        const stripe = questionIndex ? (questionIndex % 2 ? "#FFF9F7" : "#F5ECEA") : (rowIndex % 2 ? "#F5ECEA" : "#FFF9F7");
        const cells: StyledCell[] = headers.map((_, index) => ({ value: row[index] ?? "", ...bodyStyle(stripe) }));
        if (statusColumn >= 0) {
          const result = String(row[statusColumn] ?? "");
          const resultStyle = result === "Correct"
            ? { backgroundColor: "#E5F3E8", textColor: "#28623A" }
            : result === "Incorrect"
              ? { backgroundColor: "#FBE9E7", textColor: "#8A3531" }
              : result === "No answer"
                ? { backgroundColor: "#FFF2D8", textColor: "#76551B" }
                : { backgroundColor: "#EAF0F4", textColor: "#425B6D" };
          cells[statusColumn] = { ...cells[statusColumn], ...resultStyle, fontWeight: "bold", align: "center" };
        }
        return cells;
      })
    ];
    return { data: rows, sheet, columns: widths.map(width => ({ width })), stickyRowsCount: 3, showGridLines: false, zoomScale: sheet === "Questions & Answers" ? 0.85 : 0.9 };
  };
  const sheets = [
    makeSheet("Meeting Info", "SESSION RECAP", "Meeting details and report coverage", ["Meeting detail", "Value"], meetingRows, [30, 48]),
    makeSheet("Student Activity", "STUDENT ACTIVITY", "One row per student · durations are shown in minutes", activityHeaders, activityRows, [26, 38, 18, 22, 18, 18, 24, 18, 16, 14]),
    makeSheet("Questions & Answers", "QUESTIONS & ANSWERS", "Correct · green   Incorrect · red   No answer · amber", questionHeaders, questionRows, [13, 42, 20, 30, 26, 38, 38, 16, 24], 7)
  ];
  const blob = await writeExcelFile(sheets, { fontFamily: "Aptos", fontSize: 10 }).toBlob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `iseenta-session-${recap.session.meetingCode}-${date}.xlsx`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toStudents(events: TrackerEvent[], now: number): Student[] {
  const grouped = new Map<string, TrackerEvent[]>();
  for (const event of events) {
    if (!event.email) continue;
    const list = grouped.get(event.email) ?? [];
    list.push(event);
    grouped.set(event.email, list);
  }
  const students: Student[] = [];
  for (const [email, list] of grouped) {
    list.sort((a, b) => {
      const eventTimeOrder = a.time - b.time;
      if (eventTimeOrder) return eventTimeOrder;
      const aReceipt = a.receivedAt?.seconds;
      const bReceipt = b.receivedAt?.seconds;
      if (typeof aReceipt === "number" && typeof bReceipt === "number") {
        const receiptOrder = aReceipt - bReceipt || (a.receivedAt?.nanoseconds ?? 0) - (b.receivedAt?.nanoseconds ?? 0);
        if (receiptOrder) return receiptOrder;
      }
      return a.id.localeCompare(b.id);
    });
    let inMeet = false, away = false, idle = false, joined = false, focusMs = 0, focusedSince: number | null = null, tabCount: number | null = null, name = email, uid = "";
    const settle = (time: number) => {
      const focused = inMeet && !away && !idle;
      if (focused && focusedSince === null) focusedSince = time;
      else if (!focused && focusedSince !== null) { focusMs += Math.max(0, time - focusedSince); focusedSince = null; }
    };
    for (const event of list) {
      name = event.student || name;
      uid = event.uid || uid;
      if (Number.isInteger(event.tabCount) && (event.tabCount as number) >= 0) tabCount = event.tabCount as number;
      switch (event.type) {
        case "JOINED": case "RETURNED": inMeet = true; away = false; joined = true; if (event.type === "JOINED") idle = false; break;
        case "AWAY": inMeet = true; away = true; joined = true; break;
        case "LEFT": inMeet = false; away = false; break;
        case "IDLE": case "LOCKED": idle = true; break;
        case "ACTIVE": idle = false; break;
      }
      settle(event.time);
    }
    if (!joined) continue;
    const last = list[list.length - 1];
    const presenceExpired = inMeet && now > last.time + presenceTimeoutMs;
    if (focusedSince !== null) focusMs += Math.max(0, Math.min(now, last.time + presenceTimeoutMs) - focusedSince);
    const lastVisibleEvent = list.slice().reverse().find(event => event.type !== "HEARTBEAT") ?? last;
    students.push({ name, email, uid, status: !inMeet ? "Left" : presenceExpired ? "Not detected" : away ? "Away" : idle ? "Idle" : "Active", focusMs, tabCount, lastEvent: labelEvent(lastVisibleEvent.type), lastTime: new Date(lastVisibleEvent.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) });
  }
  return students.sort((a, b) => a.name.localeCompare(b.name));
}

// Eased scroll to a section: slow start, smooth glide, soft landing. Stops if the user scrolls.
function smoothScrollTo(targetY: number, onDone?: () => void) {
  const startY = window.scrollY;
  const delta = targetY - startY;
  if (Math.abs(delta) < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.scrollTo(0, targetY);
    onDone?.();
    return;
  }
  const duration = Math.min(1100, Math.max(650, Math.abs(delta) * 0.6));
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let frame = 0;
  let interrupted = false;
  const stop = () => { interrupted = true; cancelAnimationFrame(frame); cleanup(); };
  const cleanup = () => ["wheel", "touchstart", "keydown"].forEach(type => window.removeEventListener(type, stop));
  ["wheel", "touchstart", "keydown"].forEach(type => window.addEventListener(type, stop, { passive: true }));
  const start = performance.now();
  const step = (now: number) => {
    if (interrupted) return;
    const t = Math.min(1, (now - start) / duration);
    window.scrollTo(0, startY + delta * ease(t));
    if (t < 1) { frame = requestAnimationFrame(step); return; }
    cleanup();
    onDone?.();
  };
  frame = requestAnimationFrame(step);
}

function goToActivity(event: { preventDefault: () => void }) {
  event.preventDefault();
  const target = document.getElementById("activity");
  if (!target) return;
  const barHeight = document.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 87;
  const maxY = document.documentElement.scrollHeight - window.innerHeight;
  const y = Math.max(0, Math.min(maxY, target.getBoundingClientRect().top + window.scrollY - barHeight - 16));
  smoothScrollTo(y, () => {
    target.classList.remove("arrive");
    void target.offsetWidth;
    target.classList.add("arrive");
  });
}

// Animates a number toward its target (ease-out), starting from 0 on first mount.
function useCountUp(target: number, duration = 650) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setValue(target); from.current = target; return; }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(origin + (target - origin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick); else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

export default function App() {
  const detailDialog = useRef<HTMLDialogElement>(null);
  const afkRequestsRef = useRef<AfkNotice[]>([]);
  const notificationTimeoutsRef = useRef(new Map<string, number>());
  const notificationRemovalTimeoutsRef = useRef(new Map<string, number>());
  const activityResponseInitializedRef = useRef(new Set<string>());
  const activityKnownResponseIdsRef = useRef(new Set<string>());
  const activityResponseErrorsRef = useRef(new Map<string, string>());
  const activitySessionKeyRef = useRef("");
  const prevOpenActivityRef = useRef<string | null>(null);
  const [user, setUser] = useState(() => mockStudentCount ? ({ uid: "local-preview-professor", email: "preview@localhost" } as NonNullable<typeof auth.currentUser>) : auth.currentUser);
  const [events, setEvents] = useState<TrackerEvent[]>([]);
  const [classActivities, setClassActivities] = useState<ClassActivity[]>([]);
  const [activityResponses, setActivityResponses] = useState<Record<string, ActivityResponse[]>>({});
  const [activityQuestion, setActivityQuestion] = useState("");
  const [activityResponseType, setActivityResponseType] = useState<"short-answer" | "multiple-choice">("short-answer");
  const [activityOptions, setActivityOptions] = useState(["", ""]);
  const [activityCorrectAnswer, setActivityCorrectAnswer] = useState("");
  const [activityDurationSeconds, setActivityDurationSeconds] = useState(60);
  const [creatingActivity, setCreatingActivity] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [activityResponseError, setActivityResponseError] = useState("");
  const [pendingActivityIds, setPendingActivityIds] = useState<string[]>([]);
  const [openPanel, setOpenPanel] = useState<null | "questions" | "away">(null);
  const [lastPanel, setLastPanel] = useState<"questions" | "away">("questions");
  const showClassActivities = openPanel === "questions";
  const showAfkNotices = openPanel === "away";
  const setShowAfkNotices = (next: boolean | ((current: boolean) => boolean)) => setOpenPanel(current => { const value = typeof next === "function" ? next(current === "away") : next; return value ? "away" : current === "away" ? null : current; });
  const togglePanel = (panel: "questions" | "away") => setOpenPanel(current => current === panel ? null : panel);
  const [soundsOn, setSoundsOn] = useState(soundsEnabled);
  const [expandedRounds, setExpandedRounds] = useState<Record<string, boolean>>({});
  const [roundFilters, setRoundFilters] = useState<Record<string, "all" | "correct" | "incorrect" | "none">>({});
  const [hideCorrections, setHideCorrections] = useState<Record<string, boolean>>({});
  const [activityResultFilter, setActivityResultFilter] = useState<"all" | "live" | "ended">("all");
  const [dashboardNotifications, setDashboardNotifications] = useState<DashboardNotification[]>([]);
  const [exitingDashboardNotifications, setExitingDashboardNotifications] = useState<string[]>([]);
  const [afkRequests, setAfkRequests] = useState<AfkNotice[]>([]);
  const [afkNoticeTab, setAfkNoticeTab] = useState<"away" | "pending" | "acknowledged" | "returned">("pending");
  const [acknowledgingRequestId, setAcknowledgingRequestId] = useState<string | null>(null);
  const [sendingProfessorAlert, setSendingProfessorAlert] = useState(false);
  const [professorAlertFeedback, setProfessorAlertFeedback] = useState("");
  const [loadError, setLoadError] = useState("");
  const [authError, setAuthError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [meetingCode, setMeetingCode] = useState(() => {
    if (mockStudentCount) return "abc-defg-hij";
    const roomFromPopup = parseMeetingCode(new URLSearchParams(window.location.search).get("room") || "");
    return roomFromPopup || localStorage.getItem("kinetic-test-meeting-code") || "";
  });
  const [meetingLinkDraft, setMeetingLinkDraft] = useState(() => {
    const savedCode = localStorage.getItem("kinetic-test-meeting-code") || "";
    return savedCode ? `https://meet.google.com/${savedCode}` : "";
  });
  const [meetingLinkError, setMeetingLinkError] = useState("");
  const [activeSession, setActiveSession] = useState<ClassSession | null>(() => mockStudentCount ? { id: "local-preview-session", meetingCode: "abc-defg-hij", status: "active", startedAtMs: Date.now() - 42 * 60_000, elapsedMs: 0, teacherUid: "local-preview-professor" } : null);
  const [sessionRecap, setSessionRecap] = useState<SessionRecap | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const timerRunning = activeSession?.status === "active";
  const elapsedMs = activeSession ? activeSession.elapsedMs + (timerRunning ? Math.max(0, now - activeSession.startedAtMs) : 0) : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const [dark, setDark] = useState(() => { const stored = localStorage.getItem("kinetic-theme"); return stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches; });
  const [navPinned, setNavPinned] = useState(false);
  const [awayOnly, setAwayOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [studentPage, setStudentPage] = useState(0);
  const [meetingCodeCopied, setMeetingCodeCopied] = useState(false);
  const [editingLink, setEditingLink] = useState(false);
  const [selectedStudentEmail, setSelectedStudentEmail] = useState<string | null>(null);
  const [showHistoryPage, setShowHistoryPage] = useState(() => window.location.hash === "#history");
  const [retainedSessions, setRetainedSessions] = useState<Array<ClassSession & { endedAtMs: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [exportingSessionId, setExportingSessionId] = useState<string | null>(null);
  const [downloadedRecaps, setDownloadedRecaps] = useState<string[]>(() => { try { const stored = JSON.parse(localStorage.getItem("iseenta-downloaded-recaps") ?? "[]"); return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []; } catch { return []; } });
  const [historyPage, setHistoryPage] = useState(0);
  const [historySearch, setHistorySearch] = useState("");
  const [historySort, setHistorySort] = useState<"newest" | "oldest">("newest");
  const [historyFilter, setHistoryFilter] = useState<"all" | "soon">("all");
  const [historyView, setHistoryView] = useState<"grid" | "list">("grid");

  const dismissDashboardNotification = (id: string) => {
    const notificationTimer = notificationTimeoutsRef.current.get(id);
    if (notificationTimer) window.clearTimeout(notificationTimer);
    notificationTimeoutsRef.current.delete(id);
    if (notificationRemovalTimeoutsRef.current.has(id)) return;
    setExitingDashboardNotifications(current => current.includes(id) ? current : [...current, id]);
    const removalTimer = window.setTimeout(() => {
      setDashboardNotifications(current => current.filter(notification => notification.id !== id));
      setExitingDashboardNotifications(current => current.filter(notificationId => notificationId !== id));
      notificationRemovalTimeoutsRef.current.delete(id);
    }, dashboardNotificationExitMs);
    notificationRemovalTimeoutsRef.current.set(id, removalTimer);
  };
  const addDashboardNotification = (notification: DashboardNotification) => {
    if (notification.kind === "returned") playSound("notify");
    const id = notification.kind === "returned" && notification.email ? `returned-${notification.email.toLowerCase()}` : notification.id;
    const coalescedNotification = { ...notification, id };
    const oldTimer = notificationTimeoutsRef.current.get(id);
    if (oldTimer) window.clearTimeout(oldTimer);
    notificationTimeoutsRef.current.delete(id);
    const removalTimer = notificationRemovalTimeoutsRef.current.get(id);
    if (removalTimer) window.clearTimeout(removalTimer);
    notificationRemovalTimeoutsRef.current.delete(id);
    setExitingDashboardNotifications(current => current.filter(notificationId => notificationId !== id));
    setDashboardNotifications(current => [coalescedNotification, ...current.filter(item => item.id !== id)]
      .sort((a, b) => Number(b.kind === "returned") - Number(a.kind === "returned") || b.time - a.time)
      .slice(0, dashboardNotificationLimit));
    const timeout = window.setTimeout(() => {
      notificationTimeoutsRef.current.delete(id);
      dismissDashboardNotification(id);
    }, dashboardNotificationLifetimeMs - dashboardNotificationExitMs);
    notificationTimeoutsRef.current.set(id, timeout);
  };

  useEffect(() => {
    if (mockStudentCount) return;
    return onAuthStateChanged(auth, currentUser => {
      if (!currentUser) { setUser(null); return; }
      if (!isProfessorEmail(currentUser.email)) {
        setUser(null);
        setAuthError("This Google account is not authorized to view the professor dashboard.");
        // Inside the extension this Auth instance is shared with the student popup,
        // so signing out here would also sign the student out of the extension.
        if (!isExtensionPage) void signOut(auth);
        return;
      }
      setAuthError("");
      setUser(currentUser);
    });
  }, []);
  // Keep the dashboard and the extension popup on one account. The service worker
  // publishes the signed-in profile as `extensionAuth`; mirror it here both ways.
  useEffect(() => {
    if (mockStudentCount || !isExtensionPage) return;
    type ExtAuth = { role?: string; uid?: string } | null;
    const ext = (globalThis as typeof globalThis & { chrome?: { storage?: { local?: { get: (key: string) => Promise<Record<string, unknown>> }; onChanged?: { addListener: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void; removeListener: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void } } } }).chrome;
    if (!ext?.storage?.local || !ext.storage.onChanged) return;
    let cancelled = false;
    let timer = 0;
    const reconcile = (shared: ExtAuth) => {
      window.clearTimeout(timer);
      if (!shared) {
        // Signed out from the popup (or another dashboard): drop the local session too.
        if (auth.currentUser) void signOut(auth).catch(() => undefined);
        setUser(null);
        return;
      }
      if (shared.role !== "professor" || auth.currentUser?.uid === shared.uid) return;
      // Signed in elsewhere. Firebase normally delivers the new session on its own;
      // if it hasn't within a few seconds, reload once so Auth restores it from storage.
      timer = window.setTimeout(() => {
        if (cancelled || auth.currentUser?.uid === shared.uid) return;
        const flag = "iseenta-auth-reload";
        if (Date.now() - Number(sessionStorage.getItem(flag) ?? 0) < 15_000) return;
        sessionStorage.setItem(flag, String(Date.now()));
        window.location.reload();
      }, 3000);
    };
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes.extensionAuth) reconcile((changes.extensionAuth.newValue as ExtAuth) ?? null);
    };
    ext.storage.onChanged.addListener(onChanged);
    // Ask the service worker (it republishes from its own Firebase session) rather than
    // trusting a possibly stale storage value on first load.
    void (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?: (m: unknown) => Promise<{ auth?: ExtAuth }> } } }).chrome?.runtime?.sendMessage?.({ cmd: "getExtensionAuth" })
      .then(reply => { if (!cancelled && reply) reconcile(reply.auth ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; window.clearTimeout(timer); ext.storage?.onChanged?.removeListener(onChanged); };
  }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  // Follow the browser setting until the user picks a theme with the toggle.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (!localStorage.getItem("kinetic-theme")) setDark(query.matches); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const toggleTheme = () => { const next = !dark; localStorage.setItem("kinetic-theme", next ? "dark" : "light"); setDark(next); };
  useEffect(() => {
    const onScroll = () => {
      setNavPinned(window.scrollY > 24);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const dialog = detailDialog.current;
    if (!dialog) return;
    if (selectedStudentEmail && !dialog.open) dialog.showModal();
    else if (!selectedStudentEmail && dialog.open) dialog.close();
  }, [selectedStudentEmail]);
  useEffect(() => { if (showHistoryPage && user) void loadRetainedSessions(); }, [showHistoryPage, user?.uid]);
  // Local preview only (?mockStudents=40): synthetic recaps so the history page can be reviewed without Firestore.
  useEffect(() => {
    if (!mockStudentCount || !showHistoryPage || historyLoaded) return;
    const base = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const codes = ["abc-defg-hij", "klm-nopq-rst", "uvw-xyza-bcd", "efg-hijk-lmn", "opq-rstu-vwx", "yza-bcde-fgh", "ijk-lmno-pqr", "stu-vwxy-zab", "cde-fghi-jkl"];
    const ages = [0.4, 2.1, 7, 9.2, 14, 17.6, 22.5, 25.1, 28.8];
    setHistoryLoading(true);
    const timer = window.setTimeout(() => {
      setRetainedSessions(codes.map((meetingCode, index) => ({ id: `preview-session-${index}`, meetingCode, status: "ended" as const, startedAtMs: base - ages[index] * day - 2.5 * 60 * 60 * 1000, elapsedMs: (140 + index * 3) * 60 * 1000, endedAtMs: base - ages[index] * day })));
      setHistoryLoaded(true);
      setHistoryLoading(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [showHistoryPage, historyLoaded]);

  useEffect(() => { setShowAfkNotices(false); }, [activeSession?.id]);
  useEffect(() => { if (mockStudentCount) return; if (!user || !meetingCode) { setActiveSession(null); return; }
    const roomSessions = query(collection(db, "sessions"), where("meetingCode", "==", meetingCode));
    return onSnapshot(roomSessions, snap => {
      const match = snap.docs
        .map(item => ({ id: item.id, ...(item.data() as SessionDocument) }))
        .filter(item => item.status === "active" || item.status === "paused")
        .sort((a, b) => Number(b.startedAtMs ?? 0) - Number(a.startedAtMs ?? 0))[0];
      if (!match) { setActiveSession(null); return; }
      setActiveSession({ id: match.id, meetingCode, status: match.status === "active" ? "active" : "paused", startedAtMs: Number(match.startedAtMs ?? Date.now()), elapsedMs: Number(match.elapsedMs ?? 0), pausedAtMs: Number(match.pausedAtMs ?? 0), teacherUid: match.teacherUid });
    }, error => { console.error("Could not load class session", error); setLoadError("Could not load the class session. Check Firestore rules."); });
  }, [user, meetingCode]);
  useEffect(() => {
    if (mockStudentCount) return;
    if (!user || !activeSession) { setEvents([]); return; }
    setLoadError("");
    const sessionEvents = query(collection(db, "events"), where("sessionId", "==", activeSession.id));
    let initialSnapshot = true;
    let latestSeenEventTime = 0;
    return onSnapshot(sessionEvents, snap => {
      const nextEvents = snap.docs.map(item => ({ ...item.data(), id: item.id, time: Number(item.data().time) } as TrackerEvent));
      setEvents(nextEvents);
      if (initialSnapshot) {
        if (snap.metadata.fromCache) return;
        initialSnapshot = false;
        latestSeenEventTime = Math.max(0, ...nextEvents.map(event => event.time));
        return;
      }
      const returnedEvent = snap.docChanges()
        .filter(change => change.type === "added")
        .map(change => ({ ...change.doc.data(), id: change.doc.id, time: Number(change.doc.data().time) } as TrackerEvent))
        .filter(event => event.type === "RETURNED" && Boolean(event.email) && event.time > latestSeenEventTime)
        .sort((a, b) => b.time - a.time)[0];
      latestSeenEventTime = Math.max(latestSeenEventTime, ...nextEvents.map(event => event.time));
      if (returnedEvent?.email) {
        addDashboardNotification({ id: returnedEvent.id, kind: "returned", message: "Returned to Google Meet", name: returnedEvent.student || returnedEvent.email, email: returnedEvent.email, time: returnedEvent.time });
      }
    }, error => {
      console.error("Could not load session events", error);
      setLoadError(error.code === "permission-denied" ? "This Google account is not authorized to view this session." : "Could not load session activity. Check Firestore rules and try again.");
    });
  }, [user, activeSession?.id]);
  useEffect(() => {
    const activitySession = activeSession ?? sessionRecap?.session ?? null;
    const sessionKey = activitySession && user ? `${user.uid}:${activitySession.id}` : "";
    if (activitySessionKeyRef.current !== sessionKey) {
      activitySessionKeyRef.current = sessionKey;
      activityResponseInitializedRef.current.clear();
      activityKnownResponseIdsRef.current.clear();
    }
    if (mockStudentCount || !user || !activitySession || activitySession.teacherUid !== user.uid) {
      setClassActivities([]);
      setActivityResponses({});
      setOpenPanel(current => current === "questions" ? null : current);
      return;
    }
    const sessionActivities = query(
      collection(db, "classActivities"),
      where("sessionId", "==", activitySession.id),
      where("teacherUid", "==", user.uid)
    );
    return onSnapshot(sessionActivities, { includeMetadataChanges: true }, snapshot => {
      const nextActivities = snapshot.docs
        .map(item => ({ ...item.data(), id: item.id } as ClassActivity))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      // A question you just posted exists locally before Firestore has it. Its answers
      // are only listened to once the server has it, or the rules reject the early request.
      const pending = snapshot.docs.filter(item => item.metadata.hasPendingWrites).map(item => item.id).sort();
      setPendingActivityIds(current => current.join(",") === pending.join(",") ? current : pending);
      setClassActivities(nextActivities);
    }, error => {
      console.error("Could not load class activities", error);
      setLoadError(error.code === "permission-denied"
        ? "Firestore denied access to class activities. Publish the latest firestore.rules to enable quick class checks."
        : "Could not load class activities. Check your connection and try again.");
    });
  }, [user?.uid, activeSession?.id, activeSession?.teacherUid, sessionRecap?.session.id, sessionRecap?.session.teacherUid, mockStudentCount]);
  useEffect(() => {
    const activityIds = new Set(classActivities.map(activity => activity.id));
    for (const activityId of activityResponseErrorsRef.current.keys()) {
      if (!activityIds.has(activityId)) activityResponseErrorsRef.current.delete(activityId);
    }
    setActivityResponseError(activityResponseErrorsRef.current.values().next().value ?? "");
    if (!classActivities.length) {
      setActivityResponses({});
      activityResponseInitializedRef.current.clear();
      activityKnownResponseIdsRef.current.clear();
      return;
    }
    const unsubscribers = classActivities.filter(activity => !pendingActivityIds.includes(activity.id)).map(activity => onSnapshot(
      collection(db, "classActivities", activity.id, "responses"),
      snapshot => {
        activityResponseErrorsRef.current.delete(activity.id);
        setActivityResponseError(activityResponseErrorsRef.current.values().next().value ?? "");
        const knownIds = activityKnownResponseIdsRef.current;
        if (!activityResponseInitializedRef.current.has(activity.id)) {
          snapshot.docs.forEach(item => knownIds.add(`${activity.id}:${item.id}`));
          if (!snapshot.metadata.fromCache) activityResponseInitializedRef.current.add(activity.id);
        } else {
          snapshot.docChanges().forEach(change => {
            if (change.type !== "added") return;
            const responseId = `${activity.id}:${change.doc.id}`;
            if (knownIds.has(responseId)) return;
            knownIds.add(responseId);
          });
        }
        setActivityResponses(current => ({
          ...current,
          [activity.id]: snapshot.docs.map(item => item.data() as ActivityResponse)
        }));
      },
      error => {
        console.error("Could not load class activity responses", error);
        const message = error.code === "permission-denied"
          ? "Firestore denied access to student responses. Publish the latest firestore.rules."
          : "Could not load student responses. Check your connection and try again.";
        activityResponseErrorsRef.current.set(activity.id, message);
        setActivityResponseError(activityResponseErrorsRef.current.values().next().value ?? message);
      }
    ));
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  }, [classActivities.map(activity => activity.id).join(","), pendingActivityIds.join(",")]);
  useEffect(() => {
    if (mockStudentCount || !user || !activeSession) { afkRequestsRef.current = []; setAfkRequests([]); return; }
    const noticesQuery = query(collection(db, "afkRequests"), where("teacherUid", "==", user.uid));
    let initialSnapshot = true;
    return onSnapshot(noticesQuery, snapshot => {
      const notices = snapshot.docs
        .map(item => ({ ...item.data(), id: item.id } as AfkNotice))
        .filter(item => item.sessionId === activeSession.id)
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      if (!initialSnapshot) {
        for (const notice of notices) {
          const previousNotice = afkRequestsRef.current.find(previous => previous.id === notice.id);
          if (notice.status === "pending" && !previousNotice) { setAfkNoticeTab("pending"); playSound("warning"); }
          if (notice.status === "returned" && previousNotice?.status !== "returned") {
            setAfkNoticeTab("returned");
            addDashboardNotification({ id: `afk-return-${notice.id}`, kind: "returned", message: "Confirmed they are back from an away notice", name: notice.studentName || notice.studentEmail, email: notice.studentEmail, time: timestampMillis(notice.returnedAt) || Date.now() });
          }
        }
      } else if (!snapshot.metadata.fromCache) {
        const hasUnresolvedNotice = notices.some(notice => notice.status !== "returned");
        const hasRecentReturn = notices.some(notice => notice.status === "returned" && timestampMillis(notice.returnedAt) > 0 && Date.now() - timestampMillis(notice.returnedAt) < returnedNoticeLifetimeMs);
        if (hasUnresolvedNotice || hasRecentReturn) {
          setAfkNoticeTab(hasRecentReturn && !hasUnresolvedNotice ? "returned" : notices.some(notice => notice.status === "pending") ? "pending" : "acknowledged");
        }
        initialSnapshot = false;
      }
      afkRequestsRef.current = notices;
      setAfkRequests(notices);
    }, error => {
      console.error("Could not load student AFK notices", error);
      setLoadError(error.code === "permission-denied"
        ? "Firestore denied access to student notices. Publish the latest firestore.rules to enable away notices."
        : "Could not load student notices. Check your connection and try again.");
    });
  }, [user?.uid, activeSession?.id, mockStudentCount]);

  const students = useMemo(() => mockStudentCount ? createMockStudents(now) : toStudents(events, activeSession?.status === "paused" ? (activeSession.pausedAtMs || now) : now), [events, now, activeSession?.status, activeSession?.pausedAtMs]);
  const awayStudents = students.filter(student => student.status === "Away" && student.uid);
  const openClassActivity = classActivities.find(activity => activity.status === "active" && activity.expiresAtMs > now);
  const openActivitySeconds = openClassActivity ? Math.max(0, Math.ceil((openClassActivity.expiresAtMs - now) / 1000)) : 0;
  const visibleClassActivities = classActivities.filter(activity => {
    const isOpen = activity.status === "active" && activity.expiresAtMs > now;
    return activityResultFilter === "all" || (activityResultFilter === "live" ? isOpen : !isOpen);
  });
  const activityOpenCount = classActivities.filter(activity => activity.status === "active" && activity.expiresAtMs > now).length;
  const activityClosedCount = classActivities.length - activityOpenCount;
  const startClassActivity = async () => {
    if (!user || !activeSession || activeSession.status !== "active" || creatingActivity || mockStudentCount) return;
    const question = activityQuestion.trim();
    const options = activityResponseType === "multiple-choice" ? activityOptions.map(option => option.trim()).filter(Boolean) : [];
    const correctAnswer = activityCorrectAnswer.trim();
    const targetStudents = [...new Map(students
      .filter(student => student.uid)
      .map(student => [student.uid, { uid: student.uid, name: student.name, email: student.email }] as const)).values()];
    const targetUids = targetStudents.map(student => student.uid);
    setActivityError("");
    if (!question || question.length > 240) {
      setActivityError("Enter a question or prompt of up to 240 characters.");
      return;
    }
    if (activityResponseType === "multiple-choice" && (options.length < 2 || options.length > 6)) {
      setActivityError("Add between 2 and 6 answer choices.");
      return;
    }
    if (activityResponseType === "multiple-choice" && new Set(options.map(normalizeActivityAnswer)).size !== options.length) {
      setActivityError("Answer choices must be unique.");
      return;
    }
    if (correctAnswer && activityResponseType === "multiple-choice" && !options.some(option => normalizeActivityAnswer(option) === normalizeActivityAnswer(correctAnswer))) {
      setActivityError("Choose a correct answer from the listed choices, or leave it as a poll.");
      return;
    }
    if (!targetUids.length) {
      setActivityError("Wait for students to join and appear in the activity list before starting a check.");
      return;
    }
    if (targetUids.length > 300) {
      setActivityError("Quick checks support up to 300 students in one class.");
      return;
    }

    setCreatingActivity(true);
    try {
      const startedAtMs = Date.now();
      await addDoc(collection(db, "classActivities"), {
        sessionId: activeSession.id,
        teacherUid: user.uid,
        meetingCode: activeSession.meetingCode,
        question,
        responseType: activityResponseType,
        options,
        correctAnswer,
        targetUids,
        targetStudents,
        durationSeconds: activityDurationSeconds,
        startedAtMs,
        expiresAtMs: startedAtMs + activityDurationSeconds * 1000,
        status: "active",
        createdAt: serverTimestamp()
      });
      setActivityQuestion("");
      setActivityCorrectAnswer("");
      if (activityResponseType === "multiple-choice") setActivityOptions(["", ""]);
      setOpenPanel("questions");
      setActivityResultFilter("all");
    } catch (error) {
      console.error("Could not start class activity", error);
      setActivityError(error instanceof Error
        ? `Could not start the quick check: ${error.message}`
        : "Could not start the quick check. Check Firestore rules and try again.");
    } finally {
      setCreatingActivity(false);
    }
  };
  const visible = useMemo(() => students.filter(s => (!awayOnly || s.status === "Away") && `${s.name} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase())), [students, awayOnly, search]);
  const pageCount = Math.ceil(visible.length / studentsPerPage);
  const currentStudentPage = Math.min(studentPage, Math.max(0, pageCount - 1));
  const visiblePage = visible.slice(currentStudentPage * studentsPerPage, (currentStudentPage + 1) * studentsPerPage);
  const historyPerPage = 6;
  const dayMs = 24 * 60 * 60 * 1000;
  const daysLeftOf = (session: { endedAtMs: number }) => Math.max(0, Math.ceil((session.endedAtMs + retentionMs - now) / dayMs));
  const filteredHistory = retainedSessions
    .filter(session => session.meetingCode.toLowerCase().includes(historySearch.trim().toLowerCase()))
    .filter(session => historyFilter === "all" || daysLeftOf(session) <= 7)
    .sort((a, b) => historySort === "newest" ? b.endedAtMs - a.endedAtMs : a.endedAtMs - b.endedAtMs);
  const historyPageCount = Math.ceil(filteredHistory.length / historyPerPage);
  const currentHistoryPage = Math.min(historyPage, Math.max(0, historyPageCount - 1));
  const visibleHistorySessions = filteredHistory.slice(currentHistoryPage * historyPerPage, (currentHistoryPage + 1) * historyPerPage);
  const expiringSoonCount = retainedSessions.filter(session => daysLeftOf(session) <= 7).length;
  const historyTotalMs = retainedSessions.reduce((sum, session) => sum + session.elapsedMs, 0);
  const historyAverageMs = retainedSessions.length ? historyTotalMs / retainedSessions.length : 0;
  const historyByDate = [...retainedSessions].sort((a, b) => a.endedAtMs - b.endedAtMs);
  const historyLongestMs = retainedSessions.reduce((max, session) => Math.max(max, session.elapsedMs), 0);
  const nextExpiryDays = historyByDate.length ? daysLeftOf(historyByDate[0]) : retentionMs / dayMs;
  const weekMs = 7 * dayMs;
  const weekBuckets = Array.from({ length: 4 }, (_, slot) => { const age = 3 - slot; return { slot, age, count: retainedSessions.filter(session => Math.floor((now - session.endedAtMs) / weekMs) === age).length }; });
  const weekBlockMax = Math.max(1, ...weekBuckets.map(week => week.count));
  const sessionsThisWeek = weekBuckets[3].count;
  const sessionsPerWeek = weekBuckets.reduce((sum, week) => sum + week.count, 0) / 4;
  const recentSessions = historyByDate.slice(-5).reverse();
  const compactLength = (ms: number) => { const total = Math.round(ms / 60000); const h = Math.floor(total / 60); const m = total % 60; return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`; };
  const startOf = (session: { startedAtMs?: number; endedAtMs: number; elapsedMs: number }) => session.startedAtMs || session.endedAtMs - session.elapsedMs;
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const weekdayStats = weekdayOrder.map(day => {
    const list = retainedSessions.filter(session => new Date(startOf(session)).getDay() === day);
    return { day, count: list.length, lastMs: list.reduce((max, session) => Math.max(max, session.endedAtMs), 0), label: new Date(2024, 0, 1 + weekdayOrder.indexOf(day)).toLocaleDateString([], { weekday: "narrow" }), long: new Date(2024, 0, 1 + weekdayOrder.indexOf(day)).toLocaleDateString([], { weekday: "long" }) };
  });
  const weekdayMax = Math.max(1, ...weekdayStats.map(item => item.count));
  const busiestWeekday = retainedSessions.length ? [...weekdayStats].sort((x, y) => y.count - x.count || y.lastMs - x.lastMs)[0] : null;
  const startMinutes = retainedSessions.map(session => { const d = new Date(startOf(session)); return d.getHours() * 60 + d.getMinutes(); }).sort((x, y) => x - y);
  const usualStartMinutes = startMinutes.length ? startMinutes[Math.floor((startMinutes.length - 1) / 2)] : 0;
  const usualStartLabel = new Date(2024, 0, 1, Math.floor(usualStartMinutes / 60), usualStartMinutes % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const expiryTicks = Array.from({ length: 31 }, (_, day) => ({ day, count: retainedSessions.filter(session => daysLeftOf(session) === day).length })).filter(tick => tick.count > 0);
  const nextExpiryDate = new Date(now + nextExpiryDays * dayMs).toLocaleDateString([], { month: "short", day: "numeric" });
  const historyGroups = (() => {
    const groups: { label: string; items: { session: (typeof retainedSessions)[number]; index: number }[] }[] = [];
    visibleHistorySessions.forEach((session, index) => {
      const age = (now - session.endedAtMs) / dayMs;
      const label = age < 1 ? "Today" : age < 7 ? "This week" : age < 14 ? "Last week" : "Earlier";
      const group = groups.find(item => item.label === label) ?? (groups.push({ label, items: [] }), groups[groups.length - 1]);
      group.items.push({ session, index });
    });
    return groups;
  })();
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const focusHistorySession = (id: string) => {
    setSelectedHistoryId(id);
    const position = filteredHistory.findIndex(session => session.id === id);
    if (position < 0) { setHistorySearch(""); setHistoryFilter("all"); return; }
    setHistoryPage(Math.floor(position / historyPerPage));
    window.setTimeout(() => {
      const card = document.getElementById(`hx-session-${id}`);
      if (!card) return;
      const barHeight = document.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 87;
      smoothScrollTo(Math.max(0, card.getBoundingClientRect().top + window.scrollY - barHeight - 80), () => { card.classList.remove("arrive"); void card.offsetWidth; card.classList.add("arrive"); });
    }, 80);
  };
  const activeAfkRequests = afkRequests.filter(notice => notice.status !== "returned" || (timestampMillis(notice.returnedAt) > 0 && now - timestampMillis(notice.returnedAt) < returnedNoticeLifetimeMs));
  const pendingAfkRequests = activeAfkRequests.filter(notice => notice.status === "pending");
  const acknowledgedAfkRequests = activeAfkRequests.filter(notice => notice.status === "acknowledged");
  const returnedAfkRequests = activeAfkRequests.filter(notice => notice.status === "returned");
  const afkNoticeTabCounts = { away: awayStudents.length, pending: pendingAfkRequests.length, acknowledged: acknowledgedAfkRequests.length, returned: returnedAfkRequests.length };
  const afkNoticeTabOrder = ["pending", "acknowledged", "away", "returned"] as const;
  const activeAfkNoticeTab = afkNoticeTabCounts[afkNoticeTab] > 0 ? afkNoticeTab : afkNoticeTabOrder.find(tab => afkNoticeTabCounts[tab] > 0) ?? "away";
  const visibleAfkRequests = activeAfkNoticeTab === "pending" ? pendingAfkRequests : activeAfkNoticeTab === "acknowledged" ? acknowledgedAfkRequests : activeAfkNoticeTab === "returned" ? returnedAfkRequests : [];
  const hasAwayNoticeActivity = Boolean(activeSession) && (awayStudents.length > 0 || activeAfkRequests.length > 0);
  const pendingAfkCount = pendingAfkRequests.length;
  const present = students.filter(s => s.status !== "Left").length;
  const focusedNow = students.filter(student => student.status === "Active").length;
  const totalOpenTabs = students.reduce((total, student) => total + (student.tabCount ?? 0), 0);
  const studentsWithTabCounts = students.filter(student => student.tabCount !== null).length;
  const attention = students.filter(s => s.status === "Away" || s.status === "Idle" || s.status === "Not detected").length;
  const presentCount = useCountUp(present, 500);
  const focusedCount = useCountUp(focusedNow, 500);
  const attentionCount = useCountUp(attention, 500);
  const selectedStudent = students.find(student => student.email === selectedStudentEmail) ?? null;
  const selectedEvents = selectedStudent ? events.filter(event => event.email === selectedStudent.email).sort((a, b) => b.time - a.time || b.id.localeCompare(a.id)) : [];
  const recentEvents = selectedEvents.slice(0, recentEventsLimit);
  const detailAsOf = activeSession?.status === "paused" ? (activeSession.pausedAtMs || now) : now;
  const activityStats = selectedStudent ? summarizeStudentActivity(selectedEvents, detailAsOf) : null;
  const ownsActiveSession = !activeSession || activeSession.teacherUid === user?.uid;
  const shownPanel = openPanel ?? lastPanel;
  useEffect(() => { if (openPanel) setLastPanel(openPanel); }, [openPanel]);
  useEffect(() => {
    if (!openPanel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenPanel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPanel]);
  useEffect(() => {
    const id = openClassActivity?.id ?? null;
    if (prevOpenActivityRef.current && !id && classActivities.some(activity => activity.id === prevOpenActivityRef.current)) playSound("notify");
    prevOpenActivityRef.current = id;
  }, [openClassActivity?.id]);
  const activityFormDisabled = Boolean(mockStudentCount) || !user || !activeSession || activeSession.status !== "active" || !ownsActiveSession || Boolean(openClassActivity) || creatingActivity;
  const signIn = async () => {
    setAuthError("");
    const extensionRuntime = (globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string; sendMessage?: (message: unknown) => Promise<{ ok?: boolean; error?: string }> } } }).chrome?.runtime;
    if (extensionRuntime?.id) {
      try {
        const result = await extensionRuntime.sendMessage?.({ cmd: "signIn", role: "professor" });
        if (!result?.ok) setAuthError(result?.error || "Google sign-in failed. Try again.");
        else {
          // The service worker signs into the same extension Firebase app.
          // Let Firebase finish restoring that shared session before updating UI.
          await auth.authStateReady();
          if (auth.currentUser && isProfessorEmail(auth.currentUser.email)) setUser(auth.currentUser);
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : "Could not start Google sign-in.");
      }
      return;
    }
    try {
      const credential = await webSignInWithPopup(auth, googleProvider);
      if (!isProfessorEmail(credential.user.email)) {
        await signOut(auth);
        setAuthError("This Google account is not authorized to view the professor dashboard.");
        return;
      }
      setUser(credential.user);
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Google sign-in failed."); }
  };
  const signOutDashboard = async () => {
    const extensionRuntime = (globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string; sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome?.runtime;
    try {
      if (extensionRuntime?.id) await extensionRuntime.sendMessage?.({ cmd: "signOut" });
      await signOut(auth);
      setUser(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Could not sign out.");
    }
  };
  const saveMeetingLink = () => {
    const code = parseMeetingCode(meetingLinkDraft);
    if (!code) { setMeetingLinkError("Paste a valid Google Meet link or code, such as meet.google.com/abc-defg-hij."); return; }
    setSessionRecap(null);
    setMeetingCode(code);
    setMeetingLinkDraft(`https://meet.google.com/${code}`);
    localStorage.setItem("kinetic-test-meeting-code", code);
    setMeetingLinkError("");
    setEditingLink(false);
  };
  const toggleTimer = async () => {
    if (!user) { setAuthError("Sign in with the teacher account to start a class session."); return; }
    if (!meetingCode) { setMeetingLinkError("Set your separate test Google Meet link before starting a session."); return; }
    setSessionBusy(true);
    try {
      const timestamp = Date.now();
      if (activeSession?.status === "active") {
        await updateDoc(doc(db, "sessions", activeSession.id), { status: "paused", elapsedMs, pausedAtMs: timestamp, updatedAt: serverTimestamp() });
      } else if (activeSession?.status === "paused") {
        await updateDoc(doc(db, "sessions", activeSession.id), { status: "active", startedAtMs: timestamp, pausedAtMs: null, updatedAt: serverTimestamp() });
      } else {
        setSessionRecap(null);
        await addDoc(collection(db, "sessions"), { status: "active", meetingCode, course: "INTE 301: Systems Integration and Application", classLabel: "BSIT 3-5", startedAtMs: timestamp, elapsedMs: 0, startedAt: serverTimestamp(), teacherUid: user.uid });
      }
    } catch (error) { console.error("Could not update class session", error); setLoadError("Could not update the class session. Firestore rules may need team approval."); }
    finally { setSessionBusy(false); }
  };
  const stopTimer = async () => {
    if (!activeSession) return;
    setSessionBusy(true);
    try {
      const endedAtMs = Date.now();
      await updateDoc(doc(db, "sessions", activeSession.id), { status: "ended", elapsedMs, endedAt: serverTimestamp(), updatedAt: serverTimestamp() });
      setSessionRecap({ session: { ...activeSession, status: "ended", elapsedMs }, students: [...students], events: [...events], elapsedMs, endedAtMs });
      setActiveSession(null);
    }
    catch (error) { console.error("Could not stop class session", error); setLoadError("Could not stop the session. Check Firestore rules."); }
    finally { setSessionBusy(false); }
  };
  const refreshStudentActivity = async () => {
    if (!user || !meetingCode || mockStudentCount || refreshingActivity) return;
    setRefreshingActivity(true);
    setLoadError("");
    try {
      const sessions = await getDocs(query(collection(db, "sessions"), where("meetingCode", "==", meetingCode)));
      const match = sessions.docs
        .map(item => ({ id: item.id, ...(item.data() as SessionDocument) }))
        .filter(item => item.status === "active" || item.status === "paused")
        .sort((a, b) => Number(b.startedAtMs ?? 0) - Number(a.startedAtMs ?? 0))[0];
      if (!match) {
        setActiveSession(null);
        setEvents([]);
        return;
      }
      const refreshedSession: ClassSession = {
        id: match.id,
        meetingCode,
        status: match.status === "active" ? "active" : "paused",
        startedAtMs: Number(match.startedAtMs ?? Date.now()),
        elapsedMs: Number(match.elapsedMs ?? 0),
        pausedAtMs: Number(match.pausedAtMs ?? 0),
        teacherUid: match.teacherUid
      };
      setActiveSession(refreshedSession);
      const snapshot = await getDocs(query(collection(db, "events"), where("sessionId", "==", refreshedSession.id)));
      setEvents(snapshot.docs.map(item => ({ ...item.data(), id: item.id, time: Number(item.data().time) } as TrackerEvent)));
    } catch (error) {
      console.error("Could not refresh session activity", error);
      setLoadError(error instanceof Error ? `Could not refresh student activity: ${error.message}` : "Could not refresh student activity. Check your connection and Firestore access.");
    } finally {
      setRefreshingActivity(false);
    }
  };
  const exportSessionRecap = async () => {
    if (sessionRecap?.session.status !== "ended") return;
    try {
      await downloadSessionWorkbook(sessionRecap, classActivities, activityResponses);
    } catch (error) {
      console.error("Could not download session recap", error);
      setLoadError("Could not download the Excel recap. Please try again.");
      return;
    }
    setDownloadedRecaps(current => {
      if (current.includes(sessionRecap.session.id)) return current;
      const next = [...current, sessionRecap.session.id].slice(-50);
      try { localStorage.setItem("iseenta-downloaded-recaps", JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  };
  const loadRetainedSessions = async () => {
    if (!user || mockStudentCount || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const snapshot = await getDocs(query(collection(db, "sessions"), where("teacherUid", "==", user.uid)));
      const cutoff = Date.now() - historyLookbackMs;
      const sessions = snapshot.docs.flatMap(item => {
        const data = item.data();
        const endedAtMs = timestampMillis(data.endedAt);
        if (data.status !== "ended" || !endedAtMs || endedAtMs < cutoff) return [];
        return [{ id: item.id, meetingCode: String(data.meetingCode ?? "Unknown Meet"), status: "ended" as const, startedAtMs: Number(data.startedAtMs ?? 0), elapsedMs: Number(data.elapsedMs ?? 0), teacherUid: String(data.teacherUid ?? ""), endedAt: data.endedAt, endedAtMs }];
      }).sort((a, b) => b.endedAtMs - a.endedAtMs);
      setRetainedSessions(sessions);
      setHistoryPage(0);
      setHistoryLoaded(true);
    } catch (error) {
      console.error("Could not load retained sessions", error);
      setHistoryError("Could not load saved sessions. Check your connection and Firestore access, then try again.");
    } finally { setHistoryLoading(false); }
  };
  const openHistoryPage = () => {
    setShowHistoryPage(true);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#history`);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const returnToDashboard = () => {
    setShowHistoryPage(false);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const goToAvailableRecaps = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const recapPanel = document.getElementById("available-session-recaps");
    recapPanel?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start"
    });
    if (recapPanel) {
      recapPanel.classList.remove("recap-highlight");
      void recapPanel.offsetWidth;
      recapPanel.classList.add("recap-highlight");
      window.setTimeout(() => recapPanel.classList.remove("recap-highlight"), 1800);
    }
  };
  const exportRetainedSession = async (session: ClassSession & { endedAtMs: number }) => {
    setExportingSessionId(session.id);
    setHistoryError("");
    try {
      const snapshot = await getDocs(query(collection(db, "events"), where("sessionId", "==", session.id)));
      const sessionEvents = snapshot.docs.map(item => ({ ...item.data(), id: item.id, time: Number(item.data().time) } as TrackerEvent));
      const recap: SessionRecap = { session, students: toStudents(sessionEvents, session.endedAtMs), events: sessionEvents, elapsedMs: session.elapsedMs, endedAtMs: session.endedAtMs };
      let rounds: ClassActivity[] = [];
      const answers: Record<string, ActivityResponse[]> = {};
      let note = "";
      try {
        const roundSnapshot = await getDocs(query(collection(db, "classActivities"), where("sessionId", "==", session.id), where("teacherUid", "==", user?.uid ?? "")));
        rounds = roundSnapshot.docs.map(item => ({ ...item.data(), id: item.id } as ClassActivity));
        await Promise.all(rounds.map(async round => {
          const responseSnapshot = await getDocs(collection(db, "classActivities", round.id, "responses"));
          answers[round.id] = responseSnapshot.docs.map(item => item.data() as ActivityResponse);
        }));
      } catch (error) {
        console.warn("Could not load question results for this recap", error);
        rounds = [];
        note = "Question results could not be loaded for this recap.";
      }
      await downloadSessionWorkbook(recap, rounds, answers, note);
    } catch (error) {
      console.error("Could not export retained session", error);
      const detail = error instanceof Error ? error.message : String(error);
      setHistoryError(`Could not export this recap: ${detail || "activity may have expired or access may be temporarily unavailable."}`);
    } finally { setExportingSessionId(null); }
  };
  const acknowledgeAfkRequest = async (notice: AfkNotice) => {
    setAcknowledgingRequestId(notice.id);
    try {
      await updateDoc(doc(db, "afkRequests", notice.id), { status: "acknowledged", acknowledgedAt: serverTimestamp() });
    } catch (error) {
      console.error("Could not acknowledge student notice", error);
      setLoadError("Could not acknowledge the notice. Check your connection and try again.");
    } finally { setAcknowledgingRequestId(null); }
  };
  const notifyAwayStudents = async () => {
    if (!user || !activeSession || activeSession.status !== "active" || !awayStudents.length || mockStudentCount) return;
    setShowAfkNotices(true);
    setAfkNoticeTab("away");
    setSendingProfessorAlert(true);
    setProfessorAlertFeedback("");
    try {
      const targetUids = [...new Set(awayStudents.map(student => student.uid).filter(Boolean))];
      if (!targetUids.length) throw new Error("No away students can be notified yet. Wait for their next presence update.");
      // Firestore rules cap each target list at 100 students. Split larger
      // classes into separate alert docs while keeping the copy identical.
      const groups: string[][] = [];
      for (let index = 0; index < targetUids.length; index += 100) {
        groups.push(targetUids.slice(index, index + 100));
      }
      await Promise.all(groups.map(group => addDoc(collection(db, "professorAlerts"), {
        sessionId: activeSession.id,
        teacherUid: user.uid,
        targetUids: group,
        message: "Your professor noticed your Meet tab is hidden. Please return to the class when you are ready.",
        createdAt: serverTimestamp()
      })));
      addDashboardNotification({ id: `reminder-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: "reminder", message: `Reminder sent to ${targetUids.length} away ${targetUids.length === 1 ? "student" : "students"}.`, time: Date.now() });
    } catch (error) {
      console.error("Could not notify away students", error);
      setProfessorAlertFeedback(error instanceof Error ? error.message : "Could not send the reminder. Check your connection and try again.");
    } finally { setSendingProfessorAlert(false); }
  };
  const copyMeetingCode = async () => {
    try {
      await navigator.clipboard.writeText(meetingCode);
      setMeetingCodeCopied(true);
      window.setTimeout(() => setMeetingCodeCopied(false), 1800);
    } catch (error) {
      console.error("Could not copy meeting code", error);
    }
  };


  const statusCounts = statusOrder.map(status => ({ status, count: students.filter(s => s.status === status).length }));
  const breakdownShare = (ms: number) => activityStats && activityStats.meetingMs ? (ms / activityStats.meetingMs) * 100 : 0;
  const sessionStateLabel = activeSession ? (timerRunning ? "Live" : "Paused") : "Ready";

  const recapDownloaded = Boolean(sessionRecap && downloadedRecaps.includes(sessionRecap.session.id));
  const recapReady = Boolean(sessionRecap?.session.status === "ended" && !activeSession && sessionRecap.session.meetingCode === meetingCode && parseMeetingCode(meetingLinkDraft) === sessionRecap.session.meetingCode);
  const sessionSignal = activeSession ? (timerRunning ? "active" : "idle") : "not-detected";
  const filtersActive = awayOnly || search.trim() !== "";
  const clearFilters = () => { setSearch(""); setAwayOnly(false); setStudentPage(0); };
  const pulseLive = activeSession ? (timerRunning ? "Updating live" : "Updates paused") : "Ready to start";
  const empty = !user
    ? { icon: LogIn, title: "Sign in to view live activity", text: "Sign in with your teacher Google account to view live activity." }
    : visible.length > 0 ? null
    : events.length > 0 ? { icon: Search, title: "No students found", text: "Try another name or turn off Show switchers." }
    : activeSession ? { icon: Users, title: "No activity yet", text: "No student activity recorded today." }
    : { icon: Users, title: "Ready for your next class", text: "Start the session when your class is ready." };
  const EmptyIcon = empty?.icon ?? Search;
  const drawerStats = activityStats ? [
    ["Tab switches", String(activityStats.switches)],
    ["Estimated focused", formatDuration(activityStats.focusedMs)],
    ["Focus share", `${activityStats.focusPercent}%`],
    ["Time in Meet", formatDuration(activityStats.meetingMs)],
    ["Away from Meet", formatDuration(activityStats.awayMs)],
    ["Idle or locked", formatDuration(activityStats.idleMs)],
  ] : [];

  return <div className="app-shell">
    <header className={`topbar ${navPinned ? "scrolled" : ""}`}>
      <div className="brand-block"><Wordmark /><span className="brand-caption">Class activity tracker</span></div>
      <nav className="topnav" aria-label="Dashboard navigation">
        <div className="nav-tabs" style={{ "--i": showHistoryPage ? 1 : 0 } as CSSProperties}>
          <span className="nav-tab-indicator" aria-hidden="true" />
          <button type="button" className="nav-tab" aria-current={!showHistoryPage ? "page" : undefined} onClick={() => showHistoryPage ? returnToDashboard() : smoothScrollTo(0)}><LayoutDashboard /><span className="nav-label">Live dashboard</span></button>
          <button type="button" className="nav-tab" aria-current={showHistoryPage ? "page" : undefined} onClick={() => showHistoryPage ? smoothScrollTo(0) : openHistoryPage()}><History /><span className="nav-label">Session history</span></button>
        </div>
        <button type="button" className="btn btn-ghost btn-icon nav-jump" onClick={showHistoryPage ? goToAvailableRecaps : goToActivity} aria-label={showHistoryPage ? "Jump to session recaps" : "Jump to student activity"} title={showHistoryPage ? "Jump to session recaps" : "Jump to student activity"}>{showHistoryPage ? <ScrollText /> : <TableProperties />}</button>
        <span className="nav-divider" />
        {mockStudentCount ? <span className="account-chip"><span className="account-avatar" aria-hidden="true">PV</span><span className="account-email nav-label">Preview mode</span></span>
          : user ? <div className="account-chip"><span className="account-avatar" aria-hidden="true">{(user.email ?? "P").slice(0, 2).toUpperCase()}</span><span className="account-email nav-label">{user.email}</span><button type="button" className="btn btn-ghost btn-icon account-out" onClick={() => void signOutDashboard()} aria-label="Sign out" title="Sign out"><LogOut /></button></div>
          : <button type="button" className="btn btn-primary btn-sm nav-signin" onClick={() => void signIn()}><LogIn /><span className="nav-label">Sign in</span></button>}
        <button type="button" className={`btn btn-ghost btn-icon theme-toggle${dark ? " is-dark" : ""}`} onClick={toggleTheme} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Switch to light theme" : "Switch to dark theme"}><span className="theme-orb" aria-hidden="true" /></button>
      </nav>
    </header>
    <main id="top" className="workspace">
      <div className="page-intro"><div><h1>{showHistoryPage ? "Every session, on record." : "Your class, at a glance."}</h1><p>{showHistoryPage ? "Recaps are kept for 30 days. Download one to keep it for good." : "A little visibility. A more connected classroom."}</p></div></div>

      {!showHistoryPage && <>
      <section className="session-panel" aria-label="Current class session">
        <div>
          <div className="course-context"><span className="course-code">INTE 301</span><BookOpen size={15} />Your current class</div>
          <h2 className="course-title">Systems Integration and Application</h2>
          <div className="course-meta"><span><Users size={15} />BSIT 3-5</span><span><CalendarDays size={14} />9:00 to 11:30 AM</span></div>
        </div>
        <div className="session-tools">
          <div className="timer-row">
            <div className="timer-block"><div className="timer-caption-row"><span className="timer-caption">{recapReady ? "Last session · recap ready" : "Session elapsed"}</span><span className={`pill status-pill signal-${sessionSignal}`}><span className="dot" />{sessionStateLabel}</span></div><div className="number timer">{formatClock(elapsedSeconds)}</div></div>
            <div className="timer-controls">
              <button type="button" className="btn btn-ghost btn-icon ctrl ctrl-solid" onClick={() => void toggleTimer()} disabled={Boolean(mockStudentCount) || sessionBusy || !ownsActiveSession} aria-label={timerRunning ? "Pause session tracking" : activeSession ? "Resume session tracking" : "Start class session"} title={timerRunning ? "Pause tracking" : activeSession ? "Resume tracking" : "Start session"}>{timerRunning ? <Pause /> : <Play />}</button>
              <button type="button" className="btn btn-ghost btn-icon ctrl ctrl-ghost" onClick={() => void stopTimer()} disabled={Boolean(mockStudentCount) || sessionBusy || !activeSession || !ownsActiveSession} aria-label="Stop class session" title="Stop session"><Square size={14} /></button>
              {recapReady && <button type="button" className="btn btn-ghost btn-icon ctrl ctrl-ghost recap-btn" onClick={exportSessionRecap} disabled={Boolean(mockStudentCount)} aria-label="Download session recap" title="Download session recap"><Download />{!recapDownloaded && <span className="recap-dot" aria-hidden="true" />}</button>}
            </div>
          </div>
          <div className="meeting-tools">
            {meetingCode && !editingLink ? <>
              <span className="meet-chip"><Video size={15} /><span className="meeting-code">{meetingCode}</span>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => void copyMeetingCode()} aria-label={meetingCodeCopied ? "Meeting code copied" : "Copy meeting code"} title={meetingCodeCopied ? "Copied" : "Copy meeting code"}>{meetingCodeCopied ? <Check /> : <Copy />}</button>
              {!activeSession && <button type="button" className="btn btn-ghost btn-icon" onClick={() => { setMeetingLinkDraft(`https://meet.google.com/${meetingCode}`); setMeetingLinkError(""); setEditingLink(true); }} aria-label="Change meeting link" title="Change meeting link"><Pencil /></button>}</span>
              <a className="btn btn-primary meet-button" href={`https://meet.google.com/${meetingCode}`} target="_blank" rel="noreferrer"><Video />Open Google Meet</a>
            </> : <span className="meet-chip editing"><Video size={15} />
              <input className="meeting-input" value={meetingLinkDraft} onChange={event => setMeetingLinkDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveMeetingLink(); if (event.key === "Escape" && meetingCode) { setEditingLink(false); setMeetingLinkError(""); } }} placeholder="Paste Meet link or code" aria-label="Google Meet link or code" disabled={Boolean(activeSession)} />
              <button type="button" className="btn btn-primary btn-sm set-link" onClick={saveMeetingLink} disabled={Boolean(activeSession)}>Set link</button>
              {meetingCode && <button type="button" className="btn btn-ghost btn-icon" onClick={() => { setEditingLink(false); setMeetingLinkError(""); }} aria-label="Cancel editing" title="Cancel editing"><X /></button>}
            </span>}
          </div>
          {meetingLinkError && <p className="small meeting-error" role="alert">{meetingLinkError}</p>}
        </div>
      </section>

      <section className="pulse-section" aria-label="Class pulse">
        <div>
          <div className="pulse-heading"><h2><Activity />Class pulse</h2><span className="pulse-live"><Clock3 size={12} />{pulseLive}</span></div>
          <div className="stacked-bar" role="img" aria-label={statusCounts.map(item => `${item.count} ${item.status}`).join(", ")}>{statusCounts.map(item => <span key={item.status} className={`signal-${statusClass[item.status]} ${item.count === 0 ? "empty" : ""}`} style={{ flexGrow: item.count }} />)}</div>
          <div className="pulse-legend">{statusCounts.map(item => <span key={item.status} className={`legend-item signal-${statusClass[item.status]}`}><span className="dot" />{item.status}<b>{item.count}</b></span>)}</div>
        </div>
        <div className="pulse-figures">
          <div><p className="pulse-figure-label">Attendance</p><div className="number pulse-number">{presentCount}<small>/{students.length}</small></div><p className="pulse-figure-note">Students in session</p></div>
          <div><p className="pulse-figure-label">Focused now</p><div className="number pulse-number">{focusedCount}</div><p className="pulse-figure-note">Active in Meet</p></div>
          <div><p className="pulse-figure-label">Needs attention</p><div className="number pulse-number">{attentionCount}</div><p className="pulse-figure-note">Idle, away or undetected</p></div>
        </div>
      </section>

      <aside id="tool-drawer" className={`tool-drawer${openPanel ? " open" : ""}`} aria-label="Class tools" inert={!openPanel}>
        <div className="tool-drawer-bar">
          <div className="tool-tabs" role="tablist" aria-label="Class tools">
            <button type="button" role="tab" aria-selected={shownPanel === "questions"} onClick={() => setOpenPanel("questions")}><MessagesSquare size={15} />Ask the class{classActivities.length > 0 && <span>{classActivities.length}</span>}</button>
            <button type="button" role="tab" aria-selected={shownPanel === "away"} onClick={() => setOpenPanel("away")}><Bell size={15} />Away notices{hasAwayNoticeActivity && <span>{activeAfkRequests.length + awayStudents.length}</span>}</button>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close panel" onClick={() => setOpenPanel(null)}><X /></button>
        </div>
        <div className="tool-drawer-body" key={shownPanel}>
          {shownPanel === "questions" ? <section id="ask-the-class" className="ask-panel" aria-label="Ask the class">
            <p className="ask-intro">Post a question or poll to everyone in the room. Answers are grouped by question, and nothing here interrupts you while students reply.</p>
            {openClassActivity ? <div className="ask-wait" role="status" aria-live="polite">
              <span className="ask-wait-ring" style={{ "--p": Math.max(0, Math.min(1, (openClassActivity.expiresAtMs - now) / (openClassActivity.durationSeconds * 1000))) } as CSSProperties}><b>{openActivitySeconds}</b><small>sec</small></span>
              <span className="ask-wait-copy"><strong>Students are answering</strong><small>The next question unlocks when this timer ends, so everyone gets a full turn.</small></span>
            </div> : <fieldset className="ask-composer" disabled={activityFormDisabled}>
              <legend className="sr-only">New question</legend>
              <div className="ask-types" role="group" aria-label="Answer format" style={{ "--tabs": 2, "--i": activityResponseType === "short-answer" ? 0 : 1 } as CSSProperties}>
                <span className="ask-types-indicator" aria-hidden="true" />
                <button type="button" aria-pressed={activityResponseType === "short-answer"} onClick={() => { setActivityResponseType("short-answer"); setActivityCorrectAnswer(""); }}>Type an answer</button>
                <button type="button" aria-pressed={activityResponseType === "multiple-choice"} onClick={() => { setActivityResponseType("multiple-choice"); setActivityCorrectAnswer(""); }}>Pick a choice</button>
              </div>
              <label className="ask-field">Question
                <textarea rows={2} value={activityQuestion} onChange={event => setActivityQuestion(event.target.value)} maxLength={240} placeholder="e.g. Which example best shows encapsulation?" />
              </label>
              {activityResponseType === "short-answer" ? <label className="ask-field">Answer key <small>Optional. Leave empty to collect open answers.</small>
                <input value={activityCorrectAnswer} onChange={event => setActivityCorrectAnswer(event.target.value)} maxLength={120} placeholder="The answer that counts as correct" />
              </label> : <div className="ask-field">
                <span>Choices <small>2 to 6</small></span>
                <div className="ask-choices">{activityOptions.map((option, index) => <label className="ask-choice" key={index}><i>{String.fromCharCode(65 + index)}</i><input value={option} onChange={event => setActivityOptions(current => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={120} aria-label={`Choice ${index + 1}`} placeholder={`Choice ${index + 1}`} />{activityOptions.length > 2 && <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove choice ${index + 1}`} onClick={() => { setActivityOptions(current => current.filter((_, itemIndex) => itemIndex !== index)); if (normalizeActivityAnswer(activityCorrectAnswer) === normalizeActivityAnswer(option)) setActivityCorrectAnswer(""); }}><X size={14} /></button>}</label>)}</div>
                {activityOptions.length < 6 && <button type="button" className="btn btn-ghost btn-sm ask-add" onClick={() => setActivityOptions(current => [...current, ""])}>+ Add choice</button>}
                <label className="ask-field">Correct choice <small>Leave on "No correct answer" to run a poll.</small>
                  <select value={activityCorrectAnswer} onChange={event => setActivityCorrectAnswer(event.target.value)}><option value="">No correct answer (poll)</option>{activityOptions.map((option, index) => option.trim() && <option key={index} value={option.trim()}>{String.fromCharCode(65 + index)} · {option.trim()}</option>)}</select>
                </label>
              </div>}
              <div className="ask-send">
                <label className="ask-field">Time to answer
                  <select value={activityDurationSeconds} onChange={event => setActivityDurationSeconds(Number(event.target.value))}>
                    <option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={120}>2 minutes</option><option value={300}>5 minutes</option>
                  </select>
                </label>
                <button type="button" className="btn btn-primary" onClick={() => void startClassActivity()}>{creatingActivity ? "Posting…" : "Post to class"}</button>
              </div>
            </fieldset>}
            {(activityError || activityResponseError) && <p className="ask-error" role="alert">{activityError || activityResponseError}</p>}
            <div className="ask-rounds-head"><h3>Questions<span>{classActivities.length}</span></h3><div className="ask-filter" role="group" aria-label="Filter questions">
              <button type="button" aria-pressed={activityResultFilter === "all"} onClick={() => setActivityResultFilter("all")}>All</button>
              <button type="button" aria-pressed={activityResultFilter === "live"} onClick={() => setActivityResultFilter("live")}>Live now<span>{activityOpenCount}</span></button>
              <button type="button" aria-pressed={activityResultFilter === "ended"} onClick={() => setActivityResultFilter("ended")}>Finished<span>{activityClosedCount}</span></button>
            </div></div>
            {visibleClassActivities.length ? <div className="ask-rounds">{visibleClassActivities.map((activity, roundIndex) => {
              const responses = activityResponses[activity.id] ?? [];
              const responseByUid = new Map(responses.map(response => [response.uid, response]));
              const studentByUid = new Map((activity.targetStudents ?? []).map(student => [student.uid, student] as const));
              const targetUids = activity.targetUids ?? [];
              const expectedAnswer = activity.correctAnswer?.trim() || (!activity.question ? activity.word?.trim() || "" : "");
              const hasAnswerKey = Boolean(expectedAnswer);
              const corrections = hasAnswerKey && !hideCorrections[activity.id];
              const remainingSeconds = Math.max(0, Math.ceil((activity.expiresAtMs - now) / 1000));
              const isOpen = activity.status === "active" && remainingSeconds > 0;
              const expanded = expandedRounds[activity.id] ?? (isOpen || roundIndex === 0);
              const question = activity.question || activity.word || "Class question";
              const isChoice = (activity.responseType || "short-answer") === "multiple-choice";
              const kindLabel = isChoice ? (hasAnswerKey ? "Multiple choice" : "Poll") : hasAnswerKey ? "Short answer" : "Open question";
              const rows = targetUids.map(uid => {
                const response = responseByUid.get(uid);
                const isCorrect = Boolean(response) && hasAnswerKey && normalizeActivityAnswer(response!.answer) === normalizeActivityAnswer(expectedAnswer);
                const state = !response ? "none" : !corrections ? "answered" : isCorrect ? "correct" : "incorrect";
                return { uid, response, student: studentByUid.get(uid), state };
              });
              const count = (state: string) => rows.filter(row => row.state === state).length;
              const answeredCount = rows.length - count("none");
              const filter = roundFilters[activity.id] ?? "all";
              const shown = rows.filter(row => filter === "all" || (filter === "none" ? row.state === "none" : filter === row.state));
              const tally = isChoice ? (activity.options ?? []).map((option, index) => ({ option, index, votes: responses.filter(response => normalizeActivityAnswer(response.answer) === normalizeActivityAnswer(option)).length })) : [];
              const chips: Array<["all" | "correct" | "incorrect" | "none", string, number]> = corrections
                ? [["all", "Everyone", rows.length], ["correct", "Correct", count("correct")], ["incorrect", "Incorrect", count("incorrect")], ["none", "No answer", count("none")]]
                : [["all", "Everyone", rows.length], ["none", "No answer", count("none")]];
              return <article className={`ask-round${isOpen ? " is-live" : ""}${expanded ? " expanded" : ""}`} key={activity.id}>
                <button type="button" className="ask-round-head" aria-expanded={expanded} onClick={() => setExpandedRounds(current => ({ ...current, [activity.id]: !expanded }))}>
                  <span className="ask-round-top"><span className="ask-kind">{kindLabel}</span><span className={`ask-status ${isOpen ? "live" : "done"}`}>{isOpen ? `Taking answers · ${remainingSeconds}s` : "Finished"}</span></span>
                  <strong>{question}</strong>
                  <span className="ask-round-sub"><span>{answeredCount} of {targetUids.length} answered</span>{corrections && <span className="ask-round-score"><Check size={12} />{count("correct")} correct</span>}</span>
                  <span className="ask-bar" aria-hidden="true"><i style={{ width: `${targetUids.length ? answeredCount / targetUids.length * 100 : 0}%` }} /></span>
                  <ChevronDown className="ask-chevron" size={16} aria-hidden="true" />
                </button>
                <div className="ask-round-body"><div className="ask-round-inner">
                  {isChoice && <ul className="ask-tally" aria-label="Votes per choice">{tally.map(item => <li key={item.index} className={corrections && normalizeActivityAnswer(item.option) === normalizeActivityAnswer(expectedAnswer) ? "is-key" : ""}><span className="ask-tally-label"><i>{String.fromCharCode(65 + item.index)}</i>{item.option}{corrections && normalizeActivityAnswer(item.option) === normalizeActivityAnswer(expectedAnswer) && <Check size={13} aria-label="Correct choice" />}</span><span className="ask-tally-track"><b style={{ width: `${answeredCount ? item.votes / answeredCount * 100 : 0}%` }} /></span><span className="ask-tally-n">{item.votes}</span></li>)}</ul>}
                  <div className="ask-tools">
                    <div className="ask-chips" role="group" aria-label="Filter answers">{chips.map(([value, label, n]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setRoundFilters(current => ({ ...current, [activity.id]: value }))}>{label}<span>{n}</span></button>)}</div>
                    {hasAnswerKey && <button type="button" className="btn btn-ghost switch-control ask-switch" aria-pressed={corrections} onClick={() => { setHideCorrections(current => ({ ...current, [activity.id]: corrections })); setRoundFilters(current => ({ ...current, [activity.id]: "all" })); }}><span className="switch-track"><span className="switch-thumb" /></span>Show corrections</button>}
                  </div>
                  <ul className="ask-answers">{shown.length ? shown.map(row => <li className={`ask-answer ${row.state}`} key={row.uid}>
                    <span className="ask-who"><strong>{row.response?.name || row.student?.name || row.response?.email || row.student?.email || row.uid}</strong><small>{row.response?.email || row.student?.email || row.uid}</small></span>
                    <span className="ask-said">{row.response ? row.response.answer : isOpen ? "Waiting…" : "No answer"}</span>
                    <span className="ask-state">{row.state === "correct" ? <><Check size={12} />Correct</> : row.state === "incorrect" ? <><X size={12} />Incorrect</> : row.state === "answered" ? "Answered" : isOpen ? "Pending" : "No answer"}</span>
                  </li>) : <li className="ask-none">No students in this view.</li>}</ul>
                </div></div>
              </article>;
            })}</div> : <div className="ask-empty"><MessagesSquare size={20} /><p>{classActivities.length ? "No questions in this view." : "No questions yet. Post one above and the answers will be grouped here."}</p></div>}
          </section> : activeSession ? (<section id="student-away-notices" className="afk-inbox" aria-labelledby="afk-inbox-title" aria-live="polite">
          <div className="afk-inbox-heading"><div><h3 id="afk-inbox-title">Student away notices</h3><p>{pendingAfkCount ? `${pendingAfkCount} need acknowledgment` : acknowledgedAfkRequests.length ? `${acknowledgedAfkRequests.length} acknowledged · waiting for students to return` : awayStudents.length ? `${awayStudents.length} students currently marked away` : "Students have checked back in"}</p></div><span className="afk-inbox-count">{activeAfkRequests.length + awayStudents.length}</span></div>
          {hasAwayNoticeActivity ? <><div className="afk-notice-tabs" role="group" aria-label="Filter away notices by status" style={{ "--tabs": 4, "--i": ["away", "pending", "acknowledged", "returned"].indexOf(activeAfkNoticeTab) } as CSSProperties}>
            <span className="afk-tab-indicator" aria-hidden="true" />
            <button type="button" className="btn btn-ghost" aria-pressed={activeAfkNoticeTab === "away"} disabled={!awayStudents.length} onClick={() => setAfkNoticeTab("away")}>Currently away <span>{awayStudents.length}</span></button>
            <button type="button" className="btn btn-ghost" aria-pressed={activeAfkNoticeTab === "pending"} disabled={!pendingAfkRequests.length} onClick={() => setAfkNoticeTab("pending")}>Needs acknowledgment <span>{pendingAfkRequests.length}</span></button>
            <button type="button" className="btn btn-ghost" aria-pressed={activeAfkNoticeTab === "acknowledged"} disabled={!acknowledgedAfkRequests.length} onClick={() => setAfkNoticeTab("acknowledged")}>Acknowledged · still away <span>{acknowledgedAfkRequests.length}</span></button>
            <button type="button" className="btn btn-ghost" aria-pressed={activeAfkNoticeTab === "returned"} disabled={!returnedAfkRequests.length} onClick={() => setAfkNoticeTab("returned")}>Recently returned <span>{returnedAfkRequests.length}</span></button>
          </div>
          {activeAfkNoticeTab === "away" ? <ul className="afk-notice-list">{awayStudents.map(student => <li className="afk-notice-row" key={student.email}>
            <div className="afk-student-avatar" aria-hidden="true">{initials(student.name || student.email)}</div>
            <div className="afk-notice-student"><strong>{student.name}</strong><span>{student.email} · {student.lastTime}</span></div>
            <span className="afk-state pending">Meet tab hidden</span>
          </li>)}</ul> : <ul className="afk-notice-list">{visibleAfkRequests.map(notice => <li className="afk-notice-row" key={notice.id}>
            <div className="afk-student-avatar" aria-hidden="true">{initials(notice.studentName || notice.studentEmail)}</div>
            <div className="afk-notice-student"><strong>{notice.studentName || notice.studentEmail}</strong><span>{notice.reason} · {notice.createdAt ? formatEventTime(timestampMillis(notice.createdAt)) : "Just now"}</span>{notice.status !== "returned" && <span className="afk-duration">Away for {formatDuration(Math.max(0, now - timestampMillis(notice.createdAt)))}</span>}</div>
            {notice.status === "pending" ? <><span className="afk-state pending">Needs acknowledgment</span><button type="button" className="btn btn-outline afk-acknowledge" onClick={() => void acknowledgeAfkRequest(notice)} disabled={acknowledgingRequestId === notice.id}>{acknowledgingRequestId === notice.id ? "Saving…" : "Acknowledge"}</button></> : <span className={`afk-state ${notice.status === "returned" ? "returned" : "acknowledged"}`}>{notice.status === "returned" ? <><Check />Student is back</> : <><Check />Acknowledged</>}</span>}
          </li>)}</ul>}</> : <div className="afk-notice-empty"><Users size={18} /><p>No students are away and no AFK notices have been sent.</p></div>}
        </section>) : <div className="ask-empty"><Bell size={20} /><p>Away notices appear while a class session is running.</p></div>}
        </div>
      </aside>

      <section id="activity" className="panel roster-panel" aria-label="Student activity">
        <div className="roster-header">
          <div><h2>Student activity</h2><p>{activeSession ? "Live focus signals for this class session" : "Start the class session to begin tracking Meet focus."}</p>{mockStudentCount > 0 && <span className="mock-preview-badge">40 synthetic students · local preview only</span>}</div>
          <div className="roster-tools">
            {!mockStudentCount && <button type="button" className="btn btn-outline notify-away-button" onClick={() => void notifyAwayStudents()} disabled={!user || !activeSession || activeSession.status !== "active" || awayStudents.length === 0 || sendingProfessorAlert} title={awayStudents.length ? `Send a reminder to ${awayStudents.length} students marked Away` : "No students are currently marked Away"}>{sendingProfessorAlert ? <><span className="loading-dot" aria-hidden="true" />Sending</> : <><Bell />Notify away <span className="notify-count">{awayStudents.length}</span></>}</button>}
            {(activeSession || sessionRecap) && <button type="button" className={`btn btn-outline tool-toggle${openClassActivity ? " live" : ""}`} aria-expanded={showClassActivities} aria-controls="tool-drawer" onClick={() => togglePanel("questions")}><MessagesSquare size={15} />Ask the class{openClassActivity && <span className="tool-live" aria-label="A question is live" />}{classActivities.length > 0 && <span className="tool-count">{classActivities.length}</span>}</button>}
            {activeSession && <button type="button" className="btn btn-outline away-notices-toggle" aria-expanded={showAfkNotices} aria-controls="tool-drawer" onClick={() => setShowAfkNotices(value => !value)}><Bell size={15} />Away notices{hasAwayNoticeActivity && <span className="notify-count">{activeAfkRequests.length + awayStudents.length}</span>}</button>}
            <button type="button" className="btn btn-ghost btn-icon sound-toggle" aria-pressed={soundsOn} aria-label={soundsOn ? "Turn alert sounds off" : "Turn alert sounds on"} title={soundsOn ? "Alert sounds on" : "Alert sounds off"} onClick={() => { const next = !soundsOn; setSoundsOn(next); setSoundsEnabled(next); if (next) playSound("notify"); }}>{soundsOn ? <Volume2 size={16} /> : <VolumeX size={16} />}<span className="sound-label">{soundsOn ? "Sounds on" : "Sounds off"}</span></button>
            {!mockStudentCount && <button type="button" className="btn btn-outline activity-refresh-button" onClick={() => void refreshStudentActivity()} disabled={!user || !meetingCode || refreshingActivity} title="Refresh student activity and reconnect to the active session">{refreshingActivity ? <><span className="loading-dot" aria-hidden="true" />Refreshing</> : <><RefreshCw />Refresh</>}</button>}
            <label className="search-box"><Search size={16} /><input aria-label="Search students" placeholder="Search students" value={search} onChange={e => { setSearch(e.target.value); setStudentPage(0); }} />{search && <button type="button" className="btn btn-ghost btn-icon" aria-label="Clear search" onClick={() => { setSearch(""); setStudentPage(0); }}><X /></button>}</label>
            <button type="button" className="btn btn-ghost switch-control" aria-pressed={awayOnly} onClick={() => { setAwayOnly(v => !v); setStudentPage(0); }} title="Show only students whose Meet tab is hidden or in another tab"><span className="switch-track"><span className="switch-thumb" /></span>Show switchers</button>
          </div>
        </div>
        {dashboardNotifications.length > 0 && createPortal(<div className="dashboard-notification-stack" aria-label="Recent notifications">
          {dashboardNotifications.slice(0, dashboardNotificationLimit).map(notification => <div key={notification.id} className={`dashboard-notification ${notification.kind}${exitingDashboardNotifications.includes(notification.id) ? " exiting" : ""}`} role="status" aria-live="polite">
            <span className="toast-icon">{notification.kind === "returned" ? <Activity /> : <Bell />}</span>
            <div className="toast-body">
              <strong>{notification.kind === "returned" ? `${notification.name} is back` : "Away reminder"}</strong>
              <p>{notification.kind === "returned" ? `${notification.message} · ${formatEventTime(notification.time)}` : notification.message}</p>
              {notification.kind === "returned" && notification.email && <button type="button" className="toast-action" onClick={() => { setSelectedStudentEmail(notification.email!); dismissDashboardNotification(notification.id); }}>View activity<ArrowRight /></button>}
            </div>
            <button type="button" className="btn btn-ghost btn-icon toast-dismiss" aria-label={`Dismiss notification: ${notification.kind === "returned" ? `${notification.name} is back` : notification.message}`} onClick={() => dismissDashboardNotification(notification.id)}><X /></button>
            <span className="toast-countdown" style={{ animationDuration: `${dashboardNotificationLifetimeMs}ms` }} aria-hidden="true" />
          </div>)}
        </div>, document.body)}
        {professorAlertFeedback && <div className="inline-notice error" role="alert"><Bell size={15} /><span>{professorAlertFeedback}</span></div>}
        {authError && <div className="inline-notice error" role="alert"><Info size={15} /><span>{authError}</span></div>}
        {loadError && <div className="inline-notice error" role="alert"><WifiOff size={15} /><span>{loadError}</span></div>}
        {activeSession && !ownsActiveSession && <div className="inline-notice" role="status"><Info size={15} /><span>This session is controlled by a different professor.</span></div>}
        <table className="roster-table"><caption className="sr-only">Student activity signals for INTE 301, BSIT 3-5.</caption><thead><tr><th scope="col">Student</th><th scope="col">Status</th><th scope="col">Focus time</th><th scope="col">Last event</th></tr></thead><tbody>{user && visiblePage.map((student, index) => <tr key={student.email} style={{ "--i": Math.min(index, 14) } as CSSProperties} className={`signal-${statusClass[student.status]} ${attentionStatuses.has(student.status) ? "attention" : ""}`}>
          <td><div className="student-cell"><div className="avatar" aria-hidden="true">{initials(student.name)}</div><div className="student-info"><button type="button" className="btn btn-link student-name" onClick={() => setSelectedStudentEmail(student.email)} aria-label={`View activity details for ${student.name}`}>{student.name}</button><div className="student-email">{student.email}</div></div></div></td>
          <td><span className={`pill status-pill signal-${statusClass[student.status]}`}><span className="dot" />{student.status}</span></td>
          <td><div className="focus-cell"><div className="focus-details"><span>{Math.round(student.focusMs / 60000)} min</span><span className="tab-chip" aria-label={`${student.tabCount ?? "Unknown"} open browser tabs`}><PanelsTopLeft />{student.tabCount ?? "—"} {student.tabCount === 1 ? "tab" : "tabs"}</span></div><div className="focus-track" aria-hidden="true"><div className="focus-fill" style={{ width: `${Math.min(100, activeSession ? student.focusMs / Math.max(1, elapsedMs) * 100 : 0)}%` }} /></div></div></td>
          <td><div className="event-label">{student.lastEvent}</div><div className="event-time">{student.lastTime}</div></td>
        </tr>)}</tbody></table>
        {empty && <div className="empty-state"><EmptyIcon size={27} /><h3>{empty.title}</h3><p>{empty.text}</p>{!user ? <button type="button" className="btn btn-outline empty-action" onClick={() => void signIn()}>Sign in with Google</button> : filtersActive && events.length > 0 && <button type="button" className="btn btn-outline empty-action" onClick={clearFilters}>Clear filters</button>}</div>}
        {pageCount > 1 && <nav className="roster-pagination" aria-label="Student groups">{Array.from({ length: pageCount }, (_, page) => {
          const start = page * studentsPerPage + 1;
          const end = Math.min((page + 1) * studentsPerPage, visible.length);
          return <button type="button" key={page} className="btn btn-ghost roster-page-tab" aria-current={currentStudentPage === page ? "page" : undefined} aria-label={`Show students ${start} to ${end}`} onClick={() => setStudentPage(page)}>{start}–{end}</button>;
        })}</nav>}
        <div className="roster-footer"><span>{students.length ? `Showing ${visible.length ? currentStudentPage * studentsPerPage + 1 : 0}–${Math.min((currentStudentPage + 1) * studentsPerPage, visible.length)} of ${visible.length} matching · ${students.length} students` : "No active students"}{studentsWithTabCounts > 0 && ` · ${totalOpenTabs} open tab${totalOpenTabs === 1 ? "" : "s"} across ${studentsWithTabCounts} browser${studentsWithTabCounts === 1 ? "" : "s"}`}</span><span className="footer-note"><Info size={12} />Activity signals, not attention scores</span></div>
      </section>
      </>}
      {showHistoryPage && <section className="history-page" aria-labelledby="history-page-title">
        <div className="hx-banner">
          <div className="hx-banner-copy">
            <div className="course-context"><span className="course-code">INTE 301</span><BookOpen size={15} />Systems Integration and Application</div>
            <div className="hx-title-row"><h2 id="history-page-title" className="hx-title">Session history</h2></div>
            <p className="hx-desc">Browse your saved class recaps and review how each session went.</p>
          </div>
          <div className="hs-retention" aria-label="Recap retention">
            <div className="hs-retention-top">
              {historyLoaded && historyByDate.length > 0
                ? <p className="hs-expiry-head"><span>Next recap expires</span><span className="hs-expiry-date"><b className="number">{nextExpiryDays}</b> {nextExpiryDays === 1 ? "day" : "days"} · {nextExpiryDate}</span></p>
                : <p className="hs-expiry-head">{historyLoaded ? "Recaps are kept for 30 days" : "Checking recap expiry"}</p>}
              <p className="hs-retention-note">{historyLoaded && historyByDate.length ? (expiringSoonCount ? `${expiringSoonCount} expire this week` : "None expire this week") : "No saved recaps yet"}</p>
            </div>
            <div className="hs-expiry" role="img" aria-label={historyLoaded && historyByDate.length ? `Expiry dates of ${retainedSessions.length} saved recaps over the next 30 days; the next one expires in ${nextExpiryDays} days` : "No recaps saved yet"}>
              <span className="hs-expiry-zone" aria-hidden="true" />
              {expiryTicks.map(tick => <i key={tick.day} className={`${tick.day === nextExpiryDays ? "next " : ""}${tick.day <= 7 ? "soon" : ""}`} style={{ left: `${tick.day / 30 * 100}%`, height: `${8 + Math.min(3, tick.count - 1) * 3}px` }} />)}
            </div>
            <div className="hs-expiry-axis" aria-hidden="true"><span>Today</span><span>In 30 days</span></div>
            <p className="hs-retention-note">{historyLoaded && historyByDate.length ? (expiringSoonCount ? `${expiringSoonCount} of ${retainedSessions.length} recaps expire this week.` : "None expire this week.") : "Recaps appear here once a class ends."} Export an Excel workbook to keep one.</p>
          </div>
        </div>

        <section className="panel hs-stats" aria-labelledby="hs-summary-title">
          <header className="hs-summary-head">
            <div><h2 id="hs-summary-title">Class patterns</h2><p>A closer look at the sessions still in your 30-day window.</p></div>
            <span className="hs-period"><CalendarDays size={14} />Last 30 days</span>
          </header>
          <div className="hs-grid">
            <article className="hs-module">
              <header className="hs-module-head"><Video size={16} /><h3>Weekly pace</h3><span>4 weeks</span></header>
              <p className="hs-module-lead"><strong>{historyLoaded ? sessionsThisWeek : "—"}</strong><span>sessions this week</span></p>
              <div className="hs-weeks" role="img" aria-label={`Sessions per week, oldest first: ${weekBuckets.map(week => week.count).join(", ")}`}>
                {weekBuckets.map(week => <div className={`hs-week-row${week.age === 0 ? " now" : ""}`} key={week.slot}>
                  <span>{week.age === 0 ? "This wk" : `${week.age}w ago`}</span>
                  <i aria-hidden="true"><b style={{ width: `${week.count / weekBlockMax * 100}%` }} /></i>
                  <strong>{historyLoaded ? week.count : "—"}</strong>
                </div>)}
              </div>
              <p className="hs-module-foot">{!historyLoaded ? "Load recaps to calculate weekly pace." : retainedSessions.length ? `About ${sessionsPerWeek.toFixed(1)} sessions per week across this view.` : "No ended sessions in this 30-day window."}</p>
            </article>
            <article className="hs-module">
              <header className="hs-module-head"><Activity size={16} /><h3>Session length</h3><span>30-day average</span></header>
              <p className="hs-module-lead"><strong>{historyLoaded && retainedSessions.length ? formatDuration(historyAverageMs) : "—"}</strong><span>per saved class</span></p>
              <div className="hs-lengths" role="img" aria-label={recentSessions.length ? `Length of your last ${recentSessions.length} sessions compared with the ${formatDuration(historyAverageMs)} 30-day average` : "No sessions yet"}>
                {recentSessions.map((session, index) => <div className={`hs-length-row${session.elapsedMs >= historyAverageMs ? " over" : ""}`} key={session.id} style={{ "--i": index, "--avg": `${historyLongestMs ? historyAverageMs / historyLongestMs * 100 : 0}%` } as CSSProperties}>
                  <span>{new Date(session.endedAtMs).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  <i className="hs-length-track" aria-hidden="true"><b style={{ width: `${Math.max(6, session.elapsedMs / Math.max(1, historyLongestMs) * 100)}%` }} /></i>
                  <strong>{compactLength(session.elapsedMs)}</strong>
                </div>)}
                {!recentSessions.length && <p className="hs-chart-empty">{historyLoaded ? "No ended sessions in this 30-day window." : "Load recaps to compare class lengths."}</p>}
              </div>
              <p className="hs-module-foot">{historyLoaded && retainedSessions.length ? <><span className="hs-average-key" />Dashed line marks the 30-day average · latest five classes</> : historyLoaded ? "No session lengths to compare yet." : "Load recaps to compare recent class lengths."}</p>
            </article>
            <article className="hs-module">
              <header className="hs-module-head"><CalendarDays size={16} /><h3>Weekday rhythm</h3><span>By day</span></header>
              <p className="hs-module-lead"><strong>{historyLoaded && busiestWeekday ? `${busiestWeekday.long}s` : "—"}</strong><span>most common class day</span></p>
              <div className="hs-rhythm" role="img" aria-label={historyLoaded && retainedSessions.length ? `Sessions by weekday: ${weekdayStats.map(item => `${item.long} ${item.count}`).join(", ")}` : historyLoaded ? "No ended sessions in this 30-day window." : "Load recaps to see the weekday distribution."}>
                {weekdayStats.map(item => <div className={`hs-day-row${busiestWeekday && item.day === busiestWeekday.day ? " top" : ""}`} key={item.day}>
                  <span>{item.label}</span>
                  <i aria-hidden="true"><b style={{ height: `${item.count / weekdayMax * 100}%` }} /></i>
                  <strong>{historyLoaded ? item.count : "—"}</strong>
                </div>)}
              </div>
              <p className="hs-module-foot">{historyLoaded && retainedSessions.length ? <>Typical start time <strong>{usualStartLabel}</strong></> : historyLoaded ? "No class times in this 30-day window." : "Load recaps to find your usual start time."}</p>
            </article>
          </div>
        </section>

        {historyLoaded && retainedSessions.length > 0 && <section className="panel hx-timeline" aria-labelledby="hx-timeline-title">
          <div className="hx-timeline-head"><h3 id="hx-timeline-title">Last 30 days</h3><span>Marked days have a recap · select one to highlight it below</span></div>
          <div className="hx-bar" role="group" aria-label="Sessions plotted over the last 30 days">{Array.from({ length: 30 }, (_, slot) => {
            const bucket = 29 - slot;
            const daySessions = retainedSessions.filter(session => Math.min(29, Math.max(0, Math.floor((now - session.endedAtMs) / dayMs))) === bucket);
            const dayDate = new Date(now - bucket * dayMs);
            const label = dayDate.toLocaleDateString([], { month: "short", day: "numeric" });
            if (!daySessions.length) return <span key={slot} className="hx-day-cell" title={label} aria-hidden="true"><i>{dayDate.getDate()}</i></span>;
            const selectedHere = daySessions.find(session => session.id === selectedHistoryId);
            const target = selectedHere ? (daySessions[(daySessions.indexOf(selectedHere) + 1) % daySessions.length]) : daySessions[0];
            const soon = Math.ceil((daySessions[0].endedAtMs + retentionMs - now) / dayMs) <= 7;
            return <button type="button" key={slot} className={`hx-day-cell marked${soon ? " soon" : ""}${selectedHere ? " selected" : ""}`} aria-pressed={Boolean(selectedHere)} onClick={() => focusHistorySession(target.id)} aria-label={`${label}: ${daySessions.length} ${daySessions.length === 1 ? "session" : "sessions"}`}><span className="hx-day-tip">{label}<small>{daySessions.length} {daySessions.length === 1 ? "session" : "sessions"}</small></span><i aria-hidden="true">{dayDate.getDate()}</i>{daySessions.length > 1 && <b aria-hidden="true">{daySessions.length}</b>}</button>;
          })}</div>
          <div className="hx-axis" aria-hidden="true"><span>30 days ago</span><span>20</span><span>10</span><span>Today</span></div>
          <div className="hx-selected" role="status" aria-live="polite">{(() => {
            const chosen = retainedSessions.find(session => session.id === selectedHistoryId);
            if (!chosen) return <span className="hx-selected-hint"><Info size={14} />No session selected</span>;
            return <><span className="hx-selected-code"><Video size={14} />{chosen.meetingCode}</span><span>{formatEventTime(chosen.endedAtMs)}</span><span>{formatDuration(chosen.elapsedMs)}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedHistoryId(null)}><X />Clear</button></>;
          })()}</div>
        </section>}

        <section id="available-session-recaps" className="panel history-table-panel hx-panel" aria-labelledby="history-list-title">
          <div className="hx-panel-head">
            <div><h2 id="history-list-title">Available session recaps</h2><p>Download an Excel workbook to keep a recap beyond the retention window.</p></div>
            <button type="button" className="btn btn-outline history-refresh" onClick={() => { setHistoryLoaded(false); void loadRetainedSessions(); }} disabled={!user || historyLoading}><RefreshCw className={historyLoading ? "spin" : ""} />{historyLoading ? "Refreshing" : "Refresh"}</button>
          </div>
          <div className="hx-toolbar">
            <label className="search-box hx-search"><Search size={16} /><input aria-label="Search by meeting code" placeholder="Search meeting code" value={historySearch} onChange={event => { setHistorySearch(event.target.value); setHistoryPage(0); }} />{historySearch && <button type="button" className="btn btn-ghost btn-icon" aria-label="Clear search" onClick={() => setHistorySearch("")}><X /></button>}</label>
            <div className="segmented" role="group" aria-label="Filter sessions" style={{ "--tabs": 2, "--i": historyFilter === "all" ? 0 : 1 } as CSSProperties}>
              <span className="segmented-indicator" aria-hidden="true" />
              <button type="button" className="btn btn-ghost" aria-pressed={historyFilter === "all"} onClick={() => { setHistoryFilter("all"); setHistoryPage(0); }}>All</button>
              <button type="button" className="btn btn-ghost" aria-pressed={historyFilter === "soon"} onClick={() => { setHistoryFilter("soon"); setHistoryPage(0); }}>Expiring soon</button>
            </div>
            <div className="segmented" role="group" aria-label="Sort sessions" style={{ "--tabs": 2, "--i": historySort === "newest" ? 0 : 1 } as CSSProperties}>
              <span className="segmented-indicator" aria-hidden="true" />
              <button type="button" className="btn btn-ghost" aria-pressed={historySort === "newest"} onClick={() => { setHistorySort("newest"); setHistoryPage(0); }}><ArrowUpDown />Newest</button>
              <button type="button" className="btn btn-ghost" aria-pressed={historySort === "oldest"} onClick={() => { setHistorySort("oldest"); setHistoryPage(0); }}><ArrowUpDown />Oldest</button>
            </div>
            <div className="segmented view-toggle" role="group" aria-label="Layout" style={{ "--tabs": 2, "--i": historyView === "grid" ? 0 : 1 } as CSSProperties}>
              <span className="segmented-indicator" aria-hidden="true" />
              <button type="button" className="btn btn-ghost btn-icon" aria-pressed={historyView === "grid"} aria-label="Card layout" title="Card layout" onClick={() => setHistoryView("grid")}><LayoutGrid /></button>
              <button type="button" className="btn btn-ghost btn-icon" aria-pressed={historyView === "list"} aria-label="List layout" title="List layout" onClick={() => setHistoryView("list")}><Rows3 /></button>
            </div>
          </div>
          {historyError && <div className="inline-notice error" role="alert"><WifiOff size={15} /><span>{historyError}</span></div>}
          {!user ? <div className="empty-state"><LogIn size={27} /><h3>Sign in to view saved sessions</h3><p>Sign in with your professor account to view saved sessions.</p><button type="button" className="btn btn-outline empty-action" onClick={() => void signIn()}>Sign in with Google</button></div>
            : historyLoading && !historyLoaded ? <div className="hx-grid" aria-busy="true" aria-label="Loading saved sessions">{Array.from({ length: 6 }, (_, index) => <div key={index} className="hx-card hx-skeleton" style={{ "--i": index } as CSSProperties}><span className="shimmer hx-sk-date" /><div className="hx-sk-main"><span className="shimmer hx-sk-chip" /><span className="shimmer hx-sk-line" /><span className="shimmer hx-sk-line short" /></div><span className="shimmer hx-sk-button" /></div>)}</div>
            : !historyLoaded ? <div className="empty-state"><History size={27} /><h3>Load your saved sessions</h3><p>Load your saved sessions to view available recaps.</p><button type="button" className="btn btn-outline empty-action" onClick={() => void loadRetainedSessions()}>Load saved sessions</button></div>
            : retainedSessions.length === 0 ? <div className="empty-state"><CalendarDays size={27} /><h3>No recaps yet</h3><p>No ended sessions are available from the past 30 days.</p></div>
            : filteredHistory.length === 0 ? <div className="empty-state"><Search size={27} /><h3>No sessions found</h3><p>Try another meeting code or filter.</p><button type="button" className="btn btn-outline empty-action" onClick={() => { setHistorySearch(""); setHistoryFilter("all"); }}>Clear filters</button></div>
            : <div className={`hx-groups ${historyView}`} key={`${currentHistoryPage}-${historySort}-${historySearch}-${historyFilter}`}>{historyGroups.map(group => <section key={group.label} className="hx-group" aria-label={group.label}>
              <h3 className="hx-group-title">{group.label}<span>{group.items.length}</span></h3>
              <div className="hx-grid" role="list">{group.items.map(({ session, index }) => {
                const expiresAt = session.endedAtMs + retentionMs;
                const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / dayMs));
                const ended = new Date(session.endedAtMs);
                return <article key={session.id} id={`hx-session-${session.id}`} role="listitem" aria-current={selectedHistoryId === session.id ? "true" : undefined} className={`hx-card${daysLeft <= 7 ? " soon" : ""}${selectedHistoryId === session.id ? " selected" : ""}`} style={{ "--i": index } as CSSProperties}>
                  <div className="hx-date" aria-hidden="true"><span className="hx-month">{ended.toLocaleDateString([], { month: "short" })}</span><span className="hx-day number">{ended.getDate()}</span><span className="hx-weekday">{ended.toLocaleDateString([], { weekday: "short" })}</span></div>
                  <div className="hx-card-main">
                    <span className="hx-code"><Video size={14} />{session.meetingCode}</span>
                    <p className="hx-meta">{ended.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {formatDuration(session.elapsedMs)} · <span className={`hx-expiry${daysLeft <= 7 ? " soon" : ""}`} title={`Deleted on ${formatDate(expiresAt)}`}>{daysLeft === 0 ? "deleted today" : `${daysLeft}d left`}</span></p>
                  </div>
                  <button type="button" className="btn btn-outline hx-download retention-export" onClick={() => void exportRetainedSession(session)} disabled={Boolean(exportingSessionId)} aria-label={`Download Excel recap for session ${session.meetingCode}, ended ${formatDate(session.endedAtMs)}`}>{exportingSessionId === session.id ? <><span className="loading-dot" aria-hidden="true" />Preparing</> : <><Download />Excel</>}</button>
                </article>;
              })}</div>
            </section>)}</div>}
          {historyPageCount > 1 && <nav className="roster-pagination history-pagination" aria-label="Session history pages">{Array.from({ length: historyPageCount }, (_, page) => {
            const start = page * historyPerPage + 1;
            const end = Math.min((page + 1) * historyPerPage, filteredHistory.length);
            return <button type="button" key={page} className="btn btn-ghost roster-page-tab" aria-current={currentHistoryPage === page ? "page" : undefined} aria-label={`Show sessions ${start} to ${end}`} onClick={() => setHistoryPage(page)}>{start}–{end}</button>;
          })}</nav>}
          {historyLoaded && retainedSessions.length > 0 && <div className="roster-footer"><span>Showing {filteredHistory.length ? currentHistoryPage * historyPerPage + 1 : 0}–{Math.min((currentHistoryPage + 1) * historyPerPage, filteredHistory.length)} of {filteredHistory.length} {filteredHistory.length === 1 ? "session" : "sessions"}</span><span className="footer-note"><Info size={12} />Recaps expire 30 days after the session ends</span></div>}
        </section>
        <div className="hx-note"><Info /><p>Activity events expire 30 days after they are received. Events attached to active or paused sessions are kept until those sessions end. Ended session records expire 30 days after the session ends. Automatic cleanup starts after the project owner deploys the scheduled Firebase function.</p></div>
      </section>}
      <footer className="page-footer"><span className="footer-note"><LockKeyhole />Only Meet visibility, idle signals and tab counts are shared.</span><span className="footer-note retention-note"><Info />30-day retention: automatic cleanup runs daily after the Firebase function is deployed.</span><span>Seenta for Polytechnic University of the Philippines</span></footer>
    </main>

    <dialog ref={detailDialog} className="student-drawer" aria-labelledby="student-detail-title" onClose={() => setSelectedStudentEmail(null)} onClick={event => { if (event.target === event.currentTarget) detailDialog.current?.close(); }}>
      {selectedStudent && activityStats && <div className="drawer-inner">
        <button type="button" className="btn btn-ghost btn-icon drawer-close" onClick={() => detailDialog.current?.close()} aria-label="Close student details" title="Close student details"><X /></button>
        <div className="drawer-heading"><div className="avatar" aria-hidden="true">{initials(selectedStudent.name)}</div><h2 id="student-detail-title">{selectedStudent.name}</h2><p>{selectedStudent.email}</p><span className={`pill status-pill signal-${statusClass[selectedStudent.status]}`}><span className="dot" />{selectedStudent.status}</span></div>
        <section className="drawer-section"><h3>Time in this session</h3>
          <div className="stacked-bar" role="img" aria-label={`Focused ${formatDuration(activityStats.focusedMs)}, away ${formatDuration(activityStats.awayMs)}, idle ${formatDuration(activityStats.idleMs)}`}>{([["active", activityStats.focusedMs], ["away", activityStats.awayMs], ["idle", activityStats.idleMs]] as const).map(([key, ms]) => <span key={key} className={`signal-${key} ${ms <= 0 ? "empty" : ""}`} style={{ flexGrow: Math.max(breakdownShare(ms), 0) }} />)}</div>
          <div className="pulse-legend">{([["Focused", "active"], ["Away", "away"], ["Idle or locked", "idle"]] as const).map(([label, key]) => <span key={key} className={`legend-item signal-${key}`}><span className="dot" />{label}</span>)}</div>
          <div className="stat-grid">{drawerStats.map(([label, value]) => <div key={label}><div className="number">{value}</div><p>{label}</p></div>)}</div>
          <details className="estimate-explainer">
            <summary>How these estimates work</summary>
            <ul>
              <li><strong>Focused time</strong> estimates time in the Meet while the tab is visible and the device is not idle or locked.</li>
              <li><strong>Away time</strong> is based on signals that the Meet tab is hidden or another tab is active.</li>
              <li><strong>Idle or locked</strong> time uses the browser’s idle and screen-lock signals.</li>
              <li><strong>Not detected</strong> means no presence heartbeat arrived for 75 seconds. The dashboard stops adding focused time after that point.</li>
            </ul>
            <p>These are browser activity estimates for this session. They do not measure attention, and they do not include time from other sessions.</p>
          </details>
          <p className="disclaimer"><Info /><span>These are activity estimates from Meet tab visibility and device idle signals. They do not measure attention.</span></p>
        </section>
        <section className="drawer-section"><h3>Activity counts</h3>{(["JOINED", "RETURNED", "AWAY", "IDLE", "LOCKED", "ACTIVE", "LEFT", "TABS_UPDATED"] as EventType[]).map(type => <div className="count-row" key={type}><span>{labelEvent(type)}</span><strong className="number">{activityStats.counts.get(type) ?? 0}</strong></div>)}</section>
        <section className="drawer-section"><h3>Recent activity <span className="muted">({recentEvents.length}{selectedEvents.length > recentEventsLimit ? ` of ${selectedEvents.length}` : ""})</span></h3>{recentEvents.length ? <ol className="timeline">{recentEvents.map(event => <li key={event.id}><time>{formatEventTime(event.time)}</time><span>{labelEvent(event.type)}{event.type === "TABS_UPDATED" && Number.isInteger(event.tabCount) ? ` · ${event.tabCount} open tabs` : ""}</span></li>)}</ol> : <p className="muted">No activity recorded for this student.</p>}</section>
      </div>}
    </dialog>
  </div>;
}
