import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { InlineDiffManager } from "../../../src/editing/inlineDiff/InlineDiffManager";
import { setInlineHunks, clearInlineHunks } from "../../../src/editing/inlineDiff/inlineDiffState";
import { EditReviewController } from "../../../src/editing/EditReviewController";
import { resolveEdits, buildHunks } from "../../../src/editing/diffEngine";
import type { EditBlock, EditProposal } from "../../../src/editing/editTypes";

/** A stand-in for the CM6 EditorView, only `dispatch` is exercised. */
function fakeCm() {
  return { dispatch: vi.fn() };
}

/**
 * A workspace whose open Markdown leaves are swappable between assertions. The
 * active view is kept only to show the manager no longer depends on it.
 */
function makeWorkspace() {
  const ws = {
    leaves: [] as unknown[],
    activeView: null as unknown,
    getLeavesOfType: vi.fn(() => ws.leaves),
    getActiveViewOfType: vi.fn(() => ws.activeView),
    on: vi.fn(() => ({})),
  };
  return ws;
}

/** An open Markdown leaf showing `path` in editor `cm`. */
function leaf(cm: { dispatch: unknown }, path: string) {
  return { view: { editor: { cm }, file: { path } } };
}

function makeController(doc: string, search: string, replace: string): EditReviewController {
  const stubApp = {
    vault: { getFileByPath: () => null, process: async () => undefined, read: async () => doc },
  } as unknown as App;
  const blocks: EditBlock[] = [{ id: "b0", searchText: search, replaceText: replace, rawBlock: "" }];
  const resolved = resolveEdits(blocks, doc, { contextLines: 2, minConfidence: 0.7 });
  const proposal: EditProposal = {
    id: "p1",
    targetFilePath: "note.md",
    documentSnapshot: doc,
    snapshotTimestamp: 0,
    hunks: buildHunks(resolved),
    prose: "",
  };
  return new EditReviewController(stubApp, proposal, {
    onHunksChanged: () => undefined,
    onApplied: () => undefined,
    onUndone: () => undefined,
  });
}

describe("InlineDiffManager, open editors + dispatch", () => {
  it("dispatches the pending hunks into the target file's editor", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.leaves = [leaf(cm, "note.md")];
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow"));

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    const effect = cm.dispatch.mock.calls[0][0].effects;
    expect(effect.is(setInlineHunks)).toBe(true);
    expect(effect.value).toHaveLength(1);
    expect(effect.value[0]).toMatchObject({ matchedText: "quick", replaceText: "slow" });
  });

  it("shows the overlay in an editor that is open but not focused", () => {
    // The chat drawer takes focus whenever it raises the next approval, so the note
    // being edited is usually not the active leaf when its hunks arrive.
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.leaves = [leaf(cm, "note.md")];
    ws.activeView = null;
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow"));

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    expect(cm.dispatch.mock.calls[0][0].effects.is(setInlineHunks)).toBe(true);
  });

  it("shows the overlay in every open editor of the target file", () => {
    const left = fakeCm();
    const right = fakeCm();
    const ws = makeWorkspace();
    ws.leaves = [leaf(left, "note.md"), leaf(right, "note.md")];
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow"));

    expect(left.dispatch.mock.calls[0][0].effects.is(setInlineHunks)).toBe(true);
    expect(right.dispatch.mock.calls[0][0].effects.is(setInlineHunks)).toBe(true);
  });

  it("leaves an editor of another file untouched", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.leaves = [leaf(cm, "other.md")];
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow")); // targets note.md

    expect(cm.dispatch).not.toHaveBeenCalled();
  });

  it("does not throw or dispatch when an editor exposes no CodeMirror view", () => {
    const ws = makeWorkspace();
    ws.leaves = [{ view: { editor: {}, file: { path: "note.md" } } }]; // guard: no `.cm`
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    expect(() => manager.attach(makeController("The quick brown fox.", "quick", "slow"))).not.toThrow();
  });

  it("does not throw when no markdown editor is open", () => {
    const ws = makeWorkspace();
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    expect(() => manager.attach(makeController("doc with target here", "target", "goal"))).not.toThrow();
  });

  it("clears an editor once it switches to another note", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    const view = { editor: { cm }, file: { path: "note.md" } };
    ws.leaves = [{ view }];
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);
    manager.attach(makeController("The quick brown fox.", "quick", "slow"));
    cm.dispatch.mockClear();

    view.file = { path: "other.md" };
    manager.refresh();

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    expect(cm.dispatch.mock.calls[0][0].effects.is(clearInlineHunks)).toBe(true);
  });
});
