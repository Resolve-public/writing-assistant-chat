import { Notice } from "obsidian";
import { MAX_CONVERSATIONS } from "../constants";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import type { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";

type ConversationControllerDeps = {
  getStore: () => ChatSessionStore | null;
  getDrawer: () => ChatHistoryDrawer | null;
  getOrchestrator: () => ChatGenerationOrchestrator;
  syncConversationUi: () => Promise<void>;
  refreshAvailability: () => Promise<void>;
  onNewConversation?: () => void;
};

export class ChatConversationController {
  constructor(private readonly deps: ConversationControllerDeps) {}

  async startNewConversation(): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    const conversations = store.getConversations();
    if (conversations.length >= MAX_CONVERSATIONS) {
      const oldestConversation = [...conversations]
        .filter(
          (conversation) => conversation.id !== store.getActiveConversationId()
        )
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];

      if (oldestConversation) {
        const oldestTitle = oldestConversation.title || "Untitled conversation";
        new Notice(
          `History is full (${MAX_CONVERSATIONS}/${MAX_CONVERSATIONS}). Starting a new conversation will remove "${oldestTitle}".`,
          6000
        );
      }
    }

    // The store writes to whichever conversation is active, so the stopped run
    // must finish its terminal write here before another conversation loads.
    await this.deps.getOrchestrator().stopGeneration();

    await store.persistActiveConversation({ leaving: true });
    await store.newConversation();
    this.deps.onNewConversation?.();
    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();
    this.deps.getDrawer()?.close();
  }

  async switchConversation(id: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    if (id === store.getActiveConversationId()) {
      this.deps.getDrawer()?.close();
      return;
    }

    // The store writes to whichever conversation is active, so the stopped run
    // must finish its terminal write here before another conversation loads.
    await this.deps.getOrchestrator().stopGeneration();

    await store.persistActiveConversation({ leaving: true });
    const didSwitch = await store.switchToConversation(id);
    if (!didSwitch) return;

    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();
    this.deps.getDrawer()?.close();
  }

  async deleteConversation(id: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    // Deleting the active conversation loads another one in its place.
    if (id === store.getActiveConversationId()) {
      await this.deps.getOrchestrator().stopGeneration();
    }

    await store.deleteConversation(id);
    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();

    const drawer = this.deps.getDrawer();
    if (drawer?.isOpen()) {
      drawer.open(
        store.getConversations(),
        store.getActiveConversationId()
      );
    }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    const renamed = await store.renameConversation(id, title);
    if (!renamed) return;

    await this.deps.syncConversationUi();

    const drawer = this.deps.getDrawer();
    if (drawer?.isOpen()) {
      drawer.refresh(store.getConversations(), store.getActiveConversationId());
    }
  }

  toggleHistoryDrawer(): void {
    const drawer = this.deps.getDrawer();
    const store = this.deps.getStore();
    if (!drawer || !store) return;

    if (drawer.isOpen()) {
      drawer.close();
      return;
    }

    drawer.open(store.getConversations(), store.getActiveConversationId());
  }
}
