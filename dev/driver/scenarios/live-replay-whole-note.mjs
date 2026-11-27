// Tool results across turns when one section cannot answer (RFC-0022 Stage 0).
//
// The sibling scenario `live-replay-long-note` showed a careful model never trip the bounded
// replay record: it outlined, then read only the section it needed, and every result fit under the
// bound. This one asks a turn-1 question whose answer is spread across three sections, so the cheap
// path is a whole-note read, and then asks on later turns about facts that are past the record's
// head and absent from the turn-1 answer.
//
// What a later turn can do is the measurement: answer correctly from history (the full result
// reached it), re-read (recovery, at a cost), or answer wrongly from the fragment. The facts are
// checkable without trusting the model, since nothing else in the vault mentions them: the
// counts are 112, 111 and 112; the dog in "Market day" is Pell; the storm-week count is smaller
// because a step had cracked.

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

/** A real model, on a real machine, is slower than a scripted one by orders of magnitude. */
const LIVE_TURN_TIMEOUT_MS = 300_000;

const TURNS = [
  "Read the note Chapters/Long.md, then list every count Mara makes of steps or planks, " +
    "in the order they appear in the note. Answer with the numbers only, comma-separated.",
  "In the Market day section of that chapter, what is the name of the baker's dog?",
  "Of the counts you listed earlier, why is the smallest one smaller than the others?",
];

export default {
  id: "live-replay-whole-note",
  description: "Whole-note read, then later turns ask about facts past the replay bound. RFC-0022 Stage 0.",
  vault: "replay-whole-note",
  theme: "dark",
  provider: { kind: "live" },

  async run(app) {
    await app.shot("the model, before the first turn");

    for (const [index, text] of TURNS.entries()) {
      await app.send(text);
      await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);
      await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
      await app.shot(`turn ${index + 1}, settled`);
    }

    await app.shot("the timeline", { selector: CHAT_ROOT });
  },
};
