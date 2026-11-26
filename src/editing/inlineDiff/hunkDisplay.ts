/**
 * Display-only reduction of a pending hunk. A model often anchors an edit on text it
 * keeps (replacing "a sentence." with "a sentence.\n\nA new section"), so rendering
 * the raw match as struck and the raw replacement as new shows the kept text twice.
 * Trimming the shared prefix and suffix leaves only what actually changes.
 *
 * Accepting still applies the full, untrimmed hunk through the controller; this
 * only decides what the overlay draws.
 */
export interface HunkDisplay {
  /** Offset into the matched text where the changed span starts. */
  offset: number;
  /** Text the edit removes, struck in place. Empty for a pure insertion. */
  removed: string;
  /** Text the edit adds. Empty for a pure deletion. */
  inserted: string;
  /** `block` when the addition spans lines, so it renders beneath the line. */
  layout: "inline" | "block";
  kind: "insertion" | "deletion" | "replacement";
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * Length of the shared prefix, backed off to a word boundary so a change inside a
 * word ("cat" to "cart") shows the whole word replaced rather than a stray letter.
 */
function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;

  const splitsWord = (n: number): boolean =>
    isWordChar(a[n - 1]) && (isWordChar(a[n]) || isWordChar(b[n]));
  while (p > 0 && splitsWord(p)) p--;
  return p;
}

/** Shared suffix length within the text after `prefix`, word-snapped the same way. */
function sharedSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let s = 0;
  while (s < max && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const splitsWord = (n: number): boolean =>
    isWordChar(a[a.length - n]) &&
    (isWordChar(a[a.length - n - 1]) || isWordChar(b[b.length - n - 1]));
  while (s > 0 && splitsWord(s)) s--;
  return s;
}

export function trimHunk(matchedText: string, replaceText: string): HunkDisplay {
  const prefix = sharedPrefixLength(matchedText, replaceText);
  const suffix = sharedSuffixLength(matchedText, replaceText, prefix);
  const removed = matchedText.slice(prefix, matchedText.length - suffix);
  const inserted = replaceText.slice(prefix, replaceText.length - suffix);

  let kind: HunkDisplay["kind"] = "replacement";
  if (removed.length === 0) kind = "insertion";
  else if (inserted.length === 0) kind = "deletion";

  return {
    offset: prefix,
    removed,
    inserted,
    layout: inserted.includes("\n") ? "block" : "inline",
    kind,
  };
}

/** The margin note's label, e.g. "Addition, 5 lines". */
export function describeHunk(display: HunkDisplay): string {
  const noun = { insertion: "Addition", deletion: "Deletion", replacement: "Replacement" }[
    display.kind
  ];
  if (display.layout !== "block") return noun;
  const lines = display.inserted.trim().split("\n").length;
  return `${noun}, ${lines} ${lines === 1 ? "line" : "lines"}`;
}
