/**
 * Bounds on the stored tool-result record, the copy a later turn replays in place of a
 * tool's full result (RFC-0022). Within the turn that ran a tool the model always sees
 * the whole result; this length only decides what it keeps on the turns after.
 *
 * Kept free of imports so both the settings defaults and the pure capture helpers can
 * read it without an import cycle.
 */

/** The default record length, the value every conversation was recorded under before it became a setting. */
export const DEFAULT_TOOL_RESULT_RECORD_CHARS = 2000;

/**
 * Below this, a record is mostly its own omission note: the kept start and end are too
 * short to read as text, so a smaller value only costs a re-read.
 */
export const MIN_TOOL_RESULT_RECORD_CHARS = 500;

/**
 * The ceiling the turn-record validator enforces, so an unbounded string never reaches
 * the conversation record. At roughly 25,000 tokens it is already past the whole context
 * window of the local models this plugin is tuned for, so it never binds a real choice.
 */
export const MAX_TOOL_RESULT_RECORD_CHARS = 100_000;
