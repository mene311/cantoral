// writer.js — phrases into the FM-1's pool and its 6 × 16 entry matrix.
//
// Transport-injected, so it is testable without the unit: `dev` is the same
// little adapter skiff-write.js documents (pool, list, listOp, poolOp, getStep,
// setStep). What decides where a phrase lands:
//
//   entry already names a pattern  ->  write into that pattern (nothing is
//                                      allocated, the pool does not grow)
//   entry empty (or a REST)        ->  LIST NEW gives a fresh pool slot and
//                                      points the entry at it
//
// skiff-write.js's writeMatrix always allocates, and its writeBlock insists on
// fixed block numbering (T1 = patterns 1-16, …), which fails on a half-empty
// pool. Neither is what a phrase browser wants: pointing 16 phrases at a track
// twice must not need 32 patterns.
import * as fel from "./felucca.js";
import { bringTrack, RC_TEXT, RC_BY_OP } from "./skiff-write.js";

const entryLetter = (e) => String.fromCharCode(65 + (e & 15));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const refuse = (what, rc, op) => {
  if (rc === 3) return new Error(`${what}: the unit is playing — press PLAY to stop it, then try again`);
  const text = (op !== undefined && RC_BY_OP[op]?.[rc]) || RC_TEXT[rc] || "no reply";
  return new Error(`${what}: ${text}`);
};

// The entry's value: 1..64 = a pattern, 65 = REST, 0 = empty.
function entryValue(list, track, entry) {
  return list?.tracks?.[track]?.entries?.[entry]?.value ?? 0;
}

async function writeSteps(dev, track, steps, nstep, depth, onStatus, label) {
  let changed = 0;
  for (let i = 0; i < nstep; i++) {
    const want = steps[i];
    if (!want) continue;
    const cur = await dev.getStep(track, i);
    if (cur && fel.sameStep(want, cur, depth)) continue;
    const back = await dev.setStep(track, i, want, depth);
    if (!back || !fel.sameStep(want, back, depth))
      throw new Error(`${label}, step ${i + 1}: the unit did not take the write`);
    changed++;
    if (onStatus && i % 16 === 15) onStatus(`${label}: ${i + 1}/${nstep} steps`);
  }
  return changed;
}

// One phrase -> one (track, entry). Returns what it did, in plain numbers.
export async function writeEntry(dev, { track, entry, steps, nstep = 64, depth = 5, onStatus = () => {}, label = "" }) {
  if (!steps?.length) throw new Error("nothing to write");
  const where = label || `T${track + 1} · ${entryLetter(entry)}`;
  let list = await dev.list();
  if (!list?.tracks?.length) throw new Error("the unit reported no tracks");
  const value = entryValue(list, track, entry);

  if (value >= 1 && value <= 64) {
    const id = value - 1;
    onStatus(`${where}: writing into pattern ${value}…`);
    if (list.tracks[track].pattern !== id) await bringTrack(dev, track, entry, id);
    const changed = await writeSteps(dev, track, steps, nstep, depth, onStatus, where);
    return { created: false, id, changed };
  }

  const pool = await dev.pool();
  if (pool.free < 1)
    throw new Error("the pool is full (64 patterns) — clear unused patterns on the unit first (POOL > CLEAR UNUSED)");
  onStatus(`${where}: taking a free pool pattern…`);
  const r = await dev.listOp(fel.LOP.NEW, track, entry);
  if (!r || r.rc !== 0) throw refuse(`${where}: taking a pattern from the pool`, r?.rc, fel.LOP.NEW);
  const id = entryValue(r, track, entry) - 1;
  if (!(id >= 0 && id <= 63))
    throw new Error(`${where}: the unit put no pattern in the entry (it answered ${entryValue(r, track, entry)})`);
  if (r.tracks[track].pattern !== id) await bringTrack(dev, track, entry, id);
  const changed = await writeSteps(dev, track, steps, nstep, depth, onStatus, where);

  // read it back: an entry that does not name the pattern we just filled would
  // play the old one, and nothing about the write would look wrong
  list = await dev.list();
  if (entryValue(list, track, entry) !== id + 1)
    throw new Error(`${where}: the entry does not hold the pattern that was written (pattern ${id + 1})`);
  return { created: true, id, changed };
}

// Sixteen phrases -> one track's entries A–P, in order. Each entry is reused if
// it already names a pattern, so sending twice does not eat the pool.
export async function writeSixteen(dev, { track, start = 0, phrases, stepsOf, nstep = 64, depth = 5, onStatus = () => {} }) {
  if (!phrases?.length) throw new Error("no phrases to send");
  const list = await dev.list();
  if (!list?.tracks?.length) throw new Error("the unit reported no tracks");
  if (track >= list.tracks.length) throw new Error(`the unit reports ${list.tracks.length} tracks`);
  const taken = [];
  for (let k = 0; k < 16; k++) {
    const phrase = phrases[(start + k) % phrases.length];
    const label = `T${track + 1} · ${String.fromCharCode(65 + k)} · ${phrase.n}`;
    onStatus(`${label}: ${k + 1}/16`);
    const res = await writeEntry(dev, {
      track, entry: k, steps: stepsOf(phrase), nstep, depth, label,
    });
    taken.push({ entry: k, id: res.id, created: res.created, name: phrase.n });
    await wait(20);
  }
  const after = await dev.list();
  const bad = taken.filter((x) => entryValue(after, track, x.entry) !== x.id + 1);
  if (bad.length) throw new Error(`${bad.length} entr${bad.length === 1 ? "y" : "ies"} did not keep its pattern`);
  return { track, taken };
}

// Rests over the pattern the track is on right now. No allocation, no entry
// change: it silences whatever that track plays.
export async function silenceTrack(dev, { track, nstep = 64, depth = 5, onStatus = () => {}, rest }) {
  if (!rest) throw new Error("no rest step supplied");
  const list = await dev.list();
  const on = list?.tracks?.[track]?.pattern;
  const where = on === fel.PAT_NONE || on == null ? `T${track + 1}` : `T${track + 1} (pattern ${on + 1})`;
  return writeSteps(dev, track, Array.from({ length: nstep }, () => rest), nstep, depth, onStatus, where);
}
