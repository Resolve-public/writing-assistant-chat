import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import { validateAssistantMessageState } from "../../../../src/chat/conversation/assistantMessageValidation";

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
    detachEditPanel(): void {}
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

import type { Component } from "obsidian";
import type { ChatClient } from "../../../../src/api/chatClient";
import { createAbortError } from "../../../../src/api/httpTransport";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
} from "../../../../src/api/assistantStreamRun";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import { generateLlmResponse } from "../../../../src/chat/actions/generateLlmResponse";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type {
  ComposerInteraction,
  ComposerInteractionHostPort,
} from "../../../../src/chat/interactions/ComposerInteractionHost";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import { prepareApiMessages } from "../../../../src/chat/finalization/prepareApiMessages";
import { DEFAULT_SETTINGS } from "../../../../src/constants";
import type WritingAssistantChat from "../../../../src/main";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type {
  AgenticStep,
  AssistantMessageRevision,
  CompletionModel,
  ConversationMessage,
  EffectIntentRequest,
  GenerationAuditIdentity,
  GenerationAuditIntent,
} from "../../../../src/shared/types";
import { buildAskUserTool } from "../../../../src/tools/ask/definition";
import {
  askCancellationFailure,
  buildAskUserResult,
} from "../../../../src/tools/ask/result";
import type { AskAnswers, AskUserResponder } from "../../../../src/tools/ask/types";
import type { ToolCall } from "../../../../src/tools/types";
import {
  ClaudeCodeGenerationHandle,
  type ClaudeCodeGenerationLease,
  type ClaudeCodeToolEvent,
} from "../../../../src/services/ClaudeCodeGenerationLease";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

const question = "Which format should I use?";
const askCall: ToolCall = {
  id: "ask-1",
  name: "ask_user",
  arguments: {
    questions: [
      {
        question,
        header: "Output",
        options: [
          { label: "Concise", description: "Keep it short." },
          { label: "Detailed", description: "Include rationale." },
        ],
        multiSelect: false,
      },
    ],
  },
};

interface RoundScript {
  deltas?: string[];
  toolCalls?: ToolCall[] | null;
  error?: Error;
  waitForAbort?: boolean;
}

class FakeInteractionHost implements ComposerInteractionHostPort {
  interaction: ComposerInteraction | null = null;
  readonly clearIfOwner = vi.fn((interactionId: string) => {
    if (this.interaction?.interactionId === interactionId) {
      this.interaction = null;
    }
  });
  readonly destroy = vi.fn();
  private resolveMounted!: () => void;
  readonly mounted = new Promise<void>((resolve) => {
    this.resolveMounted = resolve;
  });

  mount(interaction: ComposerInteraction): boolean {
    this.interaction = interaction;
    this.resolveMounted();
    return true;
  }

  isActive(interactionId?: string): boolean {
    return Boolean(
      this.interaction &&
      (interactionId === undefined || this.interaction.interactionId === interactionId),
    );
  }

  submit(answers: AskAnswers): void {
    this.interaction?.onSubmit(answers);
  }
}

function makeClient(rounds: RoundScript[]): ChatClient & {
  stream: ReturnType<typeof vi.fn>;
  roundStarted: (round: number) => Promise<void>;
} {
  let index = 0;
  const startedRounds = new Set<number>();
  const roundResolvers = new Map<number, () => void>();
  const roundPromises = new Map<number, Promise<void>>();
  const roundStarted = (round: number) => {
    if (startedRounds.has(round)) return Promise.resolve();
    let promise = roundPromises.get(round);
    if (!promise) {
      promise = new Promise<void>((resolve) => {
        roundResolvers.set(round, resolve);
      });
      roundPromises.set(round, promise);
    }
    return promise;
  };
  const stream = vi.fn(
    (
      _request: ChatRequest,
      _model: string,
      _params: unknown,
      attempt: AssistantStreamAttemptContext,
    ): AssistantStreamRun<AssistantStreamEvent> => {
      const signal = attempt.signal;
      const roundIndex = index++;
      startedRounds.add(roundIndex);
      roundResolvers.get(roundIndex)?.();
      const script = rounds[roundIndex];
      const segmentId = `segment-${roundIndex}`;
      const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
        yield { type: "segment_start", segmentId };
        for (const delta of script.deltas ?? []) {
          yield { type: "prose_delta", segmentId, delta };
        }
        for (let toolIndex = 0; toolIndex < (script.toolCalls?.length ?? 0); toolIndex += 1) {
          const toolCall = script.toolCalls?.[toolIndex];
          if (!toolCall) continue;
          const declarationKey = `${segmentId}-tool-${toolIndex}`;
          yield {
            type: "tool_call_start",
            segmentId,
            declarationKey,
            toolName: toolCall.name,
          };
          yield {
            type: "tool_call_delta",
            declarationKey,
            argumentsDelta: JSON.stringify(toolCall.arguments),
          };
          yield {
            type: "tool_call_identity",
            declarationKey,
            toolCallId: toolCall.id,
            correlation: "provider_id",
          };
        }
        if (script.waitForAbort) {
          if (signal.aborted) throw createAbortError();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(createAbortError()), {
              once: true,
            });
          });
        }
        if (script.error) throw script.error;
        yield { type: "segment_end", segmentId };
        yield {
          type: "turn_end",
          stopReason: script.toolCalls ? "tool_use" : "end_turn",
        };
      })();
      return ownedRunFromLegacy({
        events,
        usage: Promise.resolve(null),
        stopReason: Promise.resolve(
          script.toolCalls ? "tool_use" : "end_turn",
        ),
        replayCapsule: Promise.resolve(null),
        replayEvidence: Promise.resolve({
          tier: "structural",
          capabilities: {
            captureOrder: "exact",
            toolCorrelation: "provider_id",
            coldReplay: "structural",
            nativeResume: false,
          },
        }),
      });
    },
  );
  return {
    complete: vi.fn(),
    stream,
    roundStarted,
  } as unknown as ChatClient & {
    stream: ReturnType<typeof vi.fn>;
    roundStarted: (round: number) => Promise<void>;
  };
}

/**
 * The Claude Code callback surface as this suite sees it (RFC-0011 phase 5): a
 * real generation handle, so a fake provider reaches the ask responder and the
 * lifecycle sink exactly the way an MCP callback does, through the lease the
 * generation installed, and sees them go away when the generation releases.
 */
interface FakeClaudeCodeBridge {
  handle: ClaudeCodeGenerationHandle;
  activate: ReturnType<typeof vi.fn>;
  getAskUserResponder(): AskUserResponder | null;
  emitToolEvent(event: ClaudeCodeToolEvent): void;
}

function makeClaudeCodeBridge(): FakeClaudeCodeBridge {
  const handle = new ClaudeCodeGenerationHandle({
    leaseId: "lease-generate-test",
    conversationId: null,
    posture: "ask",
    allowedTools: new Set(["ask_user"]),
    activeFilePath: "",
    correlationPosture: "provider_id",
  });
  const activate = vi.spyOn(handle, "activate");
  /** The lease only while it is answering; a released generation owns nothing. */
  const live = (): ClaudeCodeGenerationLease | null => {
    const lease = handle.activeLease;
    return lease && lease.state === "active" ? lease : null;
  };
  return {
    handle,
    activate: activate as unknown as ReturnType<typeof vi.fn>,
    getAskUserResponder: () => live()?.context.askResponder ?? null,
    emitToolEvent: (event) => {
      live()?.context.lifecycle?.(event);
    },
  };
}

function makeClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
  options: { failAfterSubmit?: boolean; responseText?: string } = {},
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        attempt: AssistantStreamAttemptContext,
      ): AssistantStreamRun<AssistantStreamEvent> => {
        const signal = attempt.signal;
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          let content = "The tool threw an unexpected error.";
          let isError = true;
          try {
            const answers = await responder.ask(askCall.arguments, {
              interactionId: "claude-code-ask",
              toolCallId: askCall.id,
              signal,
            });
            const result = buildAskUserResult(answers);
            content = result.content;
            isError = false;
          } finally {
            bridge.emitToolEvent({
              phase: "end",
              toolName: "ask_user",
              args: askCall.arguments,
              isError,
              content,
              toolCallId: askCall.id,
              askStatus: isError ? "skipped" : "completed",
            });
          }

          if (options.failAfterSubmit) {
            throw new Error("Claude Code provider failed after submission");
          }
          if (options.responseText) yield options.responseText;
        })();
        return textStreamResult(deltas, "claude-code-ask", askCall);
      },
    ),
  } as ChatClient;
}

function makeCleanInterruptClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        attempt: AssistantStreamAttemptContext,
      ): AssistantStreamRun<AssistantStreamEvent> => {
        const signal = attempt.signal;
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          try {
            await responder.ask(askCall.arguments, {
              interactionId: "claude-code-clean-interrupt",
              toolCallId: askCall.id,
              signal,
            });
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "AbortError") throw error;
            bridge.emitToolEvent({
              phase: "end",
              toolName: "ask_user",
              args: askCall.arguments,
              isError: true,
              content: askCancellationFailure("stopped").content,
              toolCallId: askCall.id,
              askStatus: "cancelled",
            });
          }
        })();
        return textStreamResult(deltas, "claude-code-interrupt", askCall);
      },
    ),
  } as ChatClient;
}

function makeEarlySettlingClaudeCodeClient(
  bridge: FakeClaudeCodeBridge,
  onCallbackSettled: (error: Error) => void,
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (
        _request: ChatRequest,
        _model: string,
        _params: unknown,
        attempt: AssistantStreamAttemptContext,
      ): AssistantStreamRun<AssistantStreamEvent> => {
        const signal = attempt.signal;
        const deltas = (async function* () {
          const responder = bridge.getAskUserResponder();
          if (!responder || !signal) {
            throw new Error("Claude Code ask responder was not installed before streaming.");
          }

          bridge.emitToolEvent({
            phase: "start",
            toolName: "ask_user",
            toolCallId: askCall.id,
          });
          void responder.ask(askCall.arguments, {
            interactionId: "legacy-early-settlement",
            toolCallId: askCall.id,
            signal,
          }).catch((error: unknown) => {
            onCallbackSettled(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        })();
        return textStreamResult(deltas, "claude-code-early", askCall);
      },
    ),
  } as ChatClient;
}

function textStreamResult(
  deltas: AsyncGenerator<string>,
  segmentId: string,
  toolCall?: ToolCall,
): AssistantStreamRun<AssistantStreamEvent> {
  const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
    yield { type: "segment_start", segmentId };
    if (toolCall) {
      const declarationKey = `${segmentId}:tool-0`;
      yield {
        type: "tool_call_start",
        segmentId,
        declarationKey,
        toolName: toolCall.name,
      };
      yield {
        type: "tool_call_identity",
        declarationKey,
        toolCallId: toolCall.id,
        correlation: "provider_id",
      };
      yield {
        type: "tool_call_delta",
        declarationKey,
        argumentsDelta: JSON.stringify(toolCall.arguments),
      };
    }
    for await (const delta of deltas) {
      yield { type: "prose_delta", segmentId, delta };
    }
    yield { type: "segment_end", segmentId };
    yield { type: "turn_end", status: "completed" };
  })();
  return ownedRunFromLegacy({
    events,
    usage: Promise.resolve(null),
    stopReason: Promise.resolve("end_turn"),
    replayCapsule: Promise.resolve(null),
    replayEvidence: Promise.resolve({
      tier: "textual",
      capabilities: {
        captureOrder: "text_only",
        toolCorrelation: "none",
        coldReplay: "textual",
        nativeResume: false,
      },
    }),
  });
}

function harness(
  finalization: "append" | "replace" = "append",
  posture: "ask" | "auto" = "ask",
) {
  const messages: ConversationMessage[] = [];
  // The in-flight generation audit as this suite needs it (RFC-0011 phase 6):
  // one recorder per generation, in memory, so the effect boundaries these tests
  // drive behave the way they do against the real store without this file owning
  // a conversation file. The durable behaviour itself is asserted in
  // `generationAuditStore.test.ts` and `generateLlmResponseTerminalAudit.test.ts`.
  const auditIntents: GenerationAuditIntent[] = [];
  const store = {
    persistActiveConversation: vi.fn(() => Promise.resolve()),
    openGenerationAudit: vi.fn((identity: GenerationAuditIdentity) => ({
      recordIntent: (request: EffectIntentRequest) => {
        const actionRef = identity.actionRefFor(
          request.correlation.kind === "none"
            ? request.targetId
            : request.correlation.toolCallId,
        );
        auditIntents.push({
          intentId: `intent-${actionRef}-${request.targetId}`,
          actionRef,
          family: request.family,
          targetId: request.targetId,
          correlation: request.correlation,
          summary: request.summary,
          recordedAt: 1,
          outcome: "pending",
        });
        return Promise.resolve();
      },
      reconcileIntent: (request: EffectIntentRequest) => {
        const intent = auditIntents.find(
          (entry) => entry.targetId === request.targetId,
        );
        if (intent) intent.outcome = "resolved";
        return Promise.resolve();
      },
    })),
    markGenerationIntentsUnknown: vi.fn(() => {
      for (const intent of auditIntents) {
        if (intent.outcome === "pending") intent.outcome = "unknown";
      }
      return auditIntents.length > 0
        ? { intents: auditIntents }
        : null;
    }),
    clearGenerationAudit: vi.fn(() => null),
    restoreGenerationAudit: vi.fn(),
    appendMessage: vi.fn((message: ConversationMessage) => messages.push(message)),
    setLastAssistantResponse: vi.fn(),
    commitRevisionReplacement: vi.fn(
      (
        messageId: string,
        revision: AssistantMessageRevision,
        _identity: unknown,
        actionLedger: ConversationMessage["actionLedger"],
      ) => {
        messages.push({
          id: messageId,
          role: "assistant",
          content:
            revision && "turn" in revision
              ? revision.turn.items
                  .filter((item) => item.type === "prose")
                  .map((item) => item.type === "prose" ? item.text : "")
                  .join("\n\n")
              : "",
          revisions: revision ? [revision] : [],
          activeRevisionId: revision?.revisionId,
          actionLedger,
          ...(revision.isError ? { isError: true } : {}),
          ...(revision.interrupted ? { interrupted: true } : {}),
        });
        return true;
      },
    ),
  } as unknown as ChatSessionStore;
  const turnView = {
    rootEl: {},
    refresh: vi.fn(() => Promise.resolve()),
    refreshLegacy: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    getReviewHostForToolCallId: vi.fn(() => null),
  };
  const bubble = {
    role: "assistant" as const,
    rowEl: {},
    columnEl: {},
    chromeEl: {},
    turnHostEl: {},
    turnView,
  };
  const transcript = {
    createDraftBubble: vi.fn(() => bubble),
    registerBubble: vi.fn(),
    releaseDraft: vi.fn(),
    renderBubbleContent: vi.fn(() => Promise.resolve()),
    renderPlainTextContent: vi.fn(),
  } as unknown as ChatTranscript;
  const interactionHost = new FakeInteractionHost();
  const activeControllers: Array<AbortController | null> = [];
  const settings = {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
    memoriesEnabled: false,
    vaultOpPolicy: {
      ...DEFAULT_VAULT_OP_POLICY,
      create: "deny" as const,
      overwrite: "deny" as const,
      move: "deny" as const,
      trash: "deny" as const,
      createDir: "deny" as const,
      edit: "deny" as const,
      memory: "deny" as const,
    },
  };
  const claudeCode = makeClaudeCodeBridge();
  const plugin = {
    settings,
    app: {
      workspace: {
        getActiveFile: () => null,
      },
      vault: {
        adapter: {},
        getName: () => "Vault",
        getAbstractFileByPath: () => null,
        getRoot: () => null,
      },
    },
    services: {
      ragService: {
        availability: () => "no-backend",
      },
      memoryService: {},
      modelAvailability: {
        getTrainedForToolUse: () => undefined,
        getVision: () => true,
        resolveContextWindow: () => undefined,
        reportContextWindow: vi.fn(),
      },
      claudeCode,
    },
  } as unknown as WritingAssistantChat;
  const oldMessage: ConversationMessage = {
    id: "old",
    role: "assistant",
    content: "Old answer.",
  };

  return {
    messages,
    store,
    transcript,
    interactionHost,
    activeControllers,
    claudeCode,
    options: {
      plugin,
      owner: {} as Component,
      store,
      transcript,
      activeModel: {
        provider: "openai",
        modelId: "gpt-test",
        name: "Test",
      } as CompletionModel,
      posture,
      interactionHost,
      claudeGeneration: claudeCode.handle,
      finalization:
        finalization === "append"
          ? { kind: "append" as const }
          : { kind: "replace" as const, oldMessage },
      setIsGenerating: vi.fn(),
      setActiveAbortController: (controller: AbortController | null) => {
        activeControllers.push(controller);
      },
    },
  };
}

function completedAskStep(
  message: ConversationMessage,
): AgenticStep | undefined {
  const revision = message.revisions?.find(
    (entry) => entry.revisionId === message.activeRevisionId,
  );
  if (revision?.kind === "turn") {
    const item = revision.turn.items.find(
      (entry) =>
        entry.type === "tool_call" &&
        entry.toolName === "ask_user",
    );
    if (item?.type === "tool_call") {
      return {
        type: "tool_call",
        round: item.round ?? 0,
        toolName: item.toolName,
        toolCallId: item.toolCallId,
        askGuidance: item.askGuidance,
        askStatus: item.askStatus,
      };
    }
  }
  return message.agenticSteps?.find((step) => step.toolName === "ask_user");
}

describe("generateLlmResponse version-2 persistence", () => {
  beforeEach(() => {
    vi.mocked(prepareApiMessages).mockResolvedValue({
      systemPrompt: "",
      documentContext: null,
      ragContext: null,
      messages: [],
      tools: [],
      allowedToolNames: [],
    });
  });

  /**
   * The phase 4 obligation. Every runtime writer now emits schema version 2 with
   * per-item capture evidence, and the descriptor-derived claim the provider
   * reported has to come back down to what that evidence supports before it is
   * persisted. Without the lowering the revision is refused on reload as
   * `revision_metadata_invalid`, which is a corrupted conversation rather than a
   * visible failure, so it is asserted through the real persistence path.
   */
  it("persists a turn whose replay claim its own capture evidence supports", async () => {
    const state = harness("append");
    const client = makeClient([{ deltas: ["Answer."] }]);

    await generateLlmResponse({ ...state.options, client });

    expect(state.messages).toHaveLength(1);
    const message = state.messages[0];
    const revision = message.revisions?.find(
      (entry) => entry.revisionId === message.activeRevisionId,
    );
    if (revision?.kind !== "turn") throw new Error("expected a turn revision");

    expect(revision.turn.schemaVersion).toBe(2);
    // The provider reported `exact`; nothing in the runtime placement supports
    // it, so what is stored is what the items back.
    expect(revision.replayEvidence?.capabilities.captureOrder).not.toBe("exact");
    expect(
      validateAssistantMessageState({
        revisions: message.revisions,
        activeRevisionId: message.activeRevisionId,
        actionLedger: message.actionLedger ?? [],
      }).ok,
    ).toBe(true);
  });
});

describe("generateLlmResponse ask_user integration", () => {
  beforeEach(() => {
    vi.mocked(prepareApiMessages).mockResolvedValue({
      systemPrompt: "",
      documentContext: null,
      ragContext: null,
      messages: [],
      tools: [buildAskUserTool(4)],
      allowedToolNames: ["ask_user"],
    });
  });

  it.each(["ask", "auto"] as const)(
    "keeps the model suspended under %s posture until submit",
    async (posture) => {
      const state = harness("append", posture);
      const client = makeClient([
        { toolCalls: [askCall] },
        { deltas: ["Done."] },
      ]);

      const pending = generateLlmResponse({ ...state.options, client });
      await state.interactionHost.mounted;

      expect(client.stream).toHaveBeenCalledTimes(1);
      state.interactionHost.submit({ [question]: "Detailed" });
      await pending;

      expect(client.stream).toHaveBeenCalledTimes(2);
      expect(state.messages).toHaveLength(1);
      expect(completedAskStep(state.messages[0])).toMatchObject({
        askStatus: "completed",
        askGuidance: {
          questions: [
            {
              question,
              header: "Output",
              answer: "Detailed",
            },
          ],
        },
      });
      expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
      expect(state.activeControllers.at(-1)).toBeNull();
    },
  );

  it("persists zero-text completion after submitted guidance", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { deltas: [] },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Concise" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("");
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
  });

  it("persists submitted guidance when the provider fails afterward", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { error: new Error("provider failed") },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].isError).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("persists submitted guidance when Stop wins during the next provider round", async () => {
    const state = harness();
    const client = makeClient([
      { toolCalls: [askCall] },
      { waitForAbort: true },
    ]);
    const pending = generateLlmResponse({ ...state.options, client });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await client.roundStarted(1);

    state.activeControllers[0]?.abort();
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].interrupted).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
  });

  it("keeps replacement-attempt guidance in regeneration metadata", async () => {
    const state = harness("replace");
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([
        { toolCalls: [askCall] },
        { deltas: ["Replacement."] },
      ]),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.store.commitRevisionReplacement).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({
        kind: "turn",
        origin: "regenerated",
        turn: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_call",
              toolName: "ask_user",
              askStatus: "completed",
            }),
          ]),
        }),
      }),
      expect.any(Function),
      expect.any(Array),
    );
  });

  it("lets abort win before submit and clears the mounted interaction", async () => {
    const state = harness();
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClient([{ toolCalls: [askCall] }]),
    });
    await state.interactionHost.mounted;

    state.activeControllers[0]?.abort();
    state.activeControllers[0]?.abort();
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].interrupted).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeUndefined();
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("binds the Claude Code responder for the generation and clears it on Stop", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClaudeCodeClient(state.claudeCode),
    });
    await state.interactionHost.mounted;

    expect(state.claudeCode.getAskUserResponder()).not.toBeNull();
    expect(state.claudeCode.activate).toHaveBeenCalledTimes(1);

    state.activeControllers[0]?.abort();
    await pending;

    expect(state.interactionHost.interaction).toBeNull();
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    // Released rather than cleared: the generation's own lifetime ended, and the
    // owners went with it (RFC-0011 phase 5).
    expect(state.claudeCode.handle.activeLease?.state).toBe("quiescent");
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("classifies a clean SDK Stop as an interrupted generation", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeCleanInterruptClaudeCodeClient(state.claudeCode),
    });
    await state.interactionHost.mounted;

    state.activeControllers[0]?.abort();
    state.activeControllers[0]?.abort();
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      content: "",
    });
    expect(
      state.messages[0].revisions?.find(
        (revision) => revision.revisionId === state.messages[0].activeRevisionId,
      ),
    ).toMatchObject({ kind: "turn", interrupted: true });
    expect(completedAskStep(state.messages[0])).toMatchObject({
      toolName: "ask_user",
      askStatus: "cancelled",
    });
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("cleans up safely when a legacy query settles before its ask callback", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    let settleCallback!: (error: Error) => void;
    const callbackSettled = new Promise<Error>((resolve) => {
      settleCallback = resolve;
    });

    await generateLlmResponse({
      ...state.options,
      client: makeEarlySettlingClaudeCodeClient(
        state.claudeCode,
        settleCallback,
      ),
    });
    const callbackError = await callbackSettled;

    expect(callbackError).toMatchObject({
      name: "AbortError",
      message: "The request was aborted.",
    });
    expect(state.interactionHost.interaction).toBeNull();
    expect(state.interactionHost.clearIfOwner).toHaveBeenCalledTimes(1);
    expect(state.claudeCode.getAskUserResponder()).toBeNull();
    expect(state.activeControllers.at(-1)).toBeNull();
  });

  it("persists and replays Claude Code guidance when the provider fails after submit", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const pending = generateLlmResponse({
      ...state.options,
      client: makeClaudeCodeClient(state.claudeCode, { failAfterSubmit: true }),
    });
    await state.interactionHost.mounted;
    state.interactionHost.submit({ [question]: "Detailed" });
    await pending;

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].isError).toBe(true);
    expect(completedAskStep(state.messages[0])?.askGuidance).toBeDefined();
    expect(state.messages[0].agenticSteps).toBeUndefined();
  });
});

/**
 * A Claude Code run that writes one note through the plugin's MCP tool: the
 * lifecycle events are the only account the chat has of that call.
 */
function makeClaudeCodeWriteClient(
  bridge: FakeClaudeCodeBridge,
  call: ToolCall,
): ChatClient {
  return {
    complete: vi.fn(),
    stream: vi.fn(
      (): AssistantStreamRun<AssistantStreamEvent> => {
        const deltas = (async function* () {
          bridge.emitToolEvent({
            phase: "start",
            toolName: call.name,
            toolCallId: call.id,
          });
          bridge.emitToolEvent({
            phase: "end",
            toolName: call.name,
            args: call.arguments,
            isError: false,
            content: `Wrote ${String(call.arguments.path)}.`,
            toolCallId: call.id,
          });
          yield "Written.";
        })();
        return textStreamResult(deltas, "claude-code-write", call);
      },
    ),
  } as ChatClient;
}

describe("generateLlmResponse Claude Code tool steps", () => {
  beforeEach(() => {
    vi.mocked(prepareApiMessages).mockResolvedValue({
      systemPrompt: "",
      documentContext: null,
      ragContext: null,
      messages: [],
      tools: [],
      allowedToolNames: [],
    });
  });

  it("records a step's summary as its detail whatever the size of its arguments", async () => {
    const state = harness();
    state.options.activeModel = {
      provider: "claudecode",
      modelId: "claude-sonnet-test",
      name: "Claude test",
    };
    const writeCall: ToolCall = {
      id: "write-1",
      name: "write_file",
      arguments: { path: "Notes/Big.md", content: "x".repeat(16_000) },
    };

    await generateLlmResponse({
      ...state.options,
      client: makeClaudeCodeWriteClient(state.claudeCode, writeCall),
    });

    expect(state.messages).toHaveLength(1);
    const message = state.messages[0];
    expect(message.isError).not.toBe(true);
    const revision = message.revisions?.find(
      (entry) => entry.revisionId === message.activeRevisionId,
    );
    if (revision?.kind !== "turn") throw new Error("expected a turn revision");
    expect(revision.turn.status).toBe("completed");
    const step = revision.turn.items.find(
      (item) => item.type === "tool_call" && item.toolName === "write_file",
    );
    if (step?.type !== "tool_call") throw new Error("expected the write_file step");
    expect(step).toMatchObject({ state: "completed", toolInput: "Notes/Big.md" });
    expect(step.toolArgs).toEqual(writeCall.arguments);
    expect(revision.turn.items.some((item) => item.type === "prose")).toBe(true);
  });
});
