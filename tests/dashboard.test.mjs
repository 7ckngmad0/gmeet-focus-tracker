import fs from 'node:fs';
const src = fs.readFileSync(new URL("../dashboard/app.js", import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('function buildStudentRows'), src.indexOf('function refresh()'));
const NOW = 10 * 60000;
const build = new Function('Date', fn + '; return buildStudentRows;')(
  Object.assign(function (t) { return new globalThis.Date(t); }, { now: () => NOW }));
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
t('away counted, focus paused', [['JOINED', 0], ['AWAY', 2], ['RETURNED', 4]], { status: 'Active', focus: '8 m focus', switches: 1 });
t('idle then left then rejoin clears idle', [['JOINED', 0], ['IDLE', 1], ['LEFT', 2], ['JOINED', 5]], { status: 'Active', focus: '6 m focus', switches: 0 });
t('locked then active', [['JOINED', 0], ['LOCKED', 2], ['ACTIVE', 6]], { status: 'Active', focus: '6 m focus', switches: 0 });
t('idle-only hidden', [['IDLE', 0]], null);
process.exitCode = fail;
