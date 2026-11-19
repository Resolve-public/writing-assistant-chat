import { describe, expect, it, vi } from "vitest";
import type { Component } from "obsidian";

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

import type { ChatClient } from "../../../../src/api/chatClient";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import { createAbortError } from "../../../../src/api/httpTransport";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { ComposerInteractionHostPort } from "../../../../src/chat/interactions/ComposerInteractionHost";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { CompletionModel, Conversation } from "../../../../src/shared/types";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

/**
 * PROBE: does a generation stopped by a conversation switch write its turn into
 * the conversation it was started in, or into whichever one is active by the time
 * the provider has stopped?
 *
 * The store, the generation pipeline, and the controller's switch sequence are
 * real. The provider streams one delta and then waits for abort; `stopMs` is how
 * long it takes to wind down after the abort, as a provider with a graceful stop
 * does. Storage writes take a few milliseconds, as a disk does.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeClient(stopMs: number, onFirstDelta: () => void): ChatClient {
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
        await new Promise<void>((resolve) =>
          attempt.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
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

function conversationFile(id: string, userText: string): Conversation {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    modelId: "test-model",
    modelName: "Test",
    messages: [{ id: `user-${id}`, role: "user", content: userText }],
    draft: "",
    approvalPosture: "ask",
  } as Conversation;
}

async function switchDuringGeneration(stopMs: number) {
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
    ["conversation-A", JSON.stringify(conversationFile("conversation-A", "question in A"))],
    ["conversation-B", JSON.stringify(conversationFile("conversation-B", "question in B"))],
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
  } as unknown as ChatTranscript;
  const interactionHost = {
    mount: vi.fn(() => true),
    isActive: vi.fn(() => false),
    clearIfOwner: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ComposerInteractionHostPort;

  let abortController: AbortController | null = null;
  let firstDelta!: () => void;
  const streaming = new Promise<void>((resolve) => (firstDelta = resolve));

  const generation = generateLlmResponse({
    plugin,
    owner: {} as Component,
    store,
    transcript,
    activeModel: { provider: "lmstudio", modelId: "test-model", name: "Test" } as CompletionModel,
    client: makeClient(stopMs, firstDelta),
    interactionHost,
    posture: "ask",
    finalization: { kind: "append" },
    setIsGenerating: vi.fn(),
    setActiveAbortController: (controller) => {
      if (controller) abortController = controller;
    },
  });
  const settled = generation.then(
    () => null,
    (error: unknown) => error,
  );

  await streaming;
  // ChatConversationController.switchConversation, in its own order.
  abortController!.abort();
  await store.persistActiveConversation();
  await store.switchToConversation("conversation-B");
  const generationError = await settled;

  const onDisk = (id: string) => normalizeConversation(JSON.parse(files.get(id) ?? "null"));
  return {
    generationError,
    a: onDisk("conversation-A"),
    b: onDisk("conversation-B"),
    live: store.getSnapshot(),
  };
}

const assistantCount = (conversation: Conversation) =>
  conversation.messages.filter((message) => message.role === "assistant").length;

describe("PROBE: stopping a generation by switching conversations", () => {
  for (const stopMs of [0, 50]) {
    it(`provider winds down in ${stopMs}ms`, async () => {
      const result = await switchDuringGeneration(stopMs);
      console.error(
        `[probe stopMs=${stopMs}]`,
        JSON.stringify(
          {
            generationError: String(result.generationError),
            A: {
              messages: result.a.messages.map((m) => `${m.role}:${m.id}`),
              inFlightAudit: result.a.inFlightGenerationAudit?.messageId ?? null,
            },
            B: {
              messages: result.b.messages.map((m) => `${m.role}:${m.id}`),
              inFlightAudit: result.b.inFlightGenerationAudit?.messageId ?? null,
            },
            liveActive: result.live.activeConversationId,
            liveMessages: result.live.messageHistory.map((m) => `${m.role}:${m.id}`),
          },
          null,
          2,
        ),
      );
      expect(assistantCount(result.b)).toBe(0);
      expect(assistantCount(result.a)).toBe(1);
    });
  }
});
