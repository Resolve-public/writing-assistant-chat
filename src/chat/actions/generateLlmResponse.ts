import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { buildSamplingParams } from "../finalization/buildSamplingParams";
import { resolveModelReasoning } from "../../providers/reasoningLevels";
import type WritingAssistantChat from "../../main";
import type { ChatClient } from "../../api/chatClient";
import { createAbortError } from "../../api/httpTransport";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type {
  ApprovalPosture,
  AssistantReplayEvidence,
  AssistantTurnRecord,
  CompletionModel,
  ConversationMessage,
  ProviderOption,
} from "../../shared/types";
import { writesPermitted } from "../../vault-ops/gateway";
import { getActiveProfile } from "../../shared/profileUtils";
import { prepareApiMessages } from "../finalization/prepareApiMessages";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { insertLastResponse } from "../finalization/insertLastResponse";
import { buildRegexEditProposals } from "../finalization/regexEditProposals";
import { estimateCost } from "../../api/pricing";
import { resolveVisionSupport } from "../../api/ModelAvailabilityService";
import type { UsageResult } from "../../api/usageTypes";
import type { MessageUsage } from "../../shared/types";
import { isActionTool, runToolLoop } from "./toolLoop";
import type {
  MemoryToolContext,
  ToolExecutionContext,
  TurnSettlementEvidence,
  VaultOpToolContext,
  VaultToolContext,
} from "./toolLoop";
import { LiveVaultReview } from "./liveVaultReview";
import { extractToolInput } from "../../tools/metadata";
import { finishOrSalvageAssistantTurn } from "../turns/assistantTurnSalvage";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";
import type { ComposerInteractionHostPort } from "../interactions/ComposerInteractionHost";
import { AskInteractionCoordinator } from "../interactions/AskInteractionCoordinator";
import { ApprovalInteractionCoordinator } from "../interactions/ApprovalInteractionCoordinator";
import { generateId } from "../../utils";
import {
  AssistantTurnBuilder,
  type AssistantTurnSnapshot,
} from "../turns/AssistantTurnBuilder";
import {
  createAssistantTurnMessage,
  createAssistantTurnRevision,
} from "../finalization/assistantTurnFinalization";
import {
  getActiveAssistantRevision,
  isMeaningfulAssistantReplacement,
} from "../conversation/assistantRevisions";
import {
  allVisibleProse,
  lastNonEmptyProse,
  rawConcatenatedProse,
} from "../turns/assistantTurnProjections";
import { projectRegexEditPreview } from "../messages/regexEditPreview";
import {
  lowerEvidenceFromCapture,
  withTerminalCaptureEvidence,
} from "../../shared/captureEvidence";
import { unknownOutcomeDiagnostic } from "../../shared/generationAudit";
import {
  buildDirectProviderActionLedger,
  pruneDanglingActionRefs,
  unmatchedAuditIntents,
} from "../finalization/directProviderActionLedger";
import type {
  ClaudeCodeGenerationHandle,
  ClaudeCodeGenerationLease,
} from "../../services/ClaudeCodeGenerationLease";

/**
 * How to commit the completed generation to the store.
 * - "append": add a new assistant message (send / resume)
 * - "replace": replace an existing assistant message (regenerate)
 */
type FinalizationMode =
  | { kind: "append"; autoInsert?: boolean }
  | { kind: "replace"; oldMessage: ConversationMessage };

export interface LlmGenerationOptions {
  plugin: WritingAssistantChat;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  activeModel: CompletionModel;
  client: ChatClient;
  interactionHost: ComposerInteractionHostPort;
  /** Session approval posture, the replacement for the plan/chat/edit mode. */
  posture: ApprovalPosture;
  /**
   * This generation's grip on Claude Code's callback surfaces (ADR-0032),
   * taken from the runtime the caller resolved. Present only for `claudecode`.
   * Activated with the owners below before any provider call and released in this
   * function's `finally`, which is what makes "one callback, one generation" a
   * lifetime rather than a convention.
   */
  claudeGeneration?: ClaudeCodeGenerationHandle;
  finalization: FinalizationMode;
  setIsGenerating: (v: boolean) => void;
  setActiveAbortController: (c: AbortController | null) => void;
  onCalibrate?: (estimated: number, actual: number) => void;
  /** Flip the session to auto-apply; powers the edit review's "Accept all this session". */
  onEnterAutoApply?: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function buildMessageUsage(modelId: string, usage: UsageResult): MessageUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
    ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.contextTokens !== undefined && { contextTokens: usage.contextTokens }),
    ...(usage.sessionReused !== undefined && { sessionReused: usage.sessionReused }),
    ...(usage.sessionResumed !== undefined && { sessionResumed: usage.sessionResumed }),
    ...(usage.sessionRebuildReason !== undefined && {
      sessionRebuildReason: usage.sessionRebuildReason,
    }),
    ...(usage.resumeCursor !== undefined && { resumeCursor: usage.resumeCursor }),
    // Provider-reported cost wins over the price-table estimate because Claude
    // Code aliases have no price-table entry.
    estimatedCostUsd: usage.costUsd ?? estimateCost(modelId, usage) ?? undefined,
  };
}

/**
 * The tokens actually occupying the context window for a request, for capacity
 * calibration. Cached prompt tokens are still context, so cache reads/writes
 * count; `inputTokens` alone is just the uncached remainder and collapses the
 * correction ratio toward zero on well-cached turns.
 */
function contextTokensOf(usage: UsageResult): number {
  return (
    usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
  );
}

/**
 * Core generation pipeline shared by all entry points (send, resume, regenerate).
 *
 * Callers are responsible for mutating the store into the correct pre-generation
 * state (appending a user message, removing an old assistant message, etc.) before
 * calling this function. This function owns everything from context preparation
 * through streaming, finalization, and cleanup.
 */
export async function generateLlmResponse(options: LlmGenerationOptions): Promise<void> {
  const {
    plugin,
    store,
    transcript,
    activeModel,
    client,
    interactionHost,
    posture,
    claudeGeneration,
    finalization,
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
    onEnterAutoApply,
  } = options;

  const activeProfile = getActiveProfile(plugin.settings, activeModel.provider);
  const draftIdentity = {
    messageId: generateId(),
    revisionId: `revision-${generateId()}`,
    turnId: `turn-${generateId()}`,
    createdAt: Date.now(),
  };
  /** One action reference formula, shared by the audit and the ledger it folds into. */
  const actionRefFor = (toolCallId: string): string =>
    `action-${draftIdentity.revisionId}-${toolCallId}`;
  // The generation's durable write-ahead audit (ADR-0033). Keyed by the
  // draft identity, which this generation owns before any lease or attempt exists;
  // the lease that admits a callback rides on the record as evidence. Every
  // consequential executor on either path, Claude Code's MCP callbacks and the
  // plugin's own tool loop, records through this one recorder.
  const auditRecorder = store.openGenerationAudit({
    messageId: draftIdentity.messageId,
    turnId: draftIdentity.turnId,
    provider: activeModel.provider,
    modelId: activeModel.modelId,
    actionRefFor,
  });
  let settlementEvidence: TurnSettlementEvidence = {
    quiescence: "proven",
    diagnostics: [],
  };
  const turnBuilder = new AssistantTurnBuilder({
    turnId: draftIdentity.turnId,
    resultRecordChars: plugin.settings.toolResultRecordChars,
  });
  let capturedTurn: AssistantTurnRecord | null = null;
  let capturedReplayEvidence: AssistantReplayEvidence | null = null;
  let capturedToolCorrelations: Record<
    string,
    "provider_id" | "plugin_id"
  > = {};
  const claudeActionRefsByToolCallId: Record<string, string> = {};
  const claudeToolCorrelations: Record<string, "provider_id"> = {};
  // Set when this generation actually owns a Claude callback surface, so the tool
  // loop can bind it to the turn-run owner. Null on every other provider.
  let claudeLease: ClaudeCodeGenerationLease | undefined;

  // Ambient editing: the edit pipeline (edit renderer, edit
  // review channel is active whenever the session permits any
  // write. A read-only session is exactly a deny-all policy under the `ask` posture.
  const editsActive = writesPermitted(plugin.settings.vaultOpPolicy, posture);
  const activeFilePath = plugin.app.workspace.getActiveFile()?.path;

  // Arm the abort controller BEFORE the awaited prep (RAG query rewrite + retrieval) so
  // Stop cancels during context preparation instead of being a visible no-op until the
  // first delta. The liveReview cancel listener is attached later, once liveReview exists.
  const abortController = new AbortController();
  setActiveAbortController(abortController);
  const askCoordinator = new AskInteractionCoordinator(
    interactionHost,
    abortController.signal,
    () => plugin.settings.askMaxQuestions,
  );
  // The generation's live-approval lane (RFC-0012): the same host and the same signal as
  // the ask coordinator, sharing a mount point and nothing else.
  const approvalCoordinator = new ApprovalInteractionCoordinator(
    interactionHost,
    abortController.signal,
  );

  // Gate: unknown vision capability is allow-the-attempt, keep image attachments in the
  // request for an unprobed model rather than stripping them (matches the attach gate).
  // Read twice below: once for history projection, once for the vault tools' delivery flag.
  const supportsVision =
    resolveVisionSupport(activeModel, plugin.services.modelAvailability) ?? true;

  let apiMessages;
  try {
    apiMessages = await prepareApiMessages({
      app: plugin.app,
      store,
      settings: plugin.settings,
      posture,
      signal: abortController.signal,
      ragService: plugin.services.ragService,
      memoryService: plugin.services.memoryService,
      activeProvider: activeModel.provider,
      modelCapabilities: {
        trainedForToolUse:
          activeModel.trainedForToolUse ??
          plugin.services.modelAvailability.getTrainedForToolUse(activeModel.modelId),
      },
      chatClient: client,
      completionModelId: activeModel.modelId,
      profileSystemPrompt: activeProfile.systemPrompt,
      disableBuiltinSystemPrompts: activeProfile.disableBuiltinSystemPrompts,
      // Layer-2 enablement rides this same toggle (ADR-0009): tool search activates on the
      // direct anthropic agentic path only when caching is on. The cache settings themselves
      // are attached just below; prepareApiMessages needs the flag up front to choose the
      // tool emission.
      anthropicCacheEnabled: activeProfile.anthropicCacheSettings.enabled,
      supportsVision,
      ...(finalization.kind === "replace"
        ? { excludeMessageId: finalization.oldMessage.id }
        : {}),
    });
  } catch (error) {
    askCoordinator.destroy();
    approvalCoordinator.destroy();
    // Context preparation failed before the main `try`, so its `finally` never
    // runs. The handle still owns a callback surface (and, on the legacy path, a
    // live loopback server), so it is released on this path too.
    await claudeGeneration?.release();
    setActiveAbortController(null);
    // Same shape as the `finally` below, with one difference: this path is already throwing
    // something worth reading, so a failed write here is swallowed rather than allowed to replace
    // the error that caused it.
    try {
      await store.persistActiveConversation();
    } catch (persistError) {
      console.error("[chat] The failed turn's state could not be persisted.", persistError);
    } finally {
      setIsGenerating(false);
    }
    throw error;
  }

  const ragSources = apiMessages.ragContext?.map(
    ({ filePath, headingPath, score, content, graphContext }) => ({
      filePath,
      headingPath,
      score,
      content,
      graphContext,
    }),
  );
  const { rewrittenQuery } = apiMessages;

  if (activeProfile.anthropicCacheSettings.enabled) {
    apiMessages.anthropicCacheSettings = activeProfile.anthropicCacheSettings;
  }

  // The write-ahead persist, before a single token is asked for. It still refuses the turn when it
  // cannot make the audit durable, and it no longer leaves the composer generating while it does:
  // nothing above this line is inside a `finally` that would have cleared the flag.
  try {
    await store.persistActiveConversation();
  } catch (error) {
    setIsGenerating(false);
    throw error;
  }

  const contextWindow = plugin.services.modelAvailability.resolveContextWindow(activeModel);
  if (contextWindow) {
    const estimatedTokens = estimateTokenCount(apiMessages);
    if (estimatedTokens / contextWindow >= CONTEXT_DANGER_THRESHOLD) {
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      new Notice(`Context is ~${pct}% full. The model may truncate older messages.`);
    }
  }

  // A regeneration streams while the original message stays active, so the
  // transcript hides the original until the draft commits or is released.
  const assistantBubble = transcript.createDraftBubble(
    finalization.kind === "replace" ? finalization.oldMessage.id : null,
  );

  // The plugin loop and Claude Code's internal MCP loop now feed the same
  // canonical builder. Claude lifecycle callbacks update state by exact ID but
  // never position a tool item.
  const pluginAgentic = !!apiMessages.tools?.length;
  const claudeCodeAgentic =
    activeModel.provider === "claudecode" && plugin.settings.agenticMode;
  let latestSnapshot = turnBuilder.snapshot();
  const refreshLiveTurn = (snapshot: AssistantTurnSnapshot): void => {
    latestSnapshot = snapshot;
    void assistantBubble.turnView.refresh(snapshot, {
      regexEditPreview:
        editsActive && !pluginAgentic && !claudeCodeAgentic
          ? projectRegexEditPreview(snapshot)
          : null,
    });
  };
  refreshLiveTurn(latestSnapshot);

  const vaultToolContext: VaultToolContext = {
    app: plugin.app,
    ragService: plugin.services.ragService,
    // The active note rides as a frozen attachment; the model reads current content
    // via tools, so the active file is just the current pane's file (RAG exclusion).
    activeFilePath,
    // Every direct provider's wire format carries an image (nested for Anthropic, a
    // synthesized user message on the OpenAI shape), so this site never emits
    // "transport-cannot-carry": the model's own capability is the only gate, and an
    // unprobed model is allowed the attempt (RFC-0021 P2).
    imageDelivery: supportsVision === false ? "model-cannot-see" : "inline",
  };

  const editToolContext: ToolExecutionContext | undefined =
    editsActive
      ? { app: plugin.app, filePath: activeFilePath ?? "" }
      : undefined;
  const memoryToolContext: MemoryToolContext | undefined =
    plugin.settings.memoriesEnabled
      ? {
          memoryService: plugin.services.memoryService,
          getMemories: () => plugin.settings.memories,
          saveSettings: () => plugin.saveSettings(),
        }
      : undefined;

  // The in-loop review coordinator: owns the live vault-op proposal, mounts the
  // review on the streaming timeline, applies auto ops, and suspends the loop on
  // ask-gated ops until the user decides (in-loop-tool-approval-blocking-flow). In
  // when editing is active it also owns the edit channel, folding the live diff onto
  // the timeline step like vault ops (ADR-0018).
  const liveReview = new LiveVaultReview({
    app: plugin.app,
    timelineEl: assistantBubble.turnView.rootEl,
    findActionHostByToolCallId: (toolCallId) =>
      assistantBubble.turnView.getReviewHostForToolCallId(toolCallId),
    getProvisionalActionHost: () =>
      assistantBubble.turnView.getProvisionalReviewHost(),
    onReviewPlacementChanged: () =>
      assistantBubble.turnView.refreshActionSectionVisibility(),
    policy: plugin.settings.vaultOpPolicy,
    posture,
    ...(editsActive && {
      edit: {
        inlineDiff: plugin.inlineDiff,
        resolveOptions: {
          contextLines: plugin.settings.diffContextLines,
          minConfidence: plugin.settings.diffMinMatchConfidence,
        },
      },
    }),
    ...(memoryToolContext && { memory: memoryToolContext }),
    // Session approval is offered on every channel now, not just edits (RFC-0012).
    ...(onEnterAutoApply && { onEnterAutoApply }),
    approvals: approvalCoordinator,
  });

  // Vault ops operate on arbitrary paths, so they need only the app + the live
  // review; the coordinator rebuilds the pending overlay per round.
  const vaultOpToolContext: VaultOpToolContext = { app: plugin.app, liveReview };

  // Abort (stop button, or a new user turn superseding this one) must resolve any
  // op parked on the user, or a suspended loop would hang forever on the await. The
  // controller itself was armed before prepareApiMessages so Stop also cancels prep.
  abortController.signal.addEventListener("abort", () => liveReview.cancelPending());

  const persistDirectTurn = async (input: {
    turn: AssistantTurnRecord;
    replayEvidence: AssistantReplayEvidence;
    toolCorrelations: Record<string, "provider_id" | "plugin_id">;
    usage?: UsageResult | null;
    isError?: boolean;
    interrupted?: boolean;
    errorMessage?: string;
    editProposals?: ReturnType<LiveVaultReview["getEditProposals"]>;
    parsedEditPlacement?: { itemId: string; actionRef: string };
  }): Promise<boolean> => {
    // Everything unreconciled becomes an unknown outcome before the fold: an
    // intent nobody closed belongs to an effect whose result cannot be invented
    // (ADR-0033).
    const audit = store.markGenerationIntentsUnknown();
    const intents = audit?.intents ?? [];
    const actionLedger = buildDirectProviderActionLedger({
      revisionId: draftIdentity.revisionId,
      turn: input.turn,
      toolCorrelations: input.toolCorrelations,
      actionRefsByToolCallId: claudeActionRefsByToolCallId,
      editProposals:
        input.editProposals ?? liveReview.getEditProposals(),
      appliedEditRecords: liveReview.getEditAppliedRecords(),
      vaultOpProposal: liveReview.getProposal() ?? undefined,
      appliedVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
      memoryProposals: liveReview.getMemoryProposals(),
      parsedEditPlacement: input.parsedEditPlacement,
      intents,
      createEventId: () => `event-${generateId()}`,
      createdAt: draftIdentity.createdAt,
    });
    // An intent whose action never reached its review has no ledger entry it can
    // become, because every entry payload needs evidence an intent deliberately
    // does not carry. It is kept as bounded terminal evidence on the turn instead.
    const turn = withTerminalCaptureEvidence(
      pruneDanglingActionRefs(input.turn, actionLedger),
      {
        quiescence: settlementEvidence.quiescence,
        diagnostics: [
          ...settlementEvidence.diagnostics,
          ...unmatchedAuditIntents(actionLedger, intents).map((intent) =>
            unknownOutcomeDiagnostic(activeModel.provider, intent),
          ),
        ],
      },
    );
    const parentRevision =
      finalization.kind === "replace"
        ? getActiveAssistantRevision(finalization.oldMessage)
        : null;
    const messageUsage = input.usage
      ? withoutForcedResumeCursor(
          buildMessageUsage(activeModel.modelId, input.usage),
          settlementEvidence.quiescence,
        )
      : undefined;
    // A descriptor is a ceiling; the turn's own items decide what it may claim
    // (ADR-0031). This runtime path writes version-2 capture evidence, so this is
    // where the claim has to come back down: without
    // it `crossCheckCaptureEvidence()` refuses the revision on reload with
    // `revision_metadata_invalid`, because no runtime placement supports an exact
    // ordering claim once no translator records an exact provider block identity.
    // Quiescence belongs to the same turn, so forced settlement lowers native
    // resume through the same call (ADR-0032).
    const supportedEvidence = lowerEvidenceFromCapture(
      input.replayEvidence,
      turn,
    );
    const revision = createAssistantTurnRevision({
      revisionId: draftIdentity.revisionId,
      origin:
        finalization.kind === "replace"
          ? "regenerated"
          : "generated",
      ...(parentRevision
        ? { parentRevisionId: parentRevision.revisionId }
        : {}),
      createdAt: draftIdentity.createdAt,
      provider: activeModel.provider,
      modelId: activeModel.modelId,
      turn,
      replayEvidence: supportedEvidence,
      ...(messageUsage ? { usage: messageUsage } : {}),
      ...(ragSources ? { ragSources } : {}),
      ...(rewrittenQuery ? { rewrittenQuery } : {}),
      ...(input.isError ? { isError: true } : {}),
      ...(input.interrupted ? { interrupted: true } : {}),
      ...(input.errorMessage
        ? { errorMessage: input.errorMessage }
        : {}),
    });
    const response = allVisibleProse(turn);
    if (finalization.kind === "replace") {
      if (
        !isMeaningfulAssistantReplacement({
          provider: activeModel.provider,
          turn,
          replayEvidence: supportedEvidence,
          usage: messageUsage,
        })
      ) {
        assistantBubble.turnView.destroy();
        assistantBubble.rowEl.remove();
        return false;
      }
      const committed = store.commitRevisionReplacement(
        finalization.oldMessage.id,
        revision,
        (_actionRef, _targetId, index) => ({
          eventId: `event-${generateId()}-${index}`,
          createdAt: Math.max(Date.now(), draftIdentity.createdAt),
        }),
        actionLedger,
      );
      if (!committed) {
        throw new Error("Could not commit the regenerated assistant revision.");
      }
      transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
    } else {
      const assistantMessage = createAssistantTurnMessage({
        messageId: draftIdentity.messageId,
        revision,
        actionLedger,
      });
      store.appendMessage(assistantMessage);
      transcript.registerBubble(assistantMessage.id, assistantBubble);
    }
    store.setLastAssistantResponse(response);
    // The revision now carries every intent's terminal evidence, so the in-flight
    // record is redundant and is cleared in the same persisted transition
    // (ADR-0033). A write that does not land puts the audit back: the
    // evidence has to survive for the one bounded retry the `finally` performs.
    const cleared = store.clearGenerationAudit();
    try {
      await store.persistActiveConversation();
    } catch (error) {
      store.restoreGenerationAudit(cleared);
      console.error(
        "[chat] The finished assistant turn could not be persisted.",
        error,
      );
    }
    liveReview.detachPanels?.();
    await assistantBubble.turnView.refresh(turn, {
      actionLedger,
      ...(input.errorMessage === undefined
        ? {}
        : { errorMessage: input.errorMessage }),
    });
    await assistantBubble.turnView.flush();
    if (
      finalization.kind === "append" &&
      finalization.autoInsert
    ) {
      const insertion = lastNonEmptyProse(turn);
      if (insertion) {
        await insertLastResponse(plugin, insertion);
      }
    }
    return true;
  };

  try {
    // One unified agentic round budget now that the modes are gone (the old edit-only
    // cap keyed off the live document, which no longer exists). The per-turn
    // identical-call guard is the primary spin control; this is the high backstop.
    const maxRounds = plugin.settings.maxToolRounds;

    // Only the plugin-owned tool loop buffers deltas; Claude Code streams live.
    const agenticMode = pluginAgentic;

    // Claude Code lifecycle callbacks may beat the SDK declaration. They reserve
    // identity and state by exact ID, while SDK events remain the only positioner.
    //
    // Activation is the one place this generation's owners are installed, and the
    // lease has no setter that replaces them afterwards (ADR-0032). Every callback
    // admitted from here on reads these objects or none.
    if (claudeCodeAgentic) {
      claudeLease = claudeGeneration?.activate({
        review: liveReview,
        askResponder: askCoordinator,
        askSignal: abortController.signal,
        signal: abortController.signal,
        // The same recorder the plugin loop uses: one conversation-scoped audit
        // per generation, whichever executor crosses a boundary (ADR-0033).
        audit: auditRecorder,
        lifecycle: (event) => {
          claudeToolCorrelations[event.toolCallId] = "provider_id";
          if (event.phase === "start") {
            const actionRef = isActionTool(event.toolName)
              ? `action-${draftIdentity.revisionId}-${event.toolCallId}`
              : undefined;
            if (actionRef) {
              claudeActionRefsByToolCallId[event.toolCallId] = actionRef;
            }
            turnBuilder.updateToolLifecycle(event.toolCallId, {
              state: "running",
              toolName: event.toolName,
              ...(actionRef ? { actionRef } : {}),
            });
          } else {
            const capture = turnBuilder.captureFields(event.toolName, event.args, {
              content: event.content,
              isError: event.isError,
              disposition: event.disposition,
              // Already stripped of bytes by the callback surface (RFC-0021 P7).
              ...(event.images ? { images: event.images } : {}),
            });
            // The one-line detail the step shows, as the plugin loop records it.
            // The arguments themselves arrive through the SDK capture as
            // `toolArguments`, so the detail never carries a note's whole body.
            const detail = extractToolInput({
              name: event.toolName,
              arguments: event.args,
            });
            turnBuilder.updateToolLifecycle(event.toolCallId, {
              state: event.isError ? "failed" : "completed",
              toolName: event.toolName,
              ...(detail === undefined ? {} : { toolInput: detail }),
              resultRecord: capture.resultRecord,
              resultDigest: capture.resultDigest,
              resultImages: capture.resultImages,
              askGuidance: capture.askGuidance,
              ...(event.askStatus && { askStatus: event.askStatus }),
              ...(event.isError && { isError: true, errorContent: event.content }),
            });
          }
          refreshLiveTurn(turnBuilder.snapshot());
        },
      });
    }

    // Persistence below, and the owner teardown in `finally`, both depend on
    // `runToolLoop()` having settled its provider run before it returns or
    // rethrows (ADR-0032). It owns that guarantee in its own
    // `finally`, so review and ask owners stay attached until the provider is
    // quiet and no turn is written while a provider can still produce work.
    const loopResult = await runToolLoop(
      client,
      apiMessages,
      activeModel.modelId,
      activeModel.provider,
      buildSamplingParams(
        activeProfile,
        resolveModelReasoning(
          plugin.settings.reasoningByModelKey,
          activeModel,
          plugin.services.modelAvailability,
        ),
      ),
      abortController.signal,
      {
        onDelta: () => undefined,
        onTurnSnapshot: refreshLiveTurn,
        // The turn record is frozen before the provider is proven quiet, so the
        // quiescence mode and the settlement diagnostics arrive here and are
        // stamped on at persistence (ADR-0032).
        onSettlement: (evidence) => {
          settlementEvidence = evidence;
        },
        onCalibrate: onCalibrate
          ? (request, usage) => {
              // A provider that reports its context size directly (Claude Code)
              // doesn't use ratio correction, the ring anchors on the persisted
              // per-message contextTokens instead. Its huge fixed harness
              // overhead over a small transcript would poison the ratio (~65x).
              if (usage.contextTokens !== undefined) return;
              const estimated = estimateTokenCount(request);
              onCalibrate(estimated, contextTokensOf(usage));
            }
          : undefined,
      },
      maxRounds,
      agenticMode,
      vaultToolContext,
      editToolContext,
      vaultOpToolContext,
      memoryToolContext,
      askCoordinator,
      turnBuilder,
      actionRefFor,
      claudeLease,
      auditRecorder,
    );
    const {
      usage: finalUsage,
      turn,
      replayEvidence,
      toolCorrelations,
    } = loopResult;
    capturedTurn = turn;
    capturedReplayEvidence = replayEvidence;
    const exactToolCorrelations = {
      ...claudeToolCorrelations,
      ...toolCorrelations,
    };
    capturedToolCorrelations = exactToolCorrelations;
    if (abortController.signal.aborted) throw createAbortError();

    latestSnapshot = turn;
    await assistantBubble.turnView.refresh(turn);
    await assistantBubble.turnView.flush();

    // Claude Code reports its own context window per turn (its catalog aliases
    // carry no static size); record it so the capacity ring's fallback lookup
    // resolves from the next recalculation on.
    if (finalUsage?.contextWindow) {
      plugin.services.modelAvailability.reportContextWindow(
        activeModel.modelId,
        finalUsage.contextWindow,
      );
    }

    let persistedTurn = turn;
    let regexEditProposals:
      | ReturnType<LiveVaultReview["getEditProposals"]>
      | undefined;
    let parsedEditPlacement:
      | { itemId: string; actionRef: string }
      | undefined;
    if (editsActive && !pluginAgentic && !claudeCodeAgentic) {
      regexEditProposals = await buildRegexEditProposals(
        plugin.app,
        plugin,
        rawConcatenatedProse(turn),
      );
      if (regexEditProposals.length > 0) {
        const actionRef =
          `action-${draftIdentity.revisionId}-parsed-edit`;
        const anchored = anchorParsedEditTurn(turn, actionRef);
        persistedTurn = anchored.turn;
        parsedEditPlacement = {
          itemId: anchored.itemId,
          actionRef,
        };
      }
    }
    await persistDirectTurn({
      turn: persistedTurn,
      replayEvidence,
      toolCorrelations: exactToolCorrelations,
      usage: finalUsage,
      editProposals: regexEditProposals,
      parsedEditPlacement,
    });
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted) {
      const interruptedTurn =
        capturedTurn
          ? interruptCapturedTurn(capturedTurn)
          : finishDirectTurn(
              turnBuilder,
              "interrupted",
              "Generation stopped.",
            );
      await persistDirectTurn({
        turn: interruptedTurn,
        replayEvidence:
          capturedReplayEvidence ??
          directFallbackReplayEvidence("stream_interrupted"),
        toolCorrelations: correlationsForIncompleteTurn(
          activeModel.provider,
          interruptedTurn,
          capturedToolCorrelations,
          claudeToolCorrelations,
        ),
        interrupted: interruptedTurn.status === "interrupted",
      });
    } else {
      const failedTurn =
        capturedTurn ??
        finishDirectTurn(
          turnBuilder,
          "failed",
          getErrorMessage(error),
        );
      await persistDirectTurn({
        turn: failedTurn,
        replayEvidence:
          capturedReplayEvidence ??
          directFallbackReplayEvidence("stream_failed"),
        toolCorrelations: correlationsForIncompleteTurn(
          activeModel.provider,
          failedTurn,
          capturedToolCorrelations,
          claudeToolCorrelations,
        ),
        isError: true,
        errorMessage: getErrorMessage(error),
      });
    }
  } finally {
    transcript.releaseDraft(assistantBubble);
    // Resolve any op still parked on the user so no await leaks past the turn.
    liveReview.cancelPending();
    // The generation owns exactly one coordinator per lane. Destroying them settles any
    // remaining interaction before the active generation state is cleared. The approval
    // coordinator only clears the drawer; `cancelPending()` above already resolved every
    // parked decision, and two owners for one settlement is how double-resolve bugs
    // start.
    askCoordinator.destroy();
    approvalCoordinator.destroy();
    // Both of the above run *before* the lease is released, because releasing it
    // drains the callbacks already admitted and a callback parked on a review the
    // user will never see would otherwise never return.
    await claudeGeneration?.release();
    setActiveAbortController(null);
    // The retry still rethrows, because a terminal write that did not land is the caller's to
    // know about and the audit is deliberately left on hand for it (ADR-0033). What must not
    // depend on it is the flag below: it sat after this await, so a failed write skipped it and
    // left the composer a stop button on a turn that had finished, until Obsidian was reloaded.
    // Reached in ordinary use, by the composer's debounced draft save colliding with this write.
    try {
      await store.persistActiveConversation();
    } finally {
      setIsGenerating(false);
    }
  }
}

function finishDirectTurn(
  builder: AssistantTurnBuilder,
  status: "interrupted" | "failed",
  errorMessage: string,
): AssistantTurnRecord {
  if (status === "failed") {
    for (const item of builder.snapshot().items) {
      if (
        item.type === "tool_call" &&
        item.toolCallId &&
        (item.state === "declared" || item.state === "running")
      ) {
        builder.updateToolLifecycle(item.toolCallId, {
          state: "failed",
          isError: true,
          errorContent: errorMessage,
        });
      }
    }
  }
  const salvage = finishOrSalvageAssistantTurn(builder, status);
  if (salvage.finishError !== undefined) {
    console.error(
      "[chat] The assistant turn could not be finished as built; " +
        `${salvage.dropped.length} item(s) were dropped from the persisted record.`,
      salvage.finishError,
      salvage.dropped,
    );
  }
  return salvage.turn;
}

function interruptCapturedTurn(
  turn: AssistantTurnRecord,
): AssistantTurnRecord {
  return {
    ...structuredClone(turn),
    status: "interrupted",
    items: turn.items.map((item) =>
      item.type === "tool_call" &&
      (item.state === "declared" || item.state === "running")
        ? { ...structuredClone(item), state: "interrupted" as const }
        : structuredClone(item),
    ),
  };
}

function inferDirectToolCorrelations(
  turn: AssistantTurnRecord,
): Record<string, "provider_id" | "plugin_id"> {
  return Object.fromEntries(
    turn.items
      .filter((item) => item.type === "tool_call")
      .map((item) => [
        item.toolCallId,
        item.toolCallId.startsWith("lmsa-tool-")
          ? "plugin_id"
          : "provider_id",
      ]),
  );
}

function correlationsForIncompleteTurn(
  provider: ProviderOption,
  turn: AssistantTurnRecord,
  captured: Record<string, "provider_id" | "plugin_id">,
  lifecycle: Record<string, "provider_id">,
): Record<string, "provider_id" | "plugin_id"> {
  const observed = { ...lifecycle, ...captured };
  return provider === "claudecode"
    ? observed
    : { ...inferDirectToolCorrelations(turn), ...observed };
}

/**
 * Forced quiescence forbids a persisted resume cursor (ADR-0032), and
 * `crossCheckCaptureEvidence()` refuses the whole revision on reload if one
 * survives. The provider may still have reported one, so it is dropped here
 * rather than trusted.
 */
function withoutForcedResumeCursor(
  usage: MessageUsage,
  quiescence: TurnSettlementEvidence["quiescence"],
): MessageUsage {
  if (quiescence !== "forced" || usage.resumeCursor === undefined) return usage;
  const withoutCursor = { ...usage };
  delete withoutCursor.resumeCursor;
  return withoutCursor;
}

function directFallbackReplayEvidence(
  loweredReason: string,
): AssistantReplayEvidence {
  return {
    tier: "textual",
    capabilities: {
      captureOrder: "text_only",
      toolCorrelation: "none",
      coldReplay: "textual",
      nativeResume: false,
    },
    loweredReason,
  };
}

function anchorParsedEditTurn(
  turn: AssistantTurnRecord,
  actionRef: string,
): { turn: AssistantTurnRecord; itemId: string } {
  const items = structuredClone(turn.items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "prose") continue;
    items[index] = {
      ...item,
      actionRef,
      actionAnchor: "parsed_edit",
    };
    return {
      turn: {
        ...structuredClone(turn),
        items,
      },
      itemId: item.id,
    };
  }
  throw new Error("Parsed edit response has no prose item to anchor.");
}
