import type { WorkspaceLeaf } from "obsidian";
import { ItemView, Keymap } from "obsidian";
import type { ApprovalPosture, ProviderProfile, ReasoningLevel } from "../shared/types";
import type { DocumentContext } from "../shared/chatRequest";
import type WritingAssistantChat from "../main";
import { VIEW_TYPE_CHAT, makeDefaultProfile } from "../constants";
import { getActiveProfile, getProfilesForProvider, generateProfileId } from "../shared/profileUtils";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { resolveModelReasoning, resolveReasoningLevels } from "../providers/reasoningLevels";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../providers/selectableModels";
import { resolveVisionSupport } from "../api/ModelAvailabilityService";
import { getActiveNoteText } from "../context/noteContext";
import { ChatBubbleActionHandler } from "./ChatBubbleActionHandler";
import { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";
import { ChatConversationController } from "./ChatConversationController";
import type { ContextInputs } from "./ContextCapacityUpdater";
import { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import { lastReportedContextWindow } from "../shared/tokenEstimation";
import { renderLegacyReviewPanels } from "./finalization/legacyReviewPanels";
import { ChatComposer } from "./composer/ChatComposer";
import { ComposerOverflowMenu } from "./composer/ComposerOverflowMenu";
import { ReasoningPill } from "./composer/ReasoningPill";
import { PosturePill } from "./composer/PosturePill";
import { ContextPickerPopover } from "./composer/ContextPickerPopover";
import { KnowledgePopover } from "./composer/KnowledgePopover";
import { createMemoriesSectionCallbacks } from "./composer/memoriesSection";
import { ToolUsePopover } from "./composer/ToolUsePopover";
import { ChatSessionStore } from "./conversation/ChatSessionStore";
import { ComposerInteractionHost } from "./interactions/ComposerInteractionHost";
import { ChatTranscript } from "./messages/ChatTranscript";
import { ChatModelSelector } from "./models/ChatModelSelector";
import { pluginModelDropdownDeps } from "./models/ModelDropdownView";
import { ProfileSettingsPopover } from "./models/ProfileSettingsPopover";
import type { ChatLayoutRefs } from "./types";
import { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import { createChatLayout } from "./view/createChatLayout";
import { EmptyStateCarousel } from "./view/EmptyStateCarousel";

const NO_MODEL_SELECTED_LABEL = "No model selected";
/** Below this width the "widen the panel" overlay replaces the chat. */
const MIN_VIEW_WIDTH_PX = 190;

export class ChatView extends ItemView {
  plugin: WritingAssistantChat;

  private layout: ChatLayoutRefs | null = null;
  private sessionStore: ChatSessionStore | null = null;
  private transcript: ChatTranscript | null = null;
  private emptyStateCarousel: EmptyStateCarousel | null = null;
  private composer: ChatComposer | null = null;
  private interactionHost: ComposerInteractionHost | null = null;
  private modelSelector: ChatModelSelector | null = null;
  private profilePopover: ProfileSettingsPopover | null = null;
  private contextPickerPopover: ContextPickerPopover | null = null;
  private knowledgePopover: KnowledgePopover | null = null;
  private toolUsePopover: ToolUsePopover | null = null;
  private reasoningPill: ReasoningPill | null = null;
  private posturePill: PosturePill | null = null;
  private overflowMenu: ComposerOverflowMenu | null = null;
  private historyDrawer: ChatHistoryDrawer | null = null;
  private contextUpdater: ContextCapacityUpdater | null = null;
  private orchestrator!: ChatGenerationOrchestrator;
  private conversation!: ChatConversationController;
  private bubbleActions!: ChatBubbleActionHandler;
  private lastRenderedConversationId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cachedDocumentContext: DocumentContext | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: WritingAssistantChat) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Writing assistant";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.layout = createChatLayout(this.contentEl);
    this.sessionStore = new ChatSessionStore(this.plugin, this.plugin.services.conversationStorage);
    this.transcript = new ChatTranscript(this, this.app, this.layout);
    this.emptyStateCarousel = new EmptyStateCarousel(this.layout.emptyCopyEl);

    this.orchestrator = new ChatGenerationOrchestrator({
      plugin: this.plugin,
      owner: this,
      getStore: () => this.sessionStore,
      getTranscript: () => this.transcript,
      getComposer: () => this.composer,
      getInteractionHost: () => this.interactionHost,
      getModelSelector: () => this.modelSelector,
      getContextUpdater: () => this.contextUpdater,
      getLayout: () => this.layout,
      syncConversationUi: () => this.syncConversationUi(),
      postGenerationSync: () => this.postGenerationSync(),
    });

    this.conversation = new ChatConversationController({
      getStore: () => this.sessionStore,
      getDrawer: () => this.historyDrawer,
      getOrchestrator: () => this.orchestrator,
      syncConversationUi: () => this.syncConversationUi(),
      refreshAvailability: async () => {
        await this.modelSelector?.refreshAvailability();
        this.refreshComposerIndicators();
      },
      onNewConversation: () => {
        this.composer?.resetContextForNewConversation();
      },
    });

    this.contextUpdater = new ContextCapacityUpdater(this.layout.contextCapacityEl);

    this.bubbleActions = new ChatBubbleActionHandler({
      plugin: this.plugin,
      getStore: () => this.sessionStore,
      getTranscript: () => this.transcript,
      getOrchestrator: () => this.orchestrator,
      getContextUpdater: () => this.contextUpdater,
      syncConversationUi: () => this.syncConversationUi(),
      buildContextInputs: () => this.buildContextInputs(),
    });

    this.composer = new ChatComposer(this.app, this.plugin, this.layout, {
      onDraftChange: (draft) => {
        this.sessionStore?.setDraft(draft);
        this.sessionStore?.scheduleDraftSave();
        this.contextUpdater?.scheduleUpdate(this.buildContextInputs(draft));
      },
      onSendRequest: () => {
        void this.orchestrator.send();
      },
      onStopRequest: () => {
        void this.orchestrator.stopGeneration();
      },
      onPostureChange: (posture) => {
        // Persist per conversation so a reload or a switch restores this thread's
        // own choice (a new conversation resets to `ask`, a branch inherits).
        this.sessionStore?.setActivePosture(posture);
        if (this.layout) {
          this.layout.rootEl.dataset.posture = posture;
        }
        this.posturePill?.refresh();
        this.overflowMenu?.refresh();
        this.composer?.refreshToolUseIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null
        );
        this.syncKnowledgeIndicator();
        this.composer?.refreshVisionIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null
        );
        this.composer?.refreshVisionSupport(
          this.sessionStore?.getResolvedConversationModel() ?? null
        );
      },
      onContextToggle: () => {
        this.cachedDocumentContext = null;
        this.contextUpdater?.immediateUpdate(this.buildContextInputs());
      },
    });
    this.interactionHost = new ComposerInteractionHost(this.layout, {
      onOpenNote: (target, event) => {
        void this.app.workspace.openLinkText(
          target.path,
          "",
          Keymap.isModEvent(event),
          target.line === undefined
            ? undefined
            : { eState: { line: Math.max(0, target.line - 1) } },
        );
      },
    });

    if (this.layout) {
      this.layout.rootEl.dataset.posture = this.composer?.getPosture() ?? "ask";
    }

    this.modelSelector = new ChatModelSelector(this.plugin, this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getActiveProfileId: () => this.sessionStore?.getActiveConversationMeta()?.modelId ?? "",
      getModels: () => getSelectableCompletionModels(this.plugin.settings),
      onSelectModel: async (model) => {
        if (!this.sessionStore) return;
        this.contextUpdater?.resetCalibration();
        await this.sessionStore.setActiveConversationModel(model);
        await this.syncConversationUi();
        await this.modelSelector?.refreshAvailability();
        this.refreshComposerIndicators();
      },
    });

    this.profilePopover = new ProfileSettingsPopover(this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      isProviderEnabled: (provider) => this.plugin.settings.providerSettings[provider].enabled,
      getProfilesForProvider: (provider) =>
        getProfilesForProvider(this.plugin.settings, provider),
      getActiveProfile: (provider) =>
        getActiveProfile(this.plugin.settings, provider),
      getProviderDescriptor: (provider) => PROVIDER_DESCRIPTORS[provider],
      onProfileSelect: async (profileId, provider) => {
        this.plugin.settings.activeProfileIds[provider] = profileId;
        await this.plugin.saveSettings();
      },
      onProfileCreate: async (name, provider) => {
        const profile: ProviderProfile = {
          ...makeDefaultProfile(provider),
          id: generateProfileId(provider),
          name,
          isDefault: false,
        };
        this.plugin.settings.providerProfiles.push(profile);
        this.plugin.settings.activeProfileIds[provider] = profile.id;
        await this.plugin.saveSettings();
        return profile;
      },
      onProfileDelete: async (profileId) => {
        const idx = this.plugin.settings.providerProfiles.findIndex((p) => p.id === profileId);
        if (idx === -1) return;
        const deleted = this.plugin.settings.providerProfiles[idx];
        this.plugin.settings.providerProfiles.splice(idx, 1);
        // Reset to default if the deleted profile was active
        if (this.plugin.settings.activeProfileIds[deleted.provider] === profileId) {
          this.plugin.settings.activeProfileIds[deleted.provider] = `${deleted.provider}-default`;
        }
        await this.plugin.saveSettings();
      },
      onProfileUpdate: async (profileId, patch) => {
        const profile = this.plugin.settings.providerProfiles.find((p) => p.id === profileId);
        if (!profile || profile.isDefault) return;
        Object.assign(profile, patch);
        await this.plugin.saveSettings();
      },
      getModelReasoning: () => {
        const model = this.sessionStore?.getResolvedConversationModel() ?? null;
        return model
          ? resolveModelReasoning(
              this.plugin.settings.reasoningByModelKey,
              model,
              this.plugin.services.modelAvailability,
            )
          : null;
      },
      getModelReasoningLevels: () => {
        const model = this.sessionStore?.getResolvedConversationModel() ?? null;
        return model
          ? resolveReasoningLevels(model, this.plugin.services.modelAvailability)
          : [];
      },
      onModelReasoningChange: async (level) => {
        const model = this.sessionStore?.getResolvedConversationModel() ?? null;
        if (!model) return;
        await this.setModelReasoning(model.id, level);
      },
    });

    // The memories section's snapshot and master toggle (the toggle persists,
    // then clears every pin, so the next turn re-renders the index).
    const memories = createMemoriesSectionCallbacks({
      getSettings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
      getMemoryService: () => this.plugin.services.memoryService,
    });

    this.knowledgePopover = new KnowledgePopover(this.layout, {
      getRagSnapshot: () => {
        const rag = this.plugin.settings.rag;
        return {
          enabled: rag.enabled,
          hasModel: !!rag.activeEmbeddingModelId,
          ready: this.plugin.services.ragService.isReady(),
          fileCount: this.plugin.services.ragService.getFileCount(),
          chunkCount: this.plugin.services.ragService.getChunkCount(),
          indexingState: this.plugin.services.ragService.getIndexingState(),
          stale: this.plugin.services.ragService.isStale(),
        };
      },
      getGraphSnapshot: () => {
        const kg = this.plugin.settings.knowledgeGraph;
        return {
          enabled: kg.enabled,
          ready: this.plugin.services.graphService.isReady(),
          entityCount: this.plugin.services.graphService.getEntityCount(),
          relationCount: this.plugin.services.graphService.getRelationCount(),
          buildState: this.plugin.services.graphService.getBuildState(),
        };
      },
      getMemoriesSnapshot: memories.getMemoriesSnapshot,
      getEmbeddingModels: () => getSelectableEmbeddingModels(this.plugin.settings),
      getActiveEmbeddingModelId: () => this.plugin.settings.rag.activeEmbeddingModelId,
      getModelDeps: () => pluginModelDropdownDeps(this.plugin),
      onRagToggle: async (enabled) => {
        this.plugin.settings.rag.enabled = enabled;
        await this.plugin.saveSettings();
        await this.plugin.services.ragService.configure(
          this.plugin.settings.rag,
          getSelectableEmbeddingModels(this.plugin.settings),
          this.plugin.settings.providerSettings,
        );
        this.syncKnowledgeIndicator();
      },
      onGraphToggle: async (enabled) => {
        this.plugin.settings.knowledgeGraph.enabled = enabled;
        await this.plugin.saveSettings();
        await this.plugin.services.graphService.configure(
          this.plugin.settings.knowledgeGraph,
          getSelectableCompletionModels(this.plugin.settings),
          getSelectableEmbeddingModels(this.plugin.settings),
          this.plugin.settings.providerSettings,
        );
        this.syncKnowledgeIndicator();
      },
      onMemoriesToggle: memories.onMemoriesToggle,
      onEmbeddingModelSelect: async (modelId) => {
        this.plugin.settings.rag.activeEmbeddingModelId = modelId;
        await this.plugin.saveSettings();
        await this.plugin.services.ragService.configure(
          this.plugin.settings.rag,
          getSelectableEmbeddingModels(this.plugin.settings),
          this.plugin.settings.providerSettings,
        );
      },
      onRagBuild: async () => {
        const rag = this.plugin.settings.rag;
        await this.plugin.services.ragService.startIndexing(
          rag,
          getSelectableEmbeddingModels(this.plugin.settings),
          this.plugin.settings.providerSettings,
        );
      },
      onRagRebuild: async () => {
        const rag = this.plugin.settings.rag;
        await this.plugin.services.ragService.rebuild(
          rag,
          getSelectableEmbeddingModels(this.plugin.settings),
          this.plugin.settings.providerSettings,
        );
      },
      onRagStop: () => {
        this.plugin.services.ragService.stopIndexing();
      },
      onSubscribe: (onUpdate) => {
        this.plugin.services.ragService.onIndexingStateChange(() => onUpdate());
        this.plugin.services.graphService.onBuildStateChange(() => onUpdate());
      },
      onUnsubscribe: () => {
        this.plugin.services.ragService.onIndexingStateChange(null);
        this.plugin.services.graphService.onBuildStateChange(null);
      },
      onBeforeOpen: () => {
        if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
        if (this.reasoningPill?.isOpen()) this.reasoningPill.close();
        if (this.posturePill?.isOpen()) this.posturePill.close();
        if (this.overflowMenu?.isOpen()) this.overflowMenu.close();
      },
    });

    // Persistent chip notifier: repaints the collapsed knowledge indicator when
    // indexing state or staleness changes, even while the popover is closed (a
    // background edit deferred because the embedding model is not loaded).
    this.plugin.services.ragService.onStatusChange(() => this.syncKnowledgeIndicator());

    this.toolUsePopover = new ToolUsePopover(this.layout, {
      getAgenticMode: () => this.plugin.settings.agenticMode,
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getTrainedForToolUse: (modelId) =>
        this.plugin.services.modelAvailability.getTrainedForToolUse(modelId),
      onAgenticToggle: async (enabled) => {
        this.plugin.settings.agenticMode = enabled;
        await this.plugin.saveSettings();
        this.composer?.refreshToolUseIndicator(
          this.sessionStore?.getResolvedConversationModel() ?? null,
        );
      },
      onBeforeOpen: () => {
        if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
        if (this.reasoningPill?.isOpen()) this.reasoningPill.close();
        if (this.posturePill?.isOpen()) this.posturePill.close();
        if (this.overflowMenu?.isOpen()) this.overflowMenu.close();
      },
    });

    this.reasoningPill = new ReasoningPill(this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getReasoningByModelKey: () => this.plugin.settings.reasoningByModelKey,
      getReasoningDiscovery: () => this.plugin.services.modelAvailability,
      onReasoningChange: (modelKey, level) => this.setModelReasoning(modelKey, level),
      onBeforeOpen: () => {
        this.dismissAllOverlays();
      },
    });

    this.posturePill = new PosturePill(this.layout, {
      getPosture: () => this.composer?.getPosture() ?? "ask",
      onPostureChange: (posture) => this.composer?.setPosture(posture),
      onBeforeOpen: () => {
        this.dismissAllOverlays();
      },
    });

    this.overflowMenu = new ComposerOverflowMenu(this.layout, {
      getActiveModel: () => this.sessionStore?.getResolvedConversationModel() ?? null,
      getReasoningByModelKey: () => this.plugin.settings.reasoningByModelKey,
      getReasoningDiscovery: () => this.plugin.services.modelAvailability,
      onReasoningChange: (modelKey, level) => this.setModelReasoning(modelKey, level),
      getPosture: () => this.composer?.getPosture() ?? "ask",
      onPostureChange: (posture) => this.composer?.setPosture(posture),
      getVisionSupported: () => {
        const model = this.sessionStore?.getResolvedConversationModel() ?? null;
        if (!model) return null;
        // Indicator: unknown reads as off, never as a promised capability.
        return resolveVisionSupport(model, this.plugin.services.modelAvailability) ?? false;
      },
      onOpenTools: () => this.toolUsePopover?.open(),
      onOpenKnowledge: () => this.knowledgePopover?.open(),
      onBeforeOpen: () => {
        this.dismissAllOverlays();
      },
    });

    this.contextPickerPopover = new ContextPickerPopover(this.app, this.layout, {
      isActiveNoteAttached: () => this.composer?.isActiveNoteAttached() ?? false,
      getActiveFileName: () => this.app.workspace.getActiveFile()?.name ?? null,
      onAddActiveNote: () => {
        this.composer?.attachActiveNote();
      },
      isAutoAttachEnabled: () => this.plugin.settings.includeNoteContext,
      onToggleAutoAttach: (value) => {
        this.plugin.settings.includeNoteContext = value;
        void this.plugin.saveSettings();
      },
      onAddVaultNote: (filePath, fileName) => {
        this.composer?.addExtraContextItem({ filePath, fileName });
      },
      canAttachImages: () => this.composer?.canAttachImages() ?? false,
      onAttachImage: () => {
        this.composer?.openImagePicker();
      },
      onBeforeOpen: () => {
        if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
        if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
        if (this.profilePopover?.isOpen()) this.profilePopover.close();
        if (this.reasoningPill?.isOpen()) this.reasoningPill.close();
        if (this.posturePill?.isOpen()) this.posturePill.close();
        if (this.overflowMenu?.isOpen()) this.overflowMenu.close();
      },
    });

    this.historyDrawer = new ChatHistoryDrawer(this.layout.messagesPaneEl, {
      onSelect: (id) => void this.conversation.switchConversation(id),
      onNew: () => void this.conversation.startNewConversation(),
      onDelete: (id) => void this.conversation.deleteConversation(id),
      onRename: (id, title) => void this.conversation.renameConversation(id, title),
      onClose: () => this.historyDrawer?.close(),
      onSearch: (query) => this.sessionStore?.searchConversations(query) ?? Promise.resolve([]),
      onAfterClose: () => this.sessionStore?.clearSearchCache(),
    });

    this.registerDomEvent(this.layout.newChatBtn, "click", (event) => {
      event.stopPropagation();
      this.dismissAllOverlays();
      void this.conversation.startNewConversation();
    });

    this.registerDomEvent(this.layout.historyBtn, "click", (event) => {
      event.stopPropagation();
      this.dismissAllOverlays({ keepHistory: true });
      this.conversation.toggleHistoryDrawer();
    });

    this.registerDomEvent(this.layout.modelSelectorBtn, "click", () => {
      this.dismissAllOverlays({ keepModelSelector: true });
    });

    this.registerDomEvent(this.layout.profileSettingsBtn, "click", () => {
      this.dismissAllOverlays({ keepProfile: true });
    });

    // Bind the click-away to the view's own document, not the bare global. If the
    // leaf is dragged into a popout window the overlays live in that window, so the
    // outside-click that dismisses them has to be heard there too (ADR-0024).
    this.registerDomEvent(this.contentEl.ownerDocument, "click", () => {
      this.dismissAllOverlays();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateHeader();
        this.composer?.updateContextChips();
        void this.refreshDocumentContext().then(() => {
          this.contextUpdater?.scheduleUpdate(this.buildContextInputs());
        });
      })
    );

    this.registerDomEvent(this.layout.generateResponseBtn, "click", () => {
      void this.orchestrator.generateResponse();
    });

    await this.sessionStore.restorePersistedState();
    await this.syncConversationUi();
    await this.modelSelector.refreshAvailability();
    this.refreshComposerIndicators();

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.handleWidthChange(entry.contentRect.width);
    });
    this.resizeObserver.observe(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sessionStore?.clearDraftSaveTimer();
    this.prepareForPluginUnload();
    await this.sessionStore?.persistActiveConversation({ leaving: true });
    this.contextUpdater?.destroy();
    this.transcript?.destroy();
    this.emptyStateCarousel?.destroy();
    this.modelSelector?.destroy();
    this.profilePopover?.destroy();
    this.contextPickerPopover?.destroy();
    this.plugin.services.ragService.onStatusChange(null);
    this.knowledgePopover?.destroy();
    this.toolUsePopover?.destroy();
    this.reasoningPill?.destroy();
    this.posturePill?.destroy();
    this.overflowMenu?.destroy();
    this.composer?.destroy();
  }

  /**
   * Stop generation and synchronously remove any interaction form before view or
   * plugin services are torn down. This does not detach the leaf.
   */
  prepareForPluginUnload(): void {
    void this.orchestrator?.stopGeneration("unload");
    this.interactionHost?.destroy();
  }

  seedPrompt(text: string): void {
    this.composer?.seedPrompt(text);
    this.sessionStore?.setDraft(text);
    this.sessionStore?.scheduleDraftSave();
  }

  async sendCommand(expandedPrompt: string): Promise<void> {
    await this.orchestrator.send(expandedPrompt);
  }

  setPosture(posture: ApprovalPosture): void {
    this.composer?.setPosture(posture);
  }

  /**
   * Full conversation sync, re-renders messages from store state and updates
   * all UI chrome. Used for conversation switches, message deletion, branching,
   * and other structural changes to the message list.
   */
  private async syncConversationUi(): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer) return;

    const snapshot = this.sessionStore.getSnapshot();
    const isConversationSwitch = snapshot.activeConversationId !== this.lastRenderedConversationId;
    this.lastRenderedConversationId = snapshot.activeConversationId;

    await this.transcript.renderMessages(
      snapshot.messageHistory,
      this.bubbleActions.createCallbacks(),
      isConversationSwitch
    );

    // Re-render review panels for historical messages with edit or vault-op
    // proposals. autoApply is omitted (false) so applied auto vault ops do not
    // re-run on a conversation switch, only the persisted applied record renders.
    for (const message of snapshot.messageHistory) {
      if (message.editProposals?.length || message.vaultOpProposal) {
        const bubble = this.transcript.getBubbleForMessage(message.id);
        if (bubble?.role === "assistant") {
          renderLegacyReviewPanels(this.app, bubble, message);
        }
      }
    }

    await this.syncUiChrome();
  }

  /**
   * Lightweight post-generation sync, adopts bubbles that were created
   * imperatively during the send/generate flow (attaching action toolbars)
   * and updates UI chrome, WITHOUT re-rendering messages from scratch.
   */
  private async postGenerationSync(): Promise<void> {
    if (!this.sessionStore || !this.transcript) return;

    const snapshot = this.sessionStore.getSnapshot();

    this.transcript.adoptPendingBubbles(
      snapshot.messageHistory,
      this.bubbleActions.createCallbacks(),
    );

    await this.syncUiChrome();
  }

  /**
   * Update all non-message UI elements: empty state, header, composer
   * indicators, model selector, history drawer, and context capacity.
   */
  private async syncUiChrome(): Promise<void> {
    if (!this.sessionStore || !this.transcript || !this.composer) return;

    const snapshot = this.sessionStore.getSnapshot();

    this.composer.setDraft(snapshot.draft);
    this.transcript.setEmptyStateVisible(
      snapshot.messageHistory.length === 0 && !this.orchestrator.getIsGenerating()
    );
    this.updateHeader();
    // Restore this conversation's approval posture into the composer and chrome.
    // syncUiChrome runs on every switch / branch / new / initial load, so this is
    // the single point that re-seeds posture per conversation.
    const posture = this.sessionStore.getActivePosture();
    this.composer.restorePosture(posture);
    if (this.layout) this.layout.rootEl.dataset.posture = posture;
    this.posturePill?.refresh();
    this.composer.updateContextChips();
    this.composer.refreshToolUseIndicator(
      this.sessionStore.getResolvedConversationModel()
    );
    this.toolUsePopover?.refresh();
    this.syncKnowledgeIndicator();
    this.composer.refreshVisionIndicator(
      this.sessionStore.getResolvedConversationModel()
    );
    this.composer.refreshVisionSupport(
      this.sessionStore.getResolvedConversationModel()
    );
    this.modelSelector?.syncActiveModel();
    this.reasoningPill?.refresh();
    this.overflowMenu?.refresh();

    this.profilePopover?.syncVisibility();

    if (this.historyDrawer?.isOpen()) {
      this.historyDrawer.refresh(
        this.sessionStore.getConversations(),
        snapshot.activeConversationId
      );
    }

    this.contextUpdater?.refreshUsage(
      snapshot.messageHistory,
      this.sessionStore?.getResolvedConversationModel()?.provider
    );
    await this.refreshDocumentContext();
    this.contextUpdater?.immediateUpdate(this.buildContextInputs());
    this.orchestrator.updateGenerateResponseButton(snapshot.messageHistory);
  }

  private refreshComposerIndicators(): void {
    if (!this.composer || !this.sessionStore) return;
    const model = this.sessionStore.getResolvedConversationModel();
    this.composer.refreshToolUseIndicator(model);
    this.composer.refreshVisionIndicator(model);
    this.composer.refreshVisionSupport(model);
    this.syncKnowledgeIndicator();
    this.reasoningPill?.refresh();
    this.overflowMenu?.refresh();
  }

  /** Repaint the composer knowledge chip from RAG readiness, graph readiness, and staleness. */
  private syncKnowledgeIndicator(): void {
    this.composer?.refreshKnowledgeIndicator(
      this.plugin.services.ragService.isReady(),
      this.plugin.services.graphService.isReady(),
      this.plugin.services.ragService.isStale(),
    );
  }

  private updateHeader(): void {
    if (!this.layout || !this.sessionStore) return;

    const activeModel = this.sessionStore.getResolvedConversationModel();
    this.layout.headerMetaEl.setText(
      activeModel?.name || NO_MODEL_SELECTED_LABEL
    );
  }


  private dismissAllOverlays(options?: {
    keepModelSelector?: boolean;
    keepHistory?: boolean;
    keepProfile?: boolean;
  }): void {
    if (!options?.keepModelSelector) this.modelSelector?.close();
    if (!options?.keepProfile && this.profilePopover?.isOpen()) this.profilePopover.close();
    if (this.contextPickerPopover?.isOpen()) this.contextPickerPopover.close();
    if (this.knowledgePopover?.isOpen()) this.knowledgePopover.close();
    if (this.toolUsePopover?.isOpen()) this.toolUsePopover.close();
    if (this.reasoningPill?.isOpen()) this.reasoningPill.close();
    if (this.posturePill?.isOpen()) this.posturePill.close();
    if (this.overflowMenu?.isOpen()) this.overflowMenu.close();
    if (!options?.keepHistory && this.historyDrawer?.isOpen()) this.historyDrawer.close();
  }

  /**
   * The single write path for a model's reasoning entry, shared by the composer
   * pill and the profile popover's control. Null clears the entry, so nothing
   * is sent and the model runs on its own default.
   */
  private async setModelReasoning(modelKey: string, level: ReasoningLevel | null): Promise<void> {
    if (level === null) delete this.plugin.settings.reasoningByModelKey[modelKey];
    else this.plugin.settings.reasoningByModelKey[modelKey] = level;
    await this.plugin.saveSettings();
    this.reasoningPill?.refresh();
    this.overflowMenu?.refresh();
  }

  private handleWidthChange(width: number): void {
    if (!this.layout) return;

    const isCollapsed = width < MIN_VIEW_WIDTH_PX;
    this.layout.rootEl.toggleClass("is-collapsed", isCollapsed);

    // Width changes alter text wrapping; re-measure the composer height.
    this.composer?.refreshHeight();

    if (isCollapsed && this.historyDrawer?.isOpen()) {
      this.historyDrawer.close();
    }

    if (isCollapsed && this.modelSelector?.isOpen()) {
      this.modelSelector.close();
    }

    if (isCollapsed && this.profilePopover?.isOpen()) {
      this.profilePopover.close();
    }
  }


  private async refreshDocumentContext(): Promise<void> {
    if (!this.composer?.isActiveNoteAttached()) {
      this.cachedDocumentContext = null;
      return;
    }

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.cachedDocumentContext = null;
      return;
    }

    const text = await getActiveNoteText(this.app, this.plugin.settings.maxContextChars);
    if (!text) {
      this.cachedDocumentContext = null;
      return;
    }

    this.cachedDocumentContext = {
      filePath: file.path,
      content: text,
      isFull: false,
    };
  }

  private buildContextInputs(draft?: string): ContextInputs {
    const snapshot = this.sessionStore?.getSnapshot();
    const activeModel = this.sessionStore?.getResolvedConversationModel();
    const messages = snapshot?.messageHistory ?? [];

    return {
      systemPrompt: getActiveProfile(
        this.plugin.settings,
        activeModel?.provider ?? "lmstudio",
      ).systemPrompt,
      documentContext: this.cachedDocumentContext,
      messages,
      draft: draft ?? this.composer?.getDraft() ?? "",
      // Static catalog window first; then this conversation's last provider-
      // reported window (persisted per message, so a reloaded Claude Code thread
      // keeps its ring); then the live-discovered size as the in-session fallback.
      contextWindowSize:
        activeModel?.contextWindowSize
        ?? lastReportedContextWindow(messages, activeModel?.provider)
        ?? this.plugin.services.modelAvailability.getActiveContextLength(activeModel?.modelId ?? ""),
      activeProvider: activeModel?.provider,
    };
  }
}
