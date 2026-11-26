import { describe, expect, it } from "vitest";
import { formatNoteAttachment, NOTE_ATTACHMENT_ROLE } from "../../../src/api/contextFormatting";
import { NOTE_ATTACHMENT_WRAPPER_CHARS } from "../../../src/shared/tokenEstimation";
import type { NoteAttachment } from "../../../src/shared/types";

function note(filePath: string, content: string): NoteAttachment {
  return {
    type: "note",
    id: "n1",
    filePath,
    fileName: filePath,
    content,
    truncated: false,
    mtimeSnapshot: 0,
  };
}

describe("formatNoteAttachment", () => {
  it("wraps the note in a closed element carrying its path, role, and body", () => {
    expect(formatNoteAttachment(note("Lore/The Fold.md", "Body text."))).toBe(
      [
        '<attached_note path="Lore/The Fold.md">',
        NOTE_ATTACHMENT_ROLE,
        "<content>",
        "Body text.",
        "</content>",
        "</attached_note>",
      ].join("\n"),
    );
  });

  it("uses no --- separator, so a note's own frontmatter fence stays unambiguous", () => {
    const body = "---\ntags: [lore]\n---\nThe Fold opened.";
    const text = formatNoteAttachment(note("Lore/The Fold.md", body));

    expect(text.replace(body, "")).not.toContain("---");
    expect(text).toContain(`<content>\n${body}\n</content>`);
  });

  it("keeps the token estimate's wrapper allowance equal to the real wrapper", () => {
    const path = "a.md";
    const body = "x";
    const overhead = formatNoteAttachment(note(path, body)).length - path.length - body.length;

    expect(NOTE_ATTACHMENT_WRAPPER_CHARS).toBe(overhead);
  });
});
