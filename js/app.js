// app.js — Cantoral: the Renoise phrase library, pushed into the FM-1's sequencer.
//
// What it does, in the order the screen is laid out:
//   left    pick a phrase out of the bank (folders + search)
//   middle  see it (piano roll) and hear it (notes on the destination track's channel)
//   right   write it into a track's entry, or send sixteen of them at once (A–P)
//
// Nothing here re-implements the wire protocol: js/felucca.js is the codec
// (taken from Timón, validated against a unit on Skiff 2.0.1), js/writer.js is
// the pool/entry writer built on it.
import * as midi from "./midi.js";
import * as fel from "./felucca.js";
import * as writer from "./writer.js";
import * as ph from "./phrase.js";

const $ = (id) => document.getElementById(id);
const ENTRY_LETTERS = "ABCDEFGHIJKLMNOP";

const state = {
  index: null,           // bank/index.json
  folders: new Map(),    // id -> parsed folder JSON
  folder: null,          // selected folder id, or "all"
  list: [],              // the phrases on screen (in the current folder/filter)
  selected: 0,           // index into state.list
  phrase: null,
  track: 0,
  entry: 0,
  bpm: 120,
  followDelay: false,
  nstep: 64,
  depth: 3,
  info: null,
  playing: false,
  busy: false,
  playTimer: null,
  heldNotes: [],
};

// ---------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------
function status(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function log(text, kind = "") {
  const el = $("log");
  const row = document.createElement("div");
  row.className = "logrow" + (kind ? " " + kind : "");
  row.textContent = text;
  el.prepend(row);
  while (el.children.length > 6) el.lastChild.remove();
}

// ---------------------------------------------------------------------------
// device
// ---------------------------------------------------------------------------
async function connect() {
  try {
    $("connect").disabled = true;
    status("asking the browser for the FM-1…");
    const outputs = await midi.initMidi();
    const fm = midi.findFm1();
    if (!fm) {
      setDevice(null);
      status(outputs.length ? "no FM-1 among these MIDI ports: " + outputs.map((o) => o.name).join(", ")
                            : "no MIDI ports — is the FM-1 plugged in over USB?", "err");
      return;
    }
    setDevice(fm.name);
    midi.onStateChange(() => { if (!midi.findFm1()) { setDevice(null); status("the FM-1 went away", "err"); } });
    status("FM-1 found — reading the firmware…");
    await detect();
  } catch (e) {
    status("no MIDI: " + e.message, "err");
  } finally {
    $("connect").disabled = false;
  }
}

function setDevice(name) {
  $("devname").textContent = name || "no MIDI";
  $("led").classList.toggle("on", !!name);
}

async function felReq(cmd, args, timeoutMs = 1500, tries = 2) {
  for (let k = 0; k < tries; k++) {
    const rep = await midi.sendSysex(fel.frame(cmd, args), timeoutMs,
      (d) => d[1] === 0x7D && d[2] === 0x46 && d[3] === 0x4C && d[4] === (cmd & 0x7F));
    const r = fel.reply(rep, cmd);
    if (r) return r;
  }
  return null;
}

async function detect() {
  try {
    const args = await felReq(fel.CMD.INFO, []);
    if (!args) { status("the FM-1 answered no firmware probe — is it on Skiff/Felucca?", "err"); return; }
    state.info = fel.decodeInfo(args);
    state.nstep = state.info.nstep || 64;
    state.depth = fel.stepDepth(state.info.caps);
    const caps = state.info.caps;
    const missing = [];
    if (!caps.pool) missing.push("the pattern pool");
    if (!caps.list) missing.push("the entry lists");
    if (missing.length) {
      status(`this unit runs ${state.info.version}, which has no ${missing.join(" and ")} — Cantoral needs Skiff 2.0 or Felucca with the pool`, "err");
    } else {
      status(`${state.info.version} · ${state.info.ntrk} tracks · ${state.nstep} steps · writing at depth ${state.depth}`, "ok");
    }
    paintDest();
    readPool().catch(() => null);
  } catch (e) {
    status("could not read the firmware: " + e.message, "err");
  }
}

// writeMatrix/writeBlock talk to the unit through this little adapter.
const dev = {
  pool: async () => fel.decodePool(await felReq(fel.CMD.POOL, []) ?? []),
  list: async () => fel.decodeList(await felReq(fel.CMD.LIST, []) ?? []),
  listOp: async (op, tr, en, v) =>
    fel.decodeList(await felReq(fel.CMD.LIST, v === undefined ? [op, tr, en] : [op, tr, en, v]) ?? []),
  poolOp: async (op, id) =>
    fel.decodePool(await felReq(fel.CMD.POOL, id === undefined ? [op] : [op, id]) ?? []),
  getStep: async (tr, i) => { const r = await felReq(fel.CMD.TRACK_STEP, [tr, i]); return r ? fel.readStep(r) : null; },
  setStep: async (tr, i, st, depth = 3) => {
    const r = await felReq(fel.CMD.TRACK_STEP, [tr, i, ...fel.stepBytes(st, depth)]);
    return r ? fel.readStep(r) : null;
  },
};

const requireDevice = () => {
  if (!midi.findFm1()) throw new Error("connect the FM-1 first");
  if (!state.info) throw new Error("the unit has not been read yet — press connect");
};

// ---------------------------------------------------------------------------
// pool readout
// ---------------------------------------------------------------------------
async function readPool() {
  if (!midi.findFm1() || !state.info) return;
  const [pool, list] = await Promise.all([dev.pool(), dev.list()]);
  const rows = [`<b>${pool.free}</b> of 64 pool patterns free`];
  for (let t = 0; t < list.tracks.length; t++) {
    const tr = list.tracks[t];
    const name = tr.pattern === 127 || tr.pattern == null ? "no pattern" : `pattern ${tr.pattern + 1}`;
    rows.push(`T${t + 1} on ${name}${t === state.track ? " ←" : ""}`);
  }
  $("pool").innerHTML = rows.join("<br>");
  // say which entry our target track already holds, so a write is never a surprise
  const tr = list.tracks[state.track];
  const v = tr?.entries?.[state.entry]?.value;
  $("entrynow").textContent = v === 0 || v == null ? "empty"
    : v === fel.ENTRY_REST ? "a REST"
    : `pattern ${v}`;
  return { pool, list };
}

// ---------------------------------------------------------------------------
// bank
// ---------------------------------------------------------------------------
async function loadBank() {
  const index = await (await fetch("bank/index.json", { cache: "no-cache" })).json();
  state.index = index;
  const chips = $("folders");
  const all = document.createElement("button");
  all.className = "chip";
  all.dataset.folder = "all";
  all.innerHTML = `All <small>${index.total}</small>`;
  chips.append(all);
  for (const f of index.folders) {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.folder = f.id;
    b.innerHTML = `${escapeHtml(f.title)} <small>${f.count}</small>`;
    chips.append(b);
  }
  chips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (b) selectFolder(b.dataset.folder);
  });
  const saved = localStorage.getItem("cantoral.folder");
  await selectFolder(saved && (saved === "all" || index.folders.some((f) => f.id === saved)) ? saved : "13_Classics");
  status(`${index.total} phrases · ${index.grid} grid · pick one`);
}

async function folderData(id) {
  if (state.folders.has(id)) return state.folders.get(id);
  const data = await (await fetch(`bank/${id}.json`, { cache: "no-cache" })).json();
  state.folders.set(id, data);
  return data;
}

async function selectFolder(id) {
  state.folder = id;
  localStorage.setItem("cantoral.folder", id);
  for (const c of document.querySelectorAll(".chip")) c.classList.toggle("on", c.dataset.folder === id);
  if (id === "all") {
    const all = [];
    for (const f of state.index.folders) {
      for (const p of await folderData(f.id)) all.push({ ...p, folder: f.id, title: f.title });
    }
    state.list = all;
  } else {
    const title = state.index.folders.find((f) => f.id === id)?.title ?? id;
    state.list = (await folderData(id)).map((p) => ({ ...p, folder: id, title }));
  }
  state.selected = 0;
  applyFilter();
}

function applyFilter() {
  const q = $("search").value.trim().toLowerCase();
  if (q) state.view = state.list.filter((p) => p.n.toLowerCase().includes(q));
  else state.view = state.list;
  state.selected = Math.min(state.selected, Math.max(0, state.view.length - 1));
  paintList();
  select(state.selected);
}

function paintList() {
  const el = $("list");
  el.innerHTML = "";
  const frag = document.createDocumentFragment();
  state.view.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "item" + (i === state.selected ? " on" : "");
    li.dataset.i = i;
    li.innerHTML = `<span class="nm">${escapeHtml(p.n)}</span><span class="ln">${p.l}</span>`;
    frag.append(li);
  });
  el.append(frag);
  $("count").textContent = `${state.view.length} phrase${state.view.length === 1 ? "" : "s"}`;
  const on = el.querySelector(".item.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

$("list").addEventListener("click", (e) => {
  const li = e.target.closest(".item");
  if (li) select(Number(li.dataset.i));
});

function select(i) {
  if (!state.view || !state.view.length) { state.phrase = null; drawRoll(); return; }
  state.selected = Math.max(0, Math.min(state.view.length - 1, i));
  state.phrase = state.view[state.selected];
  for (const [k, li] of [...document.querySelectorAll(".item")].entries()) li.classList.toggle("on", k === state.selected);
  const d = ph.describe(state.phrase);
  $("ptitle").textContent = state.phrase.n;
  $("pmeta").innerHTML =
    `${escapeHtml(state.phrase.title)} · <b>${d.steps}</b> steps · <b>${d.notes}</b> notes · ` +
    (d.lo != null ? `range ${ph.noteName(d.lo)}–${ph.noteName(d.hi)}` : "empty") +
    (d.ties ? ` · ${d.ties} held` : "");
  drawRoll();
}

// ---------------------------------------------------------------------------
// piano roll
// ---------------------------------------------------------------------------
function drawRoll() {
  const cv = $("roll");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const steps = state.nstep;
  const pitch = state.phrase ? ph.describe(state.phrase) : null;
  let lo = 48, hi = 72;
  if (pitch && pitch.lo != null) { lo = pitch.lo - 2; hi = pitch.hi + 2; }
  const rows = Math.max(8, hi - lo + 1);
  const cw = w / steps, ch = h / rows;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#ff5da4";
  const accent2 = css.getPropertyValue("--accent2").trim() || "#c5a5f6";
  const line = css.getPropertyValue("--line").trim() || "#584d5e";

  // row stripes per octave (C rows darker) + step grid
  for (let r = 0; r < rows; r++) {
    const p = hi - r;
    if (p % 12 === 0) { g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(0, r * ch, w, ch); }
  }
  g.strokeStyle = line;
  g.lineWidth = 1;
  for (let s = 0; s <= steps; s += 4) {
    g.globalAlpha = s % 16 === 0 ? 0.9 : 0.28;
    g.beginPath(); g.moveTo(s * cw, 0); g.lineTo(s * cw, h); g.stroke();
  }
  g.globalAlpha = 1;

  const src = state.phrase?.s ?? [];
  for (let s = 0; s < Math.min(steps, src.length); s++) {
    const ev = src[s];
    if (ev === "t") {
      g.fillStyle = accent2;
      g.globalAlpha = 0.55;
      for (let r = 0; r < rows; r++) {
        const p = hi - r;
        if (soundingAt(src, s, p)) g.fillRect(s * cw + cw * 0.35, r * ch + ch * 0.4, cw * 0.3, ch * 0.2);
      }
      g.globalAlpha = 1;
      continue;
    }
    if (!Array.isArray(ev)) continue;
    for (const [p, vel] of ev) {
      const r = hi - p;
      if (r < 0 || r >= rows) continue;
      g.globalAlpha = 0.35 + 0.65 * Math.min(1, (vel ?? 100) / 127);
      g.fillStyle = s % 16 === 0 ? accent : accent;
      roundRect(g, s * cw + 1, r * ch + 1, Math.max(2, cw - 2), Math.max(2, ch - 2), Math.min(3, cw / 3));
      g.fill();
      g.globalAlpha = 1;
    }
  }

  // playhead
  if (state.playStep != null) {
    g.fillStyle = accent;
    g.globalAlpha = 0.18;
    g.fillRect(state.playStep * cw, 0, cw, h);
    g.globalAlpha = 1;
  }
  // the phrase's own length
  if (state.phrase && state.phrase.l < steps) {
    g.fillStyle = "rgba(0,0,0,.35)";
    g.fillRect(state.phrase.l * cw, 0, w - state.phrase.l * cw, h);
  }
}

// is pitch p sounding at step s (walking back through the TIE chain)?
const soundingAtCache = new WeakMap();
function soundingAt(src, s, p) {
  let cache = soundingAtCache.get(src);
  if (!cache) { cache = new Map(); soundingAtCache.set(src, cache); }
  let map = cache.get(s);
  if (!map) {
    map = new Set();
    let i = s;
    while (i >= 0 && src[i] === "t") i--;
    if (Array.isArray(src[i])) for (const n of src[i]) map.add(n[0]);
    cache.set(s, map);
  }
  return map.has(p);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------------------
// audition (notes only — nothing is written)
// ---------------------------------------------------------------------------
function stop() {
  state.playing = false;
  clearTimeout(state.playTimer);
  for (const n of state.heldNotes) midi.sendNoteOff(n, state.track + 1);
  state.heldNotes = [];
  state.playStep = null;
  $("play").textContent = "▶ Play";
  drawRoll();
}

function play() {
  if (!state.phrase) return;
  stop();
  state.playing = true;
  $("play").textContent = "■ Stop";
  const src = state.phrase.s;
  const total = Math.max(1, state.phrase.l);
  const stepMs = 60000 / state.bpm / 4;
  let i = 0;
  const tick = () => {
    if (!state.playing) return;
    // release whatever the previous step left sounding
    for (const n of state.heldNotes) midi.sendNoteOff(n, state.track + 1);
    state.heldNotes = [];
    state.playStep = i;
    const ev = src[i];
    if (Array.isArray(ev)) {
      for (const [p, vel] of ev) {
        midi.sendNoteOn(p, Math.max(1, Math.min(127, vel ?? 100)), state.track + 1);
        state.heldNotes.push(p);
      }
    }
    drawRoll();
    i = (i + 1) % total;
    state.playTimer = setTimeout(tick, stepMs);
  };
  tick();
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------
function plan() {
  const steps = ph.toSteps(state.phrase, state.nstep, { followDelay: state.followDelay });
  return { steps, nstep: state.nstep, depth: state.depth };
}

async function push() {
  if (state.busy) return;
  if (!state.phrase) { status("pick a phrase first", "err"); return; }
  try {
    state.busy = true; stop();
    requireDevice();
    $("push").disabled = true;
    const target = `T${state.track + 1} · ${ENTRY_LETTERS[state.entry]}`;
    const res = await writer.writeEntry(dev, {
      track: state.track, entry: state.entry,
      steps: ph.toSteps(state.phrase, state.nstep, { followDelay: state.followDelay }),
      nstep: state.nstep, depth: state.depth,
      onStatus: (t) => status(t),
      label: `${target} · ${state.phrase.n}`,
    });
    const how = res.created ? `new pattern ${res.id + 1}` : `pattern ${res.id + 1}`;
    log(`${target} = ${state.phrase.n} → ${how} (${res.changed} steps changed)`, "ok");
    status(`${state.phrase.n} → ${target} ✓ (${how})`, "ok");
    readPool().catch(() => null);
  } catch (e) {
    status(e.message, "err");
    log(e.message, "err");
  } finally {
    $("push").disabled = false;
    state.busy = false;
  }
}

async function send16() {
  if (state.busy) return;
  if (!state.view || !state.view.length) return;
  const start = state.selected;
  const picked = [];
  for (let k = 0; k < 16; k++) picked.push(state.view[(start + k) % state.view.length]);
  const ok = confirm(`Write 16 phrases into T${state.track + 1}, entries A–P?\n\n` +
    `from “${picked[0].n}”\n…to “${picked[15].n}”\n\n` +
    `An entry that already holds a pattern is overwritten in place; an empty one takes a free pool pattern. ` +
    `The unit must be stopped.`);
  if (!ok) return;
  try {
    state.busy = true; stop();
    requireDevice();
    $("push16").disabled = true;
    const res = await writer.writeSixteen(dev, {
      track: state.track, start,
      phrases: state.view,
      stepsOf: (p) => ph.toSteps(p, state.nstep, { followDelay: state.followDelay }),
      nstep: state.nstep, depth: state.depth,
      onStatus: (t) => status(t),
    });
    const made = res.taken.filter((x) => x.created).length;
    log(`16 phrases → T${state.track + 1} entries A–P (${made} new patterns, ${16 - made} reused)`, "ok");
    status(`T${state.track + 1} A–P filled ✓ (${made} new patterns)`, "ok");
    readPool().catch(() => null);
  } catch (e) {
    status(e.message, "err");
    log(e.message, "err");
  } finally {
    $("push16").disabled = false;
    state.busy = false;
  }
}

async function clearTrack() {
  if (state.busy) return;
  if (!confirm(`Silence T${state.track + 1}?\n\nIt writes rests over all 64 steps of the pattern that track is on right now.`)) return;
  try {
    state.busy = true; stop();
    requireDevice();
    $("clear").disabled = true;
    const changed = await writer.silenceTrack(dev, {
      track: state.track, nstep: state.nstep, depth: state.depth,
      onStatus: (t) => status(t), rest: ph.restStep(),
    });
    log(`T${state.track + 1} silenced (${changed} steps)`, "ok");
    status(`T${state.track + 1} silenced ✓`, "ok");
    readPool().catch(() => null);
  } catch (e) {
    status(e.message, "err");
  } finally {
    $("clear").disabled = false;
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// destination panel
// ---------------------------------------------------------------------------
function paintDest() {
  const ntracks = state.info?.ntrk ?? 6;
  const tk = $("track");
  tk.innerHTML = "";
  for (let t = 0; t < ntracks; t++) {
    const o = document.createElement("option");
    o.value = t; o.textContent = `T${t + 1}`;
    tk.append(o);
  }
  tk.value = state.track;
  const en = $("entry");
  en.innerHTML = "";
  for (let e = 0; e < 16; e++) {
    const o = document.createElement("option");
    o.value = e; o.textContent = ENTRY_LETTERS[e];
    en.append(o);
  }
  en.value = state.entry;
  $("push16").disabled = state.track > 3;
  $("tracks16").textContent = state.track > 3 ? "T1–T4 only" : "A–P";
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

$("connect").addEventListener("click", connect);
$("play").addEventListener("click", () => (state.playing ? stop() : play()));
$("push").addEventListener("click", push);
$("push16").addEventListener("click", send16);
$("clear").addEventListener("click", clearTrack);
$("search").addEventListener("input", applyFilter);
$("bpm").addEventListener("input", (e) => { state.bpm = Math.max(30, Math.min(300, Number(e.target.value) || 120)); });
$("nudge").addEventListener("change", (e) => { state.followDelay = e.target.checked; });
$("track").addEventListener("change", (e) => {
  state.track = Number(e.target.value);
  localStorage.setItem("cantoral.track", state.track);
  stop(); paintDest(); readPool().catch(() => null);
});
$("entry").addEventListener("change", (e) => {
  state.entry = Number(e.target.value);
  localStorage.setItem("cantoral.entry", state.entry);
  readPool().catch(() => null);
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === "ArrowRight") { select(state.selected + 1); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { select(state.selected - 1); e.preventDefault(); }
  else if (e.key === " ") { state.playing ? stop() : play(); e.preventDefault(); }
});

window.addEventListener("resize", drawRoll);

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
state.track = Math.min(5, Number(localStorage.getItem("cantoral.track") ?? 0));
state.entry = Math.min(15, Number(localStorage.getItem("cantoral.entry") ?? 0));
paintDest();
drawRoll();
window.cantoral = state;   // handy in the console, and for the checks
loadBank().catch((e) => status("could not load the phrase bank: " + e.message, "err"));
