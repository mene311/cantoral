// pattern.js — FM-1 sequencer pattern encoder (SysEx command 0x20).
//
// Port of fm1pat.py's encode_write, byte-verified against the Virtual-FM-1
// codec (sync/Fm1Seq.cpp). Produces the exact messages that write a pattern
// into the FM-1+VA firmware's sequencer RAM, 8 steps per message.
//
// A pattern is:
//   { length: 1..64, rate: 0..9 (1/1..1/32T), tempo: 30..300,
//     gate: 5..100, swing: 50..75,
//     steps: Array(64) of { rate, notes: [{note, vel}] } }
//
// Notes <= 9 per step. rate index -> note value:
//   0:1/1 1:1/2 2:1/4 3:1/4T 4:1/8 5:1/8T 6:1/16 7:1/16T 8:1/32 9:1/32T

export const MAX_STEPS = 64;
export const MAX_NOTES = 9;
export const RATE_NAMES = ["1/1","1/2","1/4","1/4T","1/8","1/8T","1/16","1/16T","1/32","1/32T"];

const SUBSYS_ID = 0x7D;
const CMD = 0x20;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Firmware checksum: sum of (b ^ 0xFF), low 7 bits.
export function ysum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + (b ^ 0xFF)) & 0xFF;
  return s & 0x7F;
}

// One message = 8 steps of a pattern (177 bytes).
export function encodeWritePart(pattern, pat, part, save) {
  const body = [
    CMD,
    clamp(pat, 0, 15),
    clamp(part, 0, 7),
    save ? 1 : 0,
    clamp(pattern.length, 1, MAX_STEPS),
    clamp(pattern.rate, 0, 9),
    clamp(pattern.tempo, 30, 300) & 0x7F,
    (clamp(pattern.tempo, 30, 300) >> 7) & 0x7F,
    clamp(pattern.gate, 5, 100),
    clamp(pattern.swing, 50, 75),
    0, // per-pattern voice: not stored since FM-1_060
  ];
  for (let i = 0; i < 8; i++) {
    const step = pattern.steps[part * 8 + i] || { rate: pattern.rate, notes: [] };
    const notes = step.notes.slice(0, MAX_NOTES);
    body.push(clamp(step.rate, 0, 9), notes.length);
    for (let j = 0; j < MAX_NOTES; j++) body.push(j < notes.length ? clamp(notes[j].note, 0, 127) : 0);
    for (let j = 0; j < MAX_NOTES; j++) body.push(j < notes.length ? clamp(notes[j].vel, 1, 127) : 0);
  }
  return [0xF0, 0x43, 0x00, SUBSYS_ID, ...body, ysum(body), 0xF7];
}

// All messages for a pattern (parts = max(2, ceil(length/8)); last carries save).
export function encodeWrite(pattern, pat, save) {
  const parts = Math.max(2, Math.ceil(pattern.length / 8));
  const out = [];
  for (let k = 0; k < parts; k++) out.push(encodeWritePart(pattern, pat, k, save && k === parts - 1));
  return out;
}

// An empty 64-step pattern at the given rate.
export function emptyPattern(length = 64, rate = 8, tempo = 120, gate = 50, swing = 50) {
  return {
    length, rate, tempo, gate, swing,
    steps: Array.from({ length: MAX_STEPS }, () => ({ rate, notes: [] })),
  };
}
