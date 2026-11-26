import { Component, MarkdownRenderer, type App, type EventRef, type MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { EditReviewController } from "../EditReviewController";
import { clearInlineHunks, setInlineHunks, type InlineHunk } from "./inlineDiffState";

interface Registration {
  controller: EditReviewController;
  unsubscribe: () => void;
}

/**
 * Binds {@link EditReviewController}s to the live Markdown editor so a proposal's
 * pending hunks render inline in the note it edits, the second renderer over the
 * same controller as the timeline-folded edit review.
 *
 * One registration per target file (latest proposal wins); the overlay shows in
 * every open editor of a registered file, focused or not, because the chat drawer
 * takes focus whenever it raises the next approval. The controller stays the single
 * owner, the manager only translates pending hunks into decorations and pushes
 * accept / reject back through the controller.
 */
export class InlineDiffManager {
  private readonly registrations = new Map<string, Registration>();
  /** Editors currently displaying an overlay, so each can be cleared when it stops qualifying. */
  private boundViews = new Set<EditorView>();

  constructor(private readonly app: App) {}

  /** Workspace listeners that re-evaluate the overlay; pass to `registerEvent`. */
  workspaceEvents(): EventRef[] {
    return [
      this.app.workspace.on("active-leaf-change", () => this.refresh()),
      this.app.workspace.on("file-open", () => this.refresh()),
      // A note opened in a new pane or split, or a pane closed.
      this.app.workspace.on("layout-change", () => this.refresh()),
    ];
  }

  /**
   * Show this controller's pending hunks inline in every open editor of its
   * target file. A controller with nothing left to review is unregistered.
   */
  attach(controller: EditReviewController): void {
    const path = controller.targetFilePath;
    this.registrations.get(path)?.unsubscribe();

    if (!controller.hasPendingHunks()) {
      this.registrations.delete(path);
      this.refresh();
      return;
    }

    const unsubscribe = controller.subscribe(() => {
      if (!controller.hasPendingHunks()) {
        this.registrations.get(path)?.unsubscribe();
        this.registrations.delete(path);
      }
      this.refresh();
    });
    this.registrations.set(path, { controller, unsubscribe });
    this.refresh();
  }

  /** Re-sync the overlay across every open Markdown editor. */
  refresh(): void {
    const next = new Set<EditorView>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView } | undefined)?.cm;
      const registration = view.file ? this.registrations.get(view.file.path) : undefined;
      if (!cm || !registration) continue;
      cm.dispatch({ effects: setInlineHunks.of(this.toInlineHunks(registration.controller)) });
      next.add(cm);
    }

    // Clear editors that showed an overlay and no longer qualify (switched note,
    // proposal finished).
    for (const cm of this.boundViews) {
      if (!next.has(cm)) cm.dispatch({ effects: clearInlineHunks.of(null) });
    }
    this.boundViews = next;
  }

  private toInlineHunks(controller: EditReviewController): InlineHunk[] {
    return controller.pendingHunks().map((hunk) => ({
      id: hunk.id,
      matchedText: hunk.resolvedEdit.matchedText,
      replaceText: hunk.resolvedEdit.editBlock.replaceText,
      matchOffset: hunk.resolvedEdit.matchOffset,
      renderMarkdown: (markdown, el) => this.renderMarkdown(markdown, el, controller),
      onAccept: () => void controller.accept(hunk.id),
      onReject: () => controller.reject(hunk.id),
    }));
  }

  /**
   * Render a proposal as markdown resolved against its own note, so links and
   * embeds resolve the way they will once accepted. Falls back to plain text.
   */
  private renderMarkdown(
    markdown: string,
    el: HTMLElement,
    controller: EditReviewController
  ): () => void {
    const component = new Component();
    component.load();
    MarkdownRenderer.render(this.app, markdown, el, controller.targetFilePath, component).catch(
      () => {
        el.empty();
        el.setText(markdown);
      }
    );
    return () => component.unload();
  }

  destroy(): void {
    for (const { unsubscribe } of this.registrations.values()) unsubscribe();
    this.registrations.clear();
    for (const cm of this.boundViews) cm.dispatch({ effects: clearInlineHunks.of(null) });
    this.boundViews.clear();
  }
}
