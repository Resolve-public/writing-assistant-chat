import type { CanonicalToolDefinition } from "../types";
import { INSERT_WHERES } from "./validation";

// ---------------------------------------------------------------------------
// Write tools, produce EditBlocks for the diff review pipeline
// ---------------------------------------------------------------------------

export const EDIT_TOOL: CanonicalToolDefinition = {
  name: "edit",
  description:
    "Propose a targeted search-and-replace edit to a note. " +
    "Always pass `path`, the vault-relative path of the note to change (an attached note's " +
    "`path`, or the path you read with read). " +
    "The edit is shown to the user for review before being applied. " +
    "The note must already contain the search text, for an empty or brand-new note, " +
    "use write_file to set its initial content instead. " +
    "Use one call per distinct change; a single turn edits one file, edit other files in later turns.",
  strategyHint:
    "targeted search/replace for prose changes in a specific note (`path`). Requires exact text " +
    "from that note, use read first if its content is not already in context. " +
    "For an empty document there is nothing to match; use write_file instead.",
  errorGuidance:
    "If `path` is missing or the file is not found, supply the correct vault-relative path. " +
    "If the search text was not found because the document is empty, switch to write_file to set " +
    "its initial content. If the search text matched more than one place, add the surrounding lines " +
    "so it identifies exactly one passage. Otherwise re-read the document with read and match " +
    "the exact text, including whitespace and dropping read's line-number prefix.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the note to edit (e.g. \"Lore/The Fold.md\"). " +
          "Use an attached note's path or the file you read with read.",
      },
      search: {
        type: "string",
        description:
          "The exact text to find in the document. Match it character-for-character, " +
          "including whitespace and indentation. " +
          "If you copied the passage from read, drop the leading line-number prefix " +
          "(the right-aligned number and the tab after it); match only the line text itself. " +
          "Keep it SHORT, include only the passage being changed plus 2–3 surrounding lines " +
          "for unambiguous matching. Never include large sections or the full document.",
      },
      replace: {
        type: "string",
        description:
          "The text that takes the place of the matched search region: that same passage " +
          "rewritten with your change applied, so it must differ from search. " +
          "Must contain ONLY the new content for that region, not the rest of the document. " +
          "Use an empty string to delete the matched text.",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of what this edit does and why.",
      },
    },
    required: ["path", "search", "replace"],
  },
};

export const UPDATE_FRONTMATTER_TOOL: CanonicalToolDefinition = {
  name: "update_frontmatter",
  description:
    "Add, update, or remove YAML frontmatter properties of a note. Always pass `path`, the " +
    "vault-relative path of the note to change. Put ALL changes into one call. " +
    "Each operation must use action 'set' or 'remove'. Skip properties you want to leave as-is. " +
    "For a multi-value property such as tags or aliases, pass `value` as an array of strings; " +
    "it is written as a real YAML list. " +
    "If the document has no frontmatter, a new block will be created.",
  strategyHint:
    "add, update, or remove YAML frontmatter properties of a specific note (`path`). Batch all changes into a single call.",
  errorGuidance:
    "If `path` is missing or the file is not found, supply the correct vault-relative path. " +
    "If operations are invalid, check the key names and action values (must be 'set' or 'remove').",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the note whose frontmatter to edit (e.g. \"Lore/The Fold.md\").",
      },
      operations: {
        type: "array",
        description: "List of frontmatter changes to apply. Include ALL changes in one call.",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The frontmatter property name.",
            },
            value: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
              description:
                "New value for the property. Required when action is 'set'. " +
                "Pass a string for a single-value property (e.g. status: \"complete\"). " +
                "Pass an ARRAY of strings for a multi-value / list property such as tags " +
                "or aliases (e.g. [\"worldbuilding\", \"lore\"]); each item becomes its own " +
                "YAML list entry. Do not encode a list as a comma-joined string.",
            },
            action: {
              type: "string",
              enum: ["set", "remove"],
              description: "Whether to set or remove the property.",
            },
          },
          required: ["key", "action"],
        },
      },
      explanation: {
        type: "string",
        description: "Brief explanation of the change.",
      },
    },
    required: ["path", "operations"],
  },
};

export const INSERT_INTO_NOTE_TOOL: CanonicalToolDefinition = {
  name: "insert_into_note",
  description:
    "Add new text to an existing note without rewriting it. Always pass `path`, the " +
    "vault-relative path of the note to change, plus `content` (the text to add) and `where`. " +
    "Use `where`: \"after\" or \"before\" to place the text just after/before an existing passage " +
    "(pass that passage as `anchor`); \"append\" to add it at the end of the note, or \"prepend\" " +
    "at the start (no anchor needed). The text is added as its own paragraph, separated by a blank " +
    "line, so put structure (headings, list markers) inside `content` itself. " +
    "The change is shown to the user for review before it is applied. " +
    "Prefer this over write_file (which replaces the whole file) when adding to a note, and over " +
    "edit when you only need to add content rather than rewrite an existing passage.",
  strategyHint:
    "add content to an existing note without rewriting it: append/prepend, or insert before/after " +
    "an `anchor` passage. Prefer it over edit when adding (not changing) text, and over " +
    "write_file for any note that already has content.",
  errorGuidance:
    "If `path` is missing or the file is not found, supply the correct vault-relative path. " +
    "For where \"before\"/\"after\", if the anchor was not found, re-read the note with read and " +
    "copy the anchor exactly (dropping read's line-number prefix), or use \"append\"/\"prepend\" " +
    "which need no anchor.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the note to add to (e.g. \"Journal/2026-06-27.md\"). " +
          "Use an attached note's path or the file you read with read.",
      },
      content: {
        type: "string",
        description:
          "The text to add. It is inserted as its own paragraph (separated by a blank line); " +
          "include any headings or list markers in it yourself.",
      },
      where: {
        type: "string",
        enum: INSERT_WHERES,
        description:
          "Where to place the text: \"after\" or \"before\" an `anchor` passage, " +
          "\"append\" at the end of the note, or \"prepend\" at the start.",
      },
      anchor: {
        type: "string",
        description:
          "For where \"before\"/\"after\": the exact existing passage to place the text next to. " +
          "Match it character-for-character (drop read's line-number prefix). " +
          "Keep it short, a sentence or a heading line. Not used for \"append\"/\"prepend\".",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of what this insertion adds and why.",
      },
    },
    required: ["path", "content", "where"],
  },
};

/** All edit-mode tools, in the order they should appear in the API request. */
export const ALL_EDIT_TOOLS: CanonicalToolDefinition[] = [
  EDIT_TOOL,
  INSERT_INTO_NOTE_TOOL,
  UPDATE_FRONTMATTER_TOOL,
];

/** Set of edit tool names for fast membership checks in the tool loop. */
export const EDIT_TOOL_NAMES = new Set(ALL_EDIT_TOOLS.map((t) => t.name));
