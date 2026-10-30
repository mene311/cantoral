#!/usr/bin/env python3
"""Renoise phrase presets (.xrnz, plain XML) -> a JSON bank for the browser app.

One line of a phrase = one step, because both sides run on a 1/16 grid:
Renoise LPB 4 is 1 line per 16th, and the FM-1's sequencer steps are 1/16.
Phrases authored at LPB 8 (1/32 lines) are halved: only even lines survive,
which is the only lossless thing to do when a 1/32 grid has to fit 1/16.

What a step can carry, and where it comes from:

  line with notes           -> NOTE step, up to 4 notes (Skiff's per-step limit)
  note held over from an earlier line, an OFF or a fresh note ends it
                            -> TIE step (the firmware stretches the sounding note)
  nothing sounding          -> REST

  Renoise Volume 00-FF      -> step velocity, 80 (unity) = 100, so a phrase keeps its balance
  Renoise Delay  00-FF      -> kept as an integer 0-255; the app decides whether
                               to turn it into the device's NUDGE (it is scaled
                               on a half-step at most, so nothing drags)

Output: bank/<folder>.json + bank/index.json. No dependencies.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import xml.etree.ElementTree as ET
from collections import OrderedDict
from typing import Any

NOTES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
DEFAULT_SRC = "~/.local/share/Renoise/User Library/Phrases"
TITLES = {
    "00_Originals": "Originals",
    "01_Planets": "Planets",
    "02_Elements": "Elements",
    "03_Seasons": "Seasons",
    "04_Nature": "Nature",
    "05_Moods": "Moods",
    "06_Bass_Lines": "Bass lines",
    "07_Arpeggios": "Arpeggios",
    "08_Chords": "Chords",
    "09_Rhythms_Syncopation": "Rhythms & syncopation",
    "10_FX_Texture": "FX & texture",
    "11_Riffs_Motifs": "Riffs & motifs",
    "12_Melody_Ideas": "Melody ideas",
    "13_Classics": "Classics — Bach chorales",
    "14_Dark_Synth": "Dark synth",
    "15_Latin": "Latin",
    "16_RnB_Dark": "Dark R&B",
    "17_Happy": "Happy",
    "18_Wild": "Wild",
    "19_PD_Ragtime": "Ragtime — Joplin",
    "22_Reggae_Roots": "Reggae roots",
    "23_Salsa_Son": "Salsa / son",
    "24_Boogie_Blues": "Boogie & blues",
    "25_Zodiac": "Zodiac",
    "26_Weather": "Weather",
    "27_Dubstep_Bass": "Dubstep bass",
    "28_Theme_Basslines": "Theme basslines",
    "29_Wub_Triggers": "Wub triggers",
    "30_Funk_House": "Funk & house",
    "31_FM1_MVAVE": "FM-1 / M-VAVE",
}


def pitch(text: str) -> int | None:
    """'C-4' -> 60. Renoise numbers C-4 as 48, MIDI numbers it 60."""
    s = (text or "").strip()
    if not s or s in ("OFF", "---") or s[0] not in NOTES:
        return None
    name = NOTES[s[:2]] if len(s) > 1 and s[1] == "#" else NOTES[s[0]]
    try:
        octave = int(s[-1])
    except ValueError:
        return None
    return name + (octave + 1) * 12


def read_phrase(path: str) -> dict[str, Any] | None:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        print(f"  ! {os.path.basename(path)}: {exc}", file=sys.stderr)
        return None
    lpb = int(root.findtext("LinesPerBeat", "4") or 4)
    if lpb not in (4, 8):
        return None                       # nothing else exists in the library today
    stride = lpb // 4                     # 8 -> 2: keep every second line
    lines = root.find("Lines")
    if lines is None:
        return None

    rows: list[tuple[list[list[int]], bool]] = []   # (notes[pitch,vel,delay], has_off)
    for line in lines:
        notes, off = [], False
        for nc in line.iter("NoteColumn"):
            raw = nc.findtext("Note", "")
            if (raw or "").strip() == "OFF":
                off = True
                continue
            p = pitch(raw)
            if p is None:
                continue
            vol = nc.findtext("Volume") or "80"
            dly = nc.findtext("Delay") or "00"
            try:
                # Renoise's volume column is 00-FF with 80 = unity (0-200%), so 80 must land on 100.
                vel = max(1, min(127, round(int(vol, 16) / 128 * 100)))
            except ValueError:
                vel = 100
            try:
                delay = int(dly, 16)
            except ValueError:
                delay = 0
            notes.append([p, vel, delay])
        rows.append((notes, off))

    if stride > 1:
        rows = rows[::stride]

    steps: list[Any] = []
    sounding = False
    for notes, off in rows:
        if notes:
            steps.append(notes)           # a NOTE retriggers: the TIE chain just ends here
            sounding = True
        elif off:
            steps.append(None)            # explicit release
            sounding = False
        elif sounding:
            steps.append("t")             # hold: the firmware stretches the sounding note
        else:
            steps.append(None)
    while steps and steps[-1] in (None, "t"):
        steps.pop()
    if not steps:
        return None
    used = max(i + 1 for i, s in enumerate(steps) if isinstance(s, list))
    return {"n": os.path.splitext(os.path.basename(path))[0], "l": used, "s": steps}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bank"))
    args = ap.parse_args()
    src = os.path.expanduser(args.src)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    folders: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()
    for name in sorted(os.listdir(src)):
        d = os.path.join(src, name)
        if not os.path.isdir(d):
            continue
        items = []
        for f in sorted(os.listdir(d)):
            if f.endswith(".xrnz"):
                ph = read_phrase(os.path.join(d, f))
                if ph:
                    items.append(ph)
        if items:
            folders[name] = items

    index = []
    total = 0
    for name, items in folders.items():
        path = os.path.join(out, f"{name}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(items, fh, separators=(",", ":"), ensure_ascii=False)
        total += len(items)
        index.append({"id": name, "title": TITLES.get(name, name.split("_", 1)[-1].replace("_", " ")), "count": len(items)})
        print(f"  {name:26} {len(items):4} phrases  {os.path.getsize(path) // 1024:4} KB")

    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"folders": index, "total": total, "grid": "1/16", "source": "Renoise phrase presets (.xrnz)"},
                  fh, separators=(",", ":"), ensure_ascii=False)
    print(f"\n{total} phrases in {len(folders)} folders -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
