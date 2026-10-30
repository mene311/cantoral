// tests/mapping.test.mjs — what Cantoral promises, checked without a unit.
//
//   node tests/mapping.test.mjs
//
// Covers the two things that can silently ruin a write: the phrase -> step
// conversion, and the pool/entry writer's calls. The device itself is not here;
// that is `not tried on the unit yet` territory and only a real push settles it.
import assert from "node:assert/strict";
import * as ph from "../js/phrase.js";
import * as fel from "../js/felucca.js";
import * as writer from "../js/writer.js";
import * as skiff from "../js/skiff-write.js";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

// ---------------------------------------------------------------- phrase -> step
t("a held row becomes a TIE, an empty row a REST", () => {
  const steps = ph.toSteps({ l: 3, s: [[[60, 100, 0]], "t", null] }, 4);
  assert.equal(steps[0].time, fel.ST.NOTE);
  assert.equal(steps[1].time, fel.ST.TIE);
  assert.equal(steps[2].time, fel.ST.REST);
  assert.equal(steps[3].time, fel.ST.REST, "past the phrase's length is a rest, which silences the pattern");
});

t("four notes fit, five are cut to the device's limit", () => {
  const four = [[60, 100, 0], [64, 100, 0], [67, 100, 0], [72, 100, 0]];
  const st = ph.toStep(four);
  assert.equal(st.n, 4);
  assert.deepEqual(st.notes, [60, 64, 67, 72]);
  const five = ph.toStep([...four, [76, 100, 0]]);
  assert.equal(five.n, 4, "Skiff holds four notes per step and no more");
});

t("velocity is the loudest note, so a chord is not quieter than a single note", () => {
  assert.equal(ph.toStep([[60, 40, 0], [67, 110, 0]]).vel, 110);
});

t("a phrase's delay only ever nudges within half a step", () => {
  const none = ph.toStep([[60, 100, 0]], { followDelay: true }).nudge;
  const full = ph.toStep([[60, 100, 255]], { followDelay: true }).nudge;
  const mid = ph.toStep([[60, 100, 128]], { followDelay: true }).nudge;
  assert.equal(none, 0);
  assert.ok(full <= 32 && full > 0, `nudge stayed in range (${full})`);
  assert.ok(mid < full);
  assert.equal(ph.toStep([[60, 100, 255]], { followDelay: false }).nudge, 0, "off by default");
});

t("every phrase is padded to the unit's step count", () => {
  const steps = ph.toSteps({ l: 49, s: Array(49).fill(null) }, 64);
  assert.equal(steps.length, 64);
  assert.ok(steps.every((s) => s.time === fel.ST.REST));
});

t("describe counts notes, holds and the range", () => {
  const d = ph.describe({ s: [[[60, 100, 0], [64, 90, 0]], "t", null, [[67, 80, 0]]] });
  assert.deepEqual([d.steps, d.notes, d.ties, d.lo, d.hi], [4, 3, 1, 60, 67]);
});

t("a step's bytes round-trip through the codec", () => {
  const st = ph.toStep([[60, 90, 0]], { followDelay: true });
  const back = fel.readStep([0, 0, ...fel.stepBytes(st, 5)]);
  assert.ok(fel.sameStep(st, back, 5));
  assert.equal(back.notes[0], 60);
});

// ---------------------------------------------------------------- the writer
// A fake unit: one project, 4 tracks, a 64-pattern pool, 64 steps each.
function fakeDevice({ free = 64 } = {}) {
  const patterns = Array.from({ length: 64 }, (_, i) => ({ len: i < 64 - free ? 64 : 0, uses: 0 }));
  const tracks = Array.from({ length: 4 }, () => ({
    entry: 127, staged: 127, pattern: fel.PAT_NONE,
    entries: Array.from({ length: 16 }, () => ({ value: 0, reps: 1, chained: false })),
  }));
  const steps = new Map();                    // `${track}:${step}` -> step object
  const calls = [];
  let nextFree = 64 - free;
  const listReply = () => ({ op: fel.CMD.LIST, rc: 0, song: 0, tracks: tracks.map((t) => ({ ...t, entries: t.entries.map((e) => ({ ...e })) })) });
  return {
    calls, tracks, patterns, steps,
    pool: async () => ({ patterns: patterns.map((p) => ({ ...p })), free: patterns.filter((p) => !p.len).length }),
    list: async () => listReply(),
    listOp: async (op, tr, en, v) => {
      calls.push([op, tr, en, v]);
      const T = tracks[tr];
      if (op === fel.LOP.NEW) {
        if (nextFree >= 64) return { ...listReply(), rc: 4 };
        const id = nextFree++;
        patterns[id].len = 64;
        T.entries[en].value = id + 1;
        T.staged = en;
        return listReply();
      }
      if (op === fel.LOP.PLAY) {
        const val = T.entries[en].value;
        if (val < 1 || val > 64) return { ...listReply(), rc: 1 };
        T.pattern = val - 1;
        T.entry = en;
        return listReply();
      }
      if (op === fel.LOP.SET) {
        if (!(v >= 1 && v <= 64) || !patterns[v - 1].len) return { ...listReply(), rc: 1 };
        T.entries[en].value = v;
        return listReply();
      }
      if (op === fel.LOP.CLEAR) { T.entries[en] = { value: 0, reps: 1, chained: false }; return listReply(); }
      return { ...listReply(), rc: 5 };
    },
    poolOp: async () => ({ op: fel.CMD.POOL, rc: 0, patterns: [], free: 0 }),
    getStep: async (tr, i) => steps.get(`${tr}:${i}`) ?? null,
    setStep: async (tr, i, st, depth = 0) => { steps.set(`${tr}:${i}`, { ...st }); return { ...st }; },
  };
}

const stepsOf4 = () => ph.toSteps({ l: 4, s: [[[60, 100, 0]], "t", null, [[64, 100, 0]]] }, 64);

await (async () => {
  const dev = fakeDevice();
  const res = await writer.writeEntry(dev, { track: 2, entry: 5, steps: stepsOf4(), nstep: 64, depth: 5 });
  assert.equal(res.created, true, "an empty entry takes a fresh pool pattern");
  assert.equal(dev.tracks[2].entries[5].value, res.id + 1, "the entry names it");
  assert.equal(dev.tracks[2].pattern, res.id, "the track was brought onto it before writing");
  assert.equal(dev.steps.get("2:0").notes[0], 60);
  assert.equal(dev.steps.get("2:1").time, fel.ST.TIE, "the hold is a TIE row");
  assert.equal(dev.steps.get("2:2").time, fel.ST.REST, "the rest silences what was there");
  assert.equal(dev.steps.get("2:3").notes[0], 64);
  pass++; console.log("  ok  writeEntry allocates a pattern, fills it, points the entry");
})();

await (async () => {
  const dev = fakeDevice();
  const first = await writer.writeEntry(dev, { track: 2, entry: 5, steps: stepsOf4(), nstep: 64, depth: 5 });
  const second = await writer.writeEntry(dev, { track: 2, entry: 5, steps: stepsOf4(), nstep: 64, depth: 5 });
  assert.equal(second.created, false, "the second push reuses the pattern");
  assert.equal(second.id, first.id);
  assert.equal(dev.patterns.filter((p) => p.len).length, 1, "one pattern, not two");
  pass++; console.log("  ok  pushing twice into the same entry does not grow the pool");
})();

await (async () => {
  const dev = fakeDevice();
  const phrases = Array.from({ length: 16 }, (_, k) => ({ n: `P${k}`, l: 2, s: [[[60 + k, 100, 0]], "t"] }));
  const res = await writer.writeSixteen(dev, {
    track: 1, start: 0, phrases, stepsOf: (p) => ph.toSteps(p, 64), nstep: 64, depth: 5,
  });
  assert.equal(res.taken.length, 16);
  for (let k = 0; k < 16; k++) assert.equal(dev.tracks[1].entries[k].value, res.taken[k].id + 1);
  assert.equal(dev.patterns.filter((p) => p.len).length, 16);

  // sending the same sixteen again reuses every pattern
  const again = await writer.writeSixteen(dev, {
    track: 1, start: 0, phrases, stepsOf: (p) => ph.toSteps(p, 64), nstep: 64, depth: 5,
  });
  assert.equal(again.taken.filter((x) => x.created).length, 0);
  assert.equal(dev.patterns.filter((p) => p.len).length, 16, "still sixteen patterns");
  pass++; console.log("  ok  writeSixteen fills A-P and reuses them on the second send");
})();

await (async () => {
  const dev = fakeDevice();
  const res = await writer.writeSixteen(dev, {
    track: 5, start: 0, phrases: [{ n: "x", l: 1, s: [[[60, 100, 0]]] }], stepsOf: (p) => ph.toSteps(p, 64), nstep: 64, depth: 5,
  }).catch((e) => e);
  assert.ok(res instanceof Error, "a track the unit does not report is refused");
  pass++; console.log("  ok  a track beyond the unit's own count is refused");
})();

await (async () => {
  const dev = fakeDevice({ free: 0 });
  const err = await writer.writeEntry(dev, { track: 0, entry: 0, steps: stepsOf4(), nstep: 64, depth: 5 }).catch((e) => e);
  assert.match(err.message, /pool is full/);
  assert.equal(dev.calls.length, 0, "it says no without touching the unit");
  pass++; console.log("  ok  a full pool is refused and nothing is written");
})();

await (async () => {
  const dev = fakeDevice();
  await writer.writeEntry(dev, { track: 0, entry: 0, steps: stepsOf4(), nstep: 64, depth: 5 });
  const rest = ph.restStep();
  await writer.silenceTrack(dev, { track: 0, nstep: 64, depth: 5, rest });
  for (let i = 0; i < 64; i++) assert.equal(dev.steps.get(`0:${i}`).time, fel.ST.REST);
  assert.equal(dev.tracks[0].entries[0].value, 1, "silencing leaves the entry alone");
  pass++; console.log("  ok  silenceTrack writes rests and keeps the pattern");
})();

t("the block rule is still the pool's own: T1-T4 only", () => {
  assert.equal(skiff.blockOf(4), null);
  assert.deepEqual(skiff.blockOf(3), { base: 48, lo: 49, hi: 64 });
});

console.log(`\n${pass} checks passed`);
