// Tool results across turns, against a real model (RFC-0022 Stage 0).
//
// Turn 1 reads a long note. Turns 2 and 3 ask about its ending, which sits past the bounded
// replay record, so a later turn can only answer from history if the full result reached it. The
// question this run exists to answer is what the model does then: answers correctly from history,
// re-reads, or answers from the fragment it was replayed.
//
// The answers are checkable without trusting the model: the ferry's name and the last line of
// dialogue appear only in the note's final section, and nothing else in the vault mentions either.
// The persisted messages in each shot's state carry every turn's tool steps, their bounded
// records, and the provider-reported usage, which is the measurement; the pictures are the
// readable form of it.

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

/** A real model, on a real machine, is slower than a scripted one by orders of magnitude. */
const LIVE_TURN_TIMEOUT_MS = 300_000;

// Turn 1 must not let the model restate the ending in its own prose, or a later turn can answer
// from that restatement instead of from the replayed tool result (the first run, 2026-11-27,
// asked for a summary and the summary named the ferry). A section count reads the whole note and
// carries none of the later answers.
const TURNS = [
  "Read the note Chapters/Long.md, then tell me only how many level-two (##) sections it has. " +
    "Answer with the number and nothing else.",
  "In that chapter, what is the name of the ferry Mara boards at the end?",
  "What is the exact last line of dialogue in that chapter? Quote it.",
];

export default {
  id: "live-replay-long-note",
  description: "Read a long note, then ask about its ending on later turns. RFC-0022 Stage 0.",
  vault: "replay-long-note",
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
