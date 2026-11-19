import type { Component } from "obsidian";
import { Notice } from "obsidian";
import type { ConversationMessage } from "../shared/types";
import type WritingAssistantChat from "../main";
import { createChatClient } from "../providers/registry";
import { PLUGIN_UNLOAD_ABORT_REASON } from "../api/assistantStreamRun";
import type { ChatComposer } from "./composer/ChatComposer";
import type { ComposerInteractionHost } from "./interactions/ComposerInteractionHost";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import type { ChatTranscript } from "./messages/ChatTranscript";
import type { ChatModelSelector } from "./models/ChatModelSelector";
import type { ChatLayoutRefs } from "./types";
import { sendMessage } from "./actions/sendMessage";
import { generateLlmResponse } from "./actions/generateLlmResponse";
import { regenerateMessage } from "./actions/regenerateMessage";
import { assistantHasCompletedAskGuidance } from "./conversation/assistantRevisions";

export type GenerationOrchestratorDeps = {
  plugin: WritingAssistantChat;
  owner: Component;
  getStore: () => ChatSessionStore | null;
  getTranscript: () => ChatTranscript | null;
  getComposer: () => ChatComposer | null;
  getInteractionHost: () => ComposerInteractionHost | null;
  getModelSelector: () => ChatModelSelector | null;
  getContextUpdater: () => ContextCapacityUpdater | null;
  getLayout: () => ChatLayoutRefs | null;
  syncConversationUi: () => Promise<void>;
  postGenerationSync: () => Promise<void>;
};

export class ChatGenerationOrchestrator {
  private isGenerating = false;
  private activeAbortController: AbortController | null = null;
  /** Every entry point still running, through its post-generation sync. */
  private readonly runs = new Set<Promise<void>>();
  /**
   * A stop that arrived before the run armed its controller (availability check,
   * runtime resolution). It is applied the moment the controller is armed.
   */
  private pendingStopCause: "user" | "unload" | null = null;

  constructor(private readonly deps: GenerationOrchestratorDeps) {}

  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  setIsGenerating(generating: boolean): void {
    this.isGenerating = generating;
    this.deps.getComposer()?.setSendingState(generating);

    const snapshot = this.deps.getStore()?.getSnapshot();
    this.deps.getTranscript()?.setEmptyStateVisible(
      Boolean(snapshot && snapshot.messageHistory.length === 0 && !generating)
    );
  }

  /**
   * @param cause `"unload"` when the plugin or view is being torn down. It rides
   *   the abort itself so the provider-run owner cancels with `plugin_unload`
   *   rather than `user_stop`: only a user Stop may preserve a Claude session for
   *   reuse, and a session being torn down is not one to preserve (ADR-0032).
   */
  stopGeneration(cause: "user" | "unload" = "user"): Promise<void> {
    if (this.runs.size > 0) this.pendingStopCause = cause;
    this.abortActive(cause);
    return this.whenSettled();
  }

  /**
   * Resolves once every run has settled, its terminal write included. Never
   * rejects; the run's own caller is the one told about its failure.
   *
   * The store writes to whichever conversation is active, so anything about to
   * load another conversation awaits this first, or a run still winding down
   * lands its turn in the conversation that replaced its own.
   */
  private whenSettled(): Promise<void> {
    return Promise.all([...this.runs]).then(() => undefined);
  }

  private abortActive(cause: "user" | "unload"): void {
    if (!this.activeAbortController) return;
    this.activeAbortController.abort(
      cause === "unload" ? PLUGIN_UNLOAD_ABORT_REASON : undefined,
    );
    this.activeAbortController = null;
  }

  private armAbortController(controller: AbortController | null): void {
    this.activeAbortController = controller;
    if (controller && this.pendingStopCause) this.abortActive(this.pendingStopCause);
  }

  private async track(run: () => Promise<void>): Promise<void> {
    const running = run();
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.runs.add(settled);
    try {
      await running;
    } finally {
      this.runs.delete(settled);
      if (this.runs.size === 0) this.pendingStopCause = null;
    }
  }

  send(promptOverride?: string, autoInsertAfterResponse = false): Promise<void> {
    return this.track(() => this.runSend(promptOverride, autoInsertAfterResponse));
  }

  regenerate(messageId: string): Promise<void> {
    return this.track(() => this.runRegenerate(messageId));
  }

  generateResponse(): Promise<void> {
    return this.track(() => this.runGenerateResponse());
  }

  private async runSend(
    promptOverride: string | undefined,
    autoInsertAfterResponse: boolean,
  ): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const interactionHost = this.deps.getInteractionHost();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !interactionHost || !modelSelector) return;

    const posture = composer.getPosture();

    await sendMessage({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      composer,
      modelSelector,
      interactionHost,
      getIsGenerating: () => this.isGenerating,
      setIsGenerating: (sending) => this.setIsGeneratingAndSync(sending),
      setActiveAbortController: (controller) => this.armAbortController(controller),
      syncConversationUi: () => this.deps.syncConversationUi(),
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
      onEnterAutoApply: () => this.enterAutoApply(),
      promptOverride,
      autoInsertAfterResponse,
      posture,
    });
    await this.deps.postGenerationSync();
  }

  private async runRegenerate(messageId: string): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const interactionHost = this.deps.getInteractionHost();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !interactionHost || !modelSelector) return;

    await regenerateMessage({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      composer,
      modelSelector,
      interactionHost,
      messageId,
      getIsGenerating: () => this.isGenerating,
      setIsGenerating: (generating) => this.setIsGeneratingAndSync(generating),
      setActiveAbortController: (controller) => this.armAbortController(controller),
      syncConversationUi: () => this.deps.syncConversationUi(),
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
      onEnterAutoApply: () => this.enterAutoApply(),
    });
    await this.deps.postGenerationSync();
  }

  private async runGenerateResponse(): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const interactionHost = this.deps.getInteractionHost();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !interactionHost || !modelSelector) return;
    if (this.isGenerating) return;

    const snapshot = store.getSnapshot();
    if (snapshot.messageHistory.length === 0) return;

    const lastMessage = snapshot.messageHistory[snapshot.messageHistory.length - 1];
    if (lastMessage.role !== "user" && !lastMessage.isError) return;

    const activeModel = store.getResolvedConversationModel();
    if (!activeModel?.modelId) {
      new Notice("No model selected.");
      return;
    }

    const availabilityState = await modelSelector.refreshAvailability();
    if (availabilityState !== "loaded" && availabilityState !== "cloud") {
      modelSelector.retriggerAttention();
      return;
    }

    // Remove trailing error messages before generating.
    let removed = false;
    while (store.getSnapshot().messageHistory.length > 0) {
      const msgs = store.getSnapshot().messageHistory;
      const tail = msgs[msgs.length - 1];
      if (tail.isError && !assistantHasCompletedAskGuidance(tail)) {
        store.removeLastMessage();
        removed = true;
      } else {
        break;
      }
    }
    if (removed) {
      await store.persistActiveConversation();
      await this.deps.syncConversationUi();
    }

    if (store.getSnapshot().messageHistory.length === 0) return;

    const posture = composer.getPosture();
    const runtime = await this.deps.plugin.services.claudeCode.getRuntime(
      activeModel.provider,
      {
        posture,
        activeFilePath: this.deps.plugin.app.workspace.getActiveFile()?.path,
        conversationId: store.getActiveConversationId() ?? undefined,
        resumeCursor: store.getClaudeCodeResumeCursor(),
        contextWindow: this.deps.plugin.services.modelAvailability.resolveContextWindow(activeModel),
      },
    );
    const client = createChatClient(
      activeModel.provider,
      this.deps.plugin.settings.providerSettings,
      this.deps.plugin.services.credentials,
      runtime,
    );

    this.setIsGeneratingAndSync(true);

    await generateLlmResponse({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      activeModel,
      client,
      interactionHost,
      posture,
      ...(runtime?.generation ? { claudeGeneration: runtime.generation } : {}),
      finalization: { kind: "append" },
      setIsGenerating: (v) => this.setIsGeneratingAndSync(v),
      setActiveAbortController: (controller) => this.armAbortController(controller),
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
      onEnterAutoApply: () => this.enterAutoApply(),
    });
    await this.deps.postGenerationSync();
  }

  /** Flip the composer into auto-apply ("Edit automatically"), used by the edit review's
   * "Accept all this session" action so subsequent turns apply edits without gating. */
  private enterAutoApply(): void {
    this.deps.getComposer()?.setPosture("auto");
  }

  private setIsGeneratingAndSync(generating: boolean): void {
    this.setIsGenerating(generating);
    const messages = this.deps.getStore()?.getSnapshot().messageHistory ?? [];
    this.updateGenerateResponseButton(messages);
  }

  updateGenerateResponseButton(messages: ConversationMessage[]): void {
    const btn = this.deps.getLayout()?.generateResponseBtn;
    if (!btn) return;

    const shouldShow =
      !this.isGenerating &&
      messages.length > 0 &&
      (messages[messages.length - 1].role === "user" ||
        messages[messages.length - 1].isError === true);

    btn.toggleClass("lmsa-hidden", !shouldShow);
  }
}
