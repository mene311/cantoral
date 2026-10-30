# How to work on Cantoral

Cantoral is a tool for one person: the owner of this repository. He is a musician and a PM,
not a developer. Read this before writing anything here, including replies.

## Talk to him like a customer

- Plain language. What changed, what he can now do, what to tap, what is still broken.
- No test counts, no file names, no function names, no protocol numbers, no "commits", no
  "refactor", no jargon. If a sentence would not be said to someone buying the product, it
  does not go in the reply.
- He wants the result and the next thing to try: "open Cantoral, pick Classics, press Push".
- Never explain the machinery unless he asks.
- Assume an expert owner: he has flashed dozens of firmwares on this unit. Never repeat
  standing cautions ("back up first", "you may lose your patterns").
- The one risk that gets stated: bricking. Nothing here flashes firmware — the worst case is
  that a pattern gets overwritten. That gets one short sentence, not a paragraph.

## Prove it the way he will test it

- He tests by using the thing. Before saying something works, open the page and use it.
- "The tests pass" is the floor, not the ceiling. The writer is tested against a fake unit;
  a real push is the only proof the hardware takes it. Say "not tried on the unit yet" when
  that is the truth.
- When reporting a fix: what he should see now, and what to do if he does not see it.

## The app itself

- The unit's vocabulary: one project, six tracks, sixteen patterns A–P, a 64-pattern pool.
- Every control must visibly change something. A knob that does nothing is a bug.
- The screen must always say where you are and where a write is going.
- Both sides run on a 1/16 grid. A Renoise line is a step — do not re-time anything.
- Never write into a second path "for older firmware": say what the unit lacks and stop.
- The phrase bank is generated, never hand-edited: change `tools/xrnz2bank.py` and re-export.

## When something is wrong

- Say it in one line, in his terms: "the push says the unit is playing".
- Fix it, then say how to check it. No apology essays, no post-mortems unless asked.
