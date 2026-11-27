import { setIcon } from "obsidian";
import type { App, Component } from "obsidian";
import type { Attachment, ConversationMessage } from "../../shared/types";
import type {
  AssistantBubbleRefs,
  BubbleRefs,
  BubbleRenderOptions,
  ChatLayoutRefs,
  UserBubbleRefs,
} from "../types";
import type { MarkdownBubbleRenderer } from "../rendering/MarkdownBubbleRenderer";
import { MarkdownItBubbleRenderer } from "../rendering/MarkdownItBubbleRenderer";
import { BubbleActionToolbar } from "./BubbleActionToolbar";
import { BubbleVersionNav } from "./BubbleVersionNav";
import { renderUsageBadge } from "./UsageBadge";
import { renderRagSources } from "./RagSourcesList";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { AssistantTurnView } from "./AssistantTurnView";
import { selectAssistantMessageRenderSource } from "./assistantTurnRenderModel";
import { getActiveAssistantRevision } from "../conversation/assistantRevisions";
import type { ActionControlEligibility } from "../conversation/actionLedger";
import type { ActionReviewControl } from "./actionLedgerReview";

export type BubbleActionCallbacks = {
  onCopy: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onBranch: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onVersionChange: (messageId: string, revisionId: string) => void;
  getActionEligibility: (
    messageId: string,
    actionRef: string,
    targetId: string,
  ) => ActionControlEligibility;
  onActionControl: (
    messageId: string,
    actionRef: string,
    targetId: string,
    control: ActionReviewControl,
  ) => void;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 10;
/** Past this much scroll-up, the jump-to-latest button appears (above the tiny re-arm zone). */
const SCROLL_TO_BOTTOM_VISIBILITY_PX = 120;

export class ChatTranscript {
  private bubblesByMessageId = new Map<string, BubbleRefs>();
  /**
   * The bubble a generation is streaming into before its message exists, and the
   * message it replaces on a regeneration. Renders keep it last and keep the
   * replaced message hidden, until it is committed or released.
   */
  private draft: { bubble: AssistantBubbleRefs; supersededMessageId: string | null } | null =
    null;
  private renderedMessageIds: string[] = [];
  private shouldAutoScroll = true;
  private readonly markdownRenderer: MarkdownBubbleRenderer;
  private readonly scrollToBottomBtn: HTMLElement | null;

  constructor(
    private readonly owner: Component,
    private readonly app: App,
    private readonly refs: Pick<ChatLayoutRefs, "messagesEl" | "emptyStateEl">,
    markdownRenderer?: MarkdownBubbleRenderer
  ) {
    this.markdownRenderer =
      markdownRenderer ??
      new MarkdownItBubbleRenderer(this.app);
    this.scrollToBottomBtn = this.createScrollToBottomButton();
    this.owner.registerDomEvent(this.refs.messagesEl, "scroll", () => {
      this.shouldAutoScroll = this.isNearBottom();
      this.updateScrollToBottomButton();
    });
    this.followContentGrowth();
  }

  /**
   * Keep a reader who is at the bottom at the bottom while the transcript changes
   * size after the fact: markdown that finishes rendering after its bubble was
   * scrolled to, a cancelled edit giving way to taller rendered prose, the composer
   * growing and shrinking the pane. The explicit scrollToBottom() calls only cover
   * the moments they run at; this covers every later reflow. It follows only while
   * shouldAutoScroll holds, so a reader who scrolled up is left where they are.
   *
   * Content growth fires no scroll event, so shouldAutoScroll still reflects where
   * the reader was before the reflow. Rows are observed individually because a
   * scroll container's own box does not resize when its content does.
   */
  private followContentGrowth(): void {
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }
    const messagesEl = this.refs.messagesEl;
    const resizeObserver = new ResizeObserver(() => this.scrollToBottom());
    resizeObserver.observe(messagesEl);
    for (const rowEl of Array.from(messagesEl.children)) resizeObserver.observe(rowEl);

    const rowObserver = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) resizeObserver.unobserve(node as Element);
        });
        record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) resizeObserver.observe(node as Element);
        });
      }
    });
    rowObserver.observe(messagesEl, { childList: true });

    this.owner.register(() => {
      rowObserver.disconnect();
      resizeObserver.disconnect();
    });
  }

  /**
   * Floating jump-to-latest affordance. Auto-follow silently disengages when the reader
   * scrolls up mid-stream (shouldAutoScroll goes false), so without this new tokens land
   * off-screen with no way back short of dragging to the very bottom. Mounted on the
   * (positioned) messages pane so it floats over the scroll area.
   */
  private createScrollToBottomButton(): HTMLElement | null {
    const pane = this.refs.messagesEl.parentElement;
    if (!pane) return null;
    const btn = pane.createEl("button", {
      cls: "lmsa-scroll-to-bottom lmsa-hidden",
      attr: { "aria-label": "Jump to latest" },
    });
    const icon = btn.createSpan({ cls: "lmsa-scroll-to-bottom-icon" });
    setIcon(icon, "chevron-down");
    btn.createSpan({ text: "Jump to latest" });
    this.owner.registerDomEvent(btn, "click", () => this.scrollToBottom(true));
    return btn;
  }

  private updateScrollToBottomButton(): void {
    if (!this.scrollToBottomBtn) return;
    const distanceFromBottom =
      this.refs.messagesEl.scrollHeight -
      this.refs.messagesEl.scrollTop -
      this.refs.messagesEl.clientHeight;
    this.scrollToBottomBtn.toggleClass(
      "lmsa-hidden",
      distanceFromBottom <= SCROLL_TO_BOTTOM_VISIBILITY_PX
    );
  }

  /**
   * @param isConversationSwitch Forces the scroll to the bottom, and drops any
   *   in-flight draft, which belongs to the conversation being left.
   */
  async renderMessages(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
    isConversationSwitch = true
  ): Promise<void> {
    const newIds = messages.map((m) => m.id);
    const canIncrement = this.canIncrementalUpdate(newIds);

    if (canIncrement) {
      await this.incrementalRender(messages, actionCallbacks);
    } else {
      await this.fullRender(messages, actionCallbacks);
    }

    this.renderedMessageIds = newIds;
    if (isConversationSwitch) {
      this.draft?.bubble.rowEl.remove();
      this.draft = null;
    } else {
      this.restoreDraftPlacement();
    }
    this.scrollToBottom(isConversationSwitch);
  }

  /**
   * Incremental render is possible when the existing messages are a prefix
   * of the new message list (same IDs in the same order). This handles the
   * common case: new messages appended to the end of a conversation.
   */
  private canIncrementalUpdate(newIds: string[]): boolean {
    if (this.renderedMessageIds.length === 0) return false;
    if (this.renderedMessageIds.length > newIds.length) return false;
    if (this.renderedMessageIds.length === newIds.length) return false;

    for (let i = 0; i < this.renderedMessageIds.length; i++) {
      if (this.renderedMessageIds[i] !== newIds[i]) return false;
    }
    return true;
  }

  private async incrementalRender(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
  ): Promise<void> {
    const lastAssistantIndex = this.findLastAssistantIndex(messages);
    const startIndex = this.renderedMessageIds.length;

    for (let i = startIndex; i < messages.length; i++) {
      const message = messages[i];
      // A bubble the send flow already built (its user message, mid-generation)
      // is adopted as it stands instead of being duplicated below the draft.
      let bubble = this.bubblesByMessageId.get(message.id);
      if (!bubble) {
        bubble = this.createBubble(message.role, message.id);
        await this.renderMessageBody(bubble, message);
      }

      if (actionCallbacks) {
        const isLastAssistant = i === lastAssistantIndex;
        this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
      }
    }
  }

  private async renderMessageBody(bubble: BubbleRefs, message: ConversationMessage): Promise<void> {
    if (message.role === "assistant" && bubble.role === "assistant") {
      const source = selectAssistantMessageRenderSource(message);
      if (source.kind === "turn") {
        await bubble.turnView.refresh(source.turn, {
          actionLedger: source.actionLedger,
          errorMessage: source.errorMessage,
        });
      } else {
        await bubble.turnView.refreshLegacy(source.source);
      }
      return;
    }
    if (message.role === "user" && bubble.role === "user") {
      await this.renderBubbleContent(bubble, message.content, {
        attachments: message.attachments,
      });
    }
  }

  private async fullRender(
    messages: ConversationMessage[],
    actionCallbacks?: BubbleActionCallbacks,
  ): Promise<void> {
    // Emptying the container drops its scrollTop to 0, so a reader who scrolled
    // up (to edit or delete an older message) is put back where they were.
    const wasAutoScroll = this.shouldAutoScroll;
    const previousScrollTop = this.refs.messagesEl.scrollTop;
    this.clear();
    this.shouldAutoScroll = wasAutoScroll;

    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const bubble = this.createBubble(message.role, message.id);
      await this.renderMessageBody(bubble, message);

      if (actionCallbacks) {
        const isLastAssistant = i === lastAssistantIndex;
        this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
      }
    }

    if (!wasAutoScroll) {
      this.refs.messagesEl.scrollTop = previousScrollTop;
      // A scroll event fired while the container was briefly short may have
      // flipped this on; the reader is still scrolled up.
      this.shouldAutoScroll = false;
    }
  }

  getBubbleForMessage(messageId: string): BubbleRefs | null {
    return this.bubblesByMessageId.get(messageId) ?? null;
  }

  /**
   * Register a bubble that was created outside of `renderMessages` (e.g. by
   * finalization after the assistant message ID is known). Sets the data
   * attribute and adds to the lookup map for later adoption.
   */
  registerBubble(messageId: string, bubble: BubbleRefs): void {
    if (this.draft?.bubble === bubble) this.draft = null;
    const existing = this.bubblesByMessageId.get(messageId);
    if (existing && existing.rowEl !== bubble.rowEl) {
      if (existing.role === "assistant") existing.turnView.destroy();
      existing.rowEl.remove();
      this.renderedMessageIds = this.renderedMessageIds.filter(
        (renderedId) => renderedId !== messageId,
      );
    }
    bubble.rowEl.dataset.messageId = messageId;
    this.bubblesByMessageId.set(messageId, bubble);
  }

  /**
   * Create the bubble a generation streams into. On a regeneration the replaced
   * message stays in the store until the draft commits, so its bubble is hidden
   * meanwhile; committing through `registerBubble()` removes it, and
   * `releaseDraft()` reveals it again on every other exit.
   */
  createDraftBubble(supersededMessageId: string | null = null): AssistantBubbleRefs {
    if (this.draft) this.releaseDraft(this.draft.bubble);
    const bubble = this.createBubble("assistant");
    this.draft = { bubble, supersededMessageId };
    this.setSuperseded(supersededMessageId, true);
    return bubble;
  }

  /** End a draft that was not committed. A no-op once `registerBubble()` took it. */
  releaseDraft(bubble: AssistantBubbleRefs): void {
    if (this.draft?.bubble !== bubble) return;
    this.setSuperseded(this.draft.supersededMessageId, false);
    this.draft = null;
  }

  /** A render rebuilt or appended rows, so the draft goes back to last place. */
  private restoreDraftPlacement(): void {
    if (!this.draft) return;
    this.refs.messagesEl.appendChild(this.draft.bubble.rowEl);
    this.setSuperseded(this.draft.supersededMessageId, true);
  }

  private setSuperseded(messageId: string | null, superseded: boolean): void {
    if (messageId === null) return;
    this.bubblesByMessageId.get(messageId)?.rowEl.toggleClass("is-superseded", superseded);
  }

  /**
   * Adopt bubbles that were created imperatively during the send/generate flow.
   * For each message whose bubble exists in `bubblesByMessageId` but is not yet
   * in `renderedMessageIds`, attach action toolbars. Then update tracking so
   * that subsequent `renderMessages` calls see the full picture.
   */
  adoptPendingBubbles(
    messages: ConversationMessage[],
    actionCallbacks: BubbleActionCallbacks,
  ): void {
    const renderedSet = new Set(this.renderedMessageIds);
    const lastAssistantIndex = this.findLastAssistantIndex(messages);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (renderedSet.has(message.id)) continue;

      const bubble = this.bubblesByMessageId.get(message.id);
      if (!bubble) continue;

      const isLastAssistant = i === lastAssistantIndex;
      this.attachBubbleActions(bubble, message, isLastAssistant, actionCallbacks);
    }

    this.renderedMessageIds = messages.map((m) => m.id);
    this.scrollToBottom();
  }

  async updateBubbleVersion(
    messageId: string,
    messages: ConversationMessage[],
    callbacks: BubbleActionCallbacks
  ): Promise<void> {
    const bubble = this.bubblesByMessageId.get(messageId);
    if (!bubble) return;

    const message = messages.find((m) => m.id === messageId);
    if (!message) return;

    const lastAssistantIndex = this.findLastAssistantIndex(messages);
    const messageIndex = messages.indexOf(message);
    const isLastAssistant = messageIndex === lastAssistantIndex;

    // Scroll anchor: capture toolbar position before content swap
    const oldToolbarEl = bubble.rowEl.querySelector<HTMLElement>(
      ".lmsa-chat-window-bubble-toolbar"
    );
    const anchorY = oldToolbarEl?.getBoundingClientRect().top ?? null;

    await this.renderMessageBody(bubble, message);

    // Replace toolbar, usage badge, and rag sources with updated state
    oldToolbarEl?.remove();
    bubble.rowEl.querySelector(".lmsa-chat-window-usage-badge")?.remove();
    if (bubble.role === "assistant") {
      bubble.turnView.rootEl
        .querySelector(".lmsa-chat-window-rag-sources")
        ?.remove();
    }
    this.attachBubbleActions(bubble, message, isLastAssistant, callbacks);

    // Restore scroll anchor so version nav stays at the same screen position
    if (anchorY !== null) {
      const newToolbarEl = bubble.rowEl.querySelector<HTMLElement>(
        ".lmsa-chat-window-bubble-toolbar"
      );
      if (newToolbarEl) {
        const delta = newToolbarEl.getBoundingClientRect().top - anchorY;
        this.refs.messagesEl.scrollTop += delta;
      }
    }
  }

  createBubble(role: "user", messageId?: string): UserBubbleRefs;
  createBubble(role: "assistant", messageId?: string): AssistantBubbleRefs;
  createBubble(role: "user" | "assistant", messageId?: string): BubbleRefs;
  createBubble(role: "user" | "assistant", messageId?: string): BubbleRefs {
    const rowEl = this.refs.messagesEl.createDiv({
      cls: `lmsa-chat-window-message lmsa-chat-window-message--${role}`,
    });
    if (messageId) {
      rowEl.dataset.messageId = messageId;
    }

    const avatarEl = rowEl.createDiv({ cls: "lmsa-chat-window-message-avatar" });
    setIcon(avatarEl, role === "user" ? "user-round" : "bot");

    const columnEl = rowEl.createDiv({ cls: "lmsa-chat-window-message-column" });
    const chromeEl = columnEl.createDiv({ cls: "lmsa-chat-window-message-chrome" });
    chromeEl.createDiv({
      cls: "lmsa-chat-window-message-role",
      text: role === "user" ? "You" : "Assistant",
    });

    const refs: BubbleRefs =
      role === "assistant"
        ? this.createAssistantBubbleRefs(rowEl, columnEl, chromeEl)
        : this.createUserBubbleRefs(rowEl, columnEl, chromeEl);

    if (messageId) {
      this.bubblesByMessageId.set(messageId, refs);
    }

    this.scrollToBottom();
    return refs;
  }

  setEmptyStateVisible(isVisible: boolean): void {
    this.refs.emptyStateEl.toggleClass("lmsa-empty-view--hidden", !isVisible);
  }

  scrollToBottom(force = false): void {
    if (force || this.shouldAutoScroll) {
      this.refs.messagesEl.scrollTop = this.refs.messagesEl.scrollHeight;
      this.shouldAutoScroll = true;
    }
    this.updateScrollToBottomButton();
  }

  clear(): void {
    for (const bubble of this.bubblesByMessageId.values()) {
      if (bubble.role === "assistant") bubble.turnView.destroy();
    }
    this.markdownRenderer.clearAll();
    this.bubblesByMessageId.clear();
    this.renderedMessageIds = [];
    this.refs.messagesEl.empty();
    this.shouldAutoScroll = true;
    this.updateScrollToBottomButton();
  }

  destroy(): void {
    for (const bubble of this.bubblesByMessageId.values()) {
      if (bubble.role === "assistant") bubble.turnView.destroy();
    }
    this.markdownRenderer.clearAll();
  }

  renderPlainTextContent(bubble: BubbleRefs, text: string): void {
    if (bubble.role === "assistant") {
      void bubble.turnView.refreshLegacy({
        key: bubble.rowEl.dataset.messageId ?? "live-assistant",
        status: "completed",
        content: text,
      });
      return;
    }
    this.markdownRenderer.clear(bubble.contentEl);
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-chat-window-message-content--markdown");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.setText(text);
  }

  async renderBubbleContent(
    bubble: BubbleRefs,
    text: string,
    options: BubbleRenderOptions = {}
  ): Promise<void> {
    if (bubble.role === "assistant") {
      await bubble.turnView.refreshLegacy({
        key: bubble.rowEl.dataset.messageId ?? "live-assistant",
        status: "completed",
        content: text,
      });
      return;
    }
    bubble.bodyEl.removeClass("is-error", "is-muted");
    if (!options.preserveStreaming) {
      bubble.bodyEl.removeClass("is-streaming");
    }

    if (options.attachments?.length) {
      const markdownHostEl = this.prepareBubbleContentWithAttachments(bubble, options.attachments);
      if (!text) return;

      try {
        await this.markdownRenderer.render(markdownHostEl, text);
      } catch {
        this.prepareBubbleContentWithAttachments(bubble, options.attachments).setText(text);
      }
      return;
    }

    bubble.contentEl.removeClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--markdown");

    try {
      await this.markdownRenderer.render(bubble.contentEl, text);
    } catch {
      this.renderPlainTextContent(bubble, text);
    }
  }

  private renderAttachmentGallery(containerEl: HTMLElement, attachments: Attachment[]): void {
    // Note snapshots embed their own images, so don't double-render those in the
    // gallery, only directly attached images get thumbnails.
    const galleryAttachments = attachments.filter(
      (a) => a.type === "note" || (a.type === "image" && !a.sourceNotePath),
    );
    if (galleryAttachments.length === 0) return;

    const galleryEl = containerEl.createDiv({ cls: "lmsa-chat-window-attachment-gallery" });
    for (const attachment of galleryAttachments) {
      if (attachment.type === "image") {
        const imageSrc = `data:${attachment.mimeType};base64,${attachment.data}`;
        const imageAlt = attachment.fileName ?? "Image attachment";
        const thumbEl = galleryEl.createEl("button", {
          cls: "lmsa-chat-window-attachment-thumb",
          attr: {
            type: "button",
            "aria-label": `Open ${imageAlt}`,
          },
        });
        thumbEl.createEl("img", {
          cls: "lmsa-chat-window-attachment-img",
          attr: {
            src: imageSrc,
            alt: imageAlt,
          },
        });

        thumbEl.addEventListener("click", () => {
          new ImagePreviewModal(this.app, imageSrc, imageAlt).open();
        });
      } else if (attachment.type === "note") {
        const chipEl = galleryEl.createDiv({ cls: "lmsa-chat-window-attachment-note" });
        setIcon(chipEl.createSpan({ cls: "lmsa-chat-window-attachment-note-icon" }), "file-text");
        chipEl.createSpan({
          cls: "lmsa-chat-window-attachment-note-label",
          text: attachment.truncated ? `${attachment.fileName} · truncated` : attachment.fileName,
        });
      }
    }
  }

  private prepareBubbleContentWithAttachments(
    bubble: UserBubbleRefs,
    attachments: Attachment[]
  ): HTMLElement {
    this.markdownRenderer.clear(bubble.contentEl);
    bubble.contentEl.empty();
    bubble.contentEl.removeClass("lmsa-chat-window-message-content--plain");
    bubble.contentEl.addClass("lmsa-chat-window-message-content--markdown");
    this.renderAttachmentGallery(bubble.contentEl, attachments);
    return bubble.contentEl.createDiv({ cls: "lmsa-chat-window-message-markdown-host" });
  }

  private isNearBottom(): boolean {
    const distanceFromBottom =
      this.refs.messagesEl.scrollHeight -
      this.refs.messagesEl.scrollTop -
      this.refs.messagesEl.clientHeight;

    return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }
  private findLastAssistantIndex(messages: ConversationMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }

  private attachBubbleActions(
    bubble: BubbleRefs,
    message: ConversationMessage,
    isLastAssistant: boolean,
    callbacks: BubbleActionCallbacks
  ): void {
    // Usage badge, shown below assistant bubbles before the toolbar.
    if (message.role === "assistant") {
      const activeRevision = getActiveAssistantRevision(message);
      if (bubble.role === "assistant") {
        bubble.turnView.setActionReviewContext(
          (entry, targetId) =>
            callbacks.getActionEligibility(
              message.id,
              entry.actionRef,
              targetId,
            ),
          (entry, targetId, control) =>
            callbacks.onActionControl(
              message.id,
              entry.actionRef,
              targetId,
              control,
            ),
        );
      }
      renderUsageBadge(
        bubble.rowEl,
        activeRevision?.usage ?? message.usage,
        activeRevision?.modelId ?? message.modelId,
        activeRevision?.provider ?? message.provider,
        activeRevision?.kind === "turn"
          ? activeRevision.replayEvidence
          : undefined,
      );
      if (message.ragSources?.length && bubble.role === "assistant") {
        renderRagSources(
          bubble.turnView.rootEl,
          message.ragSources,
          this.app,
          message.rewrittenQuery,
        );
      }
    }

    const toolbarEl = bubble.rowEl.createDiv({ cls: "lmsa-chat-window-bubble-toolbar" });

    if (message.role === "assistant") {
      BubbleVersionNav.render(toolbarEl, message, callbacks.onVersionChange);
    }

    BubbleActionToolbar.render(toolbarEl, message, {
      isLastAssistant,
      callbacks,
    });
  }

  private createUserBubbleRefs(
    rowEl: HTMLElement,
    columnEl: HTMLElement,
    chromeEl: HTMLElement,
  ): UserBubbleRefs {
    const bodyEl = columnEl.createDiv({
      cls: "lmsa-chat-window-message-body lmsa-ui-card",
    });
    const contentEl = bodyEl.createDiv({
      cls: "lmsa-chat-window-message-content",
    });
    return {
      role: "user",
      rowEl,
      columnEl,
      chromeEl,
      bodyEl,
      contentEl,
    };
  }

  private createAssistantBubbleRefs(
    rowEl: HTMLElement,
    columnEl: HTMLElement,
    chromeEl: HTMLElement,
  ): AssistantBubbleRefs {
    const turnHostEl = rowEl.createDiv({
      cls: "lmsa-chat-window-assistant-turn-host",
    });
    const turnView = new AssistantTurnView(
      turnHostEl,
      this.app,
      this.markdownRenderer,
      () => this.scrollToBottom(),
    );
    return {
      role: "assistant",
      rowEl,
      columnEl,
      chromeEl,
      turnHostEl,
      turnView,
    };
  }
}
