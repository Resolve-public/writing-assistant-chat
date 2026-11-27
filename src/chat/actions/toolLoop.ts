import type { App } from "obsidian";
import type { ChatClient } from "../../api/chatClient";
import type {
  ChatAssistantContentItem,
  ChatRequest,
  ChatTurn,
} from "../../shared/chatRequest";
import type {
  AgenticStep,
  AssistantReplayEvidence,
  AssistantTurnRecord,
  EffectBoundary,
  EffectBoundaryGuard,
  GenerationAuditRecorder,
  ProviderCaptureDiagnostic,
  ProviderOption,
  ProviderQuiescence,
  SamplingParams,
} from "../../shared/types";
import {
  createDirectEffectGuard,
  directCorrelationFor,
  effectIntentFor,
} from "../../shared/generationAudit";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { VaultOpDisposition } from "../../vault-ops/disposition";
import { captureStepFields } from "../../tools/resultDigest";
import {
  askCancellationFailure,
  askConcurrentFailure,
  askInvalidRequestFailure,
  askRepeatedFailure,
  askSkippedSiblingFailure,
  buildAskUserResult,
} from "../../tools/ask/result";
import {
  ASK_TOOL_NAMES,
} from "../../tools/ask/definition";
import type { AskUserResponder } from "../../tools/ask/types";
import type { UsageResult, StopReason } from "../../api/usageTypes";
import { CaptureConflictError } from "../../api/assistantCapture";
import { boundedFailureMessage } from "../../api/assistantStreamRun";
import { VAULT_TOOL_NAMES } from "../../tools/vault/definition";
import { executeVaultTool } from "../../tools/vault/handlers";
import type { VaultToolContext } from "../../tools/vault/handlers";
import { effectBoundaryRefusal, toolFailure } from "../../tools/toolFailure";
import { toolNotAllowedFailure } from "../../tools/toolSurface";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { executeEditTool } from "../../tools/editing/handlers";
import type { ToolExecutionContext } from "../../tools/editing/handlers";
import { VAULT_OPS_TOOL_NAMES } from "../../tools/vault-ops/definition";
import { executeVaultOpTool, buildPendingOverlay } from "../../tools/vault-ops/handlers";
import { THINK_TOOL_NAME } from "../../tools/think/definition";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  RECALL_MEMORY_TOOL,
} from "../../tools/memory/definition";
import {
  executeMemoryTool,
  type MemoryToolContext,
} from "../../tools/memory/handlers";
import { extractToolInput } from "../../tools/metadata";
import { normalizeVaultToolCall } from "../../tools/paths";
import { streamWithRetry } from "../../api/retry";
import { TurnRunOwner } from "../streaming/TurnRunOwner";
import type { GenerationCallbackLease } from "../streaming/TurnRunOwner";
import type { LiveVaultReview } from "./liveVaultReview";
import {
  AskInteractionPreconditionError,
  AskInteractionValidationError,
} from "../interactions/AskInteractionCoordinator";
import { generateId } from "../../utils";
import {
  AssistantTurnBuilder,
  type AssistantTurnSnapshot,
  type CaptureCommitResult,
} from "../turns/AssistantTurnBuilder";

export type { VaultToolContext, ToolExecutionContext };
export type { MemoryToolContext };

/**
 * Context for in-loop vault-op execution. When `liveReview` is present, `ask`-gated
 * ops suspend the loop until the user approves/declines and the tool result carries
 * the real disposition (in-loop-tool-approval-blocking-flow). Without it the loop
 * falls back to the legacy synchronous validate-only path.
 */
export interface VaultOpToolContext {
  app: App;
  liveReview?: LiveVaultReview;
}

/** All tool names that execute inside the tool loop (results feed back to the model). */
const ALL_LOOP_TOOL_NAMES = new Set([
  ...VAULT_TOOL_NAMES,
  ...EDIT_TOOL_NAMES,
  ...VAULT_OPS_TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  ...ASK_TOOL_NAMES,
  THINK_TOOL_NAME,
]);

/** Callbacks the tool loop uses to interact with the streaming UI. */
export interface ToolLoopCallbacks {
  /** Called with visible prose bytes in provider declaration order. */
  onDelta: (delta: string) => void;
  /** Called when a read-only tool is about to execute. */
  onToolStatus?: (toolName: string) => void;
  /** Called as soon as a read-only tool call is identified by name during streaming, before execution. */
  onToolDeclared?: (toolName: string) => void;
  /** Called to reset the renderer between tool-loop rounds. */
  onNewRound?: () => void;
  /** Called after each read-only tool call completes, with a record of what was done. */
  onStepRecorded?: (step: AgenticStep) => void;
  /**
   * Called once a vault-op / edit step resolves (it was recorded before the user
   * decided). Carries the tool result so the timeline can flag failures / declines /
   * policy-denials and surface the model-facing error text, plus the real
   * `disposition` the timeline persists for the cold-rebuild replay digest (ADR-0016).
   */
  onStepResult?: (
    toolCallId: string,
    result: { isError?: boolean; content: string; disposition?: VaultOpDisposition },
  ) => void;
  /** Receives the current canonical snapshot for projection-only compatibility UI. */
  onTurnSnapshot?: (snapshot: AssistantTurnSnapshot) => void;
  /** Called with the first round's usage for token estimation calibration. */
  onCalibrate?: (request: ChatRequest, usage: UsageResult) => void;
  /**
   * The settlement evidence of every attempt this turn opened, reported once the
   * loop has proven quiescence (ADR-0031, ADR-0032).
   *
   * The turn record is frozen by `finishTurn()` before that proof exists, and on
   * a failure path the loop throws rather than returning, so this is how the
   * terminal transaction learns the quiescence mode and the bounded diagnostics
   * it has to persist.
   */
  onSettlement?: (evidence: TurnSettlementEvidence) => void;
}

/** What the terminal transaction needs from provider settlement. */
export interface TurnSettlementEvidence {
  quiescence: ProviderQuiescence;
  diagnostics: ProviderCaptureDiagnostic[];
}

/** Result returned by the tool loop after all rounds complete. */
export interface ToolLoopResult {
  /** All write tool calls accumulated across rounds. */
  writeToolCalls: ToolCall[] | null;
  /** Final usage from the last round that reported usage. */
  usage: UsageResult | null;
  /**
   * Stop reason of the most recent round that contributed write tool calls, the
   * round whose trailing write_file the truncation guard inspects.
   * Null when no round produced write calls.
   */
  writeStopReason: StopReason | null;
  /** Frozen canonical assistant turn built from the ordered stream. */
  turn: AssistantTurnRecord;
  /** Lowest actual replay fidelity selected across this turn's provider rounds. */
  replayEvidence: AssistantReplayEvidence;
  /** Exact identity evidence used to place tool-owned action-ledger entries. */
  toolCorrelations: Record<string, "provider_id" | "plugin_id">;
}

interface PendingProviderEmission {
  assistantTurn: ChatTurn;
  toolCalls: ToolCall[];
  results: Map<string, ToolResult>;
}

/**
 * Runs the read-only tool loop: streams a response, executes any read-only
 * tool calls (edit inspection tools + vault search tools), feeds results back
 * to the model, and repeats until the model produces write tool calls or a
 * plain text response.
 *
 * When maxRounds is reached the loop pushes terminal error tool results so the
 * conversation history stays valid, then allows one synthesis pass for the
 * model to summarise what it gathered. If the model calls tools again after
 * that warning it is hard-stopped.
 *
 * This function is pure orchestration, it doesn't know about UI components,
 * conversation persistence, or edit-mode specifics.
 */
export async function runToolLoop(
  client: ChatClient,
  baseRequest: ChatRequest,
  model: string,
  provider: ProviderOption,
  params: SamplingParams,
  signal: AbortSignal,
  callbacks: ToolLoopCallbacks,
  maxRounds: number,
  agenticMode: boolean,
  vaultToolContext?: VaultToolContext,
  editToolContext?: ToolExecutionContext,
  vaultOpToolContext?: VaultOpToolContext,
  memoryToolContext?: MemoryToolContext,
  askUserResponder?: AskUserResponder,
  turnBuilder: AssistantTurnBuilder = new AssistantTurnBuilder({
    turnId: `turn-${generateId()}`,
  }),
  createActionRef: (toolCallId: string) => string = (toolCallId) =>
    `action-${toolCallId}`,
  /**
   * The provider's own callback lease, when it has one (Claude Code). Bound to the
   * turn-run owner below so a callback that crosses an effect boundary refuses the
   * turn's next retry, and so each attempt's ordinal reaches the lease as evidence.
   */
  callbackLease?: GenerationCallbackLease,
  /**
   * The generation's durable audit (ADR-0033). The loop builds its own
   * effect-boundary guard from this, because only it knows which attempt is in
   * flight when a mutation is about to happen. Absent for a non-agentic turn or a
   * caller with no conversation to write to, in which case a mutation crosses on
   * liveness alone, as it does without an audit.
   */
  audit?: GenerationAuditRecorder,
): Promise<ToolLoopResult> {
  const toolLoopTurns: ChatTurn[] = [];
  let allWriteToolCalls: ToolCall[] = [];
  let finalUsage: UsageResult | null = null;
  let replayEvidence: AssistantReplayEvidence | null =
    provider === "claudecode"
      ? null
      : structuredClone(baseRequest.replayEvidence ?? null);
  const toolCorrelations = new Map<
    string,
    "provider_id" | "plugin_id"
  >();
  let calibrated = false;
  // Set to true once a cap-hit synthesis pass has been injected.
  let capHit = false;
  // Per-turn identical-call counts (D5), keyed on tool name + canonical args. Drives
  // the spin guard: the same call past IDENTICAL_CALL_THRESHOLD is refused, not run.
  const callCounts = new Map<string, number>();
  // Stop reason of the latest round that accumulated write calls (truncation guard).
  let writeStopReason: StopReason | null = null;
  // Mutations the round cap deferred (see capRoundToMutation), waiting to be drained.
  // A model that ignores parallel_tool_calls (LM Studio / llama.cpp) emits its whole
  // batch in one assistant message; rather than discard the surplus and rely on the
  // model to re-emit it next round (which local models routinely don't, silently
  // losing the intent), the loop buffers it here and drains one mutation per
  // subsequent round WITHOUT a model round-trip. The batch is thus honored in full,
  // each op still gated one at a time. `deferredStopReason` carries the emitting
  // round's stop reason so a max_tokens truncation on the batch's tail is not lost.
  let deferredCalls: ToolCall[] = [];
  let deferredStopReason: StopReason = "tool_use";
  let pendingEmission: PendingProviderEmission | null = null;
  // Rounds where the model was actually streamed; drain rounds don't count. The round
  // cap limits model turns, not replayed drains, so a large batch can't exhaust it.
  let modelRounds = 0;

  // The app, used only to translate absolute paths a model may emit into
  // vault-relative ones (normalizeVaultToolCall). Any context carries it.
  const app =
    vaultOpToolContext?.app ?? editToolContext?.app ?? vaultToolContext?.app;

  // Built from the pre-minted turn ID before retry can reach a provider (ADR-0032),
  // so every attempt of every round has a lease from before
  // its construction, and a user Stop cancels through one named path rather than
  // being inferred from whichever `AbortError` surfaces first.
  const runOwner = new TurnRunOwner(turnBuilder.snapshot().id, signal);
  runOwner.bindCallbackLease(callbackLease);

  // This loop's own effect boundary (ADR-0033). Its liveness is the turn
  // signal: the loop awaits each effect inline, so no separate owner can vanish
  // underneath one. It deliberately does not report to
  // `runOwner.noteConsequentialCallback()`, because a loop effect runs between
  // rounds rather than during a retryable attempt, so reporting it would only
  // suppress legitimate retries for the rest of the turn.
  const effectGuard = createDirectEffectGuard({
    signal,
    audit: audit ?? null,
    ownership: () => runOwner.currentAttempt,
  });

  try {
    return await runRounds();
  } catch (error) {
    await runOwner.cancelAll("downstream_failed");
    throw error;
  } finally {
    // Nothing is returned and nothing is rethrown until every attempt this turn
    // opened is quiet, so the caller can never persist a turn while its provider
    // is still running.
    const settlements = await runOwner.awaitQuiescence();
    callbacks.onSettlement?.({
      // One forced attempt makes the turn's capture forced: a hard dispose is
      // never proof that nothing else was in flight (ADR-0032).
      quiescence: settlements.some((one) => one.quiescence === "forced")
        ? "forced"
        : "proven",
      diagnostics: settlements.flatMap((one) => one.diagnostics),
    });
    runOwner.release();
  }

  async function runRounds(): Promise<ToolLoopResult> {
  for (let round = 0; ; round++) {
    // A round's tool calls come from one of two sources: a fresh model stream, or the
    // buffer of mutations a prior round's cap deferred. The buffer is drained first, so
    // the model's whole batch is honored before it is streamed again.
    let toolCalls: ToolCall[] | null;
    let stopReason: StopReason;
    let roundText: string;
    let usage: UsageResult | null = null;
    let askBarrierPlan: AskBarrierBatchPlan | null = null;
    let roundThinkingBlocks: unknown[] | null = null;
    let streamedSegmentIds: string[] = [];
    const streamedThisRound = deferredCalls.length === 0;

    if (!streamedThisRound) {
      // Drain: replay the next buffered mutation (plus any read-only calls that led up
      // to it) with no model call. capRoundToMutation keeps this to a single mutation,
      // so a drained round is still one gated op; the remainder stays buffered and the
      // buffer shrinks monotonically, so the drain sequence always terminates.
      const next = capRoundToMutation(deferredCalls);
      deferredCalls = deferredCalls.slice(next.length);
      toolCalls = next;
      stopReason = deferredStopReason;
      roundText = "";
    } else {
      const requestMessages = [...baseRequest.messages, ...toolLoopTurns];
      const roundRequest = { ...baseRequest, messages: requestMessages };

      // No round opens while a prior attempt is still capable of producing work
      // or callbacks (ADR-0032).
      await runOwner.awaitQuiescence();
      const streamResult = streamWithRetry(
        (attempt) => client.stream(roundRequest, model, params, attempt),
        runOwner,
        { signal },
      );
      const segmentIds: string[] = [];
      streamedSegmentIds = segmentIds;
      roundText = "";
      for await (const batch of streamResult.events) {
        let commit: CaptureCommitResult;
        try {
          // The whole frame lands or none of it does. Nothing below runs on a
          // refused batch, so a rejected declaration creates no executable call,
          // no review host, and no replay block.
          commit = turnBuilder.applyCaptureBatch(batch, modelRounds);
        } catch (error) {
          if (error instanceof CaptureConflictError) {
            // The transcript is no longer authoritative. Retire the conflicting
            // declaration's own batch atomically, publish that one terminal
            // snapshot, and stop the provider before anything acts on it.
            const terminal = turnBuilder.invalidateCapturedFacts(
              conflictingBatchIds(turnBuilder, error),
              captureConflictDiagnostic(provider, error),
            );
            callbacks.onTurnSnapshot?.(terminal);
            await runOwner.cancelAll("capture_failed");
            await runOwner.awaitQuiescence();
          } else {
            await runOwner.cancelAll("downstream_failed");
          }
          throw error;
        }
        try {
          // Post-commit, and only from what committed (ADR-0031). One committed
          // batch produces at most one snapshot callback.
          segmentIds.push(...commit.startedSegments);
          for (const correlated of commit.toolCorrelations) {
            if (correlated.correlation === "none") continue;
            toolCorrelations.set(correlated.toolCallId, correlated.correlation);
          }
          for (const delta of commit.proseDeltas) {
            roundText += delta;
            callbacks.onDelta(delta);
          }
          for (const toolName of commit.declaredTools) {
            if (ALL_LOOP_TOOL_NAMES.has(toolName)) {
              callbacks.onToolDeclared?.(toolName);
            }
          }
          if (!commit.duplicate) callbacks.onTurnSnapshot?.(commit.snapshot);
        } catch (error) {
          // An `onDelta` subscriber or a snapshot callback throwing is a
          // downstream failure, and it must stop the provider rather than merely
          // surface (ADR-0032). Cancelling here, before unwinding, is
          // what makes the reason honest: the `consumer_returned` that the unwind
          // itself produces would otherwise claim it first. The batch stays
          // committed; a callback cannot expose a half-applied one.
          await runOwner.cancelAll("downstream_failed");
          throw error;
        }
      }
      usage = await streamResult.usage;
      const replayCapsule = await streamResult.replayCapsule;
      if (replayCapsule && segmentIds[0]) {
        turnBuilder.startSegment({
          segmentId: segmentIds[0],
          replayCapsule,
        });
        roundThinkingBlocks = replayCapsule.thinkingBlocks;
      }
      replayEvidence = lowerReplayEvidence(
        replayEvidence,
        await streamResult.replayEvidence,
      );
      const rawToolCalls =
        provider === "claudecode"
          ? null
          : executableCallsForSegments(turnBuilder.snapshot(), segmentIds);
      // Translate any absolute paths to vault-relative *once*, here, so every
      // downstream consumer, overlay, accumulation, finalization, timeline, sees
      // the same resolved path (tools/paths.ts).
      const normalizedCalls =
        rawToolCalls && app ? rawToolCalls.map((tc) => normalizeVaultToolCall(app, tc)) : rawToolCalls;
      askBarrierPlan = normalizedCalls
        ? planAskBarrierBatch(normalizedCalls)
        : null;
      if (normalizedCalls && !askBarrierPlan) {
        const snapshot = turnBuilder.snapshot();
        const assistantContent = assistantContentForSegments(
          snapshot,
          streamedSegmentIds,
        );
        const replayCapsule = snapshot.segments.find(
          (segment) => streamedSegmentIds.includes(segment.id),
        )?.replayCapsule;
        const canReplayStructurally = assistantContent.every(
          (item) =>
            item.type === "prose" ||
            item.toolArgs !== undefined,
        );
        pendingEmission = {
          assistantTurn: canReplayStructurally
            ? {
                role: "assistant",
                content: null,
                assistantContent,
                ...(replayCapsule
                  ? {
                      providerReplayCapsule:
                        structuredClone(replayCapsule),
                    }
                  : {}),
              }
            : {
                role: "assistant",
                content: roundText || null,
                toolCalls: normalizedCalls.map((toolCall) => ({
                  id: toolCall.id,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                })),
                ...(roundThinkingBlocks
                  ? { anthropicThinkingBlocks: roundThinkingBlocks }
                  : {}),
              },
          toolCalls: normalizedCalls,
          results: new Map(),
        };
      }
      // Enforce one mutation per round (see capRoundToMutation). The model emits an
      // assistant message atomically, so the in-loop approval gate can only feed the
      // user's approve/decline back to it *between* rounds. The request-level
      // parallel_tool_calls:false / disable_parallel_tool_use flags ask the provider for
      // this, but local OpenAI-compatible servers (LM Studio / llama.cpp) accept and
      // ignore them, so this cap is the engine-independent backstop. The mutations it
      // drops are NOT discarded: they are buffered and drained on the following rounds
      // (above), so the batch's full intent survives without relying on the model to
      // re-emit it.
      const roundStopReason = await streamResult.stopReason;
      const capped =
        normalizedCalls && !askBarrierPlan
          ? capRoundToMutation(normalizedCalls)
          : normalizedCalls;
      if (normalizedCalls && capped && capped.length < normalizedCalls.length) {
        deferredCalls = normalizedCalls.slice(capped.length);
        deferredStopReason = roundStopReason;
      }
      toolCalls = capped;
      stopReason = roundStopReason;

      if (usage && callbacks.onCalibrate && !calibrated) {
        callbacks.onCalibrate(roundRequest, usage);
        calibrated = true;
      }
      if (usage) finalUsage = usage;
    }

    const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

    // Only a streamed round can end with no tool calls (a drain always carries one), so
    // the empty-response classification runs on streamed rounds only. `modelRounds` (not
    // the raw loop index, which drains inflate) drives the round-count diagnostics.
    if (streamedThisRound) {
      const hasClaudeStructure =
        provider === "claudecode" &&
        turnBuilder
          .snapshot()
          .items.some((item) => streamedSegmentIds.includes(item.segmentId));
      if (!hasClaudeStructure) {
        checkForFailedToolCall({
          hasToolCalls,
          roundText,
          stopReason,
          round: modelRounds,
          maxRounds,
          usage,
          model,
          provider,
          agenticMode,
          toolCount: baseRequest.tools?.length ?? 0,
          mode: baseRequest.documentContext ? "edit" : "chat",
        });
      }
    }

    if (!hasToolCalls || !toolCalls) break;
    for (const toolCall of toolCalls) {
      turnBuilder.updateToolLifecycle(toolCall.id, {
        state: "running",
        ...(isActionTool(toolCall.name)
          ? { actionRef: createActionRef(toolCall.id) }
          : {}),
      });
    }
    callbacks.onTurnSnapshot?.(turnBuilder.snapshot());

    // A fresh provider batch containing ask_user is owned by the barrier branch
    // before mutation capping, allow-list checks, spin counting, accumulation, or
    // any executor. A deferred drain can never enter this branch because such a
    // batch is never buffered.
    if (askBarrierPlan) {
      if (capHit) {
        recordCapResults(turnBuilder, toolCalls, round);
        callbacks.onTurnSnapshot?.(turnBuilder.snapshot());
        break;
      }

      const reachedCap = modelRounds >= maxRounds;
      const barrierResults = await resolveAskBarrierBatch({
        plan: askBarrierPlan,
        responder: askUserResponder,
        signal,
        round,
        callbacks,
        guard: effectGuard,
      });

      toolLoopTurns.push({
        role: "assistant",
        content: roundText || null,
        toolCalls: askBarrierPlan.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        ...(roundThinkingBlocks ? { anthropicThinkingBlocks: roundThinkingBlocks } : {}),
      });
      for (const { tc, result } of barrierResults) {
        recordToolResult(turnBuilder, tc, result, round);
        // No `toolResultImages` here, and none is possible: this push is the ask
        // barrier, and an ask result is the user's own answer text (RFC-0021 P3).
        toolLoopTurns.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
        });
      }
      callbacks.onTurnSnapshot?.(turnBuilder.snapshot());

      callbacks.onNewRound?.();
      if (streamedThisRound) modelRounds++;
      if (reachedCap) capHit = true;
      continue;
    }

    // Classify this round's tool calls into the buckets the loop routes
    // differently: known loop tools execute inline; unknown tools accumulate as
    // write calls for finalization; edit/vault-op/vault/think are split among
    // the loop tools.
    const {
      loopCalls,
      unknownCalls,
      editCalls,
      vaultOpCalls,
      vaultCalls,
      thinkCalls,
      memoryReadCalls,
      memoryMutationCalls,
    } = classifyToolCalls(toolCalls);
    const unknownResults = unknownCalls.map((tc) => ({
      tc,
      result: {
        content:
          `Tool "${tc.name}" is not executable in the direct-provider loop.`,
        isError: true,
        isReadOnly: false,
      } satisfies ToolResult,
    }));

    // Two pre-execution guards, both BEFORE a call executes or accumulates as a
    // write (so a refused mutating call is never applied). Blocked calls stay in
    // `loopCalls` for the assistant turn (history validity) but are excluded from the
    // live buckets below; their refusal results are pushed alongside the executed
    // ones.
    //   (1) Mode allow-list: the stable cloud surface advertises more than the mode
    //       permits, so a call the current mode disallows is refused here. Local
    //       providers emit exactly what they allow (no allowedToolNames), so this is
    //       a no-op for them.
    //   (2) D5 spin guard: refuse a call that exactly repeats past the per-turn
    //       threshold. Mode-blocked calls are excluded first so they never advance
    //       the spin counter (they never ran).
    const modeGuard = applyToolAllowGuard(loopCalls, baseRequest.allowedToolNames);
    const spinGuard = applyIdenticalCallGuard(
      loopCalls.filter((tc) => !modeGuard.blockedIds.has(tc.id)),
      callCounts,
    );
    const blockedResults = [...modeGuard.blockedResults, ...spinGuard.blockedResults];
    const blockedIds = new Set([...modeGuard.blockedIds, ...spinGuard.blockedIds]);
    const isLive = (tc: ToolCall): boolean => !blockedIds.has(tc.id);
    const liveEditCalls = editCalls.filter(isLive);
    const liveVaultOpCalls = vaultOpCalls.filter(isLive);
    const liveVaultCalls = vaultCalls.filter(isLive);
    const liveThinkCalls = thinkCalls.filter(isLive);
    const liveMemoryReadCalls = memoryReadCalls.filter(isLive);
    const liveMemoryMutationCalls = memoryMutationCalls.filter(isLive);

    // Unknown and edit calls accumulate as write calls for the finalization
    // pipeline (edits also execute in the loop so the diff panel can render them).
    if (unknownCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...unknownCalls];
      writeStopReason = stopReason;
    }
    if (liveEditCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...liveEditCalls];
      writeStopReason = stopReason;
    }

    // Vault-op calls execute in the loop AND accumulate for finalization, just
    // like edits. The pending overlay is seeded from vault ops accumulated in
    // PRIOR rounds, captured before this round's are appended, so a later
    // round's move sees an earlier round's write_file.
    const priorVaultOpCalls = allWriteToolCalls.filter((tc) => VAULT_OPS_TOOL_NAMES.has(tc.name));
    if (liveVaultOpCalls.length > 0) {
      allWriteToolCalls = [...allWriteToolCalls, ...liveVaultOpCalls];
      writeStopReason = stopReason;
    }

    // Prose that narrates a mutating action (write/edit/vault-op) is part of the
    // user-facing answer, e.g. "Here's the file I created: ```…```", not
    // reasoning. Accumulate it toward the bubble; prose before a read-only tool
    // stays in the timeline as reasoning (committed below).
    // Cap reached: push terminal error results to keep history valid, then let
    // the model produce one synthesis response. If it calls tools again after
    // the warning, hard-stop. The cap counts streamed model turns (`modelRounds`),
    // so replayed buffer drains never trip it.
    if (capHit || modelRounds >= maxRounds) {
      if (capHit) {
        recordPendingCapResults(
          turnBuilder,
          pendingEmission,
          toolCalls,
          round,
        );
        deferredCalls = [];
        pendingEmission = flushPendingEmission(
          toolLoopTurns,
          pendingEmission,
        );
        callbacks.onTurnSnapshot?.(turnBuilder.snapshot());
        break;
      }
      capHit = true;
      // Out of model rounds: abandon any buffered mutations rather than draining
      // them past the cap (finalize() sweeps their orphaned pending placeholders).
      deferredCalls = [];
      recordPendingCapResults(
        turnBuilder,
        pendingEmission,
        toolCalls,
        round,
      );
      pendingEmission = flushPendingEmission(
        toolLoopTurns,
        pendingEmission,
      );
      callbacks.onTurnSnapshot?.(turnBuilder.snapshot());
      callbacks.onNewRound?.();
      continue;
    }

    // Read-only / think tools and the (possibly suspending) vault ops and edits run
    // concurrently. Vault-op and edit steps are recorded BEFORE resolving so their
    // timeline rows exist while the review blocks this round until the user decides;
    // both channels return the *real* disposition as the tool result.
    const [otherResults, vaultOpResults, editResults, memoryResults] = await Promise.all([
      Promise.all([
        ...liveVaultCalls.map(async (tc) => {
          callbacks.onToolStatus?.(tc.name);
          if (!vaultToolContext) {
            return {
              tc,
              result: toolFailure({ kind: "unavailable", what: "vault tool context unavailable" }),
            };
          }
          return { tc, result: await executeVaultTool(tc, vaultToolContext) };
        }),
        // think is a no-op: returns empty content so the model continues reasoning.
        // Promise.resolve so every element handed to Promise.all is a thenable
        // (await-thenable) without an async function that would have no await to make.
        ...liveThinkCalls.map((tc) => {
          const result: ToolResult = { content: "", isReadOnly: true };
          return Promise.resolve({ tc, result });
        }),
        ...liveMemoryReadCalls.map((tc) => {
          callbacks.onToolStatus?.(tc.name);
          if (!memoryToolContext) {
            return Promise.resolve({
              tc,
              result: toolFailure({
                kind: "unavailable",
                what: "memory tool context unavailable",
              }),
            });
          }
          return Promise.resolve({
            tc,
            result: executeMemoryTool(tc, memoryToolContext),
          });
        }),
      ]),
      resolveVaultOps({
        vaultOpCalls: liveVaultOpCalls,
        priorVaultOpCalls,
        round,
        stopReason,
        context: vaultOpToolContext,
        callbacks,
        guard: effectGuard,
      }),
      resolveEdits({
        editCalls: liveEditCalls,
        vaultOpContext: vaultOpToolContext,
        editContext: editToolContext,
        round,
        callbacks,
        guard: effectGuard,
      }),
      resolveMemories({
        memoryCalls: liveMemoryMutationCalls,
        context: memoryToolContext,
        liveReview: vaultOpToolContext?.liveReview,
        round,
        callbacks,
        guard: effectGuard,
      }),
    ]);

    // Read-only / think results plus any spin-guard refusals record their step with
    // the result in hand (a refusal flags its step like a failed read-only call).
    for (const { tc, result } of [
      ...otherResults,
      ...blockedResults,
      ...unknownResults,
    ]) {
      recordToolResult(turnBuilder, tc, result, round);
      pendingEmission?.results.set(tc.id, result);
      callbacks.onStepRecorded?.({
        type: "tool_call",
        round,
        toolName: tc.name,
        toolCallId: tc.id,
        toolInput: extractToolInput(tc),
        toolArgs: tc.arguments,
        // The result is in hand here, so a failed read-only tool flags its step
        // immediately (no separate onStepResult round-trip).
        ...(result.isError && { isError: true, errorContent: result.content }),
        // Replay capture: discovery digest and bounded record (ADR-0016); the sibling
        // choke point is Claude Code's callTool end event.
        ...turnBuilder.captureFields(tc.name, tc.arguments, result),
      });
    }
    // Vault-op and edit steps were already recorded before resolution, push results,
    // and report the outcome so the timeline can flag failures / declines / denials
    // and capture the disposition + bounded record for replay (ADR-0016).
    for (const { tc, result } of [
      ...vaultOpResults,
      ...editResults,
      ...memoryResults,
    ]) {
      recordToolResult(turnBuilder, tc, result, round);
      pendingEmission?.results.set(tc.id, result);
      callbacks.onStepResult?.(tc.id, {
        isError: result.isError,
        content: result.content,
        disposition: result.disposition,
      });
    }
    callbacks.onTurnSnapshot?.(turnBuilder.snapshot());

    if (deferredCalls.length === 0) {
      pendingEmission = flushPendingEmission(
        toolLoopTurns,
        pendingEmission,
      );
    }
    callbacks.onNewRound?.();
    // Only a streamed round counts toward the model-turn cap; drains are free.
    if (streamedThisRound) modelRounds++;
  }

  const turn = turnBuilder.finishTurn("completed");
  callbacks.onTurnSnapshot?.(turn);
  return {
    writeToolCalls: allWriteToolCalls.length > 0 ? allWriteToolCalls : null,
    usage: finalUsage,
    writeStopReason,
    turn,
    replayEvidence: replayEvidence ?? textualFallbackEvidence(
      "provider_replay_evidence_missing",
    ),
    toolCorrelations: Object.fromEntries(toolCorrelations),
  };
  }
}

/**
 * The batches whose facts a capture conflict retires.
 *
 * A conflict names the refused batch and, when the collision is over an exact
 * tool ID, the earlier declaration it collided with. The earlier declaration's
 * own batch is what loses authority: the refused one published nothing, so it
 * owns no items to retire. When the conflict names no tool ID there is nothing
 * to trace back to, and no item is invalidated on a guess.
 */
function conflictingBatchIds(
  builder: AssistantTurnBuilder,
  error: CaptureConflictError,
): string[] {
  if (error.toolCallId === undefined) return [];
  const owner = builder
    .snapshot()
    .items.find(
      (item) =>
        item.type === "tool_call" && item.toolCallId === error.toolCallId,
    );
  const originBatchId = owner?.captureEvidence?.originBatchId;
  return originBatchId === undefined ? [] : [originBatchId];
}

/** Bounded, payload-free evidence of why capture stopped being authoritative. */
function captureConflictDiagnostic(
  provider: ProviderOption,
  error: CaptureConflictError,
): ProviderCaptureDiagnostic {
  return {
    code: `capture_conflict_${error.kind}`,
    provider,
    stage: "publication",
    message: boundedFailureMessage(error),
  };
}

function assistantContentForSegments(
  snapshot: AssistantTurnSnapshot,
  segmentIds: readonly string[],
): ChatAssistantContentItem[] {
  const included = new Set(segmentIds);
  const content: ChatAssistantContentItem[] = [];
  for (const item of snapshot.items) {
    if (!included.has(item.segmentId)) continue;
    if (item.type === "prose") {
      content.push({ type: "prose", text: item.text });
      continue;
    }
    if (item.toolCallId !== undefined) {
      content.push({
        type: "tool_call" as const,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        toolArguments: item.toolArguments,
        ...(item.toolArgs === undefined
          ? {}
          : { toolArgs: structuredClone(item.toolArgs) }),
      });
    }
  }
  return content;
}

/** Derive executable calls from the same frozen declaration facts the builder owns. */
export function executableCallsForSegments(
  snapshot: AssistantTurnSnapshot,
  segmentIds: readonly string[],
): ToolCall[] | null {
  const included = new Set(segmentIds);
  const calls = snapshot.items
    .filter(
      (item) =>
        item.type === "tool_call" &&
        included.has(item.segmentId) &&
        typeof item.toolCallId === "string" &&
        item.toolCallId.length > 0,
    )
    .map((item) => {
      if (item.type !== "tool_call" || item.toolCallId === undefined) {
        throw new Error("Executable tool filtering lost tool identity.");
      }
      return {
        id: item.toolCallId,
        name: item.toolName,
        arguments: item.toolArgs ?? {},
      };
    });
  return calls.length > 0 ? calls : null;
}

function recordToolResult(
  builder: AssistantTurnBuilder,
  toolCall: ToolCall,
  result: ToolResult,
  _round: number,
): void {
  const capture = builder.captureFields(
    toolCall.name,
    toolCall.arguments,
    result,
  );
  builder.updateToolLifecycle(toolCall.id, {
    state: result.isError ? "failed" : "completed",
    ...(capture.resultRecord === undefined
      ? {}
      : { resultRecord: capture.resultRecord }),
    ...(capture.resultDigest === undefined
      ? {}
      : { resultDigest: capture.resultDigest }),
    ...(capture.resultImages === undefined
      ? {}
      : { resultImages: capture.resultImages }),
    ...(capture.askGuidance === undefined
      ? {}
      : {
          askGuidance: capture.askGuidance,
          askStatus: "completed" as const,
        }),
    ...(result.isError
      ? { isError: true, errorContent: result.content }
      : {}),
  });
}

function recordCapResults(
  builder: AssistantTurnBuilder,
  toolCalls: ToolCall[],
  round: number,
): void {
  for (const toolCall of toolCalls) {
    recordToolResult(
      builder,
      toolCall,
      {
        content:
          "Retrieval limit reached. Synthesize an answer from the information gathered so far.",
        isError: true,
        isReadOnly: true,
      },
      round,
    );
  }
}

function recordPendingCapResults(
  builder: AssistantTurnBuilder,
  pending: PendingProviderEmission | null,
  fallbackCalls: ToolCall[],
  round: number,
): void {
  const toolCalls = pending?.toolCalls ?? fallbackCalls;
  for (const toolCall of toolCalls) {
    if (pending?.results.has(toolCall.id)) continue;
    const result: ToolResult = {
      content:
        "Retrieval limit reached. Synthesize an answer from the information gathered so far.",
      isError: true,
      isReadOnly: true,
    };
    recordToolResult(builder, toolCall, result, round);
    pending?.results.set(toolCall.id, result);
  }
}

function flushPendingEmission(
  turns: ChatTurn[],
  pending: PendingProviderEmission | null,
): null {
  if (!pending) return null;
  turns.push(pending.assistantTurn);
  for (const toolCall of pending.toolCalls) {
    const result = pending.results.get(toolCall.id);
    if (!result) {
      throw new Error(
        `Tool call "${toolCall.id}" has no result before the next provider round.`,
      );
    }
    turns.push({
      role: "tool",
      content: result.content,
      toolCallId: toolCall.id,
      // The round's real results, so this is the one place an image enters the loop's
      // history. It rides the turn rather than the result because the payload builders
      // read `ChatTurn`, and each nests or synthesizes per its own wire format
      // (RFC-0021 P3). In memory for this generation only; the persisted step keeps
      // metadata, so the structural replay cannot carry bytes.
      ...(result.images?.length ? { toolResultImages: result.images } : {}),
    });
  }
  return null;
}

function lowerReplayEvidence(
  current: AssistantReplayEvidence | null,
  incoming: AssistantReplayEvidence,
): AssistantReplayEvidence {
  if (!current) return structuredClone(incoming);
  const captureOrder = lowerCapability(
    current.capabilities.captureOrder,
    incoming.capabilities.captureOrder,
    ["text_only", "segment", "exact"],
  );
  const toolCorrelation = lowerCapability(
    current.capabilities.toolCorrelation,
    incoming.capabilities.toolCorrelation,
    ["none", "plugin_id", "provider_id"],
  );
  const coldReplay =
    current.capabilities.coldReplay === "textual" ||
    incoming.capabilities.coldReplay === "textual"
      ? "textual"
      : "structural";
  const tier =
    current.tier === "textual" || incoming.tier === "textual"
      ? "textual"
      : current.tier === "structural" || incoming.tier === "structural"
        ? "structural"
        : "native";
  const reasons = [current.loweredReason, incoming.loweredReason]
    .filter((reason): reason is string => reason !== undefined);
  return {
    tier,
    capabilities: {
      captureOrder,
      toolCorrelation,
      coldReplay,
      nativeResume:
        current.capabilities.nativeResume &&
        incoming.capabilities.nativeResume,
    },
    ...(reasons.length === 0
      ? {}
      : { loweredReason: [...new Set(reasons)].join(",") }),
  };
}

function lowerCapability<Value extends string>(
  left: Value,
  right: Value,
  ascending: readonly Value[],
): Value {
  return ascending.indexOf(left) <= ascending.indexOf(right) ? left : right;
}

function textualFallbackEvidence(
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

export function isActionTool(toolName: string): boolean {
  return (
    EDIT_TOOL_NAMES.has(toolName) ||
    VAULT_OPS_TOOL_NAMES.has(toolName) ||
    MEMORY_MUTATION_TOOL_NAMES.has(toolName) ||
    ASK_TOOL_NAMES.has(toolName)
  );
}

/** A round's tool calls partitioned by how the loop routes each kind. */
export interface ClassifiedCalls {
  /** Calls the loop executes inline: vault search, edit, vault-op, think. */
  loopCalls: ToolCall[];
  /** Calls the loop doesn't recognize; accumulated as write calls for finalization. */
  unknownCalls: ToolCall[];
  editCalls: ToolCall[];
  vaultOpCalls: ToolCall[];
  vaultCalls: ToolCall[];
  thinkCalls: ToolCall[];
  memoryReadCalls: ToolCall[];
  memoryMutationCalls: ToolCall[];
}

/** A complete fresh-provider batch claimed by the ask_user barrier. */
export interface AskBarrierBatchPlan {
  toolCalls: ToolCall[];
  primaryAsk: ToolCall;
  laterAsks: ToolCall[];
  blockedSiblings: ToolCall[];
}

/**
 * Inspect a complete normalized provider batch for ask_user before any other
 * scheduling decision. The first ask is primary, later asks and ordinary
 * siblings retain their original call objects and order.
 */
export function planAskBarrierBatch(
  toolCalls: ToolCall[],
): AskBarrierBatchPlan | null {
  const asks = toolCalls.filter((toolCall) =>
    ASK_TOOL_NAMES.has(toolCall.name),
  );
  const primaryAsk = asks[0];
  if (!primaryAsk) return null;
  return {
    toolCalls: [...toolCalls],
    primaryAsk,
    laterAsks: asks.slice(1),
    blockedSiblings: toolCalls.filter((toolCall) =>
      !ASK_TOOL_NAMES.has(toolCall.name),
    ),
  };
}

interface ResolveAskBarrierBatchDeps {
  plan: AskBarrierBatchPlan;
  responder: AskUserResponder | undefined;
  signal: AbortSignal;
  round: number;
  callbacks: ToolLoopCallbacks;
  /** This turn's effect boundary; an answered question cannot be un-asked. */
  guard?: EffectBoundaryGuard;
}

/**
 * Settle every call in an ask-containing batch. Sibling and repeated-ask
 * timeline steps are recorded before the primary responder is awaited.
 */
async function resolveAskBarrierBatch(
  deps: ResolveAskBarrierBatchDeps,
): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
  const { plan, responder, signal, round, callbacks } = deps;
  const results = new Map<ToolCall, ToolResult>();

  for (const toolCall of plan.toolCalls) {
    if (toolCall === plan.primaryAsk) continue;
    const isLaterAsk = ASK_TOOL_NAMES.has(toolCall.name);
    const result = isLaterAsk
      ? askRepeatedFailure()
      : askSkippedSiblingFailure(toolCall.name);
    results.set(toolCall, result);
    callbacks.onStepRecorded?.(
      barrierStep(
        toolCall,
        result,
        round,
        isLaterAsk ? "skipped" : undefined,
      ),
    );
  }

  let primaryResult: ToolResult;
  let primaryStatus: AgenticStep["askStatus"];
  const crossed = await crossEffectBoundaries(
    deps.guard,
    "ask_interaction",
    [plan.primaryAsk],
  );
  try {
    if (crossed.allowed.length === 0) {
      // The interaction never opened, so nothing was asked and nothing answered.
      primaryResult = askCancellationFailure("stopped");
      primaryStatus = "cancelled";
    } else if (!responder) {
      primaryResult = askConcurrentFailure();
      primaryStatus = "skipped";
    } else {
      const answers = await responder.ask(
        plan.primaryAsk.arguments,
        {
          interactionId: generateId(),
          toolCallId: plan.primaryAsk.id,
          signal,
        },
      );
      primaryResult = buildAskUserResult(answers);
      primaryStatus = "completed";
    }
  } catch (error) {
    if (error instanceof AskInteractionValidationError) {
      primaryResult = askInvalidRequestFailure(error.issue);
      primaryStatus = "skipped";
    } else if (error instanceof AskInteractionPreconditionError) {
      primaryResult = askConcurrentFailure();
      primaryStatus = "skipped";
    } else if (isAbortError(error)) {
      primaryResult = askCancellationFailure("stopped");
      callbacks.onStepRecorded?.(
        barrierStep(
          plan.primaryAsk,
          primaryResult,
          round,
          "cancelled",
        ),
      );
      throw error;
    } else {
      throw error;
    }
  }

  results.set(plan.primaryAsk, primaryResult);
  callbacks.onStepRecorded?.(
    barrierStep(
      plan.primaryAsk,
      primaryResult,
      round,
      primaryStatus,
    ),
  );
  return plan.toolCalls.map((tc) => ({
    tc,
    result: results.get(tc) ?? askSkippedSiblingFailure(tc.name),
  }));
}

function barrierStep(
  toolCall: ToolCall,
  result: ToolResult,
  round: number,
  askStatus?: AgenticStep["askStatus"],
): AgenticStep {
  return {
    type: "tool_call",
    round,
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    toolInput: extractToolInput(toolCall),
    toolArgs: toolCall.arguments,
    ...(askStatus && { askStatus }),
    ...(result.isError && {
      isError: true,
      errorContent: result.content,
    }),
    ...captureStepFields(toolCall.name, toolCall.arguments, result),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Cap a round to a single mutation so the in-loop approval gate is a genuine per-tool
 * gate. A model emits its assistant message atomically, so it can only receive the
 * user's approve/decline *between* rounds; a round carrying several mutating calls means
 * the model committed to the whole batch before any of them was reviewed (the symptom:
 * five `create_directory` ops where only the first shows "pending approval" and the rest
 * say "waiting for the previous step").
 *
 * Keeps every read-only / think call up to and including the first mutating
 * (edit / vault-op / unknown-write) call and returns the rest as the deferred tail.
 * The loop buffers that tail and drains it one mutation per subsequent round (see the
 * drain branch in {@link runToolLoop}), so the model's whole batch is honored, each op
 * gated in turn, without relying on the model to re-emit the dropped calls (local
 * models routinely don't). A pure read-only / think round is returned unchanged, those
 * need no approval and run in parallel, so multi-search rounds keep their concurrency.
 *
 * This is the engine-independent backstop for the request-level
 * `parallel_tool_calls:false` (OpenAI) / `disable_parallel_tool_use` (Anthropic) flags,
 * which cloud providers honor but local OpenAI-compatible servers (LM Studio / llama.cpp)
 * accept and silently ignore. Pure (no state, no callbacks), so the boundary is
 * unit-testable in isolation.
 */
export function capRoundToMutation(toolCalls: ToolCall[]): ToolCall[] {
  const isMutating = (tc: ToolCall): boolean =>
    EDIT_TOOL_NAMES.has(tc.name) ||
    VAULT_OPS_TOOL_NAMES.has(tc.name) ||
    MEMORY_MUTATION_TOOL_NAMES.has(tc.name) ||
    // Unknown tools accumulate as write calls for finalization, so treat them as
    // mutating too (conservative: never batch an unrecognized call behind another).
    !ALL_LOOP_TOOL_NAMES.has(tc.name);
  const firstMutation = toolCalls.findIndex(isMutating);
  if (firstMutation === -1) return toolCalls;
  return toolCalls.slice(0, firstMutation + 1);
}

/**
 * Partition a round's tool calls into the buckets the loop routes differently.
 * Pure (no state, no callbacks), so each bucket is independently assertable.
 */
export function classifyToolCalls(toolCalls: ToolCall[]): ClassifiedCalls {
  const loopCalls = toolCalls.filter((tc) => ALL_LOOP_TOOL_NAMES.has(tc.name));
  return {
    loopCalls,
    unknownCalls: toolCalls.filter((tc) => !ALL_LOOP_TOOL_NAMES.has(tc.name)),
    editCalls: loopCalls.filter((tc) => EDIT_TOOL_NAMES.has(tc.name)),
    vaultOpCalls: loopCalls.filter((tc) => VAULT_OPS_TOOL_NAMES.has(tc.name)),
    vaultCalls: loopCalls.filter((tc) => VAULT_TOOL_NAMES.has(tc.name)),
    thinkCalls: loopCalls.filter((tc) => tc.name === THINK_TOOL_NAME),
    memoryReadCalls: loopCalls.filter(
      (tc) => tc.name === RECALL_MEMORY_TOOL.name,
    ),
    memoryMutationCalls: loopCalls.filter((tc) =>
      MEMORY_MUTATION_TOOL_NAMES.has(tc.name),
    ),
  };
}

/**
 * D5 spin guard: how many identical (tool name + canonical args) calls run before
 * the next exact repeat is refused. The first {@link IDENTICAL_CALL_THRESHOLD}
 * execute; the 4th and beyond are short-circuited. The round cap is a high
 * backstop; this is the primary control against a model re-issuing the same call.
 */
export const IDENTICAL_CALL_THRESHOLD = 3;

/**
 * Order-independent serialization of a value: object keys are sorted recursively
 * so two argument maps that differ only in key order produce the same string.
 * Pure; used to canonicalize a tool call's arguments for the identical-call key.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Canonical per-turn key for a tool call: name + order-independent arguments. */
function canonicalToolKey(tc: ToolCall): string {
  return `${tc.name} ${stableStringify(tc.arguments)}`;
}

/** The recovery-shaped refusal returned when a call repeats past the threshold. */
function identicalCallRefusal(tc: ToolCall): ToolResult {
  const isReadOnly =
    VAULT_TOOL_NAMES.has(tc.name) ||
    tc.name === THINK_TOOL_NAME ||
    tc.name === RECALL_MEMORY_TOOL.name;
  return toolFailure({
    kind: "precondition",
    what: `${tc.name} was already called with these exact arguments ${IDENTICAL_CALL_THRESHOLD} times this turn and its result has not changed`,
    recovery:
      "use the result you already have, or change the arguments or your approach instead of repeating the call",
    isReadOnly,
  });
}

/** Result of applying the per-turn identical-call guard to a round's loop calls. */
export interface IdenticalCallGuardResult {
  /** Refusal results to push for calls blocked as over-threshold repeats. */
  blockedResults: Array<{ tc: ToolCall; result: ToolResult }>;
  /** Ids of the blocked calls, so execution/accumulation buckets can exclude them. */
  blockedIds: Set<string>;
}

/**
 * Per-turn spin guard (D5). Counts identical (tool name + canonical args) calls
 * across the turn in `counts`; the first {@link IDENTICAL_CALL_THRESHOLD} run
 * normally, the next exact repeat is refused with a recovery-shaped `precondition`
 * failure telling the model it already has this result. Mutates `counts`, and is
 * applied to a round's loop calls before they execute *or* accumulate as write
 * calls, so a refused mutating call is never applied. Pure aside from the counter,
 * so its threshold behavior is unit-testable in isolation.
 */
export function applyIdenticalCallGuard(
  loopCalls: ToolCall[],
  counts: Map<string, number>,
): IdenticalCallGuardResult {
  const blockedResults: Array<{ tc: ToolCall; result: ToolResult }> = [];
  const blockedIds = new Set<string>();
  for (const tc of loopCalls) {
    const key = canonicalToolKey(tc);
    const prior = counts.get(key) ?? 0;
    if (prior >= IDENTICAL_CALL_THRESHOLD) {
      blockedIds.add(tc.id);
      blockedResults.push({ tc, result: identicalCallRefusal(tc) });
    } else {
      counts.set(key, prior + 1);
    }
  }
  return { blockedResults, blockedIds };
}

/**
 * Tool allow-list guard. The stable cloud surface
 * advertises the full tool superset for cache stability, so the model can *see* a tool
 * the session does not permit (a deny-classed write under the `ask` posture); this
 * refuses any such call with a recovery-shaped
 * {@link ../../tools/toolSurface.toolNotAllowedFailure} before it executes or
 * accumulates as a write. Reads are unrestricted on cloud, so in practice only
 * not-permitted writes are blocked. `allowedToolNames` is absent for local providers
 * (their emitted set already equals the allowed set), making this a no-op; shares
 * {@link IdenticalCallGuardResult} with the spin guard so the loop merges them uniformly.
 */
export function applyToolAllowGuard(
  loopCalls: ToolCall[],
  allowedToolNames: string[] | undefined,
): IdenticalCallGuardResult {
  if (!allowedToolNames) return { blockedResults: [], blockedIds: new Set() };
  const allowed = new Set(allowedToolNames);
  const blockedResults: Array<{ tc: ToolCall; result: ToolResult }> = [];
  const blockedIds = new Set<string>();
  for (const tc of loopCalls) {
    if (allowed.has(tc.name)) continue;
    blockedIds.add(tc.id);
    blockedResults.push({ tc, result: toolNotAllowedFailure(tc.name) });
  }
  return { blockedResults, blockedIds };
}

/**
 * Cross one round's mutating calls over their named effect boundary, before any
 * of them reaches its review (ADR-0033).
 *
 * A call that cannot cross is refused here and never handed to the review, which
 * is the same shape the Claude callback path uses: the executor gets one boolean
 * and needs no new branch for "the intent could not be recorded" versus "the run
 * was stopped".
 */
async function crossEffectBoundaries(
  guard: EffectBoundaryGuard | undefined,
  boundary: EffectBoundary,
  calls: ToolCall[],
): Promise<{
  allowed: ToolCall[];
  refused: Array<{ tc: ToolCall; result: ToolResult }>;
}> {
  if (!guard) return { allowed: calls, refused: [] };
  const allowed: ToolCall[] = [];
  const refused: Array<{ tc: ToolCall; result: ToolResult }> = [];
  for (const tc of calls) {
    const crossed = await guard.crossEffectBoundary(
      boundary,
      effectIntentFor(boundary, tc, directCorrelationFor(tc.id)),
    );
    if (crossed) allowed.push(tc);
    else refused.push({ tc, result: effectBoundaryRefusal(boundary) });
  }
  return { allowed, refused };
}

/** Per-round inputs the vault-op resolver needs (was closed-over loop state). */
export interface ResolveVaultOpsDeps {
  vaultOpCalls: ToolCall[];
  /** Vault ops from PRIOR rounds, the overlay seed (a later move sees an earlier write). */
  priorVaultOpCalls: ToolCall[];
  round: number;
  stopReason: StopReason;
  context: VaultOpToolContext | undefined;
  callbacks: ToolLoopCallbacks;
  /** This turn's effect boundary. Absent preserves behavior without an audit (ADR-0033). */
  guard?: EffectBoundaryGuard;
}

/**
 * Resolve a round's vault-op calls. Records each op's timeline step first, then
 * routes to the live review (suspends on `ask` ops, returns the real
 * dispositions) or the legacy synchronous validate-only fallback.
 *
 * Lifted to module level from an in-loop closure so the live-review-vs-fallback
 * branch is reachable from a unit test with a constructed deps record.
 */
export async function resolveVaultOps(
  deps: ResolveVaultOpsDeps,
): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
  const { vaultOpCalls, priorVaultOpCalls, round, stopReason, context, callbacks } = deps;
  if (vaultOpCalls.length === 0) return [];
  for (const tc of vaultOpCalls) {
    callbacks.onToolStatus?.(tc.name);
    callbacks.onStepRecorded?.({
      type: "tool_call",
      round,
      toolName: tc.name,
      toolCallId: tc.id,
      toolInput: extractToolInput(tc),
      toolArgs: tc.arguments,
    });
  }
  // After the timeline row exists, before the review can decide anything: the row
  // is evidence, the review is the effect.
  const { allowed, refused } = await crossEffectBoundaries(
    deps.guard,
    "vault_op_review",
    vaultOpCalls,
  );
  if (allowed.length === 0) return refused;
  if (context?.liveReview) {
    const reviewed = await context.liveReview.resolveRound(
      allowed,
      stopReason === "max_tokens",
    );
    return [...reviewed, ...refused];
  }
  // Fallback: no live review, validate only (overlay seeded from prior rounds).
  const overlay = context ? buildPendingOverlay(context.app, priorVaultOpCalls) : null;
  const validated = allowed.map((tc) => {
    if (!context || !overlay) {
      return {
        tc,
        result: toolFailure({
          kind: "unavailable",
          what: "vault operation context unavailable",
          isReadOnly: false,
        }),
      };
    }
    return { tc, result: executeVaultOpTool(tc, { app: context.app, overlay }) };
  });
  return [...validated, ...refused];
}

/** Per-round inputs the edit resolver needs (was closed-over loop state). */
export interface ResolveEditsDeps {
  editCalls: ToolCall[];
  vaultOpContext: VaultOpToolContext | undefined;
  editContext: ToolExecutionContext | undefined;
  round: number;
  callbacks: ToolLoopCallbacks;
  /** This turn's effect boundary. Absent preserves behavior without an audit (ADR-0033). */
  guard?: EffectBoundaryGuard;
}

/**
 * Resolve a round's edit calls. Records each edit's timeline step first, then
 * routes to the live review (resolves in-loop with the real three-tier resolver,
 * blocks on `ask` edits, returns the real dispositions) or the legacy
 * synchronous validate-only fallback when no live review is available.
 *
 * Lifted to module level alongside {@link resolveVaultOps}.
 */
export async function resolveEdits(
  deps: ResolveEditsDeps,
): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
  const { editCalls, vaultOpContext, editContext, round, callbacks } = deps;
  if (editCalls.length === 0) return [];
  for (const tc of editCalls) {
    callbacks.onToolStatus?.(tc.name);
    callbacks.onStepRecorded?.({
      type: "tool_call",
      round,
      toolName: tc.name,
      toolCallId: tc.id,
      toolInput: extractToolInput(tc),
      toolArgs: tc.arguments,
    });
  }
  const { allowed, refused } = await crossEffectBoundaries(
    deps.guard,
    "edit_review",
    editCalls,
  );
  if (allowed.length === 0) return refused;
  if (vaultOpContext?.liveReview) {
    const reviewed = await vaultOpContext.liveReview.resolveEdits(allowed);
    return [...reviewed, ...refused];
  }
  // Fallback: no live review, validate-only acknowledge (legacy non-blocking path).
  const validated = await Promise.all(
    allowed.map(async (tc) => {
      if (!editContext) {
        return {
          tc,
          result: toolFailure({
            kind: "unavailable",
            what: "edit tool context unavailable",
            isReadOnly: false,
          }),
        };
      }
      return { tc, result: await executeEditTool(tc, editContext) };
    }),
  );
  return [...validated, ...refused];
}

export interface ResolveMemoriesDeps {
  memoryCalls: ToolCall[];
  context: MemoryToolContext | undefined;
  liveReview?: LiveVaultReview;
  round: number;
  callbacks: ToolLoopCallbacks;
  /** This turn's effect boundary. Absent preserves behavior without an audit (ADR-0033). */
  guard?: EffectBoundaryGuard;
}

/**
 * Resolve memory mutations through their dedicated review channel. The fallback
 * validates and acknowledges only, it never persists without a reviewer.
 */
export async function resolveMemories(
  deps: ResolveMemoriesDeps,
): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
  const { memoryCalls, context, liveReview, round, callbacks } = deps;
  if (memoryCalls.length === 0) return [];
  for (const tc of memoryCalls) {
    callbacks.onToolStatus?.(tc.name);
    callbacks.onStepRecorded?.({
      type: "tool_call",
      round,
      toolName: tc.name,
      toolCallId: tc.id,
      toolInput: extractToolInput(tc),
      toolArgs: tc.arguments,
    });
  }
  const { allowed, refused } = await crossEffectBoundaries(
    deps.guard,
    "memory_review",
    memoryCalls,
  );
  if (allowed.length === 0) return refused;
  if (liveReview) {
    const reviewed = await liveReview.resolveMemories(allowed);
    return [...reviewed, ...refused];
  }
  const validated = allowed.map((tc) => {
    if (!context) {
      return {
        tc,
        result: toolFailure({
          kind: "unavailable",
          what: "memory tool context unavailable",
          isReadOnly: false,
        }),
      };
    }
    return {
      tc,
      result: executeMemoryTool(tc, context),
    };
  });
  return [...validated, ...refused];
}

export interface FailedRoundContext {
  hasToolCalls: boolean;
  roundText: string;
  stopReason: StopReason;
  /** Zero-based round index; surfaced 1-based in the message. */
  round: number;
  /** The configured round cap, surfaced as "round X of Y". */
  maxRounds: number;
  /** This round's usage, when the provider reported it. */
  usage: UsageResult | null;
  /** The model id, so the message names what to swap out. */
  model: string;
  /** Which backend ran the turn, the first thing a bug report needs. */
  provider: ProviderOption;
  /** Whether tools were attached / the agent loop was active this turn. */
  agenticMode: boolean;
  /** How many tools were advertised to the model. */
  toolCount: number;
  /** Edit vs chat, derived from whether a live document rode the request. */
  mode: "edit" | "chat";
}

/**
 * A round ended with no tool calls and no usable text. Rather than the old
 * one-size-fits-all message, classify *why*, raw tool-call markup, a `tool_use`
 * stop with nothing parseable, a server-tool `pause_turn`, a genuinely empty turn,
 * or reasoning-only output,
 * then render a multi-line block (summary, cause, fix, and a copyable diagnostics
 * section) via {@link formatFailedRoundMessage}. Each failure mode is
 * distinguishable in practice and points at a different fix, so collapsing them
 * hid the signal; the diagnostics exist to be pasted verbatim into a bug report.
 *
 * A clean `end_turn` after a productive round is *not* a failure: a terse local
 * model (e.g. Gemma) that did its tool work in an earlier round often emits an
 * empty final turn with nothing to add. This surfaces especially on regeneration,
 * where the re-issued ops resolve as "already satisfied" and leave nothing to
 * summarize. Treating that as fatal threw the user a scary error on a turn that
 * actually succeeded, so an empty `end_turn` past round 0 ends the loop quietly.
 */
export function checkForFailedToolCall(ctx: FailedRoundContext): void {
  const { hasToolCalls, roundText, stopReason, round, usage } = ctx;
  if (hasToolCalls) return;

  const textContent = roundText.trim();
  const outputTokens = usage?.outputTokens ?? null;

  const isMarkup =
    textContent.startsWith("[TOOL_CALLS]") || textContent.startsWith("[TOOL_REQUEST]");

  // The loop only reaches round > 0 by way of a prior tool round, so a clean
  // end_turn here means the model finished after doing its work, complete, even
  // if it added no closing prose. (Round 0 empty stays a failure: the model
  // answered nothing at all.) Markup / tool_use still fall through as failures.
  if (stopReason === "end_turn" && !isMarkup && round > 0) return;

  const isFailure = !textContent || isMarkup || stopReason === "tool_use";
  if (!isFailure) return;

  let cause: string;
  let recovery: string;
  if (isMarkup) {
    cause = "It emitted raw tool-call markup as plain text instead of a structured tool call, so no call could be parsed.";
    recovery =
      "This model's tool-call format isn't being recognized by the provider, switch to a model with native tool-calling, or turn tools off for this request.";
  } else if (stopReason === "pause_turn") {
    // Must precede the outputTokens branch: a pause_turn carries the in-flight
    // server_tool_use tokens, which would otherwise be misread as reasoning-only output.
    cause =
      "It paused after a long run of server-side tool-search calls (the server's tool loop hit its iteration cap before the model emitted a client tool call or a final answer).";
    recovery =
      "Regenerate to continue. The plugin does not auto-resume a paused server-tool turn; if this recurs, the model is searching the tool catalogue repeatedly without acting, so narrow the request.";
  } else if (stopReason === "tool_use") {
    cause = 'The provider reported a tool call (stop reason "tool_use") but returned no parseable call.';
    recovery = "The tool-call payload was malformed or empty, regenerate, or switch to a more capable model.";
  } else if (outputTokens && outputTokens > 0) {
    cause = `It generated ${outputTokens} token${outputTokens === 1 ? "" : "s"} but none were text content (likely reasoning-only output with an empty final message).`;
    recovery =
      "If this is a reasoning model it may have spent the turn thinking without answering, regenerate, or use a model that emits a final message.";
  } else if (stopReason === "max_tokens") {
    cause = "It hit the output token limit before producing any text.";
    recovery = "Raise the max output tokens for this model, or shorten the conversation.";
  } else {
    cause = "It returned an empty response with no text and no tool calls.";
    recovery =
      "The context may be too long, the request may have been cut off, or the model may be overloaded, regenerate, shorten the conversation, or switch models.";
  }

  throw new Error(formatFailedRoundMessage(ctx, cause, recovery, textContent, outputTokens));
}

/**
 * Render the failure as a multi-line block: a one-line summary, the classified
 * cause and suggested fix, then a labelled diagnostics section the user can copy
 * verbatim into a bug report. Errors render in a `white-space: pre-wrap` bubble,
 * so the line breaks survive; the same text is also useful pasted into a console
 * or issue. Keep every field on its own line, this exists to be reported.
 */
function formatFailedRoundMessage(
  ctx: FailedRoundContext,
  cause: string,
  recovery: string,
  textContent: string,
  outputTokens: number | null,
): string {
  const inputTokens = ctx.usage?.inputTokens ?? null;
  const tokenLine = (n: number | null): string => (n === null ? "unknown" : String(n));

  const diagnostics: Array<[string, string]> = [
    ["Provider", ctx.provider],
    ["Model", ctx.model],
    ["Round", `${ctx.round + 1} of ${ctx.maxRounds + 1}`],
    ["Stop reason", ctx.stopReason],
    ["Output tokens", tokenLine(outputTokens)],
    ["Input tokens", tokenLine(inputTokens)],
    ["Mode", ctx.mode],
    ["Agentic", ctx.agenticMode ? "on" : "off"],
    ["Tools attached", String(ctx.toolCount)],
  ];
  if (textContent) {
    const preview = textContent.slice(0, 300).replace(/\s+/g, " ");
    diagnostics.push(["Raw output", `"${preview}${textContent.length > 300 ? "…" : ""}"`]);
  }

  const diagnosticsBlock = diagnostics.map(([label, value]) => `  ${label}: ${value}`).join("\n");

  return [
    "The model returned no usable response.",
    "",
    `What happened: ${cause}`,
    `Try this: ${recovery}`,
    "",
    "Diagnostics (copy this when reporting the issue):",
    diagnosticsBlock,
  ].join("\n");
}
