import type { NoteAttachment } from "../shared/types";
import type { AdditionalContextItem, DocumentContext } from "../shared/chatRequest";

/**
 * Labeled text for context that belongs in the conversation, never the cached
 * system prefix. Note snapshots ride their own (frozen) user turn; the live
 * edit-mode document and extra notes are appended to the latest user turn.
 * Shared across all provider clients so placement and labels stay consistent.
 */

/**
 * Says what an attached note is for. Without it, smaller models read the note as
 * text to quote and propose edits whose replace repeats the search unchanged. It
 * names both uses, because the plugin cannot know whether the user attached a note
 * to change it or to consult it. It stays tool-neutral since it also reaches turns
 * that have no edit tools.
 */
export const NOTE_ATTACHMENT_ROLE =
  "The user attached this note to their message. It is a snapshot taken when the message " +
  "was sent: use it as reference, or edit the note if the request asks for changes.";

/**
 * A frozen note snapshot attached to a user turn. The wrapper is closed, so the model
 * can tell where the note ends, and uses no `---`, which would blur into a note's own
 * frontmatter fence. The body sits in its own element so the role sentence is never
 * mistaken for note text to match against. The body is not escaped: escaping would
 * change the exact text the model copies into an edit's search, and a note containing
 * a literal `</content>` is not a case that has been observed.
 */
export function formatNoteAttachment(note: NoteAttachment): string {
  return [
    `<attached_note path="${note.filePath}">`,
    NOTE_ATTACHMENT_ROLE,
    "<content>",
    note.content,
    "</content>",
    "</attached_note>",
  ].join("\n");
}

/** The live document under edit, re-sent each turn. */
export function formatDocumentContext(doc: DocumentContext): string {
  const label = doc.isFull
    ? `Document to edit (${doc.filePath})`
    : `Current note (${doc.filePath})`;
  return `---\n${label}:\n${doc.content}`;
}

/** A live extra context note (edit mode). */
export function formatAdditionalContextItem(item: AdditionalContextItem): string {
  return `---\nContext note (${item.filePath}):\n${item.content}`;
}

/** Provenance label for an image embedded in an attached note. */
export function noteImageLabel(sourceNotePath: string, fileName: string): string {
  return `Embedded image from attached note (${sourceNotePath}): ${fileName}`;
}

/**
 * Provenance label for an image a tool read returned (RFC-0021 D5). It rides a
 * synthesized `user` message on the OpenAI wire format, because a `tool` message
 * accepts text parts only, so the label has to say whose voice this is: without it
 * the model can read the picture as something the user just sent.
 */
export function toolImageLabel(path: string): string {
  return `Image returned by read for ${path}`;
}
