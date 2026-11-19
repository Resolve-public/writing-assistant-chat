import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Component } from "obsidian";

vi.mock("../../../../src/chat/finalization/prepareApiMessages", () => ({
  prepareApiMessages: vi.fn(),
}));

vi.mock("../../../../src/shared/profileUtils", () => ({
  getActiveProfile: () => ({
    systemPrompt: "",
    disableBuiltinSystemPrompts: false,
    anthropicCacheSettings: { enabled: false },
  }),
}));

vi.mock("../../../../src/chat/finalization/buildSamplingParams", () => ({
  buildSamplingParams: () => ({}),
}));

vi.mock("../../../../src/providers/reasoningLevels", () => ({
  resolveModelReasoning: () => null,
}));

vi.mock("../../../../src/chat/actions/liveVaultReview", () => ({
  LiveVaultReview: class {
    cancelPending(): void {}
    detachPanels(): void {}
    getProposal(): null {
      return null;
    }
    getAppliedRecord(): null {
      return null;
    }
    getEditProposals(): never[] {
      return [];
    }
    getEditAppliedRecords(): never[] {
      return [];
    }
    getMemoryProposals(): never[] {
      return [];
    }
  },
}));

import type { ChatClient } from "../../../../src/api/chatClient";
import type { AssistantStreamRun } from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { ComposerInteractionHostPort } from "../../../../src/chat/interactions/ComposerInteractionHost";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { CompletionModel, Conversation, ConversationMessage } from "../../../../src/shared/types";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

/**
 * Regeneration keeps the original message active while its replacement streams.
 * The transcript owns hiding the original (see ChatTranscript.test.ts); the
 * generation's half of the contract is naming the message its draft replaces,
 * committing through `registerBubble()`, and releasing the draft on every exit.
 */

/** One round streaming `prose`, or a turn with no items when `prose` is empty. */
function makeClient(prose: string): ChatClient {
  return {
    complete: vi.fn(),
    stream: (): AssistantStreamRun => {
      const segmentId = "segment-1";
      const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
        yield { type: "segment_start", segmentId };
        if (prose) yield { type: "prose_delta", segmentId, delta: prose };
        yield { type: "segment_end", segmentId };
        yield { type: "turn_end", status: "completed" };
      })();
      return ownedRunFromLegacy({
        events,
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
        stopReason: Promise.resolve("end_turn"),
        replayCapsule: Promise.resolve(null),
        replayEvidence: Promise.resolve({
          tier: "textual",
          capabilities: {
            captureOrder: "segment",
            toolCorrelation: "none",
            coldReplay: "textual",
            nativeResume: false,
          },
        }),
      });
    },
  } as unknown as ChatClient;
}

function harness() {
  const settings = {
    ...DEFAULT_SETTINGS,
    agenticMode: false,
    memoriesEnabled: false,
    vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY },
    chatHistory: {
      conversations: [
        {
          id: "conversation-1",
          title: "Thread",
          createdAt: 1,
          updatedAt: 1,
          modelId: "test-model",
          modelName: "Test",
          messageCount: 0,
        },
      ],
      activeConversationId: "conversation-1",
    },
  };
  const files = new Map<string, string>();
  files.set(
    "conversation-1",
    JSON.stringify({
      id: "conversation-1",
      title: "Thread",
      createdAt: 1,
      updatedAt: 1,
      modelId: "test-model",
      modelName: "Test",
      messages: [{ id: "user-1", role: "user", content: "write a line" }],
      draft: "",
      approvalPosture: "ask",
    }),
  );
  const storage = {
    load: (id: string) => {
      const raw = files.get(id);
      return Promise.resolve(raw ? normalizeConversation(JSON.parse(raw)) : null);
    },
    save: (conversation: Conversation) => {
      files.set(conversation.id, JSON.stringify(conversation));
      return Promise.resolve();
    },
    delete: (id: string) => {
      files.delete(id);
      return Promise.resolve();
    },
  } as unknown as ConversationStorage;

  const plugin = {
    settings,
    saveSettings: vi.fn(() => Promise.resolve()),
    app: { workspace: { getActiveFile: () => null }, vault: {} },
    services: {
      ragService: { availability: () => "no-backend" },
      memoryService: {},
      modelAvailability: {
        getTrainedForToolUse: () => undefined,
        getVision: () => true,
        resolveContextWindow: () => undefined,
        reportContextWindow: vi.fn(),
      },
    },
    inlineDiff: {},
  } as unknown as WritingAssistantChat;

  const store = new ChatSessionStore(plugin, storage);
  const makeBubble = () => ({
    role: "assistant" as const,
    rowEl: { remove: vi.fn() },
    columnEl: {},
    chromeEl: {},
    turnHostEl: {},
    turnView: {
      rootEl: {},
      refresh: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      destroy: vi.fn(),
      getReviewHostForToolCallId: vi.fn(() => null),
      getProvisionalReviewHost: vi.fn(() => ({})),
      refreshActionSectionVisibility: vi.fn(),
    },
  });
  const transcript = {
    createDraftBubble: vi.fn(makeBubble),
    registerBubble: vi.fn(),
    releaseDraft: vi.fn(),
  };
  const interactionHost = {
    mount: vi.fn(() => true),
    isActive: vi.fn(() => false),
    clearIfOwner: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ComposerInteractionHostPort;

  const run = (
    prose: string,
    finalization: Parameters<typeof generateLlmResponse>[0]["finalization"],
  ) =>
    generateLlmResponse({
      plugin,
      owner: {} as Component,
      store,
      transcript: transcript as unknown as ChatTranscript,
      activeModel: {
        provider: "lmstudio",
        modelId: "test-model",
        name: "Test",
      } as CompletionModel,
      client: makeClient(prose),
      interactionHost,
      posture: "ask",
      finalization,
      setIsGenerating: vi.fn(),
      setActiveAbortController: vi.fn(),
    });

  /** Seed an original answer, then return it as the message to regenerate. */
  const seedOriginal = async (): Promise<ConversationMessage> => {
    await store.restorePersistedState();
    await run("Original.", { kind: "append" });
    const history = store.getSnapshot().messageHistory;
    const original = history[history.length - 1];
    if (original?.role !== "assistant") throw new Error("no original answer was seeded");
    transcript.createDraftBubble.mockClear();
    transcript.releaseDraft.mockClear();
    transcript.registerBubble.mockClear();
    return original;
  };

  return { store, transcript, run, seedOriginal };
}

beforeEach(() => {
  vi.mocked(prepareApiMessages).mockResolvedValue({
    messages: [{ role: "user", content: "write a line" }],
  } as unknown as Awaited<ReturnType<typeof prepareApiMessages>>);
});

describe("regeneration draft lifecycle", () => {
  it("names the replaced message and commits the draft under its id", async () => {
    const h = harness();
    const original = await h.seedOriginal();

    await h.run("Replacement.", { kind: "replace", oldMessage: original });

    expect(h.transcript.createDraftBubble).toHaveBeenCalledWith(original.id);
    const draft = h.transcript.createDraftBubble.mock.results[0]?.value;
    expect(h.transcript.registerBubble).toHaveBeenCalledWith(original.id, draft);
    expect(h.transcript.releaseDraft).toHaveBeenCalledWith(draft);
  });

  it("releases an empty draft without committing it", async () => {
    const h = harness();
    const original = await h.seedOriginal();

    await h.run("", { kind: "replace", oldMessage: original });

    const draft = h.transcript.createDraftBubble.mock.results[0]?.value;
    expect(h.transcript.registerBubble).not.toHaveBeenCalled();
    expect(h.transcript.releaseDraft).toHaveBeenCalledWith(draft);
    expect(h.store.getSnapshot().messageHistory.at(-1)?.activeRevisionId).toBe(
      original.activeRevisionId,
    );
  });

  it("releases the draft when the replacement cannot be committed", async () => {
    const h = harness();
    const original = await h.seedOriginal();
    vi.spyOn(h.store, "commitRevisionReplacement").mockReturnValue(false);

    await expect(
      h.run("Replacement.", { kind: "replace", oldMessage: original }),
    ).rejects.toThrow("Could not commit the regenerated assistant revision.");

    const draft = h.transcript.createDraftBubble.mock.results[0]?.value;
    expect(h.transcript.registerBubble).not.toHaveBeenCalled();
    expect(h.transcript.releaseDraft).toHaveBeenCalledWith(draft);
  });

  it("replaces nothing on an ordinary send", async () => {
    const h = harness();
    await h.store.restorePersistedState();

    await h.run("Hello.", { kind: "append" });

    expect(h.transcript.createDraftBubble).toHaveBeenCalledWith(null);
  });
});
