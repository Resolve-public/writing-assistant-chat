import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/chat/finalization/prepareApiMessages", () => ({
  prepareApiMessages: vi.fn(() =>
    Promise.resolve({ messages: [{ role: "user", content: "write a line" }] }),
  ),
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

/**
 * The send entry point, reduced to the part this file is about: it awaits a
 * pre-generation step (availability, runtime resolution) and then runs the real
 * generation with the orchestrator's own callbacks.
 */
const sendScript = {
  client: null as ChatClient | null,
  beforeGeneration: Promise.resolve(),
};
vi.mock("../../../../src/chat/actions/sendMessage", () => ({
  sendMessage: async (options: SendMessageOptions) => {
    options.setIsGenerating(true);
    await sendScript.beforeGeneration;
    await generateLlmResponse({
      plugin: options.plugin,
      owner: options.owner,
      store: options.store,
      transcript: options.transcript,
      activeModel: { provider: "lmstudio", modelId: "test-model", name: "Test" } as CompletionModel,
      client: sendScript.client as ChatClient,
      interactionHost: options.interactionHost,
      posture: "ask",
      finalization: { kind: "append" },
      setIsGenerating: options.setIsGenerating,
      setActiveAbortController: options.setActiveAbortController,
    });
  },
}));

import type { Component } from "obsidian";
import type { ChatClient } from "../../../../src/api/chatClient";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import { createAbortError } from "../../../../src/api/httpTransport";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import type { sendMessage } from "../../../../src/chat/actions/sendMessage";
import { ChatConversationController } from "../../../../src/chat/ChatConversationController";
import { ChatGenerationOrchestrator } from "../../../../src/chat/ChatGenerationOrchestrator";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { CompletionModel, Conversation } from "../../../../src/shared/types";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

type SendMessageOptions = Parameters<typeof sendMessage>[0];

/**
 * A generation stopped by leaving its conversation must land its turn in the
 * conversation it was started in.
 *
 * The store writes to whichever conversation is active, and a provider can take
 * real time to wind down after the abort (a graceful stop). Before the
 * orchestrator's stop settled the run, a switch that outlasted that wind-down
 * loaded the next conversation first, and the stopped turn was written into it.
 *
 * The store, the orchestrator, the conversation controller, and the generation
 * pipeline are real. Storage writes take a few milliseconds, as a disk does.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Streams one delta, then winds down for `stopMs` once aborted. */
function windingDownClient(stopMs: number, onFirstDelta: () => void): ChatClient {
  return {
    complete: vi.fn(),
    stream: (
      _request: unknown,
      _model: string,
      _params: unknown,
      attempt: AssistantStreamAttemptContext,
    ): AssistantStreamRun => {
      const segmentId = "segment-1";
      const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
        yield { type: "segment_start", segmentId };
        yield { type: "prose_delta", segmentId, delta: "Partial answer." };
        onFirstDelta();
        if (!attempt.signal.aborted) {
          await new Promise<void>((resolve) =>
            attempt.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await sleep(stopMs);
        throw createAbortError();
      })();
      return ownedRunFromLegacy({
        events,
        usage: Promise.resolve(null),
        stopReason: Promise.resolve("unknown"),
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

function conversationFile(id: string): Conversation {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    modelId: "test-model",
    modelName: "Test",
    messages: [{ id: `user-${id}`, role: "user", content: `question in ${id}` }],
    draft: "",
    approvalPosture: "ask",
  } as Conversation;
}

async function harness() {
  const meta = (id: string) => ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    modelId: "test-model",
    modelName: "Test",
    messageCount: 1,
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    agenticMode: false,
    memoriesEnabled: false,
    vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY },
    chatHistory: {
      conversations: [meta("conversation-A"), meta("conversation-B")],
      activeConversationId: "conversation-A",
    },
  };
  const files = new Map<string, string>([
    ["conversation-A", JSON.stringify(conversationFile("conversation-A"))],
    ["conversation-B", JSON.stringify(conversationFile("conversation-B"))],
  ]);
  const storage = {
    load: async (id: string) => {
      await sleep(2);
      const raw = files.get(id);
      return raw ? normalizeConversation(JSON.parse(raw)) : null;
    },
    save: async (conversation: Conversation) => {
      const bytes = JSON.stringify(conversation);
      await sleep(2);
      files.set(conversation.id, bytes);
    },
    delete: (id: string) => {
      files.delete(id);
      return Promise.resolve();
    },
  } as unknown as ConversationStorage;

  const plugin = {
    settings,
    saveSettings: vi.fn(() => sleep(1)),
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
  await store.restorePersistedState();

  const bubble = {
    role: "assistant" as const,
    rowEl: { remove: vi.fn() },
    turnView: {
      rootEl: {},
      refresh: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      destroy: vi.fn(),
      getReviewHostForToolCallId: vi.fn(() => null),
      getProvisionalReviewHost: vi.fn(() => ({})),
      refreshActionSectionVisibility: vi.fn(),
    },
  };
  const transcript = {
    createDraftBubble: vi.fn(() => bubble),
    registerBubble: vi.fn(),
    releaseDraft: vi.fn(),
    setEmptyStateVisible: vi.fn(),
  };
  const interactionHost = {
    mount: vi.fn(() => true),
    isActive: vi.fn(() => false),
    clearIfOwner: vi.fn(),
    destroy: vi.fn(),
  };

  const orchestrator = new ChatGenerationOrchestrator({
    plugin,
    owner: {} as Component,
    getStore: () => store,
    getTranscript: () => transcript as never,
    getComposer: () => ({ getPosture: () => "ask", setSendingState: vi.fn() }) as never,
    getInteractionHost: () => interactionHost as never,
    getModelSelector: () => ({}) as never,
    getContextUpdater: () => null,
    getLayout: () => null,
    syncConversationUi: () => Promise.resolve(),
    postGenerationSync: () => Promise.resolve(),
  });
  const controller = new ChatConversationController({
    getStore: () => store,
    getDrawer: () => null,
    getOrchestrator: () => orchestrator,
    syncConversationUi: () => Promise.resolve(),
    refreshAvailability: () => Promise.resolve(),
  });

  const onDisk = (id: string) => normalizeConversation(JSON.parse(files.get(id) ?? "null"));
  return { store, orchestrator, controller, onDisk };
}

const assistantMessages = (conversation: Conversation) =>
  conversation.messages.filter((message) => message.role === "assistant");

describe("leaving a conversation while it generates", () => {
  it("keeps a slowly stopping turn in its own conversation", async () => {
    const h = await harness();
    let firstDelta!: () => void;
    const streaming = new Promise<void>((resolve) => (firstDelta = resolve));
    sendScript.client = windingDownClient(50, firstDelta);
    sendScript.beforeGeneration = Promise.resolve();

    const send = h.orchestrator.send();
    await streaming;
    await h.controller.switchConversation("conversation-B");
    await send;

    expect(assistantMessages(h.onDisk("conversation-B"))).toHaveLength(0);
    expect(assistantMessages(h.onDisk("conversation-A"))).toHaveLength(1);
    expect(h.store.getSnapshot().activeConversationId).toBe("conversation-B");
    expect(assistantMessages({ messages: h.store.getSnapshot().messageHistory } as Conversation))
      .toHaveLength(0);
  });

  it("applies a stop that arrives before the run armed its abort", async () => {
    const h = await harness();
    let release!: () => void;
    sendScript.beforeGeneration = new Promise<void>((resolve) => (release = resolve));
    const client = windingDownClient(0, () => undefined);
    const stream = vi.spyOn(client, "stream");
    sendScript.client = client;

    const send = h.orchestrator.send();
    const stopped = h.orchestrator.stopGeneration();
    release();
    await stopped;
    await send;

    // The run was cancelled at arm time. Without that, nothing would ever abort
    // it, the fake would wait forever, and `stopped` would never settle.
    const stoppedTurn = assistantMessages(h.onDisk("conversation-A"));
    expect(stoppedTurn).toHaveLength(1);
    expect(stoppedTurn[0].interrupted).toBe(true);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(h.orchestrator.getIsGenerating()).toBe(false);
  });

  it("settles immediately when nothing is generating", async () => {
    const h = await harness();
    await expect(h.orchestrator.stopGeneration()).resolves.toBeUndefined();
  });
});
