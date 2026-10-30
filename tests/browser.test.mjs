// tests/browser.test.mjs — drives the real page against a FAKE FM-1 that speaks
// enough of Skiff 2.0's editor protocol for the whole button path to run:
// connect → read the pool → push a phrase → push it again (reuse) → send 16 →
// a write refused because the unit "is playing".
//
//   python3 -m http.server 8099 &        # the page must be served, not file://
//   node tests/browser.test.mjs
//
// The hardware is still the only proof the FM-1 takes a write; this catches the
// wiring between the codec, the writer and the screen. Playwright + chromium
// must be installed (`npx playwright install chromium`).
import { chromium } from '/home/meneses/.npm-global/lib/node_modules/playwright/index.mjs';

const FAKE = `
(() => {
  const STOPPED = 0;
  const pool = Array.from({length: 64}, () => ({len: 0}));
  const tracks = Array.from({length: 6}, () => ({
    entry: 127, staged: 127, pattern: 127,
    entries: Array.from({length: 16}, () => ({value: 0, reps: 1})),
  }));
  const steps = new Map();
  let nextFree = 0, playing = false;

  const HDR = [0x7D, 0x46, 0x4C];
  const listBytes = (rc = 0) => {
    const a = [0x4F, rc, 0];
    for (const t of tracks) {
      a.push(t.entry, t.staged, t.pattern);
      for (const e of t.entries) a.push(e.value, e.reps - 1);
    }
    return a;
  };
  const poolBytes = (rc = 0) => {
    const a = [0x4E, rc];
    for (const p of pool) a.push(p.len, 0);
    return a;
  };
  const stepBytes = (k) => {
    const s = steps.get(k) || {n:0, notes:[0,0,0,0], time:2, flags:0, vel:0, hit:0, acc:0, hi:0, chance:100, ratchet:1, flam:0, cond:0, nudge:0, ties:0};
    return [s.n, ...s.notes, s.time, s.flags, s.vel, s.hit ?? 0, s.acc ?? 0, s.hi ?? 0,
            s.chance ?? 100, s.ratchet ?? 1, s.flam ?? 0, s.cond ?? 0, (s.nudge ?? 0) + 32, s.ties ?? 0];
  };
  function reply(cmd, args) {
    const bytes = [0xF0, ...HDR, cmd & 0x7F, ...args.map(v => v & 0x7F), 0xF7];
    setTimeout(() => {
      const input = fake.inputs.values().next().value;
      if (input?.onmidimessage) input.onmidimessage({ data: new Uint8Array(bytes) });
    }, 2);
  }
  function handle(data) {
    const d = Array.from(data);
    if (d[0] !== 0xF0 || d[1] !== 0x7D || d[2] !== 0x46 || d[3] !== 0x4C) return;
    const cmd = d[4], a = d.slice(5, -1);
    if (cmd === 1) {                                   // INFO
      const args = [];
      for (const ch of 'Skiff 2.0.1') args.push(ch.charCodeAt(0));
      args.push(0);                                    // terminator
      args.push(6, 64, 64, 64, 0);                     // engines, pcount, gcount, nstep, pe0
      for (let i = 0; i < 6; i++) for (const ch of 'FM') args.push(ch.charCodeAt(0));
      for (let i = 0; i < 6; i++) args.push(0);
      args.push(6, 16);                                // ntrk, chainRows
      args.push(0x43, 0x01, 0x01, 0x52, 0x01, 0x01, 0x57, 0x01, 0x7F, 0x58, 0x01, 0x01);
      reply(cmd, args);
      return;
    }
    if (cmd === 78) {                                  // POOL
      const op = a[0];
      if (op === 3) { for (const p of pool) if (!p.len) p.len = 0; }
      reply(cmd, poolBytes(0));
      return;
    }
    if (cmd === 79) {                                  // LIST
      const [op, tr, en, v] = a;
      if (playing && op !== 6) { reply(cmd, listBytes(3)); return; }
      const T = tracks[tr];
      if (op === 7) {                                  // NEW
        if (nextFree >= 64) { reply(cmd, listBytes(4)); return; }
        const id = nextFree++; pool[id].len = 64;
        T.entries[en].value = id + 1; T.staged = en;
        reply(cmd, listBytes(0)); return;
      }
      if (op === 3) {                                  // PLAY
        const val = T.entries[en].value;
        if (val < 1 || val > 64) { reply(cmd, listBytes(1)); return; }
        T.pattern = val - 1; T.entry = en;
        reply(cmd, listBytes(0)); return;
      }
      if (op === 1) {                                  // SET
        if (!(v >= 1 && v <= 64) || !pool[v - 1].len) { reply(cmd, listBytes(1)); return; }
        T.entries[en].value = v; reply(cmd, listBytes(0)); return;
      }
      if (op === 4) { T.entries[en] = {value: 0, reps: 1}; reply(cmd, listBytes(0)); return; }
      reply(cmd, listBytes(5)); return;
    }
    if (cmd === 30) {                                  // TRACK_STEP
      const tr = a[0], i = a[1];
      if (a.length > 2) {                              // set
        if (playing) { reply(cmd, [tr, i, ...stepBytes(tr + ":" + i)], 3); return; }
        const s = a.slice(2);
        steps.set(tr + ":" + i, {
          n: s[0], notes: s.slice(1, 5), time: s[5], flags: s[6], vel: s[7],
          hit: s[8], acc: s[9], hi: s[10], chance: s[11], ratchet: s[12],
          flam: s[13], cond: s[14], nudge: s[15] - 32, ties: s[16],
        });
      }
      reply(cmd, [tr, i, ...stepBytes(tr + ":" + i)]);
      return;
    }
    if (cmd === 2 || cmd === 3) { reply(cmd, [0, 0]); return; }
  }
  const fake = {
    inputs: new Map(), outputs: new Map(),
    written: [],                                         // for the assertion: what the page wrote
    notes: [],                                           // note ons/offs the audition sent
  };
  const out = {
    id: 'fm1-out', name: 'FM-1', manufacturer: 'Hügelton',
    send(bytes) {
      const b = Array.from(bytes);
      if (b[0] !== 0xF0) fake.notes.push({ t: performance.now(), kind: b[0] & 0xF0, note: b[1], vel: b[2] });
      fake.written.push(b); handle(bytes);
    },
  };
  const inp = { id: 'fm1-in', name: 'FM-1', manufacturer: 'Hügelton', onmidimessage: null, open() {} };
  fake.outputs.set(out.id, out); fake.inputs.set(inp.id, inp);
  navigator.requestMIDIAccess = async () => ({
    inputs: fake.inputs, outputs: fake.outputs,
    sysexEnabled: true, onstatechange: null,
  });
  // expose for the assertions
  window.__fake = { pool, tracks, steps, written: fake.written, notes: fake.notes, setPlaying: (v) => { playing = v; } };
})();
`;

const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(FAKE);
const PORT = process.env.PORT || 8099;
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// connect
await page.click('#connect');
await page.waitForTimeout(700);
const connected = await page.textContent('#status');

// pick a phrase and push it into T3 entry C
await page.selectOption('#track', '2');
await page.selectOption('#entry', '2');
await page.click('.item:nth-child(9)');
await page.waitForTimeout(300);
const picked = await page.textContent('#ptitle');
await page.click('#push');
await page.waitForTimeout(3000);
const pushStatus = await page.textContent('#status');
const afterPush = await page.evaluate(() => ({
  entryValue: window.__fake.tracks[2].entries[2].value,
  poolUsed: window.__fake.pool.filter((p) => p.len).length,
  step0: window.__fake.steps.get('2:0'),
  marks: [...window.__fake.steps.entries()].slice(0, 4).map(([k, v]) => [k, v.time, v.notes[0]]),
}));

// push the same phrase again: must reuse, not allocate
await page.click('#push');
await page.waitForTimeout(2500);
const afterSecond = await page.evaluate(() => ({
  poolUsed: window.__fake.pool.filter((p) => p.len).length,
  entryValue: window.__fake.tracks[2].entries[2].value,
}));

// sixteen phrases into T1
page.once('dialog', (d) => d.accept());
await page.selectOption('#track', '0');
await page.click('.item:nth-child(3)');
await page.click('#push16');
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  const st = await page.textContent('#status');
  if (st.includes('filled') || /refused|failed|full|error/i.test(st)) break;
  await page.waitForTimeout(500);
}
const after16 = await page.evaluate(() => ({
  entries: window.__fake.tracks[0].entries.map((e) => e.value),
  poolUsed: window.__fake.pool.filter((p) => p.len).length,
}));
const status16 = await page.textContent('#status');

// a refused write while the unit "plays"
await page.evaluate(() => window.__fake.setPlaying(true));
await page.click('#push');
await page.waitForTimeout(1200);
const refused = await page.textContent('#status');
await page.evaluate(() => window.__fake.setPlaying(false));

// ---- the audition: a short phrase must turn around at the end of its BAR ----
// "Dorian Arp" is 8 steps; a bar is 16. Looping at the last note would keep the
// playhead inside 0..7 — the bug this checks for.
await page.click('.chip[data-folder="all"]');
await page.waitForTimeout(1200);
await page.fill('#search', 'Dorian Arp');
await page.waitForTimeout(400);
await page.click('.item:nth-child(1)');
await page.fill('#bpm', '300');
await page.waitForTimeout(300);
const loopText = await page.textContent('#loopinfo');
await page.evaluate(() => { window.__fake.notes.length = 0; });
await page.click('#play');
const seen = await page.evaluate(async () => {
  const st = window.cantoral;
  const seq = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    if (seq[seq.length - 1] !== st.playStep) seq.push(st.playStep);
    await new Promise((r) => setTimeout(r, 15));
  }
  return seq;
});
await page.click('#play');                     // stop
// ties must not be cut: every note-off must belong to a note-on that is sounding
const orphans = await page.evaluate(() => {
  const held = new Set();
  let bad = 0;
  for (const n of window.__fake.notes) {
    if (n.kind === 0x90 && n.vel > 0) held.add(n.note);
    else if (n.kind === 0x80) { if (!held.has(n.note)) bad++; held.delete(n.note); }
  }
  return bad;
});
const wraps = [];
for (let i = 1; i < seen.length; i++) if (seen[i] < seen[i - 1]) wraps.push([seen[i - 1], seen[i]]);
const audition = { steps: seen, max: Math.max(...seen), wraps };
await page.screenshot({ path: '/tmp/cantoral-e2e.png' });

console.log(JSON.stringify({ connected, picked, pushStatus, afterPush, afterSecond, after16, status16, refused, loopText, audition, orphans, errs }, null, 1));
await b.close();
