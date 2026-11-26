import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { describeHunk, trimHunk, type HunkDisplay } from "./hunkDisplay";

/**
 * Maximum character drift tolerated between a hunk's snapshot offset and where
 * its text is found in the live document before the hunk is treated as no longer
 * anchorable. Mirrors the guard in {@link applyHunksLive}.
 */
const MAX_OFFSET_DRIFT = 500;

/**
 * A pending edit, flattened from a `DiffHunk` into just what the overlay needs.
 * The accept / reject callbacks are bound to the owning `EditReviewController`,
 * so the overlay never mutates the document itself.
 */
export interface InlineHunk {
  id: string;
  matchedText: string;
  replaceText: string;
  /** Snapshot offset where the match started, used to re-anchor against drift. */
  matchOffset: number;
  /**
   * Render markdown into `el` in the note's context; returns the cleanup to run
   * when the widget is destroyed.
   */
  renderMarkdown: (markdown: string, el: HTMLElement) => () => void;
  onAccept: () => void;
  onReject: () => void;
}

/** Replace the editor's pending inline hunks. */
export const setInlineHunks = StateEffect.define<InlineHunk[]>();
/** Remove all inline hunks from the editor. */
export const clearInlineHunks = StateEffect.define<null>();

interface InlineDiffState {
  hunks: InlineHunk[];
  deco: DecorationSet;
}

/**
 * Find the occurrence of `text` closest to `expected`, or null when absent or
 * drifted beyond {@link MAX_OFFSET_DRIFT}. Re-anchoring (rather than trusting the
 * raw snapshot offset) is what keeps the strike/insert over the right range as
 * the document moves underneath the proposal.
 */
function findAnchor(doc: string, hunk: InlineHunk): number | null {
  if (hunk.matchedText.length === 0) {
    return hunk.matchOffset >= 0 && hunk.matchOffset <= doc.length ? hunk.matchOffset : null;
  }

  let idx = doc.indexOf(hunk.matchedText);
  if (idx === -1) return null;

  let best = idx;
  let bestDist = Math.abs(idx - hunk.matchOffset);
  while ((idx = doc.indexOf(hunk.matchedText, idx + 1)) !== -1) {
    const dist = Math.abs(idx - hunk.matchOffset);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }

  if (hunk.matchOffset >= 0 && bestDist > MAX_OFFSET_DRIFT) return null;
  return best;
}

/** Margin-note width plus the gap to the text column; below this, notes stay inline. */
const MARGIN_NOTE_SPACE = 230;
/** Editor-root class that moves review notes into the right margin. */
const MARGIN_MODE_CLASS = "lmsa-inline-diff-margin-mode";

/** Per-widget-DOM cleanup for rendered markdown, run from `WidgetType.destroy`. */
const disposers = new WeakMap<HTMLElement, () => void>();

/**
 * The review note: what kind of change this is, plus accept / reject. In margin
 * mode CSS lifts it into the right margin beside its line; otherwise it sits
 * inline with the change.
 */
function buildReviewNote(parent: HTMLElement, hunk: InlineHunk, display: HunkDisplay): void {
  const note = parent.createSpan({ cls: "lmsa-inline-diff-note" });
  note.createSpan({ cls: "lmsa-inline-diff-note-label", text: describeHunk(display) });
  const actions = note.createSpan({ cls: "lmsa-inline-diff-actions" });
  addButton(actions, "Accept", "lmsa-inline-diff-btn--accept", hunk.onAccept);
  addButton(actions, "Reject", "lmsa-inline-diff-btn--reject", hunk.onReject);
}

function addButton(parent: HTMLElement, label: string, cls: string, onClick: () => void): void {
  const btn = parent.createEl("button", {
    cls: `lmsa-inline-diff-btn ${cls}`,
    attr: { "aria-label": `${label} change`, type: "button" },
    text: label,
  });
  // mousedown + preventDefault so the click doesn't move the editor selection
  // or steal focus before the handler runs.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
}

abstract class ReviewWidget extends WidgetType {
  constructor(
    protected readonly hunk: InlineHunk,
    protected readonly display: HunkDisplay
  ) {
    super();
  }

  eq(other: ReviewWidget): boolean {
    return other.hunk.id === this.hunk.id && other.hunk.replaceText === this.hunk.replaceText;
  }

  /** Let the widget's own DOM handle clicks rather than the editor. */
  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    disposers.get(dom)?.();
    disposers.delete(dom);
  }
}

/**
 * Sits inside a text line: a one-line change's inserted words (if any), then the
 * review note. A multi-line addition uses it for the note alone, on the line the
 * block follows. The note always lives in a line rather than in a block widget,
 * because Obsidian gives block widgets `contain: paint`, which clips anything
 * positioned outside them, so a margin note inside the block is never painted.
 */
class InlineChangeWidget extends ReviewWidget {
  toDOM(view: EditorView): HTMLElement {
    // Build against the editor's own document, not the bare global. A CodeMirror
    // editor can live in a popped-out markdown window independent of our chat view,
    // so the widget's document is the editor's, reached via the view CM6 passes in
    // (ADR-0024). Raw createElement, not createEl: CM6 mounts this root, so
    // it is detached at creation, and createEl cannot target a non-main document
    // (ADR-0026).
    const root = view.dom.ownerDocument.createElement("span");
    root.addClass("lmsa-inline-diff-inline");
    if (this.display.layout === "inline" && this.display.inserted.length > 0) {
      root.createSpan({ cls: "lmsa-inline-diff-added", text: this.display.inserted });
    }
    buildReviewNote(root, this.hunk, this.display);
    return root;
  }
}

/**
 * A multi-line addition, rendered as markdown on its own lines beneath the change
 * so headings and lists read like the rest of the note. Its review note is on the
 * line above, see {@link InlineChangeWidget}.
 */
class BlockChangeWidget extends ReviewWidget {
  toDOM(view: EditorView): HTMLElement {
    // Raw createElement for the same reason as InlineChangeWidget.toDOM.
    const block = view.dom.ownerDocument.createElement("div");
    block.addClass("lmsa-inline-diff-block");

    const body = block.createDiv({ cls: "lmsa-inline-diff-body markdown-rendered" });
    const markdown = this.display.inserted.replace(/^\n+|\n+$/g, "");
    disposers.set(block, this.hunk.renderMarkdown(markdown, body));
    return block;
  }
}

function buildDecorations(hunks: InlineHunk[], doc: Text): DecorationSet {
  const docStr = doc.toString();
  const ranges: Range<Decoration>[] = [];

  for (const hunk of hunks) {
    const at = findAnchor(docStr, hunk);
    if (at === null) continue;

    // Decorate only what changes; the untrimmed hunk is still what accept applies.
    const display = trimHunk(hunk.matchedText, hunk.replaceText);
    const from = at + display.offset;
    const to = from + display.removed.length;

    if (to > from) {
      ranges.push(Decoration.mark({ class: "lmsa-inline-diff-removed" }).range(from, to));
    }

    // A one-line change puts its widget right after the change. A block must sit on
    // a line boundary, so it goes after the line holding the last changed character
    // (or the insertion point), and its note goes at the end of that same line.
    const lineRefPos = to > from ? to - 1 : to;
    const blockPos = doc.lineAt(Math.min(lineRefPos, doc.length)).to;
    const notePos = display.layout === "inline" ? to : blockPos;

    // A positioned line gives the margin note its vertical anchor.
    ranges.push(Decoration.line({ class: "lmsa-inline-diff-line" }).range(doc.lineAt(notePos).from));
    ranges.push(
      Decoration.widget({ widget: new InlineChangeWidget(hunk, display), side: 1 }).range(notePos)
    );
    if (display.layout === "inline") continue;

    ranges.push(
      Decoration.widget({
        widget: new BlockChangeWidget(hunk, display),
        block: true,
        side: 1,
      }).range(blockPos)
    );
  }

  // sort=true lets CodeMirror order the mixed mark/line/widget ranges correctly.
  return Decoration.set(ranges, true);
}

const inlineDiffField = StateField.define<InlineDiffState>({
  create() {
    return { hunks: [], deco: Decoration.none };
  },
  update(value, tr) {
    let hunks = value.hunks;
    let replaced = false;

    for (const effect of tr.effects) {
      if (effect.is(setInlineHunks)) {
        hunks = effect.value;
        replaced = true;
      } else if (effect.is(clearInlineHunks)) {
        hunks = [];
        replaced = true;
      }
    }

    // Rebuild (re-anchor) whenever the hunk set is replaced or the document
    // moves underneath an active overlay. Note-scale documents make a full
    // rebuild per change cheap enough; batching is a future optimization.
    if (replaced || (tr.docChanged && hunks.length > 0)) {
      return { hunks, deco: buildDecorations(hunks, tr.state.doc) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

/**
 * Turns margin mode on while the editor has room right of the text column
 * (readable line width on a wide pane), so review notes sit beside their lines
 * like comments on a manuscript. Narrow panes keep them inline.
 */
const marginModePlugin = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      this.measure();
    }

    update(update: ViewUpdate): void {
      const before = update.startState.field(inlineDiffField).hunks;
      const after = update.state.field(inlineDiffField).hunks;
      if (update.geometryChanged || before !== after) this.measure();
    }

    private measure(): void {
      if (this.view.state.field(inlineDiffField).hunks.length === 0) {
        this.view.dom.removeClass(MARGIN_MODE_CLASS);
        return;
      }
      this.view.requestMeasure({
        read: (view) =>
          view.scrollDOM.getBoundingClientRect().right -
          view.contentDOM.getBoundingClientRect().right,
        write: (space, view) => view.dom.toggleClass(MARGIN_MODE_CLASS, space >= MARGIN_NOTE_SPACE),
      });
    }

    destroy(): void {
      this.view.dom.removeClass(MARGIN_MODE_CLASS);
    }
  }
);

/** The editor extension to register once via `Plugin.registerEditorExtension`. */
export const inlineDiffExtension: Extension = [inlineDiffField, marginModePlugin];
