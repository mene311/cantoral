// skiff-write.js — write the 64-pattern pool and the 6 x 16 entry matrix (Skiff 2.0), through an
// injected transport so the logic is testable without a unit.
//
//   const dev = { pool(), list(), listOp(op, track, entry, value?), getStep(track, i), setStep(track, i, st) }
//   await writeMatrix(dev, { patterns, cells, nstep, onStatus })
//
// Facts this rests on (web/EDITOR_PROTOCOL.md, 2.0.1):
//   - the pool holds 64 patterns; LIST's entries name a pattern by 1..64 (0 empty, 65 REST)
//   - a track's steps are the pattern it is currently ON: LIST NEW assigns a fresh pattern to an
//     entry and brings the track onto it, TRACK_STEP then writes into that pattern
//   - write and clear need the unit STOPPED (LIST/POOL ops return rc 3 while it plays)
//   - LIST SET's value is the pattern's number + 1
import * as fel from "./felucca.js";

export const RC_TEXT = {
  0: "done", 1: "empty: nothing to copy, or no room after", 2: "done, without its automation",
  3: "the unit is playing", 4: "PATTERNS FULL", 5: "failed",
};
// rc 1 is one code with several meanings by op; say the one that applies.
export const RC_BY_OP = {
  [fel.LOP.SET]: { 1: "the pattern is not kept (an empty pool slot?) - the unit will not point an entry at it",
                   4: "PATTERNS FULL" },
  [fel.LOP.NEW]: { 1: "no new pattern could be made", 4: "PATTERNS FULL" },
  [fel.LOP.CLEAR]: { 1: "the entry was already empty" },
  [fel.LOP.PLAY]: { 1: "an empty entry cannot be launched" },
};

export async function readState(dev) {
  const pool = await dev.pool();
  const list = await dev.list();
  return { pool, list };
}

// Refuse early only for what we can know without asking: room in the pool. Whether the unit is PLAYING
// is the device's answer, not a field to guess at: LIST's SONG byte is song MODE (on/off), and a refused
// op comes back with rc 3 ("the unit is playing") — so the ops below raise that where it happens.
export function checkWritable(state, need) {
  if (state.pool.free < need) throw new Error(`the pool has ${state.pool.free} free pattern${state.pool.free === 1 ? "" : "s"}; this plan needs ${need} — clear some first (POOL > CLEAR UNUSED)`);
  if (state.list.tracks.length < 1) throw new Error("the unit reported no tracks");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the unit says "entry", the front panel says A-P
const entryLetter = (e) => String.fromCharCode(65 + (e & 15));

// Put a track ON an entry's pattern before writing into it, and prove it: LIST PLAY is accepted even
// when the unit only STAGES the entry (it then applies at its launch point), so ask again, re-poll, and
// only give up when the unit keeps reporting another pattern — with no step written in that case.
export async function bringTrack(dev, track, entry, id, { tries = 3, polls = 6, ms = 120 } = {}) {
  let last = null;
  for (let k = 0; k < tries; k++) {
    const r = await dev.listOp(fel.LOP.PLAY, track, entry);
    if (!r || r.rc !== 0) throw refuse(`launching T${track + 1} entry ${entryLetter(entry)}`, r?.rc, fel.LOP.PLAY);
    let st = r;
    for (let i = 0; i < polls; i++) {
      last = st.tracks?.[track] ?? last;
      if (last?.pattern === id) return st;
      if (ms) await wait(ms);
      st = await dev.list();
    }
    if (ms) await wait(ms * 2);
  }
  throw new Error(`the unit will not bring T${track + 1} onto pattern ${id + 1} (it stays on ` +
    `${last?.pattern === 127 || last?.pattern == null ? "no pattern" : `pattern ${last.pattern + 1}`}` +
    `, entry ${entryLetter(entry)} staged): stop the unit (or leave song mode) and try again — nothing was written`);
}

// rc 3 is the device saying it is playing: that is worth its own sentence, since it is the one thing the
// user has to change on the unit itself.
const refuse = (what, rc, op) => {
  if (rc === 3) return new Error(`${what}: the unit is playing — press PLAY to stop it, then try again`);
  const text = (op !== undefined && RC_BY_OP[op]?.[rc]) || RC_TEXT[rc] || "no reply";
  return new Error(`${what}: ${text}`);
};

// Write `patterns` into the pool and point `cells` (x-track, entry) at them.
//   patterns: [[step, ...], ...]   up to 64; each step as the codec's readStep()
//   cells:    [{ track, entry, pattern }] with pattern an index into `patterns`
//   depth:    how far a step write goes (see felucca.stepDepth)
export async function writeMatrix(dev, opts) {
  const { patterns = [], cells = [], nstep = 64, depth = 5, authorTrack = 0, authorEntry = 15,
          onStatus = () => {} } = opts;
  if (!patterns.length) throw new Error("nothing to write");
  if (patterns.length > 64) throw new Error("the pool holds 64 patterns");

  const state = await readState(dev);
  checkWritable(state, patterns.length);
  const ntracks = state.list.tracks.length;
  for (const c of cells) {
    if (c.track < 0 || c.track >= ntracks) throw new Error(`cell track ${c.track} outside 0..${ntracks - 1}`);
    if (c.entry < 0 || c.entry > 15) throw new Error(`cell entry ${c.entry} outside 0..15`);
    if (c.pattern < 0 || c.pattern >= patterns.length) throw new Error(`cell names pattern ${c.pattern}, which is not in the plan`);
  }

  // The authoring entry is sacrificed (NEW overwrites it). Remember it, and only put it back AFTER the
  // cells are assigned: LIST CLEAR erases a pattern that nothing else names, so clearing it first would
  // delete the very pattern the cells are about to point at (rc 1: "a pattern not kept").
  const saved = state.list.tracks[authorTrack]?.entries?.[authorEntry] ?? { value: 0, reps: 1 };

  const ids = [];
  for (let k = 0; k < patterns.length; k++) {
    onStatus(`pattern ${k + 1}/${patterns.length}: allocating a pool slot…`);
    const r = await dev.listOp(fel.LOP.NEW, authorTrack, authorEntry);
    if (!r || r.rc !== 0) throw refuse("allocating a pool slot", r?.rc);
    // The pattern's number is the entry's value - 1 (1..64). The track's own "pattern it is on" can
    // still read 127 (PAT_NONE) right after a NEW: an entry is STAGED first and the track comes onto
    // it when it launches. Never take 127 as an id; take the entry, then put the track onto it.
    const id = (r.tracks[authorTrack]?.entries?.[authorEntry]?.value ?? 0) - 1;
    if (!(id >= 0 && id <= 63))
      throw new Error(`the unit put nothing in the entry (it answered ${r.tracks[authorTrack]?.entries?.[authorEntry]?.value}) — the pool may be full`);
    ids.push(id);
    if (r.tracks[authorTrack]?.pattern !== id)
      await bringTrack(dev, authorTrack, authorEntry, id);

    for (let i = 0; i < nstep; i++) {
      const want = patterns[k][i];
      if (!want) continue;
      const cur = await dev.getStep(authorTrack, i);
      if (cur && fel.sameStep(want, cur, depth)) continue;
      const back = await dev.setStep(authorTrack, i, want, depth);
      if (!back || !fel.sameStep(want, back, depth))
        throw new Error(`pattern ${k + 1}, step ${i + 1}: the unit did not take the write`);
    }
    if (k % 8 === 7) onStatus(`pattern ${k + 1}/${patterns.length} written`);
  }

  // a cell may sit on the authoring entry: then the cell's SET is the restore
  const scratchIsCell = cells.some((c) => c.track === authorTrack && c.entry === authorEntry);
  if (saved.value !== 0 && !scratchIsCell) {
    const r = await dev.listOp(fel.LOP.SET, authorTrack, authorEntry, saved.value);
    if (!r || r.rc !== 0) throw refuse(`restoring T${authorTrack + 1} entry ${authorEntry + 1}`, r?.rc, fel.LOP.SET);
  }

  const poolNow = await dev.pool();        // (the snapshot taken before the NEWs is stale)
  for (const c of cells) {
    // before asking: is the pattern we are about to name actually kept? (the unit answers rc 1 if not)
    const kept = (poolNow.patterns[ids[c.pattern]]?.len ?? 0) > 0;
    if (!kept)
      throw new Error(`pattern ${ids[c.pattern] + 1} is not in the pool any more - nothing to point T${c.track + 1} entry ${c.entry + 1} at`);
    const r = await dev.listOp(fel.LOP.SET, c.track, c.entry, ids[c.pattern] + 1);
    if (!r || r.rc !== 0) throw refuse(`T${c.track + 1} entry ${c.entry + 1} -> pattern ${ids[c.pattern] + 1}`, r?.rc, fel.LOP.SET);
  }

  if (saved.value === 0 && !scratchIsCell) {
    const r = await dev.listOp(fel.LOP.CLEAR, authorTrack, authorEntry);   // safe now: the cells name them
    if (!r || r.rc > 1) throw refuse(`clearing the scratch entry T${authorTrack + 1}/${authorEntry + 1}`, r?.rc, fel.LOP.CLEAR);
  }

  // read it all back: every cell must name the pattern the plan says
  const after = await dev.list();
  const bad = [];
  for (const c of cells) {
    const got = after.tracks[c.track]?.entries?.[c.entry]?.value;
    if (got !== ids[c.pattern] + 1)
      bad.push(`T${c.track + 1}/${c.entry}: holds ${got === 0 ? "nothing" : got === fel.ENTRY_REST ? "a REST" : `pattern ${got}`}, expected ${ids[c.pattern] + 1}`);
  }
  if (bad.length) throw new Error("read-back mismatch — " + bad.slice(0, 4).join("; ") + (bad.length > 4 ? ` (+${bad.length - 4} more)` : ""));

  onStatus(`wrote ${patterns.length} pattern${patterns.length === 1 ? "" : "s"} and ${cells.length} entr${cells.length === 1 ? "y" : "ies"} ✓`);
  return { ids, cells: cells.length };
}


// ---------------------------------------------------------------- blocks of 16
// WRITE 16 does not care where the cursor is or what is already there: each track owns a fixed block of
// the pool — T1 patterns 1..16, T2 17..32, T3 33..48, T4 49..64. A block slot that is empty is created
// (LIST NEW hands out the first free number, so filling in order fills the block in order); a slot that
// already holds a pattern is reused: the entry is pointed at it and its steps are overwritten in place, so
// writing a block twice does not grow the pool.
export const BLOCK = 16;
export function blockOf(track) {
  const base = track * BLOCK;
  if (base + BLOCK > 64) return null;                 // T5 and T6: no block of their own in a 64-pattern pool
  return { base, lo: base + 1, hi: base + BLOCK };    // 1-based, the way the unit numbers patterns
}

export async function writeBlock(dev, opts) {
  const { track, patterns, nstep = 64, depth = 3, onStatus = () => {} } = opts;
  if (!patterns || patterns.length !== BLOCK) throw new Error(`a block is ${BLOCK} patterns, not ${patterns?.length ?? 0}`);
  const block = blockOf(track);
  if (!block) throw new Error(`track ${track + 1} has no block of 16: the pool is 64 patterns, so only T1..T4 ` +
                              `have one (T1 1-16, T2 17-32, T3 33-48, T4 49-64)`);
  let state = await readState(dev);
  if (state.list.tracks.length <= track) throw new Error(`the unit reports ${state.list.tracks.length} tracks`);

  // one pass, slot by slot, so a full or half-written block can be resumed where it stopped
  for (let k = 0; k < BLOCK; k++) {
    const id = block.base + k;
    const exists = (state.pool.patterns[id]?.len ?? 0) > 0;
    let r;
    if (exists) {
      r = await dev.listOp(fel.LOP.SET, track, k, id + 1);          // point the entry at the pattern we own
      if (!r || r.rc !== 0) throw refuse(`T${track + 1} entry ${k + 1} -> pattern ${id + 1}`, r?.rc, fel.LOP.SET);
    } else {
      const before = (await dev.pool()).free;
      if (before < 1) throw new Error("the pool is full: clear unused patterns first (POOL > CLEAR UNUSED)");
      r = await dev.listOp(fel.LOP.NEW, track, k);
      if (!r || r.rc !== 0) throw refuse(`creating pattern ${id + 1}`, r?.rc, fel.LOP.NEW);
      const got = (r.tracks[track]?.entries?.[k]?.value ?? 0) - 1;
      if (got !== id)
        throw new Error(`the unit handed out pattern ${got + 1} where the block needs ${id + 1}: ` +
                        `patterns ${block.lo}-${block.hi} are not free (clear the pool first)`);
    }
    // the track must be ON the pattern before TRACK_STEP writes into it
    await bringTrack(dev, track, k, id);

    for (let i = 0; i < nstep; i++) {
      const want = patterns[k][i];
      if (!want) continue;
      const cur = await dev.getStep(track, i);
      if (cur && fel.sameStep(want, cur, depth)) continue;
      const back = await dev.setStep(track, i, want, depth);
      if (!back || !fel.sameStep(want, back, depth))
        throw new Error(`pattern ${id + 1}, step ${i + 1}: the unit did not take the write`);
    }
    onStatus(`T${track + 1} · pattern ${id + 1} (${k + 1}/16) written`);
    state = await readState(dev);
  }

  // read the block back: the entries must name 1..16 of the block, in order
  const after = await dev.list();
  for (let k = 0; k < BLOCK; k++) {
    const got = after.tracks[track]?.entries?.[k]?.value;
    if (got !== block.base + k + 1)
      throw new Error(`T${track + 1} entry ${k + 1} names ${got === 0 ? "nothing" : got}, expected ${block.base + k + 1}`);
  }
  onStatus(`16 patterns written to T${track + 1} (patterns ${block.lo}-${block.hi}) ✓`);
  return { track, base: block.base, ids: Array.from({ length: BLOCK }, (_, k) => block.base + k) };
}

// Clear cells (LIST CLEAR) and/or pool patterns (POOL CLEAR / EMPTY / CLEAR UNUSED).
export async function clearMatrix(dev, { cells = [], patterns = [], mode = "clear", onStatus = () => {} } = {}) {
  const state = await readState(dev);          // (song MODE is not "playing"; a refusal says so with rc 3)
  for (const c of cells) {
    const r = await dev.listOp(fel.LOP.CLEAR, c.track, c.entry);
    if (!r || r.rc !== 0) throw refuse(`CLEAR track ${c.track + 1} entry ${c.entry}`, r?.rc);
  }
  if (patterns.length) {
    const op = mode === "empty" ? 2 : 1;                  // 2: EMPTY (2.0), 1: CLEAR
    for (const p of patterns) {
      const r = await dev.poolOp(op, p);
      if (!r || r.rc !== 0) throw refuse(`POOL ${mode} pattern ${p}`, r?.rc);
    }
  } else if (mode === "unused") {
    const r = await dev.poolOp(3);
    if (!r || r.rc !== 0) throw refuse("POOL CLEAR UNUSED", r?.rc);
  }
  onStatus("cleared");
}
