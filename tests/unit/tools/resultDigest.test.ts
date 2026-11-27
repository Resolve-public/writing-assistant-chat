import { describe, it, expect } from "vitest";
import {
  boundToolResult,
  captureStepFields,
  DISCOVERY_DIGEST_TOOLS,
  formatAgenticReplayLines,
  formatResultDigest,
  formatStepReplayLine,
  INTERRUPTED_REPLAY_MARKER,
  OMISSION_NOTE_MAX_CHARS,
  omissionRecovery,
  RESULT_TRUNCATION_MARKER,
  TOOL_RESULT_CHAR_LIMIT,
} from "../../../src/tools/resultDigest";
import {
  SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE,
  VAULT_TOOL_NAMES,
} from "../../../src/tools/vault/definition";
import type { AgenticStep } from "../../../src/shared/types";

/**
 * Phase-2 capture contract for the claudecode cold rebuild
 * (ADR-0016).
 * The digest is pointers only, never scores or chunk content; the record is a bounded
 * copy of the full result.
 */

describe("boundToolResult", () => {
  it("stores a result under the cap whole", () => {
    const short = "No results found for query.";
    expect(boundToolResult(short)).toBe(short);
  });

  it("keeps the start and the end of an oversized result around an omission note", () => {
    const big = "H".repeat(1000) + "M".repeat(3000) + "T".repeat(1000);
    const bounded = boundToolResult(big, 2000, "Call read again.");
    const [head, rest] = bounded.split("\n…[");
    const tail = rest.slice(rest.indexOf("]\n") + 2);
    expect(head).toBe("H".repeat(1000));
    expect(tail).toBe("T".repeat(1000));
    expect(bounded).not.toContain("M");
    expect(bounded).toContain(
      "…[3000 of 5000 characters omitted here. This is a copy of the result as it was at " +
        "that point in the conversation. Call read again.]",
    );
    expect(bounded).not.toContain(RESULT_TRUNCATION_MARKER);
  });

  it("snaps both cuts to a nearby line boundary rather than splitting a line", () => {
    const line = (n: number) => `${String(n).padStart(4)}\tline of text number ${n}\n`;
    const big = Array.from({ length: 400 }, (_, i) => line(i + 1)).join("");
    const bounded = boundToolResult(big, 2000, "Call read again.");
    const [head, rest] = bounded.split("…[");
    const tail = rest.slice(rest.indexOf("]\n") + 2);
    expect(head.endsWith("\n")).toBe(true);
    expect(big.startsWith(head)).toBe(true);
    expect(big.endsWith(tail)).toBe(true);
    expect(tail.startsWith(" ")).toBe(true);
    expect(tail).toMatch(/^\s*\d+\tline of text number \d+\n/);
  });

  it("keeps a result exactly at the limit whole (no note)", () => {
    const exact = "y".repeat(TOOL_RESULT_CHAR_LIMIT);
    expect(boundToolResult(exact)).toBe(exact);
  });

  it("honors a caller-supplied limit", () => {
    const content = "a".repeat(800);
    expect(boundToolResult(content, 1000)).toBe(content);
    expect(boundToolResult(content, 500)).toContain("characters omitted here");
  });
});

describe("omissionRecovery", () => {
  it("points a whole-note read back at the same path or at get_outline and a section", () => {
    expect(omissionRecovery("read", { path: "Drafts/Chapter 3.md" })).toBe(
      'For the current text, call read with path "Drafts/Chapter 3.md", or call ' +
        "get_outline on it and read only the section you need with a headingPath.",
    );
  });

  it("points a section read back at the same section", () => {
    expect(
      omissionRecovery("read", { path: "Drafts/Chapter 3.md", headingPath: "Act I > The Duel" }),
    ).toBe(
      'For the current text, call read with path "Drafts/Chapter 3.md" and headingPath ' +
        '"Act I > The Duel".',
    );
  });

  it("refers to an argument too long to quote as the same one instead of clipping it", () => {
    const longPath = "a/".repeat(600) + "note.md";
    const recovery = omissionRecovery("read", { path: longPath });
    expect(recovery).toContain("call read with the same path");
    expect(recovery.length).toBeLessThanOrEqual(OMISSION_NOTE_MAX_CHARS);
  });

  it("names the tool for any other tool", () => {
    expect(omissionRecovery("search_content", { query: "oath" })).toBe(
      "Call search_content again if you need the omitted part.",
    );
  });
});

describe("formatResultDigest, semantic_search four-outcome contract (section A.1)", () => {
  it("invalid-args: a blank-query failure digests as FAILED with the first sentence", () => {
    // The handler's blank-query failure (toolFailure invalid-args).
    const content = "Error: query is required. check the arguments against the tool's schema and retry.";
    expect(formatResultDigest("semantic_search", { query: "  " }, { content, isError: true })).toBe(
      '[semantic_search: "", FAILED: query is required]',
    );
  });

  it("unavailable: a no-backend failure digests as FAILED with the curated first sentence", () => {
    const content = SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE["no-backend"];
    const digest = formatResultDigest("semantic_search", { query: "Mira's oath" }, { content, isError: true });
    expect(digest).toBe(
      '[semantic_search: "Mira\'s oath", FAILED: Semantic search did not run: no embedding model ' +
        "is configured, so this vault has no semantic index and one cannot be built]",
    );
  });

  it("empty result: ran fine, found nothing, digests as no results", () => {
    const content =
      'No results found for query: "oath". Retry once with a more specific query, or use search_content for an exact-string lookup.';
    expect(formatResultDigest("semantic_search", { query: "oath" }, { content })).toBe(
      '[semantic_search: "oath", no results]',
    );
  });

  it("hits: digests as pointers only (path > heading), never scores or chunk content", () => {
    const content =
      'Search results for: "oath"\n\n' +
      "[Chapters/ch1.md > Vows] (score: 0.812)\nMira swore the oath at dawn.\n\n" +
      "[Chapters/ch2.md] (score: 0.771)\nThe oath was later broken.";
    expect(formatResultDigest("semantic_search", { query: "oath" }, { content })).toBe(
      '[semantic_search: "oath", surfaced: Chapters/ch1.md > Vows; Chapters/ch2.md]',
    );
  });
});

describe("formatResultDigest hit bounds (section A.1)", () => {
  it("caps at 8 pointers, ~500 chars, and never leaks scores or chunk content", () => {
    const blocks: string[] = ['Search results for: "wide"', ""];
    for (let i = 0; i < 12; i++) {
      blocks.push(`[Chapters/really-long-chapter-name-number-${i}.md > A Fairly Long Heading ${i}] (score: 0.${i}00)`);
      blocks.push(`Secret chunk body ${i} that must never appear in the digest.`);
      blocks.push("");
    }
    const digest = formatResultDigest("semantic_search", { query: "wide" }, { content: blocks.join("\n") })!;

    expect(digest).not.toContain("score");
    expect(digest).not.toContain("Secret chunk body");
    // At most 8 pointers listed (pointers are "; "-separated inside "surfaced: ").
    const surfaced = digest.slice(digest.indexOf("surfaced: ") + "surfaced: ".length, -1);
    const pointers = surfaced.split("; ").filter((p) => p !== "…");
    expect(pointers.length).toBeLessThanOrEqual(8);
    expect(digest.length).toBeLessThanOrEqual(560);
  });
});

describe("formatResultDigest, the other discovery tools (same shape)", () => {
  it("search_files hits digest as its matched paths", () => {
    const content = 'Notes matching "*oath*" in vault (2):\nChapters/ch1.md\nChapters/ch2.md';
    expect(formatResultDigest("search_files", { pattern: "*oath*" }, { content })).toBe(
      '[search_files: "*oath*", surfaced: Chapters/ch1.md; Chapters/ch2.md]',
    );
  });

  it("get_links narrowed to one direction digests as that direction's paths", () => {
    const content = 'Notes linking to "Characters/Mira.md" (2):\nChapters/ch1.md\nChapters/ch3.md';
    expect(formatResultDigest("get_links", { path: "Characters/Mira.md" }, { content })).toBe(
      '[get_links: "Characters/Mira.md", surfaced: Chapters/ch1.md; Chapters/ch3.md]',
    );
  });

  // D7's recorded consequence: the outgoing direction now earns a replay digest it did
  // not have, because only get_backlinks was in DISCOVERY_DIGEST_TOOLS. Its empty
  // sentence opens with a quote rather than "No ", so the no-pointer fallback is what
  // has to catch it.
  it("get_links digests the outgoing direction, which had no digest before the merge", () => {
    const hits = 'Notes "Scenes/Act 1.md" links to (1):\nCharacters/Mira.md';
    expect(formatResultDigest("get_links", { path: "Scenes/Act 1.md" }, { content: hits })).toBe(
      '[get_links: "Scenes/Act 1.md", surfaced: Characters/Mira.md]',
    );
    const empty =
      '"Scenes/Act 1.md" has no outgoing links. This note links to no other notes; nothing to follow up.';
    expect(formatResultDigest("get_links", { path: "Scenes/Act 1.md" }, { content: empty })).toBe(
      '[get_links: "Scenes/Act 1.md", no results]',
    );
  });

  // The two-section shape is the one the generic "opens with No " empty check gets
  // wrong: an empty incoming direction opens the content while outgoing carries hits.
  it("get_links with both directions digests every section's paths, distinct", () => {
    const both =
      'Notes linking to "Characters/Mira.md" (2):\nChapters/ch1.md\nChapters/ch3.md\n\n' +
      'Notes "Characters/Mira.md" links to (2):\nChapters/ch1.md\nLore/Fold.md';
    expect(formatResultDigest("get_links", { path: "Characters/Mira.md" }, { content: both })).toBe(
      '[get_links: "Characters/Mira.md", surfaced: Chapters/ch1.md; Chapters/ch3.md; Lore/Fold.md]',
    );

    const incomingEmpty =
      'No notes link to "Characters/Mira.md". This note has no incoming wikilinks; nothing to follow up.\n\n' +
      'Notes "Characters/Mira.md" links to (1):\nLore/Fold.md';
    expect(
      formatResultDigest("get_links", { path: "Characters/Mira.md" }, { content: incomingEmpty }),
    ).toBe('[get_links: "Characters/Mira.md", surfaced: Lore/Fold.md]');

    const bothEmpty =
      'No notes link to "Characters/Mira.md". This note has no incoming wikilinks; nothing to follow up.\n\n' +
      '"Characters/Mira.md" has no outgoing links. This note links to no other notes; nothing to follow up.';
    expect(
      formatResultDigest("get_links", { path: "Characters/Mira.md" }, { content: bothEmpty }),
    ).toBe('[get_links: "Characters/Mira.md", no results]');
  });

  it("find_notes_by_tag hits digest as the tagged paths", () => {
    const content = 'Notes tagged "#oath" (1):\nChapters/ch1.md';
    expect(formatResultDigest("find_notes_by_tag", { tag: "#oath" }, { content })).toBe(
      '[find_notes_by_tag: "#oath", surfaced: Chapters/ch1.md]',
    );
  });

  it("search_content hits digest as the distinct matched paths (grep + context shapes)", () => {
    const grep = 'Matches for text "oath" (2):\nChapters/ch1.md:12: he swore an oath\nChapters/ch1.md:40: the oath held';
    expect(formatResultDigest("search_content", { query: "oath" }, { content: grep })).toBe(
      '[search_content: "oath", surfaced: Chapters/ch1.md]',
    );
    const withContext = 'Matches for text "oath" (1):\n[Chapters/ch2.md]\n> 5: the oath';
    expect(formatResultDigest("search_content", { query: "oath" }, { content: withContext })).toBe(
      '[search_content: "oath", surfaced: Chapters/ch2.md]',
    );
  });

  it("an empty result on any discovery tool digests as no results", () => {
    expect(
      formatResultDigest("search_files", { pattern: "*none*" }, {
        content: 'No notes found matching pattern "*none*" in vault. Loosen the glob.',
      }),
    ).toBe('[search_files: "*none*", no results]');
  });
});

describe("formatResultDigest, non-discovery tools get no digest", () => {
  it("returns undefined for path -> content and mutation tools", () => {
    for (const name of ["read", "list_directory", "move", "edit"]) {
      expect(formatResultDigest(name, { path: "x.md" }, { content: "anything" })).toBeUndefined();
    }
  });

  // D1 point 19 (a merge that changes a result's shape has to find what parses that
  // shape), asked of `read` rather than reasoned about. The merged tool's two pathways
  // differ in their header line, `[path]` against `[path > headingPath]`, and this file
  // holds the only bracket-header parsers in the tree. Both pathways' real bytes are
  // fed through the digest entry point here: neither reaches an extractor, because
  // `read` is not a discovery tool, so the shape difference has no consumer.
  it("neither read pathway reaches a pointer extractor, header line or not", () => {
    const whole = "[Book.md]\n\n1\t# Act I\n2\tintro";
    const section = "[Book.md > Act I > Chapter 1]\n\n3\t## Chapter 1\n4\tthe duel was fierce";
    for (const content of [whole, section]) {
      expect(formatResultDigest("read", { path: "Book.md" }, { content })).toBeUndefined();
      expect(captureStepFields("read", { path: "Book.md" }, { content }).resultDigest)
        .toBeUndefined();
    }
  });

  // The same question asked of the two gated merges. `move` and `trash` differ between
  // their pathways only in the acknowledgement's verb, and nothing parses that string,
  // so the answer is again "no consumer". The half of their result that *is* structured,
  // the emitted VaultOperation, changes shape between pathways (a folder move carries no
  // fingerprint, a folder trash no snapshot) and every reader of it switches on the
  // typechecked `kind`, so tsc is that half's parser and no test can add to it.
  it("neither pathway of move or trash reaches a pointer extractor", () => {
    const results: Array<[string, Record<string, unknown>, string]> = [
      ["move", { from: "A.md", to: "B.md" }, 'Move "A.md" → "B.md" queued for review.'],
      ["move", { from: "A", to: "B" }, 'Move folder "A" → "B" queued for review.'],
      ["trash", { path: "A.md" }, 'Trash "A.md" queued for review.'],
      ["trash", { path: "A" }, 'Trash folder "A" queued for review.'],
    ];
    for (const [name, args, content] of results) {
      expect(formatResultDigest(name, args, { content })).toBeUndefined();
      expect(captureStepFields(name, args, { content }).resultDigest).toBeUndefined();
    }
  });
});

describe("captureStepFields", () => {
  it("carries a reviewed op's disposition (a decline is otherwise invisible)", () => {
    expect(
      captureStepFields(
        "create_directory",
        { path: "Drafts/Arcs" },
        { content: "Declined by user, \"Drafts/Arcs\" was not changed.", isError: false, disposition: "declined" },
      ),
    ).toMatchObject({ disposition: "declined" });
  });

  it("captures each disposition value the review can return", () => {
    for (const disposition of ["applied", "declined", "failed", "auto-applied", "satisfied"] as const) {
      expect(
        captureStepFields("move", { from: "a", to: "b" }, { content: "outcome text", disposition }),
      ).toMatchObject({ disposition });
    }
  });

  it("captures a digest + bounded record for a discovery result", () => {
    const content = 'Search results for: "oath"\n\n[Chapters/ch1.md] (score: 0.9)\nbody';
    const fields = captureStepFields("semantic_search", { query: "oath" }, { content });
    expect(fields.resultDigest).toBe('[semantic_search: "oath", surfaced: Chapters/ch1.md]');
    expect(fields.resultRecord).toBe(content);
    expect(fields.disposition).toBeUndefined();
  });

  it("bounds the stored record of an oversized result with the tool's recovery", () => {
    const big = "z".repeat(TOOL_RESULT_CHAR_LIMIT + 500);
    const fields = captureStepFields("read", { path: "big.md" }, { content: big });
    expect(fields.resultRecord).toBe(
      boundToolResult(big, TOOL_RESULT_CHAR_LIMIT, omissionRecovery("read", { path: "big.md" })),
    );
    expect(fields.resultRecord).toContain('call read with path "big.md"');
    expect(fields.resultDigest).toBeUndefined();
  });

  it("bounds the record at the length it is given", () => {
    const content = "q".repeat(3000);
    const whole = captureStepFields("read", { path: "a.md" }, { content }, 5000);
    expect(whole.resultRecord).toBe(content);
    const cut = captureStepFields("read", { path: "a.md" }, { content }, 1000);
    expect(cut.resultRecord).toContain("2000 of 3000 characters omitted here");
  });

  it("returns nothing for a call with no content, disposition, or digest", () => {
    expect(captureStepFields("think", {}, { content: "" })).toEqual({});
  });

  it("captures exact ask guidance beside the bounded generic result record", () => {
    const args = {
      questions: [{
        question: "Which areas should I cover?",
        header: "Coverage",
        options: [
          { label: "Testing", description: "Cover test design." },
          { label: "Migration", description: "Cover migration concerns." },
        ],
        multiSelect: true,
      }],
    };
    const content = JSON.stringify({
      answers: {
        "Which areas should I cover?": [
          "Testing",
          "Also include \"accessibility\"\n[failure; modes]",
        ],
      },
    });

    expect(captureStepFields("ask_user", args, { content })).toEqual({
      resultDigest:
        '[ask_user guidance: {"questions":[{"question":"Which areas should I cover?",' +
        '"header":"Coverage","answer":["Testing",' +
        '"Also include \\"accessibility\\"\\n[failure; modes]"]}]}]',
      resultRecord: content,
      askGuidance: {
        questions: [{
          question: "Which areas should I cover?",
          header: "Coverage",
          answer: ["Testing", "Also include \"accessibility\"\n[failure; modes]"],
        }],
      },
    });
  });

  it("does not derive ask guidance from a failed or malformed ask result", () => {
    const args = {
      questions: [{
        question: "Choose?",
        header: "Choice",
        options: [
          { label: "First", description: "Choose first." },
          { label: "Second", description: "Choose second." },
        ],
        multiSelect: false,
      }],
    };
    const failed = captureStepFields("ask_user", args, {
      content: "Error: cancelled.",
      isError: true,
    });
    const malformed = captureStepFields("ask_user", args, {
      content: '{"answers":{"Choose?":[]}}',
    });

    expect(failed.askGuidance).toBeUndefined();
    expect(failed.resultDigest).toBeUndefined();
    expect(malformed.askGuidance).toBeUndefined();
    expect(malformed.resultDigest).toBeUndefined();
  });
});

/**
 * Phase-3 replay line formatting (section 4.A): the persisted capture fields become the
 * compact bracketed lines a cold rebuild replays under each assistant turn.
 */
describe("formatStepReplayLine", () => {
  it("returns null for a reasoning step (no tool to record)", () => {
    expect(formatStepReplayLine({ type: "reasoning", round: 0, text: "thinking" })).toBeNull();
  });

  it("returns null for a tool_call step missing its tool name", () => {
    expect(formatStepReplayLine({ type: "tool_call", round: 0 })).toBeNull();
  });

  it("renders a captured read as tool + key argument", () => {
    expect(
      formatStepReplayLine({
        type: "tool_call",
        round: 0,
        toolName: "read",
        toolInput: "Chapters/chapter-3.md",
        resultRecord: "the chapter text",
      }),
    ).toBe("[read: Chapters/chapter-3.md]");
  });

  it("renders just the tool name when there is no key argument", () => {
    expect(
      formatStepReplayLine({ type: "tool_call", round: 0, toolName: "think", resultRecord: "a thought" }),
    ).toBe("[think]");
  });

  it("returns null for a bare pre-phase-2 step (no capture fields): old transcripts replay unchanged", () => {
    expect(
      formatStepReplayLine({ type: "tool_call", round: 0, toolName: "read", toolInput: "a.md" }),
    ).toBeNull();
  });

  it("appends a declined disposition as the steering signal", () => {
    expect(
      formatStepReplayLine({
        type: "tool_call",
        round: 0,
        toolName: "create_directory",
        toolInput: "Drafts/Arcs",
        disposition: "declined",
      }),
    ).toBe("[create_directory: Drafts/Arcs, DECLINED by user]");
  });

  it("labels every disposition value the review can return", () => {
    const cases: Record<NonNullable<AgenticStep["disposition"]>, string> = {
      applied: "[move: a, applied]",
      "auto-applied": "[move: a, auto-applied]",
      declined: "[move: a, DECLINED by user]",
      failed: "[move: a, FAILED]",
      satisfied: "[move: a, already satisfied]",
      cancelled: "[move: a, CANCELLED before review]",
    };
    for (const [disposition, expected] of Object.entries(cases)) {
      expect(
        formatStepReplayLine({
          type: "tool_call",
          round: 0,
          toolName: "move",
          toolInput: "a",
          disposition: disposition as AgenticStep["disposition"],
        }),
      ).toBe(expected);
    }
  });

  it("uses the precomputed discovery digest verbatim (pointers only)", () => {
    const resultDigest = '[semantic_search: "oath", surfaced: Chapters/ch1.md > Vows]';
    expect(
      formatStepReplayLine({
        type: "tool_call",
        round: 0,
        toolName: "semantic_search",
        toolInput: "oath",
        resultDigest,
      }),
    ).toBe(resultDigest);
  });
});

describe("formatAgenticReplayLines", () => {
  it("emits one line per tool_call step, in order, skipping reasoning steps", () => {
    const steps: AgenticStep[] = [
      { type: "reasoning", round: 0, text: "let me look" },
      { type: "tool_call", round: 0, toolName: "read", toolInput: "Chapters/ch3.md", resultRecord: "text" },
      {
        type: "tool_call",
        round: 1,
        toolName: "semantic_search",
        toolInput: "oath",
        resultDigest: '[semantic_search: "oath", no results]',
      },
      {
        type: "tool_call",
        round: 1,
        toolName: "create_directory",
        toolInput: "Drafts/Arcs",
        disposition: "declined",
      },
    ];
    expect(formatAgenticReplayLines(steps)).toEqual([
      "[read: Chapters/ch3.md]",
      '[semantic_search: "oath", no results]',
      "[create_directory: Drafts/Arcs, DECLINED by user]",
    ]);
  });

  it("returns an empty array when no step records a tool call", () => {
    expect(formatAgenticReplayLines([{ type: "reasoning", round: 0, text: "hmm" }])).toEqual([]);
  });
});

describe("INTERRUPTED_REPLAY_MARKER", () => {
  it("is the marker resolution C appends to an aborted turn", () => {
    expect(INTERRUPTED_REPLAY_MARKER).toBe("[response interrupted by user]");
  });
});

/**
 * Drift guard for DISCOVERY_DIGEST_TOOLS.
 *
 * A rename that misses this set silently drops that tool's replay digest: the call
 * still runs, the timeline still renders, and only a Claude Code cold rebuild is worse
 * off, which is the one consumer nobody exercises by hand (ADR-0016). Nothing else
 * fails, so this is the guard.
 */
describe("DISCOVERY_DIGEST_TOOLS drift guard", () => {
  it("names only advertised read tools", () => {
    for (const name of DISCOVERY_DIGEST_TOOLS) {
      expect(
        VAULT_TOOL_NAMES.has(name),
        `DISCOVERY_DIGEST_TOOLS names "${name}", which is not an advertised vault read tool`,
      ).toBe(true);
    }
  });

  // Every member must reach a live pointer-extraction branch. A renamed tool left in
  // the set but dropped from digestKeyArg / extractPointers would still be "covered" by
  // membership alone, so this asserts the extraction actually produces something.
  it("every member digests a representative hit result into pointers", () => {
    const HIT_RESULT: Record<string, string> = {
      semantic_search: "Results:\n[Lore/Fold.md > Origins] (score: 0.81)\nthe fold opened",
      search_content: "Lore/Fold.md:12: the fold opened",
      search_files: 'Files matching "Fold*" (1):\nLore/Fold.md',
      get_links:
        'Notes linking to "Lore/Fold.md" (1):\nScenes/Act 1.md\n\n' +
        'Notes "Lore/Fold.md" links to (1):\nLore/Origins.md',
      find_notes_by_tag: 'Notes tagged "#lore" (1):\nLore/Fold.md',
    };
    const ARGS: Record<string, unknown> = {
      query: "the fold",
      pattern: "Fold*",
      path: "Lore/Fold.md",
      tag: "lore",
    };
    for (const name of DISCOVERY_DIGEST_TOOLS) {
      const sample = HIT_RESULT[name];
      expect(sample, `no representative hit result for "${name}"`).toBeDefined();
      const digest = formatResultDigest(name, ARGS, { content: sample });
      expect(digest, `no digest produced for "${name}"`).toBeDefined();
      expect(digest, `"${name}" digested a hit result as empty`).not.toContain("no results");
      expect(digest).toContain("surfaced:");
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-result image metadata (RFC-0021 D6, ADR-0041). The capture is the one place
// the bytes are dropped, so neither choke point can forget to.
// ---------------------------------------------------------------------------

describe("captureStepFields with tool-result images", () => {
  const STUB =
    "[Art/map.png]\n\nImage: PNG, 1024x768, 240.0 KB, attached as an image block.";

  const image = {
    path: "Art/map.png",
    mimeType: "image/png" as const,
    data: "AQID",
    byteLength: 245760,
    width: 1024,
    height: 768,
  };

  it("records the metadata, drops the bytes, and keeps the stub as the record", () => {
    const fields = captureStepFields(
      "read",
      { path: "Art/map.png" },
      { content: STUB, images: [image] },
    );

    expect(fields.resultImages).toEqual([
      {
        path: "Art/map.png",
        mimeType: "image/png",
        byteLength: 245760,
        width: 1024,
        height: 768,
      },
    ]);
    // The one assertion this whole field exists for.
    expect(JSON.stringify(fields.resultImages)).not.toContain("AQID");
    expect(fields.resultRecord).toBe(STUB);
    // `read` is not a discovery tool, so it earns no pointer digest, image or not.
    expect(fields.resultDigest).toBeUndefined();
  });

  it("omits absent dimensions rather than storing undefined", () => {
    const { data: _data, width: _width, height: _height, ...noDimensions } = image;
    const fields = captureStepFields("read", {}, { content: STUB, images: [noDimensions] });

    expect(fields.resultImages).toEqual([
      { path: "Art/map.png", mimeType: "image/png", byteLength: 245760 },
    ]);
    expect(Object.keys(fields.resultImages?.[0] ?? {})).toEqual([
      "path",
      "mimeType",
      "byteLength",
    ]);
  });

  it("accepts already-stripped metadata, which is what Claude Code hands it", () => {
    const { data: _data, ...record } = image;
    const fields = captureStepFields("read", {}, { content: STUB, images: [record] });

    expect(fields.resultImages).toEqual([record]);
  });

  it("leaves a text result exactly as before", () => {
    const withField = captureStepFields("read", { path: "a.md" }, { content: "text" });
    const withEmpty = captureStepFields("read", { path: "a.md" }, { content: "text", images: [] });

    expect(withField.resultImages).toBeUndefined();
    expect(withEmpty.resultImages).toBeUndefined();
    expect(withField).toEqual({ resultRecord: "text" });
  });
});
