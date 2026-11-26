import { describe, it, expect } from "vitest";
import { describeHunk, trimHunk } from "../../../src/editing/inlineDiff/hunkDisplay";

describe("trimHunk", () => {
  it("turns a replace that keeps its anchor into a pure insertion", () => {
    const anchor = "the lighthouse keeper.";
    const added = "\n\n## Habits\n- **Early riser**: up before the tide.";
    const display = trimHunk(anchor, anchor + added);

    expect(display).toEqual({
      offset: anchor.length,
      removed: "",
      inserted: added,
      layout: "block",
      kind: "insertion",
    });
  });

  it("shrinks a one-word rewrite to that word, inline", () => {
    const display = trimHunk("one of the oldest towns", "one of the first towns");

    expect(display).toMatchObject({
      offset: "one of the ".length,
      removed: "oldest",
      inserted: "first",
      layout: "inline",
      kind: "replacement",
    });
  });

  it("snaps to word boundaries instead of splitting a word", () => {
    expect(trimHunk("the cat sat", "the cart sat")).toMatchObject({
      removed: "cat",
      inserted: "cart",
    });
    expect(trimHunk("walked home", "talked home")).toMatchObject({
      offset: 0,
      removed: "walked",
      inserted: "talked",
    });
  });

  it("reports a deletion when nothing is added", () => {
    expect(trimHunk("calm and quiet.", "calm.")).toMatchObject({
      removed: " and quiet",
      inserted: "",
      kind: "deletion",
      layout: "inline",
    });
  });

  it("keeps a full rewrite whole", () => {
    expect(trimHunk("abc", "xyz")).toMatchObject({ offset: 0, removed: "abc", inserted: "xyz" });
  });
});

describe("describeHunk", () => {
  it("counts the added lines for a block", () => {
    expect(describeHunk(trimHunk("a.", "a.\n\n## H\n- one\n- two"))).toBe("Addition, 3 lines");
  });

  it("names an inline change without a count", () => {
    expect(describeHunk(trimHunk("a cat", "a dog"))).toBe("Replacement");
  });
});
