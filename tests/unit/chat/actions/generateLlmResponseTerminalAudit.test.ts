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

/**
 * The review owner, mocked at the seam the effect boundary sits in front of.
 *
 * `resolveRound` is what a crossed boundary reaches; `getProposal` is the review
 * state the terminal fold builds its ledger entry from. Everything about the
 * boundary, the intent, and the fold is real.
 */
const reviewState = {
  seen: [] as string[],
  registered: true,
  status: "applied" as "applied" | "pending",
};

vi.mock("../../../../src/chat/actions/liveVaultReview", () => ({
  LiveVaultReview: class {
    cancelPending(): void {}
    detachEditPanel(): void {}
    detachPanels(): void {}
    resolveRound(calls: Array<{ id: string; name: string }>) {
      for (const call of calls) reviewState.seen.push(call.name);
      return Promise.resolve(
        calls.map((tc) => ({
          tc,
          result: { content: "Created Folder", isError: false },
        })),
      );
    }
    getProposal() {
      // Only a call that actually reached the review has registered state.
      if (!reviewState.registered || reviewState.seen.length === 0) return null;
      return {
        id: "proposal-1",
        createdAt: 10,
        ops: [
          {
            id: "op-1",
            op: { kind: "createDir", path: "Folder" },
            gate: "ask",
            status: reviewState.status,
            summary: "Create Folder",
            sourceToolCallId: "toolu_write",
          },
        ],
      };
    }
    getAppliedRecord() {
      return reviewState.status === "applied"
        ? {
            proposalId: "proposal-1",
            applied: [
              { opId: "op-1", inverse: { kind: "trashFolder", path: "Folder" } },
            ],
            appliedAt: 30,
          }
        : null;
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
  AssistantStreamSettlement,
} from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ConversationStorage } from "../../../../src/chat/conversation/ConversationStorage";
import { normalizeConversation } from "../../../../src/chat/conversation/conversationUtils";
import { validateAssistantMessageState } from "../../../../src/chat/conversation/assistantMessageValidation";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { ComposerInteractionHostPort } from "../../../../src/chat/interactions/ComposerInteractionHost";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type {
  AssistantTurnRevision,
  CompletionModel,
  Conversation,
  ConversationMessage,
} from "../../../../src/shared/types";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

/**
 * RFC-0011 phase 6, plan section 9.2: the terminal transaction.
 *
 * ```text
 * stop or complete provider -> await settlement -> reconcile durable intents
 *   -> freeze evidence -> validate -> append one revision
 *   -> clear the in-flight audit atomically -> render
 * ```
 *
 * The store here is the real one over a fake conversation file, so "persisted"
 * means the bytes a reload would read. The review owner is the only mock, because
 * the boundary sits directly in front of it.
 */

const writeCall = {
  id: "toolu_write",
  name: "create_directory",
  arguments: { path: "Folder" },
};

interface Script {
  toolCall?: boolean;
  error?: Error;
  settlement?: AssistantStreamSettlement;
}

function makeClient(rounds: Script[]): ChatClient {
  let index = 0;
  return {
    complete: vi.fn(),
    stream: (
      _request: ChatRequest,
      _model: string,
      _params: unknown,
      _attempt: AssistantStreamAttemptContext,
    ): AssistantStreamRun => {
      const script = rounds[index++] ?? {};
      const segmentId = `segment-${index}`;
      const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
        yield { type: "segment_start", segmentId };
        if (script.toolCall) {
          const declarationKey = `${segmentId}-tool-0`;
          yield {
            type: "tool_call_start",
            segmentId,
            declarationKey,
            toolName: writeCall.name,
          };
          yield {
            type: "tool_call_delta",
            declarationKey,
            argumentsDelta: JSON.stringify(writeCall.arguments),
          };
          yield {
            type: "tool_call_identity",
            declarationKey,
            toolCallId: writeCall.id,
            correlation: "provider_id",
          };
        } else {
          yield { type: "prose_delta", segmentId, delta: "Done." };
        }
        if (script.error) throw script.error;
        yield { type: "segment_end", segmentId };
        yield {
          type: "turn_end",
          status: script.toolCall ? "streaming" : "completed",
        };
      })();
      const run = ownedRunFromLegacy({
        events,
        usage: Promise.resolve({
          inputTokens: 10,
          outputTokens: 5,
          resumeCursor: {
            sessionId: "session-1",
            coveredCount: 1,
            prefixHash: "hash",
            configFingerprint: "fingerprint",
          },
        }),
        stopReason: Promise.resolve(script.toolCall ? "tool_use" : "end_turn"),
        replayCapsule: Promise.resolve(null),
        replayEvidence: Promise.resolve({
          tier: "textual",
          capabilities: {
            captureOrder: "segment",
            toolCorrelation: "provider_id",
            coldReplay: "textual",
            nativeResume: true,
          },
        }),
      });
      // A provider that reports forced quiescence: the hard-dispose tier ran, so
      // nothing downstream may claim exact capture or a resume cursor.
      return script.settlement
        ? { ...run, settled: Promise.resolve(script.settlement) }
        : run;
    },
  } as unknown as ChatClient;
}

const forcedSettlement: AssistantStreamSettlement = {
  quiescence: "forced",
  reason: "user_stop",
  hardDisposed: true,
  diagnostics: [
    {
      code: "graceful_stop_overran",
      provider: "claudecode",
      stage: "settlement",
      message: "the provider did not stop within its measured deadline",
    },
  ],
};

function harness() {
  reviewState.seen = [];
  reviewState.registered = true;
  reviewState.status = "applied";
  const settings = {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
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
      messages: [{ id: "user-1", role: "user", content: "make a folder" }],
      draft: "",
      approvalPosture: "ask",
    }),
  );
  let failSaveWhen: ((conversation: Conversation) => boolean) | null = null;
  const storage = {
    load: (id: string) => {
      const raw = files.get(id);
      return Promise.resolve(raw ? normalizeConversation(JSON.parse(raw)) : null);
    },
    save: (conversation: Conversation) => {
      if (failSaveWhen?.(conversation)) {
        return Promise.reject(new Error("disk full"));
      }
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
    app: {
      workspace: { getActiveFile: () => null },
      vault: {
        adapter: {},
        configDir: ".obsidian",
        getName: () => "Vault",
        getAbstractFileByPath: () => null,
        getFileByPath: () => null,
        getFolderByPath: () => null,
        getAllLoadedFiles: () => [],
        getRoot: () => null,
      },
    },
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
  const turnView = {
    rootEl: {},
    refresh: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(),
    getReviewHostForToolCallId: vi.fn(() => null),
    getProvisionalReviewHost: vi.fn(() => ({})),
    refreshActionSectionVisibility: vi.fn(),
  };
  const bubble = {
    role: "assistant" as const,
    rowEl: { remove: vi.fn() },
    columnEl: {},
    chromeEl: {},
    turnHostEl: {},
    turnView,
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

  const setIsGenerating = vi.fn();

  return {
    store,
    plugin,
    setIsGenerating,
    onDisk: () => {
      const raw = files.get("conversation-1");
      return raw ? normalizeConversation(JSON.parse(raw)) : null;
    },
    failSaveWhen: (predicate: (conversation: Conversation) => boolean) => {
      failSaveWhen = predicate;
    },
    run: (rounds: Script[]) =>
      generateLlmResponse({
        plugin,
        owner: {} as Component,
        store,
        transcript,
        activeModel: {
          provider: "lmstudio",
          modelId: "test-model",
          name: "Test",
        } as CompletionModel,
        client: makeClient(rounds),
        interactionHost,
        posture: "ask",
        finalization: { kind: "append" },
        setIsGenerating,
        setActiveAbortController: vi.fn(),
      }),
  };
}

function assistantRevision(
  message: ConversationMessage | undefined,
): AssistantTurnRevision {
  const revision = message?.revisions?.find(
    (entry) => entry.revisionId === message.activeRevisionId,
  );
  if (revision?.kind !== "turn") {
    throw new Error("the assistant message has no turn revision");
  }
  return revision;
}

beforeEach(async () => {
  vi.mocked(prepareApiMessages).mockResolvedValue({
    messages: [{ role: "user", content: "make a folder" }],
    tools: [{ name: "create_directory" }],
  } as unknown as Awaited<ReturnType<typeof prepareApiMessages>>);
});

describe("terminal transaction", () => {
  it("persists proven quiescence and clears the audit in the same state", async () => {
    const h = harness();
    await h.store.restorePersistedState();

    await h.run([{ toolCall: true }, {}]);

    const conversation = h.onDisk();
    const assistant = conversation?.messages.find(
      (message) => message.role === "assistant",
    );
    const revision = assistantRevision(assistant);
    expect(revision.turn.quiescence).toBe("proven");
    // The audit existed while the mutation was in flight and is gone now.
    expect(conversation?.inFlightGenerationAudit).toBeUndefined();
    expect(h.store.getGenerationAudit()).toBeNull();
    // The write-ahead intent folded into the entry the review produced.
    const entry = assistant?.actionLedger?.[0];
    expect(entry?.events.map((event) => event.type)).toEqual([
      "proposed",
      "intent_recorded",
      "approved",
      "apply_succeeded",
    ]);
    expect(reviewState.seen).toEqual(["create_directory"]);
  });

  it("keeps a persisted turn valid on reload", async () => {
    const h = harness();
    await h.store.restorePersistedState();

    await h.run([{ toolCall: true }, {}]);

    const assistant = h
      .onDisk()
      ?.messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    const validation = validateAssistantMessageState({
      revisions: assistant?.revisions,
      activeRevisionId: assistant?.activeRevisionId,
      actionLedger: assistant?.actionLedger ?? [],
    });
    if (!validation.ok) console.error("VALIDATION", JSON.stringify(validation.reason));
    expect(validation.ok).toBe(true);
  });

  it("stores the forced diagnostic and no resume cursor", async () => {
    const h = harness();
    await h.store.restorePersistedState();

    await h.run([{ settlement: forcedSettlement }]);

    const revision = assistantRevision(
      h.onDisk()?.messages.find((message) => message.role === "assistant"),
    );
    expect(revision.turn.quiescence).toBe("forced");
    expect(revision.turn.captureDiagnostics).toEqual([
      expect.objectContaining({ code: "graceful_stop_overran" }),
    ]);
    // Settled decision 24: forced quiescence forbids native resume, so the
    // cursor the provider reported cannot be kept.
    expect(revision.usage?.resumeCursor).toBeUndefined();
    expect(revision.replayEvidence?.capabilities.nativeResume).toBe(false);
  });

  it("records an unmatched intent as one bounded diagnostic", async () => {
    const h = harness();
    await h.store.restorePersistedState();
    // The boundary was crossed and then the review registered nothing, so no
    // ledger payload can exist for it.
    reviewState.registered = false;

    await h.run([{ toolCall: true }, {}]);

    const revision = assistantRevision(
      h.onDisk()?.messages.find((message) => message.role === "assistant"),
    );
    expect(revision.turn.captureDiagnostics).toEqual([
      expect.objectContaining({
        code: "consequential_outcome_unknown",
        stage: "callback",
      }),
    ]);
    expect(h.onDisk()?.inFlightGenerationAudit).toBeUndefined();
  });

  it("keeps the audit available when the terminal persist fails", async () => {
    const h = harness();
    await h.store.restorePersistedState();
    // Fail only the write that carries the finished assistant message.
    h.failSaveWhen((conversation) =>
      conversation.messages.some((message) => message.role === "assistant"),
    );

    // The terminal write and the `finally`'s retry both fail, and the retry
    // rethrows to the caller the way any failed conversation write does.
    await expect(h.run([{ toolCall: true }, {}])).rejects.toThrow("disk full");

    // The provider is stopped and the evidence is still on hand, which is what
    // one bounded retry needs (section 9.4).
    expect(h.store.getGenerationAudit()?.intents).toHaveLength(1);
  });

  it("clears the generating flag even when that terminal persist fails", async () => {
    // The failure above rethrows on purpose, and the line that cleared the flag sat after it in the
    // same block, so it was skipped: the turn ended, nothing caught the rejection, and the composer
    // stayed a stop button until Obsidian was reloaded. The driver reached this by ordinary means,
    // with the composer's debounced draft save colliding with this very write.
    const h = harness();
    await h.store.restorePersistedState();
    h.failSaveWhen((conversation) =>
      conversation.messages.some((message) => message.role === "assistant"),
    );

    await expect(h.run([{ toolCall: true }, {}])).rejects.toThrow("disk full");

    expect(h.setIsGenerating).toHaveBeenCalledWith(false);
  });

  it("persists a failed turn whose ledger records an applied action", async () => {
    const h = harness();
    await h.store.restorePersistedState();

    await h.run([
      { toolCall: true },
      { error: new Error("the provider failed after the mutation") },
    ]);

    // Before phase 6 the compatibility projection marked this message
    // `isError`, and `getCleanMessagesForPersistence()` dropped every such
    // message, so an applied vault operation's whole undo record left the disk
    // with it.
    const assistant = h
      .onDisk()
      ?.messages.find((message) => message.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.actionLedger?.[0].events.map((event) => event.type)).toContain(
      "apply_succeeded",
    );
  });
});
