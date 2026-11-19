import type {
  ApprovalPosture,
  AssistantMessageRevision,
  ClaudeCodeResumeCursor,
  CompletionModel,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  EffectIntentRequest,
  EffectRunOwnership,
  GenerationAuditIdentity,
  GenerationAuditRecorder,
  InFlightGenerationAudit,
  ProviderOption,
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../shared/types";
import type WritingAssistantChat from "../../main";
import { resolveCompletionModel } from "../../utils";
import {
  createConversation,
  generateConversationTitle,
  pruneHistory,
  toConversationMeta,
} from "./conversationUtils";
import type { ConversationStorage } from "./ConversationStorage";
import type { ChatSessionSnapshot } from "../types";
import { ChatSessionMemory } from "./ChatSessionMemory";
import { ConversationSearch, type ConversationSearchHit } from "./ConversationSearch";
import type {
  ActionControlEligibility,
  SupersessionEventIdentity,
} from "./actionLedger";
import type { ProseItemEdit } from "./assistantRevisions";
import { buildOrphanRecoveryMessage } from "./generationAuditRecovery";

const CHAT_DRAFT_SAVE_DELAY_MS = 300;

/**
 * Thin coordinator: delegates in-memory state to ChatSessionMemory,
 * disk I/O to ConversationStorage, and metadata to plugin settings.
 *
 * The public API is unchanged from the pre-split version so that
 * consumers (ChatView, actions, finalization) don't need updating.
 */
export class ChatSessionStore {
  private readonly memory = new ChatSessionMemory();
  private draftSaveTimer: number | null = null;
  private readonly search: ConversationSearch;

  constructor(
    private readonly plugin: WritingAssistantChat,
    private readonly storage: ConversationStorage,
  ) {
    this.search = new ConversationSearch({
      getActiveId: () => this.memory.getActiveConversationId(),
      getActiveMessages: () => this.memory.getSnapshot().messageHistory,
      loadConversation: (id) => this.storage.load(id),
    });
  }

  // ── History search ──────────────────────────────────────────────

  /**
   * Find conversations whose title, model, or message body matches `query`.
   * Body text is scanned on demand (index-free) and cached per conversation; the
   * cache is invalidated on save/delete and released via {@link clearSearchCache}
   * when the drawer closes.
   */
  searchConversations(query: string): Promise<ConversationSearchHit[]> {
    return this.search.search(query, this.getConversations());
  }

  /** Release cached conversation bodies (called when the history drawer closes). */
  clearSearchCache(): void {
    this.search.clear();
  }

  // ── Read-through to memory ──────────────────────────────────────

  getSnapshot(): ChatSessionSnapshot {
    return this.memory.getSnapshot();
  }

  getActiveConversationId(): string | null {
    return this.memory.getActiveConversationId();
  }

  /**
   * The active conversation's Claude Code resume cursor (ADR-0016), read at the start
   * of a turn so the session registry can attempt a disk `resume` before a synthetic
   * rebuild. Undefined when no claudecode turn has banked one.
   */
  getClaudeCodeResumeCursor(): ClaudeCodeResumeCursor | undefined {
    return this.memory.getClaudeCodeResumeCursor();
  }

  getActiveConversationMeta(): ConversationMeta | null {
    return this.findMeta(this.memory.getActiveConversationId());
  }

  /**
   * The active conversation's approval posture. Sourced from the meta (the
   * authoritative, settings-persisted copy, like the model), so it survives a
   * reload even if the posture was changed without sending a turn. Defaults to
   * `ask` for a legacy conversation whose meta predates the field.
   */
  getActivePosture(): ApprovalPosture {
    return this.getActiveConversationMeta()?.approvalPosture ?? "ask";
  }

  /**
   * Record a posture change for the active conversation and persist it. Writes
   * the meta and saves settings (mirrors {@link setActiveConversationModel}); the
   * next {@link persistActiveConversation} carries it onto the stored file.
   */
  setActivePosture(posture: ApprovalPosture): void {
    const meta = this.findMeta(this.memory.getActiveConversationId());
    if (!meta) return;
    meta.approvalPosture = posture;
    void this.plugin.saveSettings();
  }

  getConversations(): ConversationMeta[] {
    return this.plugin.settings.chatHistory.conversations;
  }

  getResolvedConversationModel(
    meta: ConversationMeta | null = this.findMeta(this.memory.getActiveConversationId()),
  ): CompletionModel | null {
    return meta ? resolveCompletionModel(this.plugin.settings, meta.modelId) : null;
  }

  // ── Write-through to memory ─────────────────────────────────────

  setDraft(draft: string): void {
    this.memory.setDraft(draft);
  }

  appendMessage(message: ConversationMessage): void {
    this.memory.appendMessage(message);
  }

  setLastAssistantResponse(text: string): void {
    this.memory.setLastAssistantResponse(text);
  }

  updateUserMessageContent(messageId: string, newContent: string): boolean {
    return this.memory.updateUserMessageContent(messageId, newContent);
  }

  editLegacyAssistantContent(
    messageId: string,
    text: string,
    provider: ProviderOption,
    modelId: string,
  ): boolean {
    return this.memory.editLegacyAssistantContent(
      messageId,
      text,
      provider,
      modelId,
    );
  }

  editAssistantTurnProse(
    messageId: string,
    edits: readonly ProseItemEdit[],
  ): boolean {
    return this.memory.editAssistantTurnProse(messageId, edits);
  }

  getActionControlEligibility(
    messageId: string,
    actionRef: string,
    targetId: string,
    driftGuardAllowsUndo = true,
  ): ActionControlEligibility {
    return this.memory.getActionControlEligibility(
      messageId,
      actionRef,
      targetId,
      driftGuardAllowsUndo,
    );
  }

  appendEligibleActionEvent(
    messageId: string,
    actionRef: string,
    event: ToolActionEvent,
    driftGuardAllowsUndo = true,
  ): boolean {
    return this.memory.appendEligibleActionEvent(
      messageId,
      actionRef,
      event,
      driftGuardAllowsUndo,
    );
  }

  // ── In-flight generation audit (ADR-0033) ──────────────────────

  /**
   * Opens one generation's durable write-ahead audit and hands back the recorder
   * its effect boundaries write through.
   *
   * The audit is keyed by the draft identity the generation already owns, and the
   * lease rides on the record as evidence. The Claude generation lease ID and the
   * attempt identity are different namespaces because `getRuntime()` mints the
   * generation lease before a turn ID exists (ADR-0033).
   *
   * `recordIntent` resolves only after the conversation is on disk, so awaiting it
   * is what makes the evidence write-ahead rather than merely intended. It refuses
   * once the audit is closed: after the terminal fold there is nowhere to record a
   * crossing, so a late one must not act.
   */
  openGenerationAudit(identity: GenerationAuditIdentity): GenerationAuditRecorder {
    this.memory.openGenerationAudit(identity);
    return {
      recordIntent: (request, ownership) =>
        this.appendGenerationIntent(identity, request, ownership),
      reconcileIntent: (request) => this.reconcileGenerationIntent(identity, request),
    };
  }

  getGenerationAudit(): InFlightGenerationAudit | null {
    return this.memory.getGenerationAudit();
  }

  /** Converts every unreconciled intent to `outcome_unknown` before the fold. */
  markGenerationIntentsUnknown(): InFlightGenerationAudit | null {
    return this.memory.markGenerationIntentsUnknown();
  }

  /** Closes the audit, returning what it held. Persisting is the caller's step. */
  clearGenerationAudit(): InFlightGenerationAudit | null {
    return this.memory.clearGenerationAudit();
  }

  restoreGenerationAudit(audit: InFlightGenerationAudit | null): void {
    this.memory.restoreGenerationAudit(audit);
  }

  /**
   * Finalizes an audit found on disk (ADR-0033).
   *
   * An audit that survived a load belongs to a generation that never reached its
   * terminal transaction, so it becomes one failed revision carrying every
   * intent's evidence and is then cleared. Idempotent: when the message it names
   * already exists, the terminal record is already there and the audit is just
   * dropped, which is the crash-between-the-write-and-the-clear case.
   */
  private async recoverOrphanedGenerationAudit(): Promise<void> {
    const audit = this.memory.getGenerationAudit();
    if (!audit) return;
    const known = this.memory
      .getSnapshot()
      .messageHistory.some((message) => message.id === audit.messageId);
    if (!known) {
      this.memory.appendMessage(buildOrphanRecoveryMessage(audit));
    }
    this.memory.clearGenerationAudit();
    await this.persistActiveConversation();
  }

  private async appendGenerationIntent(
    identity: GenerationAuditIdentity,
    request: EffectIntentRequest,
    ownership: EffectRunOwnership,
  ): Promise<void> {
    if (!this.memory.isGenerationAuditOpen(identity)) {
      throw new Error(
        "This generation's write-ahead audit is closed, so no further effect may be recorded.",
      );
    }
    const restore = structuredClone(this.memory.getGenerationAudit());
    this.memory.appendGenerationIntent(identity, request, ownership);
    try {
      await this.persistActiveConversation();
    } catch (error) {
      // An intent that did not reach disk must not be left in memory looking
      // durable: the boundary that asked for it is about to refuse.
      this.memory.clearGenerationAudit();
      this.memory.openGenerationAudit(identity);
      this.memory.restoreGenerationAudit(restore);
      throw error;
    }
  }

  private async reconcileGenerationIntent(
    identity: GenerationAuditIdentity,
    request: EffectIntentRequest,
  ): Promise<void> {
    this.memory.reconcileGenerationIntent(identity, request);
    try {
      await this.persistActiveConversation();
    } catch {
      // The effect has already happened, so there is nothing left to gate. An
      // unpersisted reconciliation reads as `outcome_unknown` on reload, which
      // overstates the uncertainty in the safe direction.
    }
  }

  removeMessage(messageId: string): ConversationMessage | null {
    return this.memory.removeMessage(messageId);
  }

  removeLastMessage(): ConversationMessage | null {
    return this.memory.removeLastMessage();
  }

  getMessagesUpToInclusive(messageId: string): ConversationMessage[] {
    return this.memory.getMessagesUpToInclusive(messageId);
  }

  switchMessageRevision(messageId: string, revisionId: string): boolean {
    return this.memory.switchMessageRevision(messageId, revisionId);
  }

  commitRevisionReplacement(
    messageId: string,
    revision: AssistantMessageRevision,
    identity: (
      actionRef: string,
      targetId: string,
      index: number,
    ) => SupersessionEventIdentity,
    newActionLedger: ToolActionLedgerEntry[] = [],
  ): boolean {
    return this.memory.commitRevisionReplacement(
      messageId,
      revision,
      identity,
      newActionLedger,
    );
  }

  ensureConversationTitleFromFirstUserMessage(text: string): boolean {
    if (this.memory.getSnapshot().messageHistory.length > 0) return false;

    const meta = this.findMeta(this.memory.getActiveConversationId());
    if (!meta || meta.title) return false;

    meta.title = generateConversationTitle(text);
    return true;
  }

  // ── Coordinated operations (memory + persistence) ───────────────

  async restorePersistedState(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const currentId = history.activeConversationId;

    if (currentId) {
      const conversation = await this.storage.load(currentId);
      if (conversation) {
        this.hydrate(conversation);
        await this.recoverOrphanedGenerationAudit();
        return;
      }
    }

    if (history.conversations.length > 0) {
      const firstId = history.conversations[0].id;
      const conversation = await this.storage.load(firstId);
      if (conversation) {
        this.hydrate(conversation);
        await this.recoverOrphanedGenerationAudit();
        return;
      }
    }

    const freshConversation = createConversation("", "");
    history.conversations.unshift(toConversationMeta(freshConversation));
    history.activeConversationId = freshConversation.id;
    this.hydrate(freshConversation);
  }

  async setActiveConversationModel(model: CompletionModel): Promise<void> {
    const meta = this.findMeta(this.memory.getActiveConversationId());
    if (!meta) return;

    meta.modelId = model.id;
    meta.modelName = model.name;
    this.memory.setActiveModel(model.id, model.name);
    await this.plugin.saveSettings();
  }

  async newConversation(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const conversation = createConversation(
      this.memory.getActiveModelId(),
      this.memory.getActiveModelName(),
    );

    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrate(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  async switchToConversation(id: string): Promise<boolean> {
    if (id === this.memory.getActiveConversationId()) return false;

    const meta = this.findMeta(id);
    if (!meta) return false;

    const conversation = await this.storage.load(id);
    if (!conversation) return false;

    this.hydrate(conversation);
    await this.recoverOrphanedGenerationAudit();
    await this.plugin.saveSettings();
    return true;
  }

  async addAndSwitchToConversation(conversation: Conversation): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrate(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  /**
   * Rename a conversation. The title is otherwise frozen to the first user message
   * (ensureConversationTitleFromFirstUserMessage), so this is the only way to relabel a
   * thread. Updates the drawer-facing meta and keeps the stored file's title in sync.
   * Returns false when the id is unknown or the (trimmed) title is empty or unchanged.
   */
  async renameConversation(id: string, title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) return false;

    const meta = this.findMeta(id);
    if (!meta || meta.title === trimmed) return false;

    meta.title = trimmed;

    if (id === this.memory.getActiveConversationId()) {
      // The active conversation persists meta.title to its file and re-derives meta.
      await this.persistActiveConversation();
    } else {
      // Non-active: keep the stored file's title aligned with the meta.
      const conversation = await this.storage.load(id);
      if (conversation) {
        conversation.title = trimmed;
        await this.storage.save(conversation);
      }
      await this.plugin.saveSettings();
    }
    return true;
  }

  async deleteConversation(id: string): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const isActiveConversation = id === this.memory.getActiveConversationId();

    history.conversations = history.conversations.filter((meta) => meta.id !== id);
    await this.storage.delete(id);
    this.search.invalidate(id);

    if (isActiveConversation) {
      if (history.conversations.length > 0) {
        const firstId = history.conversations[0].id;
        const conversation = await this.storage.load(firstId);
        if (conversation) {
          this.hydrate(conversation);
          await this.recoverOrphanedGenerationAudit();
        } else {
          this.hydrateWithFresh(history);
        }
      } else {
        this.hydrateWithFresh(history);
      }
    }

    await this.plugin.saveSettings();
  }

  /**
   * @param options.leaving The view is about to move off this conversation (new,
   *   switch, close). Only then is an empty, untitled conversation discarded: a
   *   save while it is still shown (the draft timer after the composer is cleared)
   *   must keep its meta, or the open view loses its model and cannot set one.
   */
  async persistActiveConversation(options: { leaving?: boolean } = {}): Promise<void> {
    const id = this.memory.getActiveConversationId();
    if (!id) return;

    const history = this.plugin.settings.chatHistory;
    const metaIndex = history.conversations.findIndex((meta) => meta.id === id);
    if (metaIndex === -1) return;

    const cleanMessages = this.memory.getCleanMessagesForPersistence();
    const snapshot = this.memory.getSnapshot();
    const isEmptyConversation = cleanMessages.length === 0 && !snapshot.draft.trim();
    const meta = history.conversations[metaIndex];

    if (options.leaving && isEmptyConversation && !meta.title) {
      history.conversations.splice(metaIndex, 1);
      await this.storage.delete(id);
      this.search.invalidate(id);
      if (history.activeConversationId === id) {
        history.activeConversationId = history.conversations[0]?.id ?? null;
      }
      await this.plugin.saveSettings();
      return;
    }

    const conversation: Conversation = {
      id,
      title: meta.title,
      createdAt: this.memory.getActiveCreatedAt() || meta.createdAt,
      updatedAt: Date.now(),
      modelId: meta.modelId,
      modelName: meta.modelName,
      messages: cleanMessages,
      draft: snapshot.draft,
      approvalPosture: meta.approvalPosture ?? "ask",
      ...this.memory.getActiveBranchOrigin(),
      // Durable write-ahead evidence for a generation still in flight. This is
      // the write half of the round trip: the loader has preserved an orphaned
      // audit through loading, but nothing ever wrote one (ADR-0033).
      ...(this.memory.getGenerationAudit()
        ? { inFlightGenerationAudit: this.memory.getGenerationAudit() as InFlightGenerationAudit }
        : {}),
    };
    await this.storage.save(conversation);
    // The active thread is served live during search, but once it is switched away
    // its stored body changed, so drop any cache entry from before it was active.
    this.search.invalidate(id);

    history.conversations[metaIndex] = toConversationMeta(conversation);
    await this.plugin.saveSettings();
  }

  // ── Draft save scheduling ───────────────────────────────────────

  scheduleDraftSave(): void {
    this.clearDraftSaveTimer();
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.persistActiveConversation();
    }, CHAT_DRAFT_SAVE_DELAY_MS);
  }

  clearDraftSaveTimer(): void {
    if (this.draftSaveTimer === null) return;

    window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
  }

  // ── Internal helpers ────────────────────────────────────────────

  private findMeta(id: string | null): ConversationMeta | null {
    if (!id) return null;
    return this.plugin.settings.chatHistory.conversations.find((meta) => meta.id === id) ?? null;
  }

  private hydrate(conversation: Conversation): void {
    this.memory.hydrateFromConversation(conversation);
    this.plugin.settings.chatHistory.activeConversationId = conversation.id;
  }

  private hydrateWithFresh(history: { conversations: ConversationMeta[]; activeConversationId: string | null }): void {
    const freshConversation = createConversation("", "");
    history.conversations.unshift(toConversationMeta(freshConversation));
    this.hydrate(freshConversation);
  }
}
