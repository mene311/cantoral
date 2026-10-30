// felucca.js — Felucca editor protocol codec (pure: no transport, no imports).
//
// The firmware side is firmware/src/editor.c. Frames:
//   F0 7D 46 4C <cmd> <args...> F7
// Every valid request gets exactly one reply with the same header and cmd.
// Invalid fixed argument lengths get no reply. Every data byte is 7 bit.
//
// Used here:
//   INFO (1)        version string, NENGINES, P_COUNT, G_COUNT, NSTEP, P_E0,
//                   NENGINES engine-name strings, NTRK, CHAIN_ROWS, tagged blocks
//   TRACK_STEP (30) track, index (get)  |  track, index + the step bytes (set)
//                   reply: track, index, n, note0..3, time, flags, vel,
//                   hit, acc, hi, chance, ratchet, nudge
//
// Step times: 0 NOTE, 1 TIE, 2 REST. Flags: 1 accent, 2 slide (bits 3-4 are
// the ratchet, set by the device's own RATCH — a write keeps them).
// A chance of 100 means "always" (the firmware stores 0 for it).
//
// Note length: there is no length field in a Felucca step. Inside a row the
// note's gate is the track's own GATE parameter (firmware seq.c:
// g = period * P_SGATE / 128 — it cannot pass the row); across rows the only
// way to hold is TIE (see holdLen / pulseSteps / tieStep below).

export const CMD = {
  INFO: 1, GET: 2, SET: 3, STEP_GET: 6, STEP_SET: 7, PROJECT: 9, TRACK: 27, TRACK_MIX: 29, TRACK_STEP: 30,
  MOTION: 64, POOL: 78, LIST: 79, PERFORM: 80,
};
// LIST (79) ops, and the value an entry holds for a REST (page: "Pool, lists, PERFORM")
export const LOP = { SET: 1, COPY: 2, PLAY: 3, CLEAR: 4, REPS: 5, SONG: 6, NEW: 7, COPY_PLUS: 8 };
export const ENTRY_REST = 65;            // SET's value for a REST; an entry's 0 is empty
export const PAT_NONE = 127;             // "on no entry's pattern", "no entry staged"
export const ST = { NOTE: 0, TIE: 1, REST: 2 };
export const SF = { ACCENT: 1, SLIDE: 2 };

const HDR = [0x7D, 0x46, 0x4C];

// F0 7D 46 4C <cmd> <args> F7
export function frame(cmd, args = []) {
  return [0xF0, ...HDR, cmd & 0x7F, ...args.map((a) => a & 0x7F), 0xF7];
}

// The args of a reply to `cmd`, or null (a push, another command, garbage).
export function reply(sx, cmd) {
  if (!sx || sx.length < 6 || sx[0] !== 0xF0 || sx[sx.length - 1] !== 0xF7) return null;
  if (sx[1] !== 0x7D || sx[2] !== 0x46 || sx[3] !== 0x4C) return null;
  if (sx[4] !== (cmd & 0x7F)) return null;
  return sx.slice(5, -1);
}

function readStr(args, at) {
  let s = "";
  while (at < args.length && args[at]) s += String.fromCharCode(args[at++]);
  return [s, at + 1];
}

// The tagged tail of INFO: tag -> payload length, in the order the firmware writes them
// (EDITOR_PROTOCOL.md, "INFO"). 0x57 and 0x58 are capability bitmaps.
export const INFO_TAGS = {
  0x55: 1,   // uiCaps
  0x4D: 2,   // 64 01
  0x42: 1,
  0x46: 2,   // nfactory nbank
  0x53: 1,
  0x50: 1,
  0x4E: 1,   // MENU settings' count
  0x52: 1,   // ratchet (1.0.5)
  0x4C: 1,   // parameter locks (1.1)
  0x54: 4,   // light tracks: tracks, e0 e1 e2
  0x43: 1,   // a step's FLAM, COND, NUDGE (W1)
  0x4B: 1,   // the DRUM-X kit (W3)
  0x57: 1,   // caps: bit0 TRANSPORT, bit1 PROJ_NAME, bit2 POOL, bit3 LIST, bit4 PERFORM, bit5 SMP_MIX, bit6 ties
  0x49: 4,   // wide ids: P_COUNT, P_E0 (7 bits each, split)
  0x58: 1,   // 2.0 caps: bit0 LIST2/NEW/COPY+/CHAIN/ONCE/EMPTY/UNUSED, bit1 entries' sounds
};

// INFO reply -> the fields this app needs, plus what the device says it can do.
export function decodeInfo(args) {
  let at = 0, version;
  [version, at] = readStr(args, at);
  const [nengines, pcount, gcount, nstep, pe0] = args.slice(at, at + 5);
  at += 5;
  const engines = [];
  for (let i = 0; i < nengines; i++) { let s; [s, at] = readStr(args, at); engines.push(s); }
  const ntrk = args[at] ?? 4;
  const chainRows = args[at + 1] ?? 16;
  at += 2;
  const tags = {};
  while (at + 1 < args.length) {                     // the tagged blocks, in the firmware's own order
    const id = args[at], sub = args[at + 1], len = INFO_TAGS[id];
    if (sub !== 0x01 || len === undefined || at + 2 + len > args.length) break;
    tags[id] = args.slice(at + 2, at + 2 + len);
    at += 2 + len;
  }
  // A tag this table does not know stops the walk, and every tag after it would be lost - including the
  // capability bits that decide whether the pool/entry path is even used. So whichever tags are missing,
  // find them by their own two bytes; a payload byte pair like "58 01" does not occur in the others.
  for (const id of Object.keys(INFO_TAGS).map(Number)) {
    if (id in tags) continue;
    const len = INFO_TAGS[id];
    for (let i = 0; i + 2 + len <= args.length; i++) {
      if (args[i] === id && args[i + 1] === 0x01) { tags[id] = args.slice(i + 2, i + 2 + len); break; }
      if (i > args.length - 3) break;
    }
  }
  const c57 = tags[0x57]?.[0] ?? 0, c58 = tags[0x58]?.[0] ?? 0;
  const caps = {
    version,
    ntrk, nstep, pcount, pe0, chainRows, engines,
    wideIds: 0x49 in tags,                          // 1.3: parameter ids past 127
    ratchet: 0x52 in tags,                          // 1.0.5: a step's ratchet byte
    locks: 0x4C in tags,                            // 1.1: motion records can be locks
    lightTracks: tags[0x54] ?? null,                // phase 6: [tracks, e0, e1, e2]
    flam: 0x43 in tags,                             // W1: FLAM, COND, NUDGE
    drumx: 0x4B in tags,                            // W3: the DRUM-X kit
    transport: !!(c57 & 1),                         // TRANSPORT
    projName: !!(c57 & 2),                          // PROJ_NAME
    pool: !!(c57 & 4),                              // POOL (78): the 64-pattern pool
    list: !!(c57 & 8),                              // LIST (79): the per-track entries
    perform: !!(c57 & 16),                          // PERFORM (80)
    smpMix: !!(c57 & 32),                           // #21: each slot sound's own mix
    ties: !!(c57 & 64),                             // 2.0: a step's per-note ties
    list2: !!(c58 & 1),                             // 2.0: LIST's NEW, COPY+, CHAIN, ONCE, EMPTY, CLEAR UNUSED
    entrySounds: !!(c58 & 2),                       // #30: SOUND on the entries
    tags,
  };
  return { version, nengines, pcount, gcount, nstep, pe0, engines, ntrk, chainRows, tags, caps };
}

// A step write's bytes. The fields go in the firmware's order and each one depends on the ones before
// it (EDITOR_PROTOCOL.md: "the chance can only follow the hits, the ratchet the chance, ... the ties
// the three"): so a write carries a PREFIX of the chain. `depth` says how far to go:
//   0 the 8 base bytes (n, notes, time, flags, vel) - the step keeps its own hits, chance, ratchet
//   1 + hits/acc/hi (v5)      2 + chance (v7)     3 + ratchet (1.0.5)
//   4 + FLAM, COND, NUDGE (W1)                    5 + ties (2.0)
// Anything we do not mean to change is read back first and written as it was.
export function stepBytes(st, depth = 0) {
  const notes = [0, 1, 2, 3].map((k) => (st.notes?.[k] ?? 0) & 0x7F);
  const b = [Math.min(4, st.n ?? (st.notes?.length ?? 0)), ...notes, st.time & 3, st.flags & 3,
    (st.vel ?? 0) & 0x7F];
  if (depth >= 1) b.push((st.hit ?? 0) & 0x7F, (st.acc ?? 0) & 0x7F, (st.hi ?? 0) & 0x7F);
  if (depth >= 2) b.push(Math.min(100, Math.max(0, st.chance ?? 100)) & 0x7F);
  if (depth >= 3) b.push(Math.min(4, Math.max(1, st.ratchet ?? 1)) & 0x7F);
  if (depth >= 4) b.push((st.flam ?? 0) & 1, (st.cond ?? 0) & 0x7F, ((st.nudge ?? 0) + 32) & 0x7F);
  if (depth >= 5) b.push((st.ties ?? 0) & 15);
  return b;
}

// The deepest field a device with these caps understands.
export function stepDepth(caps) {
  if (!caps) return 0;
  let d = 5;                                        // 2.0 ties imply everything before them
  if (!caps.ties) d = caps.flam ? 4 : caps.ratchet ? 3 : 1;
  return d;
}

// TRACK_STEP / STEP_GET reply args -> a step object (the optional tail by its length).
export function readStep(args, base = 2 /* TRACK_STEP: track, index */) {
  const a = args.slice(base);
  const st = {
    n: a[0], notes: [a[1], a[2], a[3], a[4]], time: a[5], flags: a[6] & 3, vel: a[7],
  };
  if (a.length >= 11) { st.hit = a[8]; st.acc = a[9]; st.hi = a[10]; }
  if (a.length >= 12) st.chance = a[11];
  if (a.length >= 13) st.ratchet = a[12];
  if (a.length >= 16) { st.flam = a[13]; st.cond = a[14]; st.nudge = a[15] - 32; }
  if (a.length >= 17) st.ties = a[16] & 15;
  if (base === 2) { st.track = args[0]; st.index = args[1]; }
  return st;
}

// Do the bytes we would write already equal what the device reports? (Only the fields a write sets,
// at the depth we would write them: the rest stay the device's.)
export function sameStep(want, cur, depth = 0) {
  const w = stepBytes(want, depth), c = stepBytes(cur, depth);
  return w.every((b, i) => b === c[i]);
}

function fromPulse(src, velDefault = 100) {
  const notes = (src?.notes ?? []).slice(0, 4);
  return {
    n: notes.length,
    notes: [0, 1, 2, 3].map((k) => (notes[k]?.note ?? 0) & 0x7F),
    time: notes.length ? ST.NOTE : ST.REST,
    flags: 0,
    vel: notes.length ? ((notes[0].vel ?? velDefault) & 0x7F) : 0,
    hit: 0, acc: 0, hi: 0,
    chance: 100,
  };
}

// How many rows the note at `i` covers, 1..noteLen. Felucca has no per-step length:
// a longer note is written as TIE rows (firmware seq.c: on a TIE the track does not
// retrigger, it pushes the sounding note's off forward and keeps holding while TIE
// steps chain), and the hold ends at the next NOTE row. So the span stops at the
// next row that has notes, and at the end of the pattern (rows past `length` are
// rests, which release — a hold is not carried into the next pass).
// `pattern` is the *pulses* pattern: a row with notes anywhere in it ends the hold.
export function holdLen(pattern, i, end = 64, noteLen = 1) {
  const steps = pattern?.steps ?? [];
  let len = 1;
  while (len < noteLen && i + len < end && !(steps[i + len]?.notes?.length)) len++;
  return len;
}

// A pulses pattern (64 steps, up to 9 notes each) -> `nstep` Felucca steps
// (up to 4 notes each). Steps past the pattern's length become rests.
// noteLen > 1 holds each note across the following empty rows (TIE steps) so it
// sounds until the next note on the track — the device's own length control.
export function pulseSteps(pattern, nstep = 64, velDefault = 100, noteLen = 1) {
  const len = Math.min(pattern?.length ?? nstep, nstep);
  const out = [];
  for (let i = 0; i < nstep; i++) out.push(fromPulse(i < len ? pattern?.steps?.[i] : null, velDefault));
  if (noteLen > 1)
    for (let i = 0; i < len; i++) {
      if (out[i].time !== ST.NOTE) continue;
      const span = holdLen(pattern, i, len, noteLen);
      for (let k = 1; k < span; k++) out[i + k] = tieStep();
    }
  return out;
}

// POOL (78) reply: op, rc, then for each of the 64 patterns its LEN (0: empty) and how many use it.
export function decodePool(args) {
  const rc = args[1] ?? 0, patterns = [];
  for (let i = 0; i < 64; i++) patterns.push({ len: args[2 + i * 2] ?? 0, uses: args[3 + i * 2] ?? 0 });
  return { op: args[0] ?? 0, rc, patterns, free: patterns.filter((p) => p.len === 0).length };
}

// LIST (79) reply: op, rc, SONG, then per track: the entry it is on (127 none), the entry staged
// (127 none), the pattern it is on (0..63, 127 none), then its 16 entries: value (1..64 kept,
// 65 REST, 0 empty) and REPS - 1 (0 on a CHAIN).
export const LIST_TRACK_BYTES = 3 + 16 * 2;
export function decodeList(args) {
  const op = args[0] ?? 0, rc = args[1] ?? 0, song = args[2] ?? 0, tracks = [];
  for (let at = 3; at + LIST_TRACK_BYTES <= args.length; at += LIST_TRACK_BYTES) {
    const entries = [];
    for (let e = 0; e < 16; e++)
      entries.push({ value: args[at + 3 + e * 2], reps: args[at + 4 + e * 2] + 1, chained: args[at + 4 + e * 2] === 0 && args[at + 3 + e * 2] !== 0 });
    tracks.push({ entry: args[at], staged: args[at + 1], pattern: args[at + 2], entries });
  }
  return { op, rc, song, tracks };
}

// LIST's reply codes, in words (the app shows these instead of numbers).
export const LIST_RC = {
  0: "done", 1: "empty entry or nothing to copy", 2: "done, without its automation",
  3: "the unit is playing", 4: "PATTERNS FULL", 5: "failed",
};

// A REST step (what clearing a track writes).
export function restStep() {
  return { n: 0, notes: [0, 0, 0, 0], time: ST.REST, flags: 0, vel: 0, hit: 0, acc: 0, hi: 0, chance: 100 };
}

// A TIE step: it holds what the track already plays; it never triggers by itself.
export function tieStep() {
  return { n: 0, notes: [0, 0, 0, 0], time: ST.TIE, flags: 0, vel: 0, hit: 0, acc: 0, hi: 0, chance: 100 };
}
