import fs from 'node:fs';
const src = fs.readFileSync(new URL("../dashboard/app.js", import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('const PRESENCE_TIMEOUT_MS'), src.indexOf('function refresh()'));
const NOW = 10 * 60000;
const helpers = new Function('Date', fn + '; return { buildStudentRows, summarizeStudentActivity };')(
  Object.assign(function (t) { return new globalThis.Date(t); }, { now: () => NOW }));
const build = helpers.buildStudentRows;
const m = x => x * 60000;
let fail = 0;
const t = (label, events, exp) => {
  const [r] = build(events.map(([type, min]) => ({ type, time: m(min), email: 'a@x', student: 'A' })));
  const got = r ? { status: r.status, focus: r.focusDuration, switches: r.switches } : null;
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) fail = 1;
  console.log(ok ? 'PASS' : 'FAIL', label, ok ? '' : JSON.stringify(got));
};
t('left stops focus', [['JOINED', 0], ['LEFT', 3]], { status: 'Left', focus: '3 m focus', switches: 0 });
t('away counted, focus paused', [['JOINED', 0], ['AWAY', 2], ['RETURNED', 4], ['HEARTBEAT', 9]], { status: 'Active', focus: '8 m focus', switches: 1 });
// RETURNED doesn't clear idle on its own — only LEFT does — so this sequence isolates
// the LEFT-clears-idle change (a JOINED rejoin would clear idle either way)
t('idle then left then rejoin clears idle', [['JOINED', 0], ['IDLE', 1], ['LEFT', 2], ['RETURNED', 5], ['HEARTBEAT', 9]], { status: 'Active', focus: '6 m focus', switches: 0 });
t('locked then active', [['JOINED', 0], ['LOCKED', 2], ['ACTIVE', 6], ['HEARTBEAT', 9]], { status: 'Active', focus: '6 m focus', switches: 0 });
t('idle-only hidden', [['IDLE', 0]], null);
const paused = build([
  { type: 'JOINED', time: m(0), email: 'a@x', student: 'A' },
  { type: 'HEARTBEAT', time: m(4), email: 'a@x', student: 'A' }
], m(5))[0];
const pausedOk = paused?.focusDuration === '5 m focus';
console.log(pausedOk ? 'PASS' : 'FAIL', 'paused session freezes focus duration');
if (!pausedOk) fail = 1;
const stale = build([{ type: 'JOINED', time: m(0), email: 'a@x', student: 'A' }], m(10))[0];
const staleOk = stale?.status === 'Not detected' && stale.focusDuration === '1 m focus';
console.log(staleOk ? 'PASS' : 'FAIL', 'stale presence stops estimated focus time');
if (!staleOk) fail = 1;
const freshPresence = build([
  { type: 'JOINED', time: m(0), email: 'a@x', student: 'A' },
  { type: 'HEARTBEAT', time: m(1), email: 'a@x', student: 'A' }
], m(2))[0];
const freshOk = freshPresence?.status === 'Active' && freshPresence.focusDuration === '2 m focus';
console.log(freshOk ? 'PASS' : 'FAIL', 'fresh presence heartbeat keeps time recording');
if (!freshOk) fail = 1;
const activity = helpers.summarizeStudentActivity([
  ['JOINED', 0], ['AWAY', 2], ['RETURNED', 5],
  ['IDLE', 7], ['ACTIVE', 8], ['LEFT', 10]
].map(([type, min]) => ({ type, time: m(min) })), m(12));
const activityGot = {
  switches: activity.switches,
  meetingMs: activity.meetingMs,
  focusedMs: activity.focusedMs,
  awayMs: activity.awayMs,
  idleMs: activity.idleMs,
  focusPercent: activity.focusPercent,
  awayCount: activity.counts.get('AWAY'),
  switchTimes: activity.events.filter(evt => evt.type === 'AWAY').map(evt => evt.time)
};
const activityExpected = {
  switches: 1, meetingMs: m(10), focusedMs: m(6), awayMs: m(3),
  idleMs: m(1), focusPercent: 60, awayCount: 1, switchTimes: [m(2)]
};
const activityOk = JSON.stringify(activityGot) === JSON.stringify(activityExpected);
console.log(activityOk ? 'PASS' : 'FAIL', 'student activity durations and switch count');
if (!activityOk) fail = 1;
const staleActivity = helpers.summarizeStudentActivity([
  { type: 'JOINED', time: m(0) }
], m(10));
const staleActivityOk = staleActivity.presenceExpired
  && staleActivity.meetingMs === 75000
  && staleActivity.focusedMs === 75000;
console.log(staleActivityOk ? 'PASS' : 'FAIL', 'detail statistics cap time at last presence signal');
if (!staleActivityOk) fail = 1;
process.exitCode = fail;
