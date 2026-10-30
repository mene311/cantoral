# Cantoral

A browser page that pushes the **Renoise phrase library** into the **M-VAVE FM-1**'s
sequencer. Pick a phrase, see it, hear it, write it into a track's entry.

**▶ Live:** https://mene311.github.io/cantoral/

Vanilla JS + Web MIDI, no build step, no dependencies. 550 phrases / 28 folders load
as JSON straight from the repo — nothing to install, nothing to run.

**Firmware:** the write path is the **Skiff / Felucca editor protocol** (pool `78`,
list `79`, `TRACK_STEP 30`), so it needs a unit on Skiff 2.0 or a Felucca build with
the pool. The app reads the unit's own `INFO` and says so if the firmware is older.
Stock and FM-1+VA firmware have no pool at all — [Timón](https://github.com/mene311/timon)
and [FM-1 Pulses](https://github.com/mene311/fm1-pulses) cover those.

## Using it

```bash
python3 -m http.server 8080   # Web MIDI needs a secure context: https or localhost
```

1. Plug the FM-1 into USB and press **connect**. The line under the header turns into
   the firmware's own version, its track count and step count.
2. Pick a folder (or **All**, or search by name), then a phrase. `←` `→` walk the list.
3. **▶ Play** sends the phrase to the unit on the destination track's channel — nothing
   is written. `BPM` sets the audition speed. A pass runs to the **end of the bar** the
   last note lands in (`loop 16` / `loop all 64`, and the dashed line on the roll), so the
   air after the phrase is heard instead of the loop clipping the bar — most phrases end
   mid-bar at 49 or 61 of 64 steps. Holds are honoured too: a tied note is not released
   until the next note or rest.
4. **Push phrase →** writes it into the entry you picked (Track / Entry). An entry that
   already holds a pattern is **overwritten in place**; an empty one takes a free pool
   pattern. The pool readout tells you what each track is on and how many patterns are free.
5. **Send 16** takes the sixteen phrases from the current one onward and fills the
   track's entries A–P — a program bank you can select from the unit's front panel.

The unit refuses writes while it is **playing**: press PLAY to stop it (SEQ off, not
just STOP is not enough on every build — the app repeats the unit's own refusal).

## What a phrase becomes

Both sides run on a **1/16 grid**, so a Renoise line is one FM-1 step. Nothing is
re-timed.

| Renoise phrase | FM-1 step |
|---|---|
| a line with notes (up to 4 per line in the whole library) | a NOTE step, up to 4 notes |
| a note held across lines (no OFF, no new note) | a TIE step — the firmware stretches the sounding note |
| an OFF, or silence | a REST |
| Volume column (00–FF, `80` = unity) | step velocity, so the phrase keeps its balance |
| Delay column (00–FF within the line) | the step's **NUDGE**, scaled into half a step at most — off by default ("follow Renoise delay") |
| 32- or 64-line phrases | 64-step patterns (the tail is written as rests, which silences what was there) |

Phrases authored at LPB 8 (1/32) are halved onto the 1/16 grid on export — 30 of the
550, all in the dubstep/wub/FM-1 packs and one Original.

## The bank

`bank/<folder>.json` is generated from the Renoise phrase presets by
`tools/xrnz2bank.py`; `bank/index.json` is the list of folders. Re-export any time:

```bash
python3 tools/xrnz2bank.py                       # from ~/.local/share/Renoise/User Library/Phrases
python3 tools/xrnz2bank.py --src /path --out bank
```

Compact on purpose: a rest is `null`, a hold is `"t"`, a note is `[pitch, vel, delay]`.
All 550 phrases are 244 KB together, so a folder loads instantly on a phone.

**Provenance** — the phrase library, in the library's own words:

- `13_Classics` (123): public-domain **Bach chorale** melodies, taken from the
  infinite-bach corpus (jsbchorales.net movement codes, titles via Riemenschneider /
  DCMLab), melody line extracted and converted.
- `19_PD_Ragtime` (10): **Scott Joplin**, public-domain Mutopia transcriptions.
- everything else (417): original, made with the builders in
  `~/Projects/renoise/tools/phrases/` — planets/elements/seasons/nature/moods, bass
  lines, arps, chords, rhythms, riffs, melody ideas, zodiac/weather families, genre
  basslines (reggae, son, boogie, funk/house, Latin, dubstep), dark synth, FM-1 packs.

The Bach and Joplin material is out of copyright and the transcriptions are
public domain; the generated material is the library author's own.

## Files

```
index.html, css/{style,app}.css
js/app.js       the screen: bank browsing, piano roll, audition, the write buttons
js/writer.js    phrases -> pool patterns + entries (reuse-or-create), rests, read-back
js/phrase.js    a bank step -> a device step (velocities, holds, nudge)
js/felucca.js   the editor-protocol codec (from Timón; also used by FM-1 Pulses · Felucca)
js/skiff-write.js  the pool/list writer it came with (bringTrack + the refusal wording)
js/midi.js      Web MIDI transport, sysex request/reply
tools/xrnz2bank.py  the exporter
tests/          node tests: the conversion, the writer against a fake unit, the codec
```

```bash
node tests/mapping.test.mjs   # 14 checks — phrase -> step, writer, refusals
node tests/codec.test.mjs     # 23 checks — the protocol codec
```

The device itself is not simulated away: the writer is tested against a fake unit,
so **a real push is the only proof the hardware takes it**. Do one phrase first.

A third check drives the real page in a headless browser against a **fake FM-1** that
answers the protocol, so the buttons are exercised (connect → push → push again →
send 16 → a refused write while the unit "plays"):

```bash
python3 -m http.server 8099 &
node tests/browser.test.mjs
```
