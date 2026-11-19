import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import type WritingAssistantChat from "../../../../src/main";
import type { CompletionModel, PluginSettings } from "../../../../src/shared/types";

/**
 * A fresh, untitled conversation that is persisted while empty (the draft-save
 * timer after the composer is cleared) must stay selectable: the open view is
 * still showing it, so its model has to keep resolving and keep being settable.
 */
function harness() {
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    chatHistory: { conversations: [], activeConversationId: null },
  };
  const storage = {
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  } as unknown as ConversationStorage;
  const plugin = { settings, saveSettings: () => Promise.resolve() } as unknown as
    WritingAssistantChat;
  return { settings, store: new ChatSessionStore(plugin, storage) };
}

const MODEL = {
  id: "anthropic:claude-sonnet-4-5",
  name: "Sonnet",
  modelId: "claude-sonnet-4-5",
  provider: "anthropic",
} as CompletionModel;

describe("empty conversation persisted while open", () => {
  it("keeps the active conversation's meta so a picked model sticks", async () => {
    const { store } = harness();
    await store.restorePersistedState();
    expect(store.getActiveConversationMeta()).not.toBeNull();

    // Type, then clear the composer: the debounced draft save persists an empty draft.
    store.setDraft("");
    await store.persistActiveConversation();

    expect(store.getActiveConversationMeta()).not.toBeNull();
    await store.setActiveConversationModel(MODEL);
    expect(store.getActiveConversationMeta()?.modelId).toBe(MODEL.id);
  });

  it("still discards an empty, untitled conversation when the view leaves it", async () => {
    const { settings, store } = harness();
    await store.restorePersistedState();
    const id = store.getActiveConversationId();

    await store.persistActiveConversation({ leaving: true });

    expect(settings.chatHistory.conversations.some((meta) => meta.id === id)).toBe(false);
    expect(settings.chatHistory.activeConversationId).toBeNull();
  });
});
