// Run background.js meeting logic with mocked chrome + firebase
import fs from 'node:fs';
let src = fs.readFileSync(new URL("../src/background.js", import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const cfg = fs.readFileSync(new URL("../src/config.js", import.meta.url), 'utf8').replace(/export /g, '');
const store = { profile: { role: 'student', uid: 'u1', email: 'a@x', name: 'A', consent: true } };
const written = [];
const L = {};
const ev = n => ({ addListener: f => (L[n] = f) });
const chrome = {
  storage: { local: {
    get: async k => Object.fromEntries([].concat(k).map(x => [x, store[x]])),
    set: async o => Object.assign(store, o),
    remove: async k => [].concat(k).forEach(x => delete store[x])
  } },
  runtime: { onMessage: ev('msg'), onConnect: ev('connect'), onStartup: ev('startup'), onInstalled: ev('installed'), getURL: p => p },
  tabs: { onRemoved: ev('removed'), onUpdated: ev('updated'), get: async () => { throw 0; }, query: async () => [], create: async () => {} },
  idle: { setDetectionInterval() {}, onStateChanged: ev('idle') }
};
const deps = {
  collection: () => 0,
  addDoc: async (_, d) => written.push(`${d.type}:${d.meetingCode}`),
  Timestamp: { fromMillis: x => x },
  auth: { authStateReady: async () => {}, currentUser: { uid: 'u1' } },
  db: 0, signInWithGoogle: async () => null, signOutGoogle: async () => {}
};
new Function('chrome', ...Object.keys(deps), cfg + src)(chrome, ...Object.values(deps));
const flush = () => new Promise(r => setTimeout(r, 20));
const msg = (type, tab, code, extra = {}) => { let resp; L.msg({ type, time: 1, meetingCode: code, ...extra }, { tab: { id: tab } }, r => (resp = r)); return resp; };
let fail = 0;
const check = (label, exp) => {
  const ok = JSON.stringify(written) === JSON.stringify(exp);
  if (!ok) fail = 1;
  console.log(ok ? 'PASS' : 'FAIL', label, ok ? '' : JSON.stringify(written));
  written.length = 0;
};
msg('JOINED', 1, 'abc-defg-hij'); await flush(); check('join', ['JOINED:abc-defg-hij']);
msg('AWAY', 2, 'abc-defg-hij'); await flush(); check('AWAY from other tab ignored', []);
L.idle('idle'); await flush(); check('idle while in meeting', ['IDLE:abc-defg-hij']);
L.updated(1, { url: 'https://meet.google.com/abc-defg-hij?authuser=0' }); await flush(); check('same-room url change keeps meeting', []);
L.updated(1, { url: 'https://meet.google.com/' }); await flush(); check('navigate to home -> LEFT', ['LEFT:abc-defg-hij']);
L.idle('active'); await flush(); check('idle event after leaving ignored', []);
msg('JOINED', 1, 'abc-defg-hij'); await flush(); written.length = 0;
L.removed(7); await flush(); check('other tab closed ignored', []);
L.removed(1); await flush(); check('meeting tab closed -> LEFT', ['LEFT:abc-defg-hij']);
msg('LEFT', 1, 'abc-defg-hij'); await flush(); check('late content LEFT after close not duplicated', []);
msg('JOINED', 1, 'abc-defg-hij'); await flush(); written.length = 0;
let port = { name: 'popup', sender: {}, onDisconnect: ev('disc') }; L.connect(port);
const r = msg('AWAY', 1, 'abc-defg-hij', { visible: true }); await flush(); check('AWAY while popup open ignored', []);
console.log(r?.ignored ? 'PASS' : 'FAIL', 'ignored reply sent'); if (!r?.ignored) fail = 1;
L.disc(); msg('AWAY', 1, 'abc-defg-hij', { visible: true }); await flush(); check('AWAY after popup closed saved', ['AWAY:abc-defg-hij']);
msg('JOINED', 3, 'xyz-wxyz-abc'); await flush(); check('join other room closes first', ['LEFT:abc-defg-hij', 'JOINED:xyz-wxyz-abc']);
deps.auth.currentUser = { uid: 'someone-else' };
msg('AWAY', 3, 'xyz-wxyz-abc'); await flush(); check('wrong account -> not written', []);
console.log(store.syncError ? 'PASS' : 'FAIL', 'syncError set:', store.syncError);
process.exitCode = fail;
