/**
 * Replay-capture helpers for the claudecode cold rebuild (ADR-0016).
 *
 * At the two tool-result choke points (Claude Code's `callTool` end event and the
 * plugin tool loop) we now record, per {@link ../shared/types.AgenticStep}, what a
 * later rebuild needs but the flat prose transcript never held: the real
 * disposition of a reviewed op, a compact pointers-only digest of a discovery
 * result, and a bounded copy of the full result text. Nothing here is sent to the
 * API directly; the cold-rebuild replay digest reads these fields (ADR-0016).
 *
 * Pure: no Obsidian, no disk, so the four-outcome digest contract is
 * unit-testable string by string.
 */

import { assertNever } from "../utils";
import type {
  AgenticStep,
  CompletedAskGuidanceRecord,
  ToolResultImageRecord,
} from "../shared/types";
import type { ToolResultImage } from "./types";
import type { VaultOpDisposition } from "../vault-ops/disposition";
import { ASK_USER_TOOL_NAME } from "./ask/definition";
import { DEFAULT_TOOL_RESULT_RECORD_CHARS } from "./resultRecordBounds";
import {
  deriveAskGuidanceCapture,
  formatAskGuidanceDigest,
} from "./ask/result";

/**
 * Default cap (chars) on a stored full-result record (issue question 9), so vault content
 * riding the conversation JSON stays a bounded, linear footprint rather than duplicating
 * whole notes. The user owns the actual value (`toolResultRecordChars`, RFC-0022).
 */
export const TOOL_RESULT_CHAR_LIMIT = DEFAULT_TOOL_RESULT_RECORD_CHARS;

/**
 * The marker records captured before the omission note ended with. Never written now;
 * kept because persisted conversations still carry it.
 */
export const RESULT_TRUNCATION_MARKER = " …[truncated]";

/**
 * Longest tool argument an omission note quotes back. A longer one is referred to as
 * "the same" argument instead, so the note stays bounded without clipping a path the
 * model would then copy wrong.
 */
const OMISSION_NOTE_MAX_ARG_CHARS = 1024;

/** Upper bound on an omission note's length: two quoted arguments plus the fixed wording. */
export const OMISSION_NOTE_MAX_CHARS = 2 * OMISSION_NOTE_MAX_ARG_CHARS + 512;

/** The result fields the choke points hand a step, the input to {@link captureStepFields}. */
export interface ResolvedToolResult {
  /** The tool result text returned to the model. */
  content: string;
  /** Whether the call errored (failed / policy-denied); declines resolve `false`. */
  isError?: boolean;
  /** The reviewed op's real disposition, when this call went through review. */
  disposition?: VaultOpDisposition;
  /**
   * Images the result carried, with or without their bytes. The plugin loop hands the
   * full {@link ../tools/types.ToolResultImage}s, Claude Code's lifecycle event hands
   * metadata already stripped; either way the capture stores metadata only (RFC-0021 D6).
   */
  images?: ToolResultImageRecord[] | ToolResultImage[];
}

/** The replay-capture fields merged onto an {@link ../shared/types.AgenticStep} (ADR-0016). */
export interface StepCaptureFields {
  resultDigest?: string;
  resultRecord?: string;
  disposition?: VaultOpDisposition;
  askGuidance?: CompletedAskGuidanceRecord;
  /**
   * What the step keeps of an image the tool returned: the path, format, size and
   * dimensions, never the base64 (RFC-0021 D6). The bound on `resultRecord` exists so
   * vault content in the conversation JSON stays linear, and a loop can read as many
   * images as it likes, so bytes here would defeat that bound outright. The timeline
   * reloads the picture from the vault by path instead.
   */
  resultImages?: ToolResultImageRecord[];
}

/** The recovery sentence for a caller that names no tool. */
const GENERIC_RECOVERY = "Call the same tool again if you need the omitted part.";

/**
 * Bound a tool result for the stored record. A result within `limit` is stored whole.
 * A longer one keeps its start and its end, about half the limit each and snapped to a
 * line boundary when one is near, with an omission note between them saying how much is
 * missing, that this is the result as it was then, and the call that gets it back
 * (`recovery`). Both ends, because in prose the end of a passage is often what the next
 * turn needs.
 *
 * The note is what lets a model notice the gap at all: a bare cut reads as a result that
 * simply stops (RFC-0022 D1, the ADR-0021 actionable-failure pattern).
 */
export function boundToolResult(
  content: string,
  limit: number = TOOL_RESULT_CHAR_LIMIT,
  recovery: string = GENERIC_RECOVERY,
): string {
  if (content.length <= limit) return content;
  const headTarget = Math.ceil(limit / 2);
  const tailTarget = limit - headTarget;

  let head = content.slice(0, headTarget);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak >= headTarget / 2) head = head.slice(0, headBreak + 1);

  let tail = content.slice(content.length - tailTarget);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < tailTarget / 2) tail = tail.slice(tailBreak + 1);

  const omitted = content.length - head.length - tail.length;
  const note =
    `${head.endsWith("\n") ? "" : "\n"}…[${omitted} of ${content.length} characters omitted ` +
    `here. This is a copy of the result as it was at that point in the conversation. ` +
    `${recovery}]\n`;
  return head + note + tail;
}

/**
 * The recovery sentence an omission note ends with, per tool. `read` is the one tool whose
 * omitted part a model routinely needs, and it has no line offsets, so the way back is
 * the same path, or `get_outline` and then one section by `headingPath`, which is what
 * `read`'s own description teaches.
 */
export function omissionRecovery(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "read") {
    const path = quotedArg(args.path);
    const heading = quotedArg(args.headingPath);
    if (heading) {
      return `For the current text, call read with path ${path ?? "the same path"} and headingPath ${heading}.`;
    }
    const target = path ? `path ${path}` : "the same path";
    return (
      `For the current text, call read with ${target}, or call get_outline on it and read ` +
      `only the section you need with a headingPath.`
    );
  }
  return `Call ${toolName} again if you need the omitted part.`;
}

/** A string argument in double quotes, or null when absent or too long to quote back. */
function quotedArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > OMISSION_NOTE_MAX_ARG_CHARS) return null;
  return `"${trimmed}"`;
}

/**
 * Compute every replay-capture field for one tool_call step from its resolved
 * result. The single source both choke points call, so neither can drift. Returns
 * only the fields that apply: an empty object for a call with no content, no
 * disposition, and no discovery digest (spreading it then adds nothing, preserving
 * prior behavior for such calls (ADR-0016).
 */
export function captureStepFields(
  toolName: string,
  args: Record<string, unknown>,
  result: ResolvedToolResult,
  recordChars: number = TOOL_RESULT_CHAR_LIMIT,
): StepCaptureFields {
  const fields: StepCaptureFields = {};
  const askCapture =
    toolName === ASK_USER_TOOL_NAME ? deriveAskGuidanceCapture(args, result) : null;
  const digest = askCapture?.digest ?? formatResultDigest(toolName, args, result);
  if (digest !== undefined) fields.resultDigest = digest;
  if (result.content) {
    fields.resultRecord = boundToolResult(
      result.content,
      recordChars,
      omissionRecovery(toolName, args),
    );
  }
  if (result.disposition !== undefined) fields.disposition = result.disposition;
  if (askCapture) fields.askGuidance = askCapture.guidance;
  // `data` is dropped here rather than at each choke point, so neither can forget to.
  if (result.images?.length) {
    fields.resultImages = result.images.map(({ path, mimeType, byteLength, width, height }) => ({
      path,
      mimeType,
      byteLength,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }));
  }
  return fields;
}

/**
 * Discovery-class tools whose *results* are pointers the args don't already carry
 * (ADR-0016): the rebuilt model can re-ground any pointer in one cheap call, so replay
 * stays pointers rather than chunk content. The path→content tool (`read`, on either
 * pathway) and listing tools (`list_directory`) get no digest, their args are the
 * pointer, or the view is re-derivable.
 *
 * Exported for the drift guard in `tests/unit/tools/resultDigest.test.ts`: these are
 * tool names nothing typechecks, so a rename that misses one silently drops that tool's
 * replay digest and degrades cold rebuild.
 */
export const DISCOVERY_DIGEST_TOOLS = new Set([
  "semantic_search",
  "search_content",
  "search_files",
  "get_links",
  "find_notes_by_tag",
]);

/** Max pointers a hits digest lists, and its char budget (ADR-0016). */
const MAX_DIGEST_POINTERS = 8;
const MAX_DIGEST_CHARS = 500;

/**
 * A compact, pointers-only digest of a discovery-tool result for cold-rebuild
 * replay (ADR-0016), or `undefined` for any non-discovery tool. Never
 * carries scores or chunk content, both non-reproducible and decision-irrelevant on
 * replay.
 */
export function formatResultDigest(
  toolName: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
): string | undefined {
  if (!DISCOVERY_DIGEST_TOOLS.has(toolName)) return undefined;

  const head = `${toolName}: "${digestKeyArg(toolName, args)}"`;

  // invalid-args + unavailable: replay the failure so the rebuilt model knows why it
  // historically fell back (e.g. to search_content).
  if (result.isError) {
    return `[${head}, FAILED: ${firstSentence(result.content)}]`;
  }

  // Empty result: ran fine, found nothing. Every single-list handler's empty message
  // opens "No "; a hit result never does. Load-bearing on replay: without it the model
  // can neither trust nor rule out its own earlier retrieval.
  //
  // `get_links` is exempt because it can return two sections: an empty incoming
  // direction opens the content with "No notes link to ..." while the outgoing section
  // below it carries hits. Its extraction reads section by section, and the no-pointer
  // fallback below covers the case where both directions really are empty.
  if (toolName !== "get_links" && result.content.trimStart().startsWith("No ")) {
    return `[${head}, no results]`;
  }

  const pointers = extractPointers(toolName, result.content);
  if (pointers.length === 0) return `[${head}, no results]`;
  return `[${head}, surfaced: ${boundPointers(pointers)}]`;
}

/** The key argument a discovery tool digests under (its query / pattern / path / tag). */
function digestKeyArg(toolName: string, args: Record<string, unknown>): string {
  const raw =
    toolName === "search_files"
      ? args.pattern
      : toolName === "get_links"
        ? args.path
        : toolName === "find_notes_by_tag"
          ? args.tag
          : args.query; // semantic_search, search_content
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The first sentence of an error result, "Error:" prefix stripped, for the FAILED
 * digest line. A sentence boundary is a period followed by whitespace or end.
 */
function firstSentence(text: string): string {
  const body = text.trim().replace(/^Error:\s*/, "");
  const boundary = body.search(/\.(?:\s|$)/);
  return (boundary >= 0 ? body.slice(0, boundary) : body).trim();
}

/**
 * Extract the pointer list from a hit result, per tool. `semantic_search` yields
 * `path > heading` (exactly `read`'s two args); the lexical / link / tag tools
 * yield vault paths the model can `read`. Never chunk content.
 */
function extractPointers(toolName: string, content: string): string[] {
  if (toolName === "semantic_search") {
    // Header + per chunk `[filePath > headingPath] (score) \n <chunk content>`.
    const pointers: string[] = [];
    const re = /^\[([^\]]+)\] \(score:/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) pointers.push(m[1].trim());
    return pointers;
  }

  if (toolName === "search_content") {
    // `path:line: snippet` (no context) or `[path]` block headers (with context);
    // collect the distinct file paths, first-seen order.
    const seen = new Set<string>();
    for (const line of content.split("\n")) {
      const bracket = /^\[(.+)\]$/.exec(line);
      const grep = /^(.+?):\d+: /.exec(line);
      const path = bracket ? bracket[1] : grep ? grep[1] : null;
      if (path) seen.add(path.trim());
    }
    return [...seen];
  }

  if (toolName === "get_links") {
    // One or two blank-line-separated sections, each either a `… (N):` header followed by
    // one vault path per line, or a single "no links this way" sentence contributing
    // nothing. Distinct paths: a mutual link appears in both sections and is one pointer.
    const seen = new Set<string>();
    for (const section of content.split("\n\n")) {
      const lines = section.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0 || !lines[0].endsWith("):")) continue;
      for (const line of lines.slice(1)) seen.add(line);
    }
    return [...seen];
  }

  // search_files / find_notes_by_tag share one shape: a `… (N):` header line, then one
  // vault path per line.
  return content
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Cap a pointer list to {@link MAX_DIGEST_POINTERS} entries and {@link MAX_DIGEST_CHARS}. */
function boundPointers(pointers: string[]): string {
  const shown = pointers.slice(0, MAX_DIGEST_POINTERS);
  let joined = shown.join("; ");
  if (joined.length > MAX_DIGEST_CHARS) {
    joined = joined.slice(0, MAX_DIGEST_CHARS - 1) + "…";
  } else if (pointers.length > shown.length) {
    joined += "; …";
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Cold-rebuild replay (ADR-0016): the persisted capture fields above become the
// compact bracketed lines a cold rebuild replays under each assistant turn, and a
// marker for an interrupted reply. The formatters live here beside the capture
// contract so the digest string logic stays in one pure, unit-tested place; the
// claudecode-specific history shaping that consumes them is in prepareApiMessages.
// ---------------------------------------------------------------------------

/** Interrupted-turn marker appended during cold-rebuild replay (ADR-0016). */
export const INTERRUPTED_REPLAY_MARKER = "[response interrupted by user]";

/**
 * One replay line per persisted tool_call step (ADR-0016), in recorded order. Reasoning
 * steps and any step without a tool name are dropped. The lines are presentation-only
 * (they ride replayed `content`, never `rawContent`), so a rebuilt session learns
 * what already ran and how the user disposed of it without re-executing anything.
 */
export function formatAgenticReplayLines(steps: AgenticStep[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    const line = formatStepReplayLine(step);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/** Exact ask-only replay lines for direct-provider and error-history shaping. */
export function formatAskGuidanceReplayLines(steps: AgenticStep[]): string[] {
  return steps.flatMap((step) => {
    if (
      step.type !== "tool_call" ||
      step.toolName !== ASK_USER_TOOL_NAME ||
      !step.askGuidance
    ) {
      return [];
    }
    return [formatAskGuidanceDigest(step.askGuidance)];
  });
}

/** Whether a persisted step set contains at least one completed ask answer. */
export function hasCompletedAskGuidance(
  steps: AgenticStep[] | undefined,
): boolean {
  return steps?.some(
    (step) =>
      step.type === "tool_call" &&
      step.toolName === ASK_USER_TOOL_NAME &&
      step.askGuidance !== undefined,
  ) ?? false;
}

/**
 * The replay line for a single step, or `null` when the step contributes none.
 * Discovery tools replay their precomputed pointers-only
 * {@link AgenticStep.resultDigest} verbatim (ADR-0016); every other captured tool renders
 * as `[tool: keyArg]` with an always-shown disposition suffix when the call was
 * reviewed. `DECLINED by user` is the steering signal a flat prose transcript
 * loses.
 *
 * A step earns a line only if it carries at least one replay-capture field
 * ({@link AgenticStep.resultDigest}, {@link AgenticStep.resultRecord}, or
 * {@link AgenticStep.disposition}). Older steps have none, so older conversations
 * replay byte-identically to before; computing lines from `toolName`/`toolInput`
 * alone would silently
 * rewrite those old transcripts.
 */
export function formatStepReplayLine(step: AgenticStep): string | null {
  if (step.type !== "tool_call" || !step.toolName) return null;
  if (step.toolName === ASK_USER_TOOL_NAME) {
    return step.askGuidance
      ? formatAskGuidanceDigest(step.askGuidance)
      : null;
  }
  if (
    step.resultDigest === undefined &&
    step.resultRecord === undefined &&
    step.disposition === undefined
  ) {
    return null;
  }
  if (step.resultDigest) return step.resultDigest;
  const key = step.toolInput?.trim();
  const inner = key ? `${step.toolName}: ${key}` : step.toolName;
  const dispo = step.disposition ? dispositionReplayLabel(step.disposition) : undefined;
  return dispo ? `[${inner}, ${dispo}]` : `[${inner}]`;
}

/** The digest label for a reviewed op's disposition; declines/failures/cancels are emphasized. */
function dispositionReplayLabel(disposition: VaultOpDisposition): string {
  switch (disposition) {
    case "applied":
      return "applied";
    case "auto-applied":
      return "auto-applied";
    case "declined":
      return "DECLINED by user";
    case "failed":
      return "FAILED";
    case "satisfied":
      return "already satisfied";
    case "cancelled":
      return "CANCELLED before review";
    default:
      return assertNever(disposition);
  }
}
