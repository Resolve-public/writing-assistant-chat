import type {
  AssistantCaptureBatch,
  CaptureBatchId,
  CaptureFactsFingerprint,
} from "../../api/assistantCapture";
import { CaptureConflictError } from "../../api/assistantCapture";
import type { AssistantStreamEvent } from "../../api/usageTypes";
import { captureStepFields } from "../../tools/resultDigest";
import type {
  AssistantProseItem,
  AssistantToolCallItem,
  AssistantToolLifecycleState,
  AssistantTurnRecord,
  AssistantTurnSchemaVersion,
  AssistantTurnSegment,
  AssistantTurnStatus,
  CompletedAskGuidanceRecord,
  ProviderCaptureDiagnostic,
  ProviderItemCaptureEvidence,
  ProviderItemPlacement,
  ProviderQuiescence,
  ProviderReplayCapsule,
  ToolResultImageRecord,
} from "../../shared/types";
import { generateId } from "../../utils";
import { validateAssistantTurn } from "./assistantTurnValidation";

export type AssistantTurnBuilderIdKind = "segment" | "item";

export interface AssistantTurnBuilderOptions {
  turnId: string;
  createId?: (kind: AssistantTurnBuilderIdKind) => string;
}

export interface StartAssistantTurnSegment {
  segmentId?: string;
  providerMessageId?: string;
  replayCapsule?: ProviderReplayCapsule;
}

export interface AppendAssistantProseOptions {
  providerBlockId?: string;
  deltaKey?: string;
}

export type AssistantToolCorrelation = "provider_id" | "plugin_id";

export interface StartAssistantToolCall {
  declarationKey: string;
  providerBlockId?: string;
  toolCallId?: string;
  correlation?: AssistantToolCorrelation;
  toolName?: string;
  itemId?: string;
  sourceItemId?: string;
  toolInput?: string;
  actionRef?: string;
  round?: number;
}

export interface AppendAssistantToolArgumentsOptions {
  deltaKey?: string;
}

export interface AssistantToolLifecycleUpdate {
  state?: AssistantToolLifecycleState;
  toolName?: string;
  toolInput?: string;
  resultRecord?: string;
  resultDigest?: string;
  resultImages?: ToolResultImageRecord[];
  isError?: boolean;
  errorContent?: string;
  actionRef?: string;
  askGuidance?: CompletedAskGuidanceRecord;
  askStatus?: "completed" | "cancelled" | "skipped";
  round?: number;
}

export interface CompletedAssistantProseBlock {
  type: "prose";
  providerBlockId: string;
  text: string;
}

export interface CompletedAssistantToolCallBlock {
  type: "tool_call";
  providerBlockId: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
}

export type CompletedAssistantSegmentBlock =
  | CompletedAssistantProseBlock
  | CompletedAssistantToolCallBlock;

export interface CompletedAssistantSegment {
  segmentId: string;
  providerMessageId?: string;
  replayCapsule?: ProviderReplayCapsule;
  blocks: CompletedAssistantSegmentBlock[];
}

export type AssistantTurnSnapshotToolCallItem = Omit<
  AssistantToolCallItem,
  "toolCallId"
> & {
  toolCallId?: string;
};

export type AssistantTurnSnapshotItem =
  | AssistantProseItem
  | AssistantTurnSnapshotToolCallItem;

export interface AssistantTurnSnapshot {
  schemaVersion: AssistantTurnSchemaVersion;
  id: string;
  status: AssistantTurnStatus;
  segments: AssistantTurnSegment[];
  items: AssistantTurnSnapshotItem[];
  quiescence?: ProviderQuiescence;
  captureDiagnostics?: ProviderCaptureDiagnostic[];
}

type TerminalAssistantTurnStatus = Exclude<AssistantTurnStatus, "streaming">;

interface MutableSegment extends AssistantTurnSegment {
  finished: boolean;
  toolCount: number;
}

interface MutableProseItem extends AssistantProseItem {
  providerBlockIds: Set<string>;
  captureEvidence: ProviderItemCaptureEvidence;
}

interface MutableToolCallItem
  extends Omit<AssistantToolCallItem, "toolCallId"> {
  toolCallId?: string;
  declarationKey: string;
  declarationIndex: number;
  providerBlockId?: string;
  correlation?: AssistantToolCorrelation;
  captureEvidence: ProviderItemCaptureEvidence;
}

type MutableItem = MutableProseItem | MutableToolCallItem;

interface PendingLifecycle {
  itemId: string;
  update: AssistantToolLifecycleUpdate;
}

interface RecordedDelta {
  target: string;
  delta: string;
}

interface ReconciledProseRun {
  type: "prose";
  providerBlockIds: string[];
  text: string;
}

type ReconciledPart = ReconciledProseRun | CompletedAssistantToolCallBlock;

/**
 * Every mutable fact one assistant turn holds, in one object.
 *
 * Grouping it is what makes {@link AssistantTurnBuilder.applyCaptureBatch}
 * atomic: a transaction clones this whole object, applies and validates the
 * batch on the clone, and swaps one reference on success. Rollback mutation and
 * a second hand-written planning reducer were both rejected
 * because either would have to stay in step with the granular methods by hand,
 * and a drift between them is exactly the class of bug this is fixing.
 *
 * The maps hold the same item objects the arrays do. `structuredClone` preserves
 * that sharing within one call, so the clone is a self-consistent graph rather
 * than a set of indexes pointing at the previous state's items.
 */
interface AssistantTurnBuilderState {
  segments: MutableSegment[];
  segmentById: Map<string, MutableSegment>;
  items: MutableItem[];
  itemById: Map<string, MutableItem>;
  declarationByKey: Map<string, MutableToolCallItem>;
  toolByCallId: Map<string, MutableToolCallItem>;
  toolItemReservationByCallId: Map<string, string>;
  pendingLifecycleByCallId: Map<string, PendingLifecycle>;
  providerBlockItemIds: Map<string, string>;
  proseDeltaByKey: Map<string, RecordedDelta>;
  argumentDeltaByKey: Map<string, RecordedDelta>;
  domainIds: Set<string>;
  /**
   * Committed batch IDs and the protocol bytes they carried.
   *
   * Only batches whose frame key is the provider's own wire identity are
   * indexed, because only there does a repeated key prove redelivery. This is
   * not a lease-local batch journal: it records no applied effects, dependent
   * batches, or effect boundaries. Those require a real `supersedes` frame
   * (ADR-0031).
   */
  committedBatches: Map<CaptureBatchId, CaptureFactsFingerprint>;
  captureDiagnostics: ProviderCaptureDiagnostic[];
  activeSegmentId: string | null;
  openProseItemId: string | null;
  /** Identity every item created inside the open transaction is stamped with. */
  currentBatch: { batchId: CaptureBatchId; placement: ProviderItemPlacement } | null;
}

function createBuilderState(turnId: string): AssistantTurnBuilderState {
  return {
    segments: [],
    segmentById: new Map(),
    items: [],
    itemById: new Map(),
    declarationByKey: new Map(),
    toolByCallId: new Map(),
    toolItemReservationByCallId: new Map(),
    pendingLifecycleByCallId: new Map(),
    providerBlockItemIds: new Map(),
    proseDeltaByKey: new Map(),
    argumentDeltaByKey: new Map(),
    domainIds: new Set([turnId]),
    committedBatches: new Map(),
    captureDiagnostics: [],
    activeSegmentId: null,
    openProseItemId: null,
    currentBatch: null,
  };
}

/**
 * What one committed capture batch changed.
 *
 * Post-commit notifications are derived from this rather than from the facts the
 * batch carried, so a subscriber is told only about work that actually landed
 * (ADR-0031).
 */
export interface CaptureBatchChanges {
  /** Segments this batch opened, in arrival order. */
  startedSegments: string[];
  /** Visible prose bytes this batch committed, in arrival order. */
  proseDeltas: string[];
  /** Tool names this batch declared, in arrival order. */
  declaredTools: string[];
  /** Exact correlation evidence this batch committed. */
  toolCorrelations: Array<{
    toolCallId: string;
    correlation: AssistantToolCorrelation | "none";
  }>;
}

export interface CaptureCommitResult extends CaptureBatchChanges {
  batchId: CaptureBatchId;
  /** True when this was a byte-identical redelivery and nothing was applied. */
  duplicate: boolean;
  /** The one snapshot this batch produced. */
  snapshot: AssistantTurnSnapshot;
}

export class AssistantTurnBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantTurnBuilderError";
  }
}

/**
 * Mutable declaration reducer for one assistant turn.
 *
 * Only structured declaration events position items. Lifecycle callbacks may
 * reserve an identity and buffer state by exact tool-call ID, but they never
 * append an item. Every public snapshot is detached and deeply frozen.
 */
export class AssistantTurnBuilder {
  private readonly turnId: string;
  private readonly createId: (kind: AssistantTurnBuilderIdKind) => string;
  /** The published state. Every snapshot any consumer has seen came from here. */
  private committed: AssistantTurnBuilderState;
  /** The draft a capture transaction is applying to, or null outside one. */
  private working: AssistantTurnBuilderState | null = null;
  private finishedRecord: AssistantTurnRecord | null = null;

  constructor(options: AssistantTurnBuilderOptions) {
    assertNonEmpty(options.turnId, "Turn ID");
    this.turnId = options.turnId;
    this.createId =
      options.createId ?? ((kind) => `${kind}-${generateId()}`);
    this.committed = createBuilderState(options.turnId);
  }

  /**
   * The state the mutating methods read and write: the transaction draft while
   * one is open, the published state otherwise.
   */
  private get state(): AssistantTurnBuilderState {
    return this.working ?? this.committed;
  }

  /**
   * Commit one capture batch, or commit nothing.
   *
   * The whole frame is applied to a clone of the published state. Any fact that
   * fails leaves that clone unreferenced, so a conflict on the second declaration
   * inside a frame cannot leave the first one visible: that is the invariant the
   * incident broke, and it is not reachable by fixing identity alone.
   *
   * No callback runs during application. The commit result carries what the batch
   * changed so the caller can notify after the swap (ADR-0031), which is
   * what keeps a subscriber from ever observing the draft.
   */
  applyCaptureBatch(
    batch: AssistantCaptureBatch,
    round?: number,
  ): CaptureCommitResult {
    this.assertMutable();
    if (this.working !== null) {
      throw new AssistantTurnBuilderError(
        "A capture batch is already being applied.",
      );
    }

    const redelivery = this.checkRedelivery(batch);
    if (redelivery) return redelivery;

    const draft = cloneBuilderState(this.committed);
    draft.currentBatch = {
      batchId: batch.batchId,
      placement:
        batch.providerMessageKey === undefined
          ? { kind: "unplaced" }
          : { kind: "segment", providerMessageKey: batch.providerMessageKey },
    };
    const changed: CaptureBatchChanges = {
      startedSegments: [],
      proseDeltas: [],
      declaredTools: [],
      toolCorrelations: [],
    };

    this.working = draft;
    try {
      for (const fact of batch.facts) this.applyCaptureFact(fact, changed, round);
    } catch (error) {
      // The draft is dropped whole. Nothing this batch touched was ever visible,
      // so there is no partial state to undo.
      this.working = null;
      throw asCaptureConflict(error, batch);
    }
    draft.currentBatch = null;
    if (batch.frameKeySource === "provider") {
      draft.committedBatches.set(batch.batchId, batch.factsFingerprint);
    }
    // The one reference swap. Everything above ran on state no consumer holds.
    this.committed = draft;
    this.working = null;

    return {
      batchId: batch.batchId,
      duplicate: false,
      snapshot: this.snapshot(),
      ...changed,
    };
  }

  /**
   * Atomically retire every fact an earlier batch owns, after a later batch
   * conflicted with it.
   *
   * The declarations stay visible, marked capture-invalid, because a tool the
   * provider really declared and may already have run is not made safer by being
   * hidden. What they lose is authority: they cannot enter replay, and their
   * evidence lowers the whole turn below exact capture.
   */
  invalidateCapturedFacts(
    batchIds: readonly CaptureBatchId[],
    diagnostic?: ProviderCaptureDiagnostic,
  ): AssistantTurnSnapshot {
    this.assertMutable();
    const targets = new Set(batchIds);
    const draft = cloneBuilderState(this.committed);
    for (const item of draft.items) {
      if (!targets.has(item.captureEvidence.originBatchId)) continue;
      item.captureEvidence = {
        ...item.captureEvidence,
        validity: "capture_invalid",
      };
      if (
        item.type === "tool_call" &&
        (item.state === "declared" || item.state === "running")
      ) {
        item.state = "failed";
      }
    }
    if (diagnostic) draft.captureDiagnostics.push(diagnostic);
    this.committed = draft;
    return this.snapshot();
  }

  /** Records one bounded terminal diagnostic on the turn. */
  recordCaptureDiagnostic(diagnostic: ProviderCaptureDiagnostic): void {
    this.assertMutable();
    this.committed.captureDiagnostics.push(diagnostic);
  }

  /**
   * Whether this batch was already committed, and whether it still says what it
   * said the first time.
   */
  private checkRedelivery(
    batch: AssistantCaptureBatch,
  ): CaptureCommitResult | null {
    if (batch.frameKeySource !== "provider") return null;
    const committed = this.committed.committedBatches.get(batch.batchId);
    if (committed === undefined) return null;
    if (committed !== batch.factsFingerprint) {
      throw new CaptureConflictError(
        "fingerprint_mismatch",
        "A redelivered capture batch carried different protocol bytes.",
        { batchId: batch.batchId, conflictingBatchId: batch.batchId },
      );
    }
    // Skipped through the committed index rather than reapplied, so redelivery
    // preserves the original committed item IDs (ADR-0031).
    return {
      batchId: batch.batchId,
      duplicate: true,
      snapshot: this.snapshot(),
      startedSegments: [],
      proseDeltas: [],
      declaredTools: [],
      toolCorrelations: [],
    };
  }

  /**
   * Apply one ordered declaration fact to the open transaction.
   *
   * This was applyAssistantStreamEvent() in the tool loop, where it published a
   * snapshot after every event. Moving it inside the builder is the point: a fact
   * is now part of a frame, and a frame commits or it does not.
   */
  private applyCaptureFact(
    fact: AssistantStreamEvent,
    changed: CaptureBatchChanges,
    round?: number,
  ): void {
    switch (fact.type) {
      case "segment_start":
        this.startSegment({
          segmentId: fact.segmentId,
          ...(fact.providerMessageId === undefined
            ? {}
            : { providerMessageId: fact.providerMessageId }),
        });
        changed.startedSegments.push(fact.segmentId);
        break;
      case "prose_delta":
        this.appendProseDelta(fact.segmentId, fact.delta, {
          ...(fact.providerBlockId === undefined
            ? {}
            : { providerBlockId: fact.providerBlockId }),
          ...(fact.deltaKey === undefined ? {} : { deltaKey: fact.deltaKey }),
        });
        changed.proseDeltas.push(fact.delta);
        break;
      case "tool_call_start":
        this.startToolCall(fact.segmentId, {
          declarationKey: fact.declarationKey,
          ...(fact.toolName === undefined ? {} : { toolName: fact.toolName }),
          ...(fact.providerBlockId === undefined
            ? {}
            : { providerBlockId: fact.providerBlockId }),
          ...(fact.toolCallId === undefined
            ? {}
            : {
                toolCallId: fact.toolCallId,
                correlation:
                  fact.correlation === undefined || fact.correlation === "none"
                    ? "provider_id"
                    : fact.correlation,
              }),
          ...(round === undefined ? {} : { round }),
        });
        if (fact.toolName !== undefined) changed.declaredTools.push(fact.toolName);
        break;
      case "tool_call_delta":
        if (fact.nameDelta !== undefined) {
          this.appendToolNameDelta(fact.declarationKey, fact.nameDelta);
        }
        if (fact.argumentsDelta !== undefined) {
          this.appendToolArgumentsDelta(
            fact.declarationKey,
            fact.argumentsDelta,
            {
              ...(fact.deltaKey === undefined ? {} : { deltaKey: fact.deltaKey }),
            },
          );
        }
        break;
      case "tool_call_identity":
        this.bindToolCallId(
          fact.declarationKey,
          fact.toolCallId,
          fact.correlation === "none" ? "provider_id" : fact.correlation,
        );
        changed.toolCorrelations.push({
          toolCallId: fact.toolCallId,
          correlation: fact.correlation,
        });
        break;
      case "segment_reconcile":
        this.reconcileCompletedSegment({
          segmentId: fact.segmentId,
          ...(fact.providerMessageId === undefined
            ? {}
            : { providerMessageId: fact.providerMessageId }),
          blocks: fact.blocks,
        });
        break;
      case "tool_result": {
        const item = this.state.toolByCallId.get(fact.toolCallId);
        const capture = item
          ? captureStepFields(item.toolName, item.toolArgs ?? {}, {
              content: fact.content,
              isError: fact.isError,
            })
          : { resultRecord: fact.content };
        this.updateToolLifecycle(fact.toolCallId, {
          state: fact.isError ? "failed" : "completed",
          ...capture,
          ...(fact.isError ? { isError: true, errorContent: fact.content } : {}),
        });
        break;
      }
      case "stream_diagnostic":
        break;
      case "segment_end":
        this.finishSegment(fact.segmentId);
        break;
      case "turn_end":
        break;
    }
  }

  /** The capture evidence an item created right now carries for good. */
  private newItemEvidence(): ProviderItemCaptureEvidence {
    const batch = this.state.currentBatch;
    return {
      // An item minted outside a capture transaction was authored by the plugin,
      // not observed on the wire, so it makes no ordering claim.
      originBatchId: batch?.batchId ?? `direct:${this.turnId}`,
      placement: batch ? cloneValue(batch.placement) : { kind: "unplaced" },
      validity: "valid",
    };
  }

  startSegment(input: StartAssistantTurnSegment = {}): string {
    this.assertMutable();
    const generated = input.segmentId === undefined;
    const segmentId = input.segmentId ?? this.nextDomainId("segment");
    assertNonEmpty(segmentId, "Segment ID");

    const existing = this.state.segmentById.get(segmentId);
    if (existing) {
      this.mergeSegmentMetadata(existing, input);
      if (!existing.finished && this.state.activeSegmentId !== segmentId) {
        throw new AssistantTurnBuilderError(
          `Segment "${segmentId}" is open but is not the active segment.`,
        );
      }
      return segmentId;
    }

    if (this.state.activeSegmentId !== null) {
      throw new AssistantTurnBuilderError(
        `Finish segment "${this.state.activeSegmentId}" before starting "${segmentId}".`,
      );
    }
    if (!generated) this.claimDomainId(segmentId, "segment");

    const segment: MutableSegment = {
      id: segmentId,
      ...(input.providerMessageId === undefined
        ? {}
        : { providerMessageId: validatedText(input.providerMessageId, "Provider message ID") }),
      ...(input.replayCapsule === undefined
        ? {}
        : { replayCapsule: cloneValue(input.replayCapsule) }),
      finished: false,
      toolCount: 0,
    };
    this.state.segments.push(segment);
    this.state.segmentById.set(segmentId, segment);
    this.state.activeSegmentId = segmentId;
    return segmentId;
  }

  appendProseDelta(
    segmentId: string,
    delta: string,
    options: AppendAssistantProseOptions = {},
  ): string | null {
    this.assertMutable();
    assertNonEmpty(segmentId, "Segment ID");
    if (delta.length === 0) return null;

    const repeatedTarget = this.checkRepeatedDelta(
      this.state.proseDeltaByKey,
      options.deltaKey,
      delta,
      "prose",
    );
    if (repeatedTarget !== null) return repeatedTarget;

    const segment = this.requireWritableSegment(segmentId);
    const blockKey =
      options.providerBlockId === undefined
        ? null
        : this.providerBlockKey(segmentId, options.providerBlockId);
    const blockItem =
      blockKey === null ? undefined : this.itemForProviderBlock(blockKey);
    let prose = blockItem?.type === "prose" ? blockItem : this.openProseItem();

    if (blockItem && blockItem.type !== "prose") {
      throw new AssistantTurnBuilderError(
        `Provider block "${options.providerBlockId}" is already a tool declaration.`,
      );
    }
    if (prose && prose.segmentId !== segment.id) prose = null;
    if (prose && this.state.openProseItemId !== prose.id) {
      throw new AssistantTurnBuilderError(
        `Provider block "${options.providerBlockId}" cannot resume after tool activity.`,
      );
    }

    if (!prose) {
      const itemId = this.nextDomainId("item");
      prose = {
        type: "prose",
        id: itemId,
        segmentId,
        text: "",
        providerBlockIds: new Set<string>(),
        captureEvidence: this.newItemEvidence(),
      };
      this.state.items.push(prose);
      this.state.itemById.set(itemId, prose);
      this.state.openProseItemId = itemId;
    }

    prose.text += delta;
    if (blockKey !== null) {
      prose.providerBlockIds.add(blockKey);
      this.state.providerBlockItemIds.set(blockKey, prose.id);
    }
    this.recordDelta(
      this.state.proseDeltaByKey,
      options.deltaKey,
      prose.id,
      delta,
    );
    return prose.id;
  }

  startToolCall(segmentId: string, input: StartAssistantToolCall): string {
    this.assertMutable();
    const segment = this.requireWritableSegment(segmentId);
    assertNonEmpty(input.declarationKey, "Declaration key");

    const existing = this.state.declarationByKey.get(input.declarationKey);
    if (existing) {
      this.mergeRepeatedToolStart(existing, segmentId, input);
      return existing.id;
    }

    this.state.openProseItemId = null;
    const itemId = this.resolveDeclaredToolItemId(input);
    const tool: MutableToolCallItem = {
      type: "tool_call",
      id: itemId,
      segmentId,
      ...(input.sourceItemId === undefined
        ? {}
        : { sourceItemId: validatedText(input.sourceItemId, "Source item ID") }),
      toolName: input.toolName ?? "",
      toolArguments: "",
      ...(input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
      state: "declared",
      ...(input.actionRef === undefined
        ? {}
        : { actionRef: validatedText(input.actionRef, "Action reference") }),
      ...(input.round === undefined ? {} : { round: input.round }),
      declarationKey: input.declarationKey,
      declarationIndex: segment.toolCount,
      captureEvidence: this.newItemEvidence(),
    };
    segment.toolCount += 1;

    this.state.items.push(tool);
    this.state.itemById.set(itemId, tool);
    this.state.declarationByKey.set(input.declarationKey, tool);
    this.bindProviderBlock(tool, input.providerBlockId);

    if (input.toolCallId !== undefined) {
      this.bindToolCallId(
        input.declarationKey,
        input.toolCallId,
        input.correlation ?? "provider_id",
      );
    }
    return itemId;
  }

  appendToolNameDelta(
    declarationKey: string,
    delta: string,
  ): void {
    this.assertMutable();
    const tool = this.requireWritableDeclaration(declarationKey);
    tool.toolName += delta;
  }

  appendToolArgumentsDelta(
    declarationKey: string,
    delta: string,
    options: AppendAssistantToolArgumentsOptions = {},
  ): void {
    this.assertMutable();
    const repeatedTarget = this.checkRepeatedDelta(
      this.state.argumentDeltaByKey,
      options.deltaKey,
      delta,
      "tool arguments",
    );
    if (repeatedTarget !== null) return;

    const tool = this.requireWritableDeclaration(declarationKey);
    tool.toolArguments += delta;
    this.refreshParsedToolArguments(tool);
    this.recordDelta(
      this.state.argumentDeltaByKey,
      options.deltaKey,
      declarationKey,
      delta,
    );
  }

  bindToolCallId(
    declarationKey: string,
    toolCallId: string,
    correlation: AssistantToolCorrelation,
  ): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const tool = this.state.declarationByKey.get(declarationKey);
    if (!tool) {
      throw new AssistantTurnBuilderError(
        `Unknown declaration key "${declarationKey}".`,
      );
    }

    if (tool.toolCallId !== undefined) {
      if (tool.toolCallId !== toolCallId) {
        throw new AssistantTurnBuilderError(
          `Declaration "${declarationKey}" is already bound to "${tool.toolCallId}".`,
        );
      }
      if (tool.correlation !== undefined && tool.correlation !== correlation) {
        throw new AssistantTurnBuilderError(
          `Declaration "${declarationKey}" has conflicting correlation evidence.`,
        );
      }
      tool.correlation = correlation;
      return tool.id;
    }

    const positioned = this.state.toolByCallId.get(toolCallId);
    if (positioned && positioned !== tool) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${toolCallId}" is already bound to item "${positioned.id}".`,
      );
    }
    const reservedId = this.state.toolItemReservationByCallId.get(toolCallId);
    if (reservedId !== undefined && reservedId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${toolCallId}" reserved item "${reservedId}", not "${tool.id}".`,
      );
    }

    tool.toolCallId = toolCallId;
    tool.correlation = correlation;
    this.state.toolByCallId.set(toolCallId, tool);
    this.state.toolItemReservationByCallId.set(toolCallId, tool.id);
    this.applyPendingLifecycle(toolCallId, tool);
    return tool.id;
  }

  reserveToolItemId(toolCallId: string, itemId?: string): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const positioned = this.state.toolByCallId.get(toolCallId);
    if (positioned) {
      if (itemId !== undefined && itemId !== positioned.id) {
        throw new AssistantTurnBuilderError(
          `Tool-call ID "${toolCallId}" already owns item "${positioned.id}".`,
        );
      }
      return positioned.id;
    }

    const existing = this.state.toolItemReservationByCallId.get(toolCallId);
    if (existing !== undefined) {
      if (itemId !== undefined && itemId !== existing) {
        throw new AssistantTurnBuilderError(
          `Tool-call ID "${toolCallId}" already reserves item "${existing}".`,
        );
      }
      return existing;
    }

    const reservedId = itemId ?? this.nextDomainId("item");
    if (itemId !== undefined) this.claimDomainId(itemId, "item");
    this.state.toolItemReservationByCallId.set(toolCallId, reservedId);
    return reservedId;
  }

  updateToolLifecycle(
    toolCallId: string,
    update: AssistantToolLifecycleUpdate,
  ): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const tool = this.state.toolByCallId.get(toolCallId);
    if (tool) {
      this.mergeLifecycleIntoTool(tool, update);
      return tool.id;
    }

    const itemId = this.reserveToolItemId(toolCallId);
    const pending = this.state.pendingLifecycleByCallId.get(toolCallId);
    const merged = this.mergeLifecycleUpdates(pending?.update ?? {}, update);
    this.state.pendingLifecycleByCallId.set(toolCallId, { itemId, update: merged });
    return itemId;
  }

  finishSegment(segmentId: string): void {
    this.assertMutable();
    const segment = this.state.segmentById.get(segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(`Unknown segment "${segmentId}".`);
    }
    if (segment.finished) return;
    if (this.state.activeSegmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Segment "${segmentId}" is not the active segment.`,
      );
    }

    this.state.openProseItemId = null;
    for (const item of this.state.items) {
      if (item.type !== "tool_call" || item.segmentId !== segmentId) continue;
      if (item.toolName.trim().length === 0) {
        throw new AssistantTurnBuilderError(
          `Tool declaration "${item.declarationKey}" has no tool name.`,
        );
      }
      if (item.toolCallId === undefined) {
        const fallback = `lmsa-tool-${segmentId}-${item.declarationIndex}`;
        this.bindToolCallId(item.declarationKey, fallback, "plugin_id");
      }
    }

    segment.finished = true;
    this.state.activeSegmentId = null;
  }

  reconcileCompletedSegment(completed: CompletedAssistantSegment): void {
    this.assertMutable();
    const segment = this.state.segmentById.get(completed.segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(
        `Unknown segment "${completed.segmentId}".`,
      );
    }
    this.mergeSegmentMetadata(segment, completed);

    const parts = this.groupCompletedBlocks(completed);
    const reconciledItems = parts.map((part) =>
      part.type === "prose"
        ? this.reconcileProseRun(completed.segmentId, part)
        : this.reconcileToolBlock(completed.segmentId, segment, part),
    );
    this.assertNoToolDeclarationWasOmitted(completed.segmentId, reconciledItems);
    this.replaceSegmentItems(completed.segmentId, reconciledItems);
    if (this.state.activeSegmentId === completed.segmentId) {
      this.state.openProseItemId = null;
    }
  }

  finishTurn(status: TerminalAssistantTurnStatus): AssistantTurnRecord {
    if (this.finishedRecord) {
      if (this.finishedRecord.status !== status) {
        throw new AssistantTurnBuilderError(
          `Turn already finished as "${this.finishedRecord.status}".`,
        );
      }
      return this.finishedRecord;
    }

    if (this.state.activeSegmentId !== null) {
      this.finishSegment(this.state.activeSegmentId);
    }
    if (status === "interrupted") {
      for (const item of this.state.items) {
        if (
          item.type === "tool_call" &&
          (item.state === "declared" || item.state === "running")
        ) {
          item.state = "interrupted";
        }
      }
    }

    const record = this.buildSnapshot(status, this.committed);
    for (const item of record.items) {
      if (item.type === "tool_call" && item.toolCallId === undefined) {
        throw new AssistantTurnBuilderError(
          `Tool item "${item.id}" has no final tool-call ID.`,
        );
      }
    }
    const candidate = record as AssistantTurnRecord;
    const validation = validateAssistantTurn(candidate);
    if (!validation.ok) {
      throw new AssistantTurnBuilderError(
        `Finished turn is invalid at ${validation.reason.path}: ` +
          validation.reason.code,
      );
    }
    this.finishedRecord = freezeClone(validation.value);
    return this.finishedRecord;
  }

  snapshot(): AssistantTurnSnapshot {
    if (this.finishedRecord) return this.finishedRecord;
    // Deliberately the published state, never the transaction draft: a snapshot
    // taken while a batch is being applied must show the last committed turn.
    return freezeClone(this.buildSnapshot("streaming", this.committed));
  }

  private assertMutable(): void {
    if (this.finishedRecord) {
      throw new AssistantTurnBuilderError("The assistant turn is already finished.");
    }
  }

  private nextDomainId(kind: AssistantTurnBuilderIdKind): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId(kind);
      assertNonEmpty(id, `${kind} ID`);
      if (!this.state.domainIds.has(id)) {
        this.state.domainIds.add(id);
        return id;
      }
    }
    throw new AssistantTurnBuilderError(
      `The ID factory could not produce a unique ${kind} ID.`,
    );
  }

  private claimDomainId(id: string, kind: AssistantTurnBuilderIdKind): void {
    assertNonEmpty(id, `${kind} ID`);
    if (this.state.domainIds.has(id)) {
      throw new AssistantTurnBuilderError(
        `Domain ID "${id}" is already in use.`,
      );
    }
    this.state.domainIds.add(id);
  }

  private mergeSegmentMetadata(
    segment: MutableSegment,
    input: Pick<StartAssistantTurnSegment, "providerMessageId" | "replayCapsule">,
  ): void {
    if (input.providerMessageId !== undefined) {
      assertNonEmpty(input.providerMessageId, "Provider message ID");
      segment.providerMessageId = mergeIdentityField(
        segment.providerMessageId,
        input.providerMessageId,
        `Segment "${segment.id}" provider message ID`,
      );
    }
    if (input.replayCapsule !== undefined) {
      if (
        segment.replayCapsule !== undefined &&
        !valuesEqual(segment.replayCapsule, input.replayCapsule)
      ) {
        throw new AssistantTurnBuilderError(
          `Segment "${segment.id}" has conflicting replay capsules.`,
        );
      }
      segment.replayCapsule = cloneValue(input.replayCapsule);
    }
  }

  private requireWritableSegment(segmentId: string): MutableSegment {
    const segment = this.state.segmentById.get(segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(`Unknown segment "${segmentId}".`);
    }
    if (segment.finished) {
      throw new AssistantTurnBuilderError(`Segment "${segmentId}" is finished.`);
    }
    if (this.state.activeSegmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Segment "${segmentId}" is not the active segment.`,
      );
    }
    return segment;
  }

  private openProseItem(): MutableProseItem | null {
    if (this.state.openProseItemId === null) return null;
    const item = this.state.itemById.get(this.state.openProseItemId);
    return item?.type === "prose" ? item : null;
  }

  private providerBlockKey(segmentId: string, providerBlockId: string): string {
    assertNonEmpty(providerBlockId, "Provider block ID");
    return `${segmentId}\u0000${providerBlockId}`;
  }

  private itemForProviderBlock(blockKey: string): MutableItem | undefined {
    const itemId = this.state.providerBlockItemIds.get(blockKey);
    return itemId === undefined ? undefined : this.state.itemById.get(itemId);
  }

  private bindProviderBlock(
    tool: MutableToolCallItem,
    providerBlockId: string | undefined,
  ): void {
    if (providerBlockId === undefined) return;
    const blockKey = this.providerBlockKey(tool.segmentId, providerBlockId);
    const existing = this.state.providerBlockItemIds.get(blockKey);
    if (existing !== undefined && existing !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Provider block "${providerBlockId}" already belongs to item "${existing}".`,
      );
    }
    if (
      tool.providerBlockId !== undefined &&
      tool.providerBlockId !== providerBlockId
    ) {
      throw new AssistantTurnBuilderError(
        `Tool item "${tool.id}" already uses provider block "${tool.providerBlockId}".`,
      );
    }
    tool.providerBlockId = providerBlockId;
    this.state.providerBlockItemIds.set(blockKey, tool.id);
  }

  private resolveDeclaredToolItemId(input: StartAssistantToolCall): string {
    const reserved =
      input.toolCallId === undefined
        ? undefined
        : this.state.toolItemReservationByCallId.get(input.toolCallId);
    if (
      input.itemId !== undefined &&
      reserved !== undefined &&
      input.itemId !== reserved
    ) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${input.toolCallId}" reserves item "${reserved}".`,
      );
    }
    if (reserved !== undefined) return reserved;
    if (input.itemId !== undefined) {
      this.claimDomainId(input.itemId, "item");
      return input.itemId;
    }
    return this.nextDomainId("item");
  }

  private mergeRepeatedToolStart(
    tool: MutableToolCallItem,
    segmentId: string,
    input: StartAssistantToolCall,
  ): void {
    if (tool.segmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Declaration "${input.declarationKey}" already belongs to segment "${tool.segmentId}".`,
      );
    }
    if (input.itemId !== undefined && input.itemId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Declaration "${input.declarationKey}" already owns item "${tool.id}".`,
      );
    }
    this.bindProviderBlock(tool, input.providerBlockId);
    tool.toolName = mergeIdentityField(
      emptyToUndefined(tool.toolName),
      emptyToUndefined(input.toolName),
      `Declaration "${input.declarationKey}" tool name`,
    ) ?? "";
    tool.sourceItemId = mergeIdentityField(
      tool.sourceItemId,
      input.sourceItemId,
      `Declaration "${input.declarationKey}" source item ID`,
    );
    tool.toolInput = mergeIdentityField(
      tool.toolInput,
      input.toolInput,
      `Declaration "${input.declarationKey}" tool input`,
    );
    tool.actionRef = mergeIdentityField(
      tool.actionRef,
      input.actionRef,
      `Declaration "${input.declarationKey}" action reference`,
    );
    tool.round = mergeScalarField(
      tool.round,
      input.round,
      `Declaration "${input.declarationKey}" round`,
    );
    if (input.toolCallId !== undefined) {
      this.bindToolCallId(
        input.declarationKey,
        input.toolCallId,
        input.correlation ?? "provider_id",
      );
    }
  }

  private requireWritableDeclaration(
    declarationKey: string,
  ): MutableToolCallItem {
    const tool = this.state.declarationByKey.get(declarationKey);
    if (!tool) {
      throw new AssistantTurnBuilderError(
        `Unknown declaration key "${declarationKey}".`,
      );
    }
    this.requireWritableSegment(tool.segmentId);
    return tool;
  }

  private refreshParsedToolArguments(tool: MutableToolCallItem): void {
    const parsed = parseJsonObject(tool.toolArguments);
    if (parsed === null) {
      delete tool.toolArgs;
    } else {
      tool.toolArgs = parsed;
    }
  }

  private applyPendingLifecycle(
    toolCallId: string,
    tool: MutableToolCallItem,
  ): void {
    const pending = this.state.pendingLifecycleByCallId.get(toolCallId);
    if (!pending) return;
    if (pending.itemId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Lifecycle for "${toolCallId}" reserves item "${pending.itemId}", not "${tool.id}".`,
      );
    }
    this.mergeLifecycleIntoTool(tool, pending.update);
    this.state.pendingLifecycleByCallId.delete(toolCallId);
  }

  private mergeLifecycleIntoTool(
    tool: MutableToolCallItem,
    update: AssistantToolLifecycleUpdate,
  ): void {
    if (update.state !== undefined) {
      tool.state = mergeLifecycleState(tool.state, update.state);
    }
    tool.toolName = mergeIdentityField(
      emptyToUndefined(tool.toolName),
      emptyToUndefined(update.toolName),
      `Tool "${tool.id}" name`,
    ) ?? "";
    tool.toolInput = mergeIdentityField(
      tool.toolInput,
      update.toolInput,
      `Tool "${tool.id}" input`,
    );
    tool.resultRecord = mergeIdentityField(
      tool.resultRecord,
      update.resultRecord,
      `Tool "${tool.id}" result record`,
    );
    tool.resultDigest = mergeIdentityField(
      tool.resultDigest,
      update.resultDigest,
      `Tool "${tool.id}" result digest`,
    );
    // Compared by value, like ask guidance: a step's image list is set once, by whichever
    // choke point recorded the result, so a second and different value is the same defect
    // the result record guards against (RFC-0021).
    tool.resultImages = mergeValueField(
      tool.resultImages,
      update.resultImages,
      `Tool "${tool.id}" result images`,
    );
    tool.isError = mergeScalarField(
      tool.isError,
      update.isError,
      `Tool "${tool.id}" error flag`,
    );
    tool.errorContent = mergeIdentityField(
      tool.errorContent,
      update.errorContent,
      `Tool "${tool.id}" error content`,
    );
    tool.actionRef = mergeIdentityField(
      tool.actionRef,
      update.actionRef,
      `Tool "${tool.id}" action reference`,
    );
    tool.askGuidance = mergeValueField(
      tool.askGuidance,
      update.askGuidance,
      `Tool "${tool.id}" ask guidance`,
    );
    tool.askStatus = mergeScalarField(
      tool.askStatus,
      update.askStatus,
      `Tool "${tool.id}" ask status`,
    );
    tool.round = mergeScalarField(
      tool.round,
      update.round,
      `Tool "${tool.id}" round`,
    );
  }

  private mergeLifecycleUpdates(
    current: AssistantToolLifecycleUpdate,
    update: AssistantToolLifecycleUpdate,
  ): AssistantToolLifecycleUpdate {
    const merged: AssistantToolLifecycleUpdate = cloneValue(current);
    if (update.state !== undefined) {
      merged.state =
        current.state === undefined
          ? update.state
          : mergeLifecycleState(current.state, update.state);
    }
    mergeUpdateField(merged, update, "toolName");
    mergeUpdateField(merged, update, "toolInput");
    mergeUpdateField(merged, update, "resultRecord");
    mergeUpdateField(merged, update, "resultDigest");
    mergeUpdateField(merged, update, "resultImages");
    mergeUpdateField(merged, update, "isError");
    mergeUpdateField(merged, update, "errorContent");
    mergeUpdateField(merged, update, "actionRef");
    mergeUpdateField(merged, update, "askGuidance");
    mergeUpdateField(merged, update, "askStatus");
    mergeUpdateField(merged, update, "round");
    return merged;
  }

  private checkRepeatedDelta(
    events: Map<string, RecordedDelta>,
    deltaKey: string | undefined,
    delta: string,
    label: string,
  ): string | null {
    if (deltaKey === undefined) return null;
    assertNonEmpty(deltaKey, "Delta key");
    const previous = events.get(deltaKey);
    if (!previous) return null;
    if (previous.delta !== delta) {
      throw new AssistantTurnBuilderError(
        `${label} delta key "${deltaKey}" was reused with different bytes.`,
      );
    }
    return previous.target;
  }

  private recordDelta(
    events: Map<string, RecordedDelta>,
    deltaKey: string | undefined,
    target: string,
    delta: string,
  ): void {
    if (deltaKey !== undefined) events.set(deltaKey, { target, delta });
  }

  private groupCompletedBlocks(
    completed: CompletedAssistantSegment,
  ): ReconciledPart[] {
    const seenBlockIds = new Set<string>();
    const parts: ReconciledPart[] = [];
    let proseRun: ReconciledProseRun | null = null;

    for (const block of completed.blocks) {
      assertNonEmpty(block.providerBlockId, "Provider block ID");
      if (seenBlockIds.has(block.providerBlockId)) {
        throw new AssistantTurnBuilderError(
          `Completed segment repeats provider block "${block.providerBlockId}".`,
        );
      }
      seenBlockIds.add(block.providerBlockId);

      if (block.type === "prose") {
        if (!proseRun) {
          proseRun = { type: "prose", providerBlockIds: [], text: "" };
          parts.push(proseRun);
        }
        proseRun.providerBlockIds.push(block.providerBlockId);
        proseRun.text += block.text;
        continue;
      }

      assertNonEmpty(block.toolCallId, "Completed tool-call ID");
      assertNonEmpty(block.toolName, "Completed tool name");
      proseRun = null;
      parts.push(block);
    }

    return parts.filter((part) => part.type !== "prose" || part.text.length > 0);
  }

  private reconcileProseRun(
    segmentId: string,
    part: ReconciledProseRun,
  ): MutableProseItem {
    const existingItems = new Set<MutableProseItem>();
    for (const providerBlockId of part.providerBlockIds) {
      const blockKey = this.providerBlockKey(segmentId, providerBlockId);
      const item = this.itemForProviderBlock(blockKey);
      if (item?.type === "tool_call") {
        throw new AssistantTurnBuilderError(
          `Provider block "${providerBlockId}" changed from tool to prose.`,
        );
      }
      if (item) existingItems.add(item);
    }
    if (existingItems.size > 1) {
      throw new AssistantTurnBuilderError(
        "A completed prose run maps to more than one existing prose item.",
      );
    }

    const prose =
      existingItems.values().next().value ??
      this.createReconciledProseItem(segmentId);
    prose.text = part.text;
    for (const providerBlockId of part.providerBlockIds) {
      const blockKey = this.providerBlockKey(segmentId, providerBlockId);
      prose.providerBlockIds.add(blockKey);
      this.state.providerBlockItemIds.set(blockKey, prose.id);
    }
    return prose;
  }

  private createReconciledProseItem(segmentId: string): MutableProseItem {
    const prose: MutableProseItem = {
      type: "prose",
      id: this.nextDomainId("item"),
      segmentId,
      text: "",
      providerBlockIds: new Set<string>(),
      captureEvidence: this.newItemEvidence(),
    };
    this.state.itemById.set(prose.id, prose);
    return prose;
  }

  private reconcileToolBlock(
    segmentId: string,
    segment: MutableSegment,
    block: CompletedAssistantToolCallBlock,
  ): MutableToolCallItem {
    const blockKey = this.providerBlockKey(segmentId, block.providerBlockId);
    const byBlock = this.itemForProviderBlock(blockKey);
    if (byBlock?.type === "prose") {
      throw new AssistantTurnBuilderError(
        `Provider block "${block.providerBlockId}" changed from prose to tool.`,
      );
    }
    const byCall = this.state.toolByCallId.get(block.toolCallId);
    if (byBlock && byCall && byBlock !== byCall) {
      throw new AssistantTurnBuilderError(
        `Completed tool "${block.toolCallId}" conflicts with provider block identity.`,
      );
    }

    const tool =
      byBlock ??
      byCall ??
      this.createReconciledToolItem(segmentId, segment, block);
    this.bindProviderBlock(tool, block.providerBlockId);
    if (tool.toolCallId === undefined) {
      this.bindToolCallId(tool.declarationKey, block.toolCallId, "provider_id");
    } else if (tool.toolCallId !== block.toolCallId) {
      throw new AssistantTurnBuilderError(
        `Tool item "${tool.id}" is already bound to "${tool.toolCallId}".`,
      );
    }
    tool.toolName = block.toolName;
    tool.toolArguments = block.toolArguments;
    this.refreshParsedToolArguments(tool);
    return tool;
  }

  private createReconciledToolItem(
    segmentId: string,
    segment: MutableSegment,
    block: CompletedAssistantToolCallBlock,
  ): MutableToolCallItem {
    const declarationKey = `completed:${segmentId}:${block.providerBlockId}`;
    if (this.state.declarationByKey.has(declarationKey)) {
      throw new AssistantTurnBuilderError(
        `Completed declaration key "${declarationKey}" is already in use.`,
      );
    }
    const itemId =
      this.state.toolItemReservationByCallId.get(block.toolCallId) ??
      this.nextDomainId("item");
    const tool: MutableToolCallItem = {
      type: "tool_call",
      id: itemId,
      segmentId,
      toolName: block.toolName,
      toolArguments: block.toolArguments,
      state: "declared",
      declarationKey,
      declarationIndex: segment.toolCount,
      captureEvidence: this.newItemEvidence(),
    };
    segment.toolCount += 1;
    this.state.itemById.set(itemId, tool);
    this.state.declarationByKey.set(declarationKey, tool);
    this.bindToolCallId(declarationKey, block.toolCallId, "provider_id");
    return tool;
  }

  private assertNoToolDeclarationWasOmitted(
    segmentId: string,
    reconciledItems: MutableItem[],
  ): void {
    const retained = new Set(reconciledItems.map((item) => item.id));
    const omitted = this.state.items.find(
      (item) =>
        item.segmentId === segmentId &&
        item.type === "tool_call" &&
        !retained.has(item.id),
    );
    if (omitted?.type === "tool_call") {
      throw new AssistantTurnBuilderError(
        `Completed segment omitted declaration "${omitted.declarationKey}".`,
      );
    }
  }

  private replaceSegmentItems(
    segmentId: string,
    reconciledItems: MutableItem[],
  ): void {
    const segmentIndex = this.state.segments.findIndex((segment) => segment.id === segmentId);
    let insertionIndex = this.state.items.length;
    for (let index = 0; index < this.state.items.length; index += 1) {
      const itemSegmentIndex = this.state.segments.findIndex(
        (segment) => segment.id === this.state.items[index].segmentId,
      );
      if (itemSegmentIndex >= segmentIndex) {
        insertionIndex = index;
        break;
      }
    }

    const previousItems = this.state.items.filter((item) => item.segmentId === segmentId);
    for (const item of previousItems) {
      if (
        item.type === "prose" &&
        !reconciledItems.some((reconciled) => reconciled.id === item.id)
      ) {
        this.state.itemById.delete(item.id);
        for (const blockKey of item.providerBlockIds) {
          if (this.state.providerBlockItemIds.get(blockKey) === item.id) {
            this.state.providerBlockItemIds.delete(blockKey);
          }
        }
      }
    }

    const withoutSegment = this.state.items.filter((item) => item.segmentId !== segmentId);
    const priorCount = this.state.items
      .slice(0, insertionIndex)
      .filter((item) => item.segmentId !== segmentId).length;
    withoutSegment.splice(priorCount, 0, ...reconciledItems);
    this.state.items.splice(0, this.state.items.length, ...withoutSegment);
  }

  /**
   * Version 2 is what the capture path writes now (ADR-0031): every item
   * carries the evidence of how it was placed, so a consumer never has to infer
   * an ordering claim from a list position. Load-time migration is the only other
   * writer of version 2 and stays as it is.
   */
  private buildSnapshot(
    status: AssistantTurnStatus,
    state: AssistantTurnBuilderState,
  ): AssistantTurnSnapshot {
    return {
      schemaVersion: 2,
      id: this.turnId,
      status,
      segments: state.segments.map((segment) => ({
        id: segment.id,
        ...(segment.providerMessageId === undefined
          ? {}
          : { providerMessageId: segment.providerMessageId }),
        ...(segment.replayCapsule === undefined
          ? {}
          : { replayCapsule: cloneValue(segment.replayCapsule) }),
      })),
      items: state.items.map((item) => this.snapshotItem(item)),
      ...(state.captureDiagnostics.length === 0
        ? {}
        : { captureDiagnostics: cloneValue(state.captureDiagnostics) }),
    };
  }

  private snapshotItem(item: MutableItem): AssistantTurnSnapshotItem {
    if (item.type === "prose") {
      return {
        type: "prose",
        id: item.id,
        segmentId: item.segmentId,
        ...(item.sourceItemId === undefined
          ? {}
          : { sourceItemId: item.sourceItemId }),
        text: item.text,
        ...(item.actionRef === undefined ? {} : { actionRef: item.actionRef }),
        ...(item.actionAnchor === undefined
          ? {}
          : { actionAnchor: item.actionAnchor }),
        captureEvidence: cloneValue(item.captureEvidence),
      };
    }
    return {
      type: "tool_call",
      id: item.id,
      segmentId: item.segmentId,
      ...(item.sourceItemId === undefined
        ? {}
        : { sourceItemId: item.sourceItemId }),
      ...(item.toolCallId === undefined
        ? {}
        : { toolCallId: item.toolCallId }),
      toolName: item.toolName,
      toolArguments: item.toolArguments,
      ...(item.toolArgs === undefined
        ? {}
        : { toolArgs: cloneValue(item.toolArgs) }),
      ...(item.toolInput === undefined ? {} : { toolInput: item.toolInput }),
      state: item.state,
      ...(item.resultRecord === undefined
        ? {}
        : { resultRecord: item.resultRecord }),
      ...(item.resultDigest === undefined
        ? {}
        : { resultDigest: item.resultDigest }),
      ...(item.resultImages === undefined
        ? {}
        : { resultImages: cloneValue(item.resultImages) }),
      ...(item.isError === undefined ? {} : { isError: item.isError }),
      ...(item.errorContent === undefined
        ? {}
        : { errorContent: item.errorContent }),
      ...(item.actionRef === undefined ? {} : { actionRef: item.actionRef }),
      ...(item.askGuidance === undefined
        ? {}
        : { askGuidance: cloneValue(item.askGuidance) }),
      ...(item.askStatus === undefined ? {} : { askStatus: item.askStatus }),
      ...(item.round === undefined ? {} : { round: item.round }),
      captureEvidence: cloneValue(item.captureEvidence),
    };
  }
}

/**
 * A deep copy whose internal sharing survives.
 *
 * The index maps hold the same objects the item array does, and `structuredClone`
 * keeps that identity within one call, so the draft is a coherent graph rather
 * than a set of indexes still pointing at the published state.
 */
function cloneBuilderState(
  state: AssistantTurnBuilderState,
): AssistantTurnBuilderState {
  return structuredClone(state);
}

/**
 * Names a builder rejection as the capture conflict it is.
 *
 * The builder speaks in declaration keys and item IDs; the capture path needs the
 * batch that was refused and a bounded reason. Anything that is not an identity
 * rejection propagates untouched, because inventing a conflict kind for an
 * unknown failure would hide it.
 */
function asCaptureConflict(error: unknown, batch: AssistantCaptureBatch): unknown {
  if (!(error instanceof AssistantTurnBuilderError)) return error;
  const toolCallId = error.message.match(/Tool-call ID "([^"]+)"/)?.[1];
  return new CaptureConflictError("intra_batch", error.message, {
    batchId: batch.batchId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  });
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new AssistantTurnBuilderError(`${label} must be a non-empty string.`);
  }
}

function validatedText(value: string, label: string): string {
  assertNonEmpty(value, label);
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function mergeIdentityField(
  current: string | undefined,
  incoming: string | undefined,
  label: string,
): string | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && current !== incoming) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return incoming;
}

function mergeScalarField<T>(
  current: T | undefined,
  incoming: T | undefined,
  label: string,
): T | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && current !== incoming) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return incoming;
}

function mergeValueField<T>(
  current: T | undefined,
  incoming: T | undefined,
  label: string,
): T | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && !valuesEqual(current, incoming)) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return cloneValue(incoming);
}

function mergeLifecycleState(
  current: AssistantToolLifecycleState,
  incoming: AssistantToolLifecycleState,
): AssistantToolLifecycleState {
  if (current === incoming) return current;
  const allowed: Record<AssistantToolLifecycleState, AssistantToolLifecycleState[]> = {
    declared: ["running", "completed", "interrupted", "failed"],
    running: ["completed", "interrupted", "failed"],
    completed: [],
    interrupted: [],
    failed: [],
  };
  if (!allowed[current].includes(incoming)) {
    throw new AssistantTurnBuilderError(
      `Tool lifecycle cannot move from "${current}" to "${incoming}".`,
    );
  }
  return incoming;
}

function mergeUpdateField<Key extends keyof AssistantToolLifecycleUpdate>(
  target: AssistantToolLifecycleUpdate,
  incoming: AssistantToolLifecycleUpdate,
  key: Key,
): void {
  const next = incoming[key];
  if (next === undefined) return;
  const current = target[key];
  if (current !== undefined && !valuesEqual(current, next)) {
    throw new AssistantTurnBuilderError(
      `Buffered lifecycle field "${key}" cannot be changed.`,
    );
  }
  Object.assign(target, { [key]: cloneValue(next) });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function freezeClone<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
