import { type App, type TFile, normalizePath } from "obsidian";
import { assertNever } from "../../utils";
import type { EditBlock } from "../../editing/editTypes";
import { findEditMatch } from "../../editing/diffEngine";
import { toLf } from "../../editing/lineEndings";
import type { ToolCall, ToolResult } from "../types";
import { toolFailure } from "../toolFailure";
import { refuseOutsideVault } from "../pathBoundary";
import { EDIT_TOOL_NAMES } from "./definition";
import {
  NO_OP_EDIT_FAILURE,
  validateEdit,
  validateInsertIntoNote,
  validateUpdateFrontmatter,
} from "./validation";
import type { FrontmatterOperation, InsertWhere } from "./validation";
import { normalizeEscapes } from "./conversion";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  app: App;
  /** Vault-relative path to the active file. */
  filePath: string;
}

/**
 * Execute an edit tool inside the tool loop and return a result for the model.
 *
 * Edit tools are validated and checked against the active document so the model
 * gets immediate feedback (e.g. "search text not found") and can self-correct
 * before the loop ends. The actual diff review happens at finalization, this
 * function only validates and acknowledges.
 */
export async function executeEditTool(
  toolCall: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  if (!EDIT_TOOL_NAMES.has(toolCall.name)) {
    return unknownEditTool(toolCall.name);
  }

  switch (toolCall.name) {
    case "edit":
      return executeEdit(toolCall.arguments, ctx);
    case "insert_into_note":
      return executeInsertIntoNote(toolCall.arguments, ctx);
    case "update_frontmatter":
      return executeUpdateFrontmatter(toolCall.arguments);
    default:
      return unknownEditTool(toolCall.name);
  }
}

function unknownEditTool(name: string): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `unknown edit tool "${name}"`,
    recovery: "call one of the advertised edit tools instead",
    isReadOnly: false,
  });
}

/** The target file did not resolve. `explicit` distinguishes a bad `path`
 *  argument (report not-found) from no target at all (ask for a path). */
type TargetResolution =
  | { file: TFile; path: string }
  | { file: null; explicit: boolean };

/**
 * Resolve the edit target from the tool call's `path`
 * (ADR-0018). Invariant: an explicit `path` must land on
 * exactly that file, so if it is supplied but does not resolve we report not-found
 * rather than falling through to the open file. Only an omitted `path` falls back to
 * the document context / active file.
 */
function resolveTargetFile(ctx: ToolExecutionContext, path?: string): TargetResolution {
  if (path) {
    const file = ctx.app.vault.getFileByPath(normalizePath(path));
    return file ? { file, path: file.path } : { file: null, explicit: true };
  }
  if (ctx.filePath) {
    const file = ctx.app.vault.getFileByPath(normalizePath(ctx.filePath));
    if (file) return { file, path: file.path };
  }
  const active = ctx.app.workspace.getActiveFile();
  if (active) return { file: active, path: active.path };
  return { file: null, explicit: false };
}

/**
 * The shared failure for an unresolved edit target. An explicit `path` that didn't
 * resolve is a missing file (report not-found so the model creates it or fixes the
 * path); no target at all asks for a `path`. Used by every path-targeted edit tool.
 */
function noTargetFailure(
  target: Extract<TargetResolution, { file: null }>,
  path?: string,
): ToolResult {
  if (target.explicit) {
    return toolFailure({
      kind: "not-found",
      what: `file not found at "${path}"`,
      recovery: "check the path, or use write_file to create the note first",
      isReadOnly: false,
    });
  }
  return toolFailure({
    kind: "invalid-args",
    what: "no target note",
    recovery:
      "pass `path` (the vault-relative path of the note to edit), or open the file you want to edit",
    isReadOnly: false,
  });
}

async function executeEdit(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const v = validateEdit(args);
  if (!v.ok) {
    return toolFailure({
      kind: "invalid-args",
      what: `invalid edit arguments: ${v.error}`,
      isReadOnly: false,
    });
  }

  const searchText = normalizeEscapes(v.args.search);
  if (!searchText) {
    return toolFailure({
      kind: "invalid-args",
      what: "search text is empty",
      recovery: "pass the exact text you want to replace",
      isReadOnly: false,
    });
  }

  if (searchText === normalizeEscapes(v.args.replace)) {
    return toolFailure({ kind: "invalid-args", ...NO_OP_EDIT_FAILURE, isReadOnly: false });
  }

  // An explicit out-of-vault `path` is named at the boundary before resolution,
  // otherwise it reports "not found" and points at write_file, which would itself
  // be refused for escaping the vault.
  if (v.args.path) {
    const outside = refuseOutsideVault(v.args.path, false);
    if (outside) return outside;
  }

  const target = resolveTargetFile(ctx, v.args.path);
  if (!target.file) return noTargetFailure(target, v.args.path);

  const content = await ctx.app.vault.read(target.file);
  // Match the way the apply step will: exact first, then whitespace-normalized,
  // so a search that differs only in indentation/spacing is not falsely rejected
  // here only to succeed at apply time (tool-set-review H1). The line number is
  // read off the same LF space the match offset lives in.
  const match = findEditMatch(searchText, content);

  if (!match) {
    return toolFailure({
      kind: "no-match",
      what: `search text not found in "${target.path}"`,
      recovery:
        "match the document exactly, including whitespace and indentation, or use read to verify the current content",
      isReadOnly: false,
    });
  }

  const lineNumber = toLf(content).slice(0, match.offset).split("\n").length;
  const explanation = v.args.explanation ? ` (${v.args.explanation})` : "";
  return {
    content: `Edit proposed for "${target.path}": matched at line ${lineNumber}${explanation}. Queued for user review.`,
    isReadOnly: false,
  };
}

async function executeInsertIntoNote(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const v = validateInsertIntoNote(args);
  if (!v.ok) {
    return toolFailure({
      kind: "invalid-args",
      what: `invalid insert_into_note arguments: ${v.error}`,
      isReadOnly: false,
    });
  }

  // Name an out-of-vault `path` at the boundary before any lookup (mirrors
  // executeEdit), so the model gets the boundary reason, not a generic
  // "not found" that points it to search for an unreachable path.
  if (v.args.path) {
    const outside = refuseOutsideVault(v.args.path, false);
    if (outside) return outside;
  }

  const target = resolveTargetFile(ctx, v.args.path);
  if (!target.file) return noTargetFailure(target, v.args.path);

  // For before/after, verify the anchor resolves now so the model self-corrects
  // within the turn. append/prepend need no anchor, so they always acknowledge.
  if (v.args.where === "before" || v.args.where === "after") {
    const anchor = normalizeEscapes(v.args.anchor ?? "");
    const content = await ctx.app.vault.read(target.file);
    if (!findEditMatch(anchor, content)) {
      return toolFailure({
        kind: "no-match",
        what: `anchor text not found in "${target.path}"`,
        recovery:
          "match the anchor exactly (including whitespace), or use where \"append\"/\"prepend\" which need no anchor",
        isReadOnly: false,
      });
    }
  }

  const explanation = v.args.explanation ? ` (${v.args.explanation})` : "";
  return {
    content: `Insertion proposed for "${target.path}" (${v.args.where})${explanation}. Queued for user review.`,
    isReadOnly: false,
  };
}

function executeUpdateFrontmatter(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const v = validateUpdateFrontmatter(args);
  if (!v.ok) {
    return Promise.resolve(
      toolFailure({
        kind: "invalid-args",
        what: `invalid update_frontmatter arguments: ${v.error}`,
        isReadOnly: false,
      }),
    );
  }

  const summary = v.args.operations
    .map((op) => `${op.action} '${op.key}'`)
    .join(", ");
  const explanation = v.args.explanation ? ` (${v.args.explanation})` : "";
  return Promise.resolve({
    content: `Frontmatter update proposed: ${summary}${explanation}. Queued for user review.`,
    isReadOnly: false,
  });
}

/**
 * Resolve structure-aware EditBlocks that need MetadataCache or document
 * content to populate their searchText / replaceText.
 *
 * This must be called before blocks are passed to `resolveEdits()`.
 */
export async function resolveStructuralEditBlocks(
  blocks: EditBlock[],
  ctx: ToolExecutionContext,
): Promise<EditBlock[]> {
  const file = ctx.app.vault.getFileByPath(ctx.filePath);
  if (!file) return blocks;

  const resolved: EditBlock[] = [];
  for (const block of blocks) {
    if (block.toolName === "update_frontmatter") {
      resolved.push(await resolveUpdateFrontmatter(ctx.app, file, block));
    } else if (block.toolName === "insert_into_note") {
      resolved.push(await resolveInsertIntoNote(ctx.app, file, block));
    } else {
      resolved.push(block);
    }
  }
  return resolved;
}

/**
 * Resolve an insert_into_note block into concrete searchText/replaceText against the
 * document, so the diff engine and apply step treat it exactly like a search/replace:
 *
 *   - before/after, searchText is the anchor (matched with the engine's three tiers,
 *     so whitespace drift is tolerated), replaceText wraps it with the new paragraph.
 *   - prepend, an empty search resolves to offset 0 (a robust top-of-file insert).
 *   - append, the shortest *unique* trailing block anchors the end, grown upward from
 *     the last non-empty line until it occurs once, so a duplicated final line never
 *     anchors the insert in the middle of the note.
 *
 * The inserted text is separated from the surrounding content by one blank line (a
 * paragraph break); its own leading/trailing blank lines are trimmed so seams never
 * double up. An empty note takes the body alone.
 */
async function resolveInsertIntoNote(
  app: App,
  file: TFile,
  block: EditBlock,
): Promise<EditBlock> {
  const where = block.toolArgs?.where as InsertWhere | undefined;
  const rawText = typeof block.toolArgs?.content === "string" ? block.toolArgs.content : "";
  const anchor = typeof block.toolArgs?.anchor === "string" ? block.toolArgs.anchor : "";
  // Malformed args never reach here (conversion validated the call); guard anyway.
  if (!where || rawText === "") return block;

  const content = toLf(await app.vault.read(file));
  const body = rawText.replace(/^\n+|\n+$/g, "");
  const isEmpty = content.trim().length === 0;

  switch (where) {
    case "before":
      return { ...block, searchText: anchor, replaceText: `${body}\n\n${anchor}` };
    case "after":
      return { ...block, searchText: anchor, replaceText: `${anchor}\n\n${body}` };
    case "prepend":
      return { ...block, searchText: "", replaceText: isEmpty ? body : `${body}\n\n` };
    case "append": {
      if (isEmpty) return { ...block, searchText: "", replaceText: body };
      const tail = uniqueTrailingAnchor(content);
      return { ...block, searchText: tail, replaceText: `${tail}\n\n${body}` };
    }
    default:
      return assertNever(where);
  }
}

/**
 * The shortest block of trailing lines that occurs exactly once in `content`, used to
 * anchor an append. Starts at the last non-empty line and grows upward until the block
 * is unique (or reaches the whole document, which is always unique), so a repeated
 * final line can never make the diff engine anchor the append earlier in the note.
 */
function uniqueTrailingAnchor(content: string): string {
  const lines = content.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--; // skip trailing blank lines
  if (end === 0) return "";

  let start = end - 1;
  let anchor = lines.slice(start, end).join("\n");
  while (start > 0 && content.indexOf(anchor) !== content.lastIndexOf(anchor)) {
    start--;
    anchor = lines.slice(start, end).join("\n");
  }
  return anchor;
}

// ---------------------------------------------------------------------------
// Structural edit block resolution
// ---------------------------------------------------------------------------

async function resolveUpdateFrontmatter(
  app: App,
  file: TFile,
  block: EditBlock,
): Promise<EditBlock> {
  const operations = block.toolArgs?.operations as
    | FrontmatterOperation[]
    | undefined;
  if (!operations || operations.length === 0) return block;

  const content = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);

  const hasFrontmatter = !!cache?.frontmatterPosition;

  if (hasFrontmatter && cache?.frontmatterPosition) {
    const fmStart = cache.frontmatterPosition.start.line;
    const fmEnd = cache.frontmatterPosition.end.line;
    const lines = content.split("\n");

    // Full frontmatter block including --- delimiters
    const fmLines = lines.slice(fmStart, fmEnd + 1);
    const searchText = fmLines.join("\n");

    // Apply operations to the inner lines, preserving complex YAML
    // structures (lists, nested objects) for keys that aren't modified.
    const innerLines = fmLines.slice(1, -1);
    const newInner = applyFrontmatterOperations(innerLines, operations);
    const replaceText = "---\n" + newInner.join("\n") + "\n---";

    return { ...block, searchText, replaceText };
  } else {
    // No existing frontmatter, build a new block from set operations.
    const setOps = operations.filter((op) => op.action === "set");
    if (setOps.length === 0) return block;

    const newInner = setOps.flatMap((op) => renderFrontmatterEntry(op.key, op.value));
    const fmBlock = "---\n" + newInner.join("\n") + "\n---";

    // Anchor on the first line to insert before it.
    const lines = content.split("\n");
    if (lines.length === 0) {
      return { ...block, searchText: "", replaceText: fmBlock };
    }

    const firstLine = lines[0];
    return {
      ...block,
      searchText: firstLine,
      replaceText: fmBlock + "\n" + firstLine,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a YAML value in double quotes and escape inner characters when the
 * value contains characters that could alter YAML structure (colons,
 * newlines, comment markers, etc.).  Plain safe scalars are returned as-is.
 */
function yamlSafeValue(value: string): string {
  if (/[\n\r:#{}[\],&*?|>!'"%@`]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  return value;
}

/**
 * Render one `set` operation as YAML frontmatter line(s). A string value becomes a
 * single `key: value` scalar line; an array value becomes a block list so a
 * multi-value property (tags, aliases) is written as a real YAML list rather than a
 * single quoted scalar, which Obsidian would otherwise read as one literal tag. An
 * empty array is written as an empty flow list (`key: []`); an empty/omitted value
 * yields a bare `key:`.
 */
function renderFrontmatterEntry(key: string, value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((item) => `  - ${yamlSafeValue(item)}`)];
  }
  return value ? [`${key}: ${yamlSafeValue(value)}`] : [`${key}:`];
}

/**
 * Apply frontmatter operations to raw YAML lines, preserving complex
 * values (lists, nested objects, multi-line strings) for keys that
 * are not being modified.
 */
function applyFrontmatterOperations(
  innerLines: string[],
  operations: FrontmatterOperation[],
): string[] {
  const result = [...innerLines];

  // Build a map of operations by key for efficient lookup.
  const opsByKey = new Map<string, FrontmatterOperation>();
  for (const op of operations) {
    opsByKey.set(op.key, op);
  }

  // Identify which lines belong to which top-level key.
  // A top-level key starts at column 0 with `key:`. Continuation lines
  // (indented, or list items) belong to the preceding key.
  const keyRanges: Array<{ key: string; start: number; end: number }> = [];
  for (let i = 0; i < result.length; i++) {
    const line = result[i];
    // Top-level key: starts at column 0, has a colon not inside a quote.
    // A column-0 block-list item ("- item" or "- a: b") is a continuation of the
    // preceding key's value, not a key of its own, even when it contains a colon.
    const colonIdx = line.indexOf(":");
    const isListItem = /^-(\s|$)/.test(line);
    if (colonIdx > 0 && !line.startsWith(" ") && !line.startsWith("\t") && !isListItem) {
      const key = line.slice(0, colonIdx).trim();
      if (key) {
        keyRanges.push({ key, start: i, end: i + 1 });
      }
    }
  }

  // Extend each key range to include continuation lines (indented lines
  // and list items that belong to the previous key's value).
  for (let i = 0; i < keyRanges.length; i++) {
    const nextStart = i + 1 < keyRanges.length
      ? keyRanges[i + 1].start
      : result.length;
    keyRanges[i].end = nextStart;
  }

  // Process operations in reverse order so splicing doesn't shift indices.
  const keysProcessed = new Set<string>();

  for (let i = keyRanges.length - 1; i >= 0; i--) {
    const { key, start, end } = keyRanges[i];
    const op = opsByKey.get(key);
    if (!op) continue;

    keysProcessed.add(key);

    if (op.action === "remove") {
      result.splice(start, end - start);
    } else if (op.action === "set") {
      // Replace the entire key block with the rendered entry (a scalar line, or a
      // multi-line block list when the value is an array).
      result.splice(start, end - start, ...renderFrontmatterEntry(key, op.value));
    }
  }

  // Append any "set" operations for keys not already in the frontmatter.
  for (const op of operations) {
    if (op.action === "set" && !keysProcessed.has(op.key)) {
      result.push(...renderFrontmatterEntry(op.key, op.value));
    }
  }

  return result;
}
