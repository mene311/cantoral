// phrase.js — a phrase from the bank (Renoise-derived, 1/16 grid) -> Skiff steps.
//
// The bank's step array is: null = nothing sounding, "t" = hold the previous
// note, [pitch, vel, delay] (up to 4 notes) = a note. See tools/xrnz2bank.py.
//
// Mapping decisions, in one place:
//   pitch     MIDI numbers already (Renoise C-4 = 60), written as the unit takes them
//   velocity  the loudest note of the step — a chord must not come out quieter
//             than a single note of the same phrase
//   delay     Renoise delays a note within its line (00-FF ticks). The device has
//             NUDGE (±32, one step's worth either way), so the ratio can only be
//             approximate: we scale into a HALF step at most, so a phrase pressed
//             wrong never smears. Off by default in the UI — turn it on to hear
//             the phrasing the Renoise file asked for.
//   hold      a "t" row becomes a TIE. Skiff/Felucca has no note length: a TIE
//             pushes the sounding note's release forward, which is exactly a
//             held note, and the next NOTE row ends it.
import * as fel from "./felucca.js";

export const MAX_NOTES = 4;
export const MAX_STEPS = 64;
const NUDGE_HALF = 16;             // half a step (NUDGE is ±32)

export function emptyStep() {
  return { n: 0, notes: [0, 0, 0, 0], time: fel.ST.REST, flags: 0, vel: 0, hit: 0, acc: 0, hi: 0, chance: 100, nudge: 0 };
}

export function tieStep() {
  return { ...emptyStep(), time: fel.ST.TIE };
}

export function restStep() {
  return emptyStep();
}

// One phrase step -> one device step.
export function toStep(src, { followDelay = false } = {}) {
  if (src === "t") return tieStep();
  if (!Array.isArray(src) || !src.length) return restStep();
  const notes = src.slice(0, MAX_NOTES);
  const st = emptyStep();
  st.n = notes.length;
  st.time = fel.ST.NOTE;
  for (let k = 0; k < MAX_NOTES; k++) st.notes[k] = notes[k] ? clamp(notes[k][0], 0, 127) : 0;
  st.vel = clamp(Math.max(...notes.map((n) => n[1] ?? 100)), 1, 127);
  if (followDelay) {
    const d = Math.max(...notes.map((n) => n[2] ?? 0));           // 0..255 of a line
    st.nudge = Math.min(32, Math.round((d / 255) * NUDGE_HALF));
  }
  return st;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A whole phrase -> `nstep` device steps (rests past the phrase's length, which
// is what silences whatever the destination pattern held before).
export function toSteps(phrase, nstep = 64, opts = {}) {
  const out = [];
  const src = phrase?.s ?? [];
  for (let i = 0; i < nstep; i++) out.push(i < src.length ? toStep(src[i], opts) : restStep());
  return out;
}

// Stats for the panel.
export function describe(phrase) {
  const src = phrase?.s ?? [];
  let notes = 0, ties = 0, lo = 999, hi = 0;
  for (const s of src) {
    if (s === "t") { ties++; continue; }
    if (!Array.isArray(s)) continue;
    notes += s.length;
    for (const n of s) { lo = Math.min(lo, n[0]); hi = Math.max(hi, n[0]); }
  }
  return { steps: src.length, notes, ties, lo: hi ? lo : null, hi: hi || null };
}

// How long one pass of the phrase is, for the audition.
//
// NOT simply "up to the last note": almost every phrase in the library ends mid
// bar (49, 57, 61 lines…), so looping there cuts the bar in pieces and the phrase
// limps. A pass ends at the bar after the last note — the same silence the unit
// plays, since it holds the pattern's full step count.
export const BAR = 16;
export function loopLength(phrase, nstep = 64, bar = BAR) {
  const used = Math.max(1, phrase?.l ?? 1);
  return Math.min(nstep, Math.max(bar, Math.ceil(used / bar) * bar));
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(p) {
  return `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
}
