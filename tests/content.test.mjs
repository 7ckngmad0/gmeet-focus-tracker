// Simulate content.js with a fake DOM/window/chrome and fake timers
import fs from 'node:fs';
const src = fs.readFileSync(new URL("../src/content.js", import.meta.url), 'utf8')
  .replace(/import \{ MEET_CODE_RE \} from "\.\/config";/, 'const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;');
let now = 0, timers = [], tid = 0;
const setTimeout_ = (fn, ms) => { const id = ++tid; timers.push({ id, at: now + ms, fn, every: 0 }); return id; };
const setInterval_ = (fn, ms) => { const id = ++tid; timers.push({ id, at: now + ms, fn, every: ms }); return id; };
const clearTimeout_ = id => { timers = timers.filter(t => t.id !== id); };
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    now = t.at;
    if (t.every) t.at += t.every; else timers.shift();
    await t.fn();
    await new Promise(r => setImmediate(r));
  }
  now = end;
}
const listeners = {};
const on = (n, f) => (listeners[n] ||= []).push(f);
const fire = n => (listeners[n] || []).forEach(f => f());
const state = { path: '/', inCall: false, hidden: false, focus: true, popupOpen: false };
const sent = [];
const chrome = { runtime: { sendMessage: async m => {
  sent.push(m.type + (m.visible !== undefined ? `(visible=${m.visible})` : ''));
  if (m.type === 'AWAY' && m.visible && state.popupOpen) return { ignored: true };
  return {};
} } };
const document = {
  get visibilityState() { return state.hidden ? 'hidden' : 'visible'; },
  hasFocus: () => state.focus,
  querySelector: () => state.inCall ? {} : null,
  addEventListener: on
};
const window = { addEventListener: on };
const location = { get pathname() { return state.path; } };
new Function('chrome', 'document', 'window', 'location', 'setTimeout', 'setInterval', 'clearTimeout', 'Date', src)
  (chrome, document, window, location, setTimeout_, setInterval_, clearTimeout_, { now: () => now });

const check = (label, expected) => {
  const ok = JSON.stringify(sent) === JSON.stringify(expected);
  console.log(ok ? 'PASS' : 'FAIL', label, ok ? '' : `\n   got ${JSON.stringify(sent)}\n   exp ${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
  sent.length = 0;
};

await advance(3000); check('home page sends nothing', []);
state.path = '/abc-defg-hij'; await advance(3000); check('lobby (no leave button) sends nothing', []);
state.inCall = true; await advance(1100); check('in call -> JOINED', ['JOINED']);
state.focus = false; state.popupOpen = true; fire('blur'); await advance(3000);
check('popup open -> AWAY probe ignored, no RETURNED', ['AWAY(visible=true)']);
state.focus = true; state.popupOpen = false; fire('focus'); await advance(500); check('focus back after popup -> nothing', []);
state.focus = false; fire('blur'); state.focus = true; await advance(200); fire('focus'); await advance(3000);
check('short blur < debounce -> nothing', []);
state.hidden = true; state.focus = false; fire('visibilitychange'); await advance(50); check('tab hidden -> AWAY immediately', ['AWAY(visible=false)']);
state.hidden = false; state.focus = true; fire('visibilitychange'); await advance(50); check('tab back -> RETURNED', ['RETURNED']);
state.inCall = false; await advance(1100); check('hang up (leave button gone) -> LEFT', ['LEFT']);
state.inCall = true; await advance(1100); check('rejoin -> JOINED', ['JOINED']);
state.path = '/xyz-wxyz-abc'; await advance(1100); check('switch room -> LEFT + JOINED', ['LEFT', 'JOINED']);
fire('pagehide'); fire('beforeunload'); await advance(10); check('pagehide+beforeunload -> single LEFT', ['LEFT']);
