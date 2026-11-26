import { type App, normalizePath } from "obsidian";
import type { ErrorKind, ToolCall, ToolResult, VaultOpReviewer } from "../../tools/types";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { diskState, diskFingerprint } from "../../vault-ops/apply";
import { applyVaultOpBatch } from "../../vault-ops/applyBatch";
import { resolveEditGate, targetPaths, type VaultOpPolicy } from "../../vault-ops/gateway";
import type { ApprovalPosture, Memory } from "../../shared/types";
import { escapesVault, outsideVaultMessage } from "../../vault-ops/pathSafety";
import {
  preReadTrashSnapshots,
  preScanReplacements,
  gateConvertedOp,
  buildReviewableOp,
} from "../../vault-ops/proposalSupport";
import {
  dispositionMessage,
  editDispositionMessage,
  type EditOpKind,
  type VaultOpDisposition,
} from "../../vault-ops/disposition";
import { toVaultOperations, type ConversionProbes } from "../../tools/vault-ops/conversion";
import { buildPendingOverlay } from "../../tools/vault-ops/handlers";
import { makeResolver } from "../../tools/vault-ops/overlay";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
import type {
  AppliedEditRecord,
  DiffHunk,
  EditBlock,
  EditProposal,
  EditStatus,
  MatchType,
} from "../../editing/editTypes";
import { resolveEdits } from "../../editing/diffEngine";
import { EditReviewController } from "../../editing/EditReviewController";
import type { InlineDiffManager } from "../../editing/inlineDiff/InlineDiffManager";
import { EditReviewTimelineView } from "../messages/editReviewTimeline";
import { convertToolCallToEditBlock } from "../../tools/editing/conversion";
import { NO_OP_EDIT_FAILURE } from "../../tools/editing/validation";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { defaultRecovery, trimDot } from "../../tools/toolFailure";
import { toolFailure } from "../../tools/toolFailure";
import {
  applyApprovedMemoryMutation,
  prepareMemoryMutation,
  type MemoryMutation,
  type MemoryToolContext,
} from "../../tools/memory/handlers";
import { resolveMemoryGate } from "../../tools/memory/definition";
import { memoryDispositionMessage } from "../../tools/memory/disposition";
import {
  MemoryReviewTimelineView,
  type ReviewableMemoryProposal,
} from "../messages/memoryReviewTimeline";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequester,
} from "../interactions/approvalTypes";
import {
  editApprovalRequest,
  memoryApprovalRequest,
  vaultOpApprovalRequest,
} from "../interactions/approvalRequests";
import { generateId } from "../../utils";

/** A converted op classified by how it must resolve. */
type Entry =
  | { call: ToolCall; kind: "error"; result: ToolResult }
  | { call: ToolCall; kind: "satisfied"; reviewable: ReviewableVaultOp }
  | { call: ToolCall; kind: "auto"; reviewable: ReviewableVaultOp }
  | { call: ToolCall; kind: "ask"; reviewable: ReviewableVaultOp };

/**
 * How a parked decision settled. `guidance` is the user's free text from a drawer
 * decline, carried to the disposition builder as a distinct trailing sentence
 * (RFC-0012); it is meaningless on any other disposition.
 */
interface ParkedOutcome {
  disposition: VaultOpDisposition;
  reason?: string;
  guidance?: string;
}

/** A parked ask op: its promise resolves when the user (or a cancel) decides. */
interface PendingResolution {
  resolve: (outcome: ParkedOutcome) => void;
  promise: Promise<ParkedOutcome>;
}

function memoryBeforeMutation(
  mutation: MemoryMutation,
  memories: Memory[],
): Memory | null {
  if (mutation.kind === "add") {
    return (
      memories.find((memory) => memory.name === mutation.memory.name) ??
      null
    );
  }
  return (
    memories.find((memory) => memory.name === mutation.name) ??
    null
  );
}

function memoryAfterMutation(
  mutation: MemoryMutation,
): Memory | null {
  return mutation.kind === "add"
    ? structuredClone(mutation.memory)
    : null;
}

interface PendingMemoryResolution {
  resolve: (result: ToolResult) => void;
  promise: Promise<ToolResult>;
}

/**
 * Dependencies for the edit channel, present only in edit mode. Edits are vault
 * ops too; their apply path is the {@link EditReviewController} and their review now
 * folds into the agentic timeline via {@link EditReviewTimelineView} (like vault ops),
 * with the in-note overlay as a second view over the same controller, so the
 * coordinator needs only the overlay manager and the resolver tuning.
 */
export interface LiveEditReviewDeps {
  /** The shared overlay manager, the second renderer over the same controller. */
  inlineDiff: InlineDiffManager;
  /** Resolver tuning from settings (context lines, min confidence). */
  resolveOptions: { contextLines: number; minConfidence: number };
}

export interface LiveVaultReviewOptions {
  app: App;
  /** The streaming bubble's timeline element, where the review decorates steps. */
  timelineEl: HTMLElement;
  /** Resolve a review host from one exact provider or plugin tool-call ID. */
  findActionHostByToolCallId?: (toolCallId: string) => HTMLElement | null;
  /** Message-local host used while an exact declaration has not arrived yet. */
  getProvisionalActionHost?: () => HTMLElement;
  /** Recompute provisional and audit section visibility after a live remount. */
  onReviewPlacementChanged?: () => void;
  policy: VaultOpPolicy;
  /** Session approval posture; `auto` overrules the per-class policy to auto-apply. */
  posture: ApprovalPosture;
  /** Edit-channel dependencies. Absent when no writes are permitted (read-only). */
  edit?: LiveEditReviewDeps;
  /** Dedicated memory mutation dependencies, absent while the feature is off. */
  memory?: MemoryToolContext;
  /**
   * Flip the session to auto-apply. Reached from "Approve everything this session" on
   * every channel, not just edits, which is why it sits here rather than under
   * {@link LiveEditReviewDeps}.
   */
  onEnterAutoApply?: () => void;
  /**
   * The generation's approval lane in the composer drawer (RFC-0012). Absent only for a
   * review constructed without a composer; a parked decision then stays parked, exactly
   * as it did before the drawer existed.
   */
  approvals?: ApprovalRequester;
}

/**
 * In-loop vault-op review coordinator (in-loop-tool-approval-blocking-flow).
 *
 * Owns one growing {@link VaultOperationProposal}, mounts {@link VaultReviewTimelineView}
 * live on the streaming bubble, applies `auto` ops immediately, and, for `ask`
 * ops, hands the tool loop a promise that resolves only when the user approves or
 * declines. The model is thus blocked at the `ask`-gated tool turn and receives the
 * *real* disposition as that call's tool result.
 *
 * One resolved state, two consumers: the timeline mutates each op's
 * {@link VaultOpStatus} (UI truth) and reports the terminal decision via
 * `onOpResolved`; this coordinator turns that into the tool result. The tool result
 * can never assert an outcome the timeline doesn't already hold.
 *
 * Shared by both executors: the plugin tool loop calls {@link resolveRound} once per
 * round; the Claude Code MCP path calls {@link resolveOne} per tool call.
 */
export class LiveVaultReview implements VaultOpReviewer {
  private readonly app: App;
  private readonly timelineEl: HTMLElement;
  private readonly findActionHostByToolCallId?: (
    toolCallId: string,
  ) => HTMLElement | null;
  private readonly getProvisionalActionHost?: () => HTMLElement;
  private readonly onReviewPlacementChanged?: () => void;
  private readonly policy: VaultOpPolicy;
  /**
   * Session approval posture. Mutable, unlike the value captured at construction: D1 of
   * the RFC-0012 plan makes "Approve everything this session" take effect inside the
   * current turn, so a later round of the same turn gates on the new posture rather than
   * the one the turn started with.
   */
  private posture: ApprovalPosture;
  private readonly onEnterAutoApply?: () => void;
  private readonly approvals?: ApprovalRequester;

  private readonly proposal: VaultOperationProposal;
  private appliedRecord: AppliedVaultOpRecord | null = null;
  /** All vault-op calls seen so far, the intent overlay later rounds resolve against. */
  private readonly accumulatedCalls: ToolCall[] = [];
  /** Per-turn count of ops resolved to `auto` (feeds the gateway circuit breaker). */
  private autoSoFar = 0;
  /**
   * opId / hunkId → its parked resolution, for `ask` ops/edits awaiting a click.
   * Shared by both channels: file ops resolve via the timeline, edits via the
   * controller subscription. Keys are all `generateId()`, so they never collide.
   */
  private readonly pending = new Map<string, PendingResolution>();
  /**
   * Guidance from a drawer decline, held from the decision until the resolution that
   * consumes it. The edit channel needs this: it settles through the controller's
   * subscription (the in-note overlay is a second renderer over the same controller), so
   * the guidance cannot ride the call that triggers the rejection. Keyed by hunk id.
   */
  private readonly declineGuidance = new Map<string, string>();
  /** Serializes registration/auto-apply so concurrent calls can't race the overlay. */
  private lock: Promise<void> = Promise.resolve();

  // --- Edit channel state (in-document edits; see resolveEdits). -----------
  private readonly editDeps?: LiveEditReviewDeps;
  /**
   * One {@link EditReviewController} per edited file, keyed by vault path (ADR-0010:
   * a turn may edit N files). Each file stays a self-contained single-file proposal;
   * this map is the turn's growing collection, so a later round targeting a different
   * file adds a controller instead of being rejected. Its proposal lives on
   * `controller.proposal`.
   */
  private readonly editControllers = new Map<string, EditReviewController>();
  /** Applied-edit record per edited file, keyed by the same vault path. */
  private readonly editAppliedRecords = new Map<string, AppliedEditRecord>();
  /**
   * Monotonic counter of edit rounds, stamped onto every hunk a round creates. Each
   * round re-reads its target files (the per-round docCache), so hunks from different
   * rounds are anchored to different document baselines; the controller's overlap
   * guard only compares hunks with equal stamps (ADR-0013). Without the stamp, a
   * second edit to an already-edited paragraph false-flags as overlapping the applied
   * hunk (whose offsets are in the previous baseline's coordinate space) and is
   * refused, the double-edit bug.
   */
  private editBaselineEpoch = 0;
  /** The one live timeline review, re-rendered (destroy + recreate) per round over every controller. */
  private editTimelineView: EditReviewTimelineView | null = null;
  private readonly memoryDeps?: MemoryToolContext;
  private readonly memoryProposals: ReviewableMemoryProposal[] = [];
  private readonly pendingMemories = new Map<string, PendingMemoryResolution>();

  constructor(opts: LiveVaultReviewOptions) {
    this.app = opts.app;
    this.timelineEl = opts.timelineEl;
    this.findActionHostByToolCallId = opts.findActionHostByToolCallId;
    this.getProvisionalActionHost = opts.getProvisionalActionHost;
    this.onReviewPlacementChanged = opts.onReviewPlacementChanged;
    this.policy = opts.policy;
    this.posture = opts.posture;
    this.editDeps = opts.edit;
    this.memoryDeps = opts.memory;
    this.onEnterAutoApply = opts.onEnterAutoApply;
    this.approvals = opts.approvals;
    this.proposal = { id: generateId(), ops: [], createdAt: Date.now() };
  }

  /** Resolve a round of vault-op calls (plugin loop). Blocks until every `ask` op decides. */
  async resolveRound(
    calls: ToolCall[],
    stoppedForMaxTokens = false,
  ): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    if (calls.length === 0) return [];

    const results = new Map<string, ToolResult>();

    // Registration + auto-apply run under the lock so the overlay, autoSoFar, and
    // the applied record stay consistent across concurrent callers. Parking on the
    // `ask` promises happens *outside* the lock so a held op never blocks the next
    // round's registration.
    const askEntries = await this.runExclusive(async () => {
      const entries = await this.register(calls, stoppedForMaxTokens);
      this.remount();

      for (const e of entries) {
        if (e.kind === "error") results.set(e.call.id, e.result);
        else if (e.kind === "satisfied") {
          results.set(e.call.id, dispoResult(e.reviewable.op, "satisfied"));
        }
      }

      const autoEntries = entries.filter((e): e is Extract<Entry, { kind: "auto" }> => e.kind === "auto");
      if (autoEntries.length > 0) {
        await this.applyAuto(autoEntries, results);
        this.remount();
      }

      return entries.filter((e): e is Extract<Entry, { kind: "ask" }> => e.kind === "ask");
    });

    // Resolve `ask` ops **serially**, in proposal order
    // (ask-ops-resolve-as-batch-not-sequential): the user decides one before the
    // next is offered (the timeline mounts `serial`), and a decline propagates to
    // dependent ops via {@link handleResolved} → {@link propagateDeclines}, failing
    // them with a reason naming the declined prerequisite. Parked references are
    // captured up front so an op failed by propagation (which clears it from
    // `pending`) is still collected here.
    const parkedEntries = askEntries.map((e) => ({ e, parked: this.pending.get(e.reviewable.id) }));
    for (const { e, parked } of parkedEntries) {
      if (!parked) continue;
      const { disposition, reason, guidance } = await parked.promise;
      results.set(e.call.id, dispoResult(e.reviewable.op, disposition, reason, guidance));
    }

    return calls.map((c) => ({ tc: c, result: results.get(c.id) ?? cancelledFallback(c) }));
  }

  /** Resolve a single vault-op call (Claude Code MCP path). */
  async resolveOne(call: ToolCall, toolCallId: string): Promise<ToolResult> {
    // Use toolCallId as the op's source id so the review binds to the same timeline
    // step the MCP tool-lifecycle events tag with `data-tool-call-id`.
    const [resolved] = await this.resolveRound([{ ...call, id: toolCallId }]);
    return resolved.result;
  }

  /**
   * Resolve a single edit call (Claude Code MCP path). The edit-channel sibling of
   * {@link resolveOne}: blocks on the user's accept/reject and returns the real
   * disposition, so Claude Code edits review in-loop just like the plugin loop.
   */
  async resolveEditOne(call: ToolCall, toolCallId: string): Promise<ToolResult> {
    const [resolved] = await this.resolveEdits([{ ...call, id: toolCallId }]);
    return resolved.result;
  }

  /** Resolve one Claude Code memory mutation on the same review channel. */
  async resolveMemoryOne(
    call: ToolCall,
    toolCallId: string,
  ): Promise<ToolResult> {
    const [resolved] = await this.resolveMemories([
      { ...call, id: toolCallId },
    ]);
    return resolved.result;
  }

  /**
   * Resolve memory proposals sequentially, gated by the session posture and then
   * `policy.memory`, the same order every write class follows.
   */
  async resolveMemories(
    calls: ToolCall[],
  ): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    const results: Array<{ tc: ToolCall; result: ToolResult }> = [];
    for (const call of calls) {
      results.push({ tc: call, result: await this.resolveMemoryCall(call) });
    }
    return results;
  }

  /**
   * Resolve a round of edit calls (`edit` / `update_frontmatter`). Each
   * call is resolved in-loop with the real three-tier {@link resolveEdits} (not a
   * cheap exact pre-flight), gated by the `edit` policy, and blocks on the user
   * when `ask`, returning the *real* disposition as that call's tool result. A
   * no-match is reported honestly as `failed`, never a silent drop.
   */
  async resolveEdits(calls: ToolCall[]): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    if (calls.length === 0) return [];
    const deps = this.editDeps;
    if (!deps) {
      return calls.map((tc) => ({
        tc,
        result: editError(
          tc,
          "edit review context unavailable",
          "unavailable",
          "retry the edit in a new message",
        ),
      }));
    }

    const results = new Map<string, ToolResult>();
    type Parked = {
      callId: string;
      hunkId: string;
      kind: EditOpKind;
      path: string;
      matchType: MatchType;
      /** > 1 when the search was non-unique; surfaced to the model on apply (symptom C). */
      occurrenceCount?: number;
    };

    // Registration + auto-apply run under the shared lock so the per-turn auto
    // budget and the controller stay consistent with the file-op channel; parking
    // on `ask` edits happens outside so a held edit never blocks the next round.
    const toPark = await this.runExclusive(async () => {
      const docCache = new Map<string, string>();
      // One baseline per round: every hunk below is resolved against this docCache's
      // reads, so they share a coordinate space with each other and with nothing from
      // earlier or later rounds (ADR-0013).
      const baselineEpoch = ++this.editBaselineEpoch;
      const autoApplied: Parked[] = [];
      const parked: Parked[] = [];

      for (const call of calls) {
        const kind = editKind(call.name);
        const block = convertToolCallToEditBlock(call);
        if (!block) {
          results.set(call.id, editError(call, "could not parse edit arguments"));
          continue;
        }

        // An `edit` with empty search text would otherwise resolve as a bogus
        // exact match (indexOf("") === 0) and silently insert at the top of the file.
        // Frontmatter blocks legitimately carry empty search (insert-at-top), so guard
        // only the prose edit channel, mirroring the legacy executeEdit check.
        if (kind === "edit" && block.searchText === "") {
          results.set(
            call.id,
            editError(call, "search text is empty", "invalid-args", "pass the exact text you want to replace"),
          );
          continue;
        }

        if (kind === "edit" && block.searchText === block.replaceText) {
          results.set(
            call.id,
            editError(call, NO_OP_EDIT_FAILURE.what, "invalid-args", NO_OP_EDIT_FAILURE.recovery),
          );
          continue;
        }

        // The model names its target via the required `path` arg (no active-doc
        // fallback), so an edit lands on the file it read, not whatever pane is open.
        if (!block.targetPath) {
          results.set(
            call.id,
            editError(
              call,
              "missing required 'path'",
              "invalid-args",
              "pass the vault-relative path of the note to edit",
            ),
          );
          continue;
        }
        const file = this.app.vault.getFileByPath(normalizePath(block.targetPath));
        if (!file) {
          results.set(
            call.id,
            editError(
              call,
              `file not found at "${block.targetPath}"`,
              "not-found",
              "check the path, or use write_file to create it",
            ),
          );
          continue;
        }

        // A turn may edit N files (ADR-0010): each distinct path gets its own
        // controller (ensureEditController), so a second file is accumulated, never
        // rejected. The one-mutation-per-round cap still serializes edits one file per
        // round; multi-file is the accumulation of those across rounds.

        let docText = docCache.get(file.path);
        if (docText === undefined) {
          docText = await this.app.vault.read(file);
          docCache.set(file.path, docText);
        }

        const resolvedBlock = await this.resolveStructural(block, file.path);
        const [resolved] = resolveEdits([resolvedBlock], docText, deps.resolveOptions);
        if (!resolved || resolved.matchType === "none") {
          // Honest no-match, the model self-corrects on this result. `nearMiss` steers
          // the recovery: a close-but-rejected window is a wording difference (spacing
          // is already handled by the whitespace tier upstream), so nudge "re-read and
          // copy exactly"; otherwise the text is simply absent, so nudge "re-read".
          const recovery = resolved?.nearMiss
            ? "the closest text was close but not identical, re-read that passage and copy the exact wording, then retry"
            : "no location matched the search text; re-read the file and retry";
          results.set(call.id, {
            content: editDispositionMessage(kind, file.path, "failed", recovery, "none"),
            isReadOnly: false,
            isError: true,
            failure: { kind: "no-match", recovery },
          });
          continue;
        }

        const gate = resolveEditGate(this.policy, file.path, this.autoSoFar, this.posture);
        if (gate === "deny") {
          results.set(call.id, editError(call, "edits are denied by the current policy", "denied"));
          continue;
        }

        // A non-unique anchor on the autonomous path is refused, not silently applied to
        // one of several identical passages. Mirrors Anthropic's text-editor contract (a
        // str_replace matching more than one location returns an error asking for more
        // context) and the no-match recovery just above. Gated on `auto`: an ask-gated edit
        // stays reviewable (the human is the disambiguator, and the diff card shows the
        // "1 of N" badge), so only the no-human path blocks. The count is the symptom-C
        // signal resolveEdits already computes (diff-engine-real-document-robustness).
        if (gate === "auto" && resolved.occurrenceCount !== undefined) {
          const recovery =
            `the search text matched ${resolved.occurrenceCount} places; include the surrounding ` +
            "lines so it identifies exactly one passage, then retry";
          results.set(call.id, {
            content: editDispositionMessage(kind, file.path, "failed", recovery),
            isReadOnly: false,
            isError: true,
            failure: { kind: "ambiguous", recovery },
          });
          continue;
        }

        if (gate !== "auto") {
          // Offer the decision *before* the hunk joins a controller, so a refused call
          // leaves no orphan diff card for a change nobody will ever be shown.
          this.park(call.id);
          const offered = this.requestApproval(
            editApprovalRequest({
              approvalId: call.id,
              toolCallId: call.id,
              kind,
              filePath: file.path,
              resolvedEdit: resolved,
            }),
            (decision) =>
              this.applyDecision(
                decision,
                () => this.approveEdit(file.path, call.id),
                (guidance) => this.declineEdit(file.path, call.id, guidance),
              ),
            () => this.pending.has(call.id),
          );
          if (!offered) {
            this.pending.delete(call.id);
            results.set(call.id, approvalLaneBusyFailure(call.name));
            continue;
          }
        }

        const controller = this.ensureEditController(file.path, docText);
        // One in-loop edit call produces one review hunk. Preserve the tool-call
        // identity so the review mounts on that exact declaration instead of the
        // provisional out-of-band action section.
        const hunk: DiffHunk = {
          id: call.id,
          resolvedEdit: resolved,
          status: "pending",
          baselineEpoch,
        };
        controller.proposal.hunks.push(hunk);

        const matchType = resolved.matchType;
        const occurrenceCount = resolved.occurrenceCount;
        if (gate === "auto") {
          this.autoSoFar++;
          autoApplied.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path, matchType, occurrenceCount });
        } else {
          parked.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path, matchType, occurrenceCount });
        }
      }

      if (this.editControllers.size > 0) this.renderEditPanel();

      for (const a of autoApplied) {
        // Accept through the controller that owns this file, so a multi-file turn
        // applies each hunk against its own file's snapshot (ADR-0010 isolation).
        const controller = this.editControllers.get(a.path);
        await controller?.accept(a.hunkId);
        const applied = controller?.getStatus(a.hunkId) === "accepted";
        const disposition: VaultOpDisposition = applied ? "auto-applied" : "failed";
        const reason = applied ? undefined : "the edit could not be applied to the document";
        results.set(a.callId, {
          content: editDispositionMessage(
            a.kind,
            a.path,
            disposition,
            reason,
            a.matchType,
            a.occurrenceCount,
          ),
          isReadOnly: false,
          isError: !applied,
          failure: applied ? undefined : { kind: "failed", recovery: reason },
          // Auto-applied or failed edit outcome, captured for replay (ADR-0016).
          disposition,
        });
      }
      if (autoApplied.length > 0) this.renderEditPanel();

      return parked;
    });

    await Promise.all(
      toPark.map(async (p) => {
        const pending = this.pending.get(p.hunkId);
        if (!pending) {
          results.set(p.callId, editCancelled(p.kind, p.path));
          return;
        }
        const { disposition, reason, guidance } = await pending.promise;
        results.set(p.callId, {
          content: editDispositionMessage(
            p.kind,
            p.path,
            disposition,
            reason,
            p.matchType,
            p.occurrenceCount,
            guidance,
          ),
          isReadOnly: false,
          isError: disposition === "failed",
          failure: disposition === "failed" ? { kind: "failed", recovery: reason } : undefined,
          // The edit-channel sibling of dispoResult's disposition capture (ADR-0016).
          disposition,
        });
      }),
    );

    return calls.map((tc) => ({
      tc,
      result: results.get(tc.id) ?? editCancelled(editKind(tc.name), pathArg(tc)),
    }));
  }

  getProposal(): VaultOperationProposal | null {
    return this.proposal.ops.length > 0 ? this.proposal : null;
  }

  getAppliedRecord(): AppliedVaultOpRecord | null {
    return this.appliedRecord;
  }

  /** Every edited file's proposal that produced at least one hunk (ADR-0010). */
  getEditProposals(): EditProposal[] {
    return [...this.editControllers.values()]
      .map((c) => c.proposal)
      .filter((p) => p.hunks.length > 0);
  }

  /** Every edited file's applied-edit record (auto + accepted hunks). */
  getEditAppliedRecords(): AppliedEditRecord[] {
    return [...this.editAppliedRecords.values()];
  }

  /** Detached memory review evidence for canonical action-ledger finalization. */
  getMemoryProposals(): ReviewableMemoryProposal[] {
    return structuredClone(this.memoryProposals);
  }

  /**
   * Drop the in-loop edit timeline view's controller subscription before
   * finalization mounts the durable one. The proposal/record live on; finalization's
   * fresh view cleans the loop-time step decorations, so nothing doubles up.
   */
  detachEditPanel(): void {
    this.editTimelineView?.destroy();
    this.editTimelineView = null;
  }

  /**
   * Hand every decorated step over to the durable ledger view.
   *
   * Loop-time controls go because the ledger renders the decisions that are still
   * open, and loop-time evidence goes because the ledger renders that too, from the
   * persisted payload
   * ({@link ../messages/ActionLedgerEvidenceView.ActionLedgerEvidenceView}). Both are
   * removed rather than left in place: they belong to the review objects this
   * generation owns, and leaving them would show each diff twice.
   */
  detachPanels(): void {
    this.detachEditPanel();
    this.timelineEl
      .querySelectorAll(
        ".lmsa-memory-step-controls, " +
          ".lmsa-memory-review-preview, " +
          ".lmsa-vault-review-footer, " +
          ".lmsa-vault-review-fallback, " +
          ".lmsa-vault-step-controls, " +
          ".lmsa-vault-timeline-preview, " +
          ".lmsa-edit-step-controls, " +
          ".lmsa-edit-timeline-hunk",
      )
      // The durable view renders the same cards from the same classes. Only the
      // loop's own decorations are swept, so a second finalization pass cannot
      // strip the record that the first one handed over.
      .forEach((element) => {
        if (element.closest(".lmsa-action-evidence")) return;
        element.remove();
      });
    this.timelineEl
      .querySelectorAll(".lmsa-assistant-turn-item")
      .forEach((element) => {
        element.classList.remove(
          "is-vault-awaiting",
          "is-vault-applied",
          "is-vault-failed",
          "is-vault-rejected",
          "is-vault-cancelled",
          "is-vault-satisfied",
          "is-edit-pending",
          "is-edit-applied",
          "is-edit-skipped",
          "is-edit-nomatch",
        );
      });
  }

  /**
   * Resolve every outstanding `ask` op as `cancelled` (abort / new user turn), so a
   * parked turn can't leak a hung await. Ops are left `pending` so the user can still
   * decide later via the finalized review surface, graceful fallback to async review.
   */
  cancelPending(): void {
    for (const [, parked] of this.pending) {
      parked.resolve({ disposition: "cancelled" });
    }
    this.pending.clear();
    this.declineGuidance.clear();

    const cancelledIds = new Set(this.pendingMemories.keys());
    for (const [proposalId, parked] of this.pendingMemories) {
      const proposal = this.memoryProposals.find(
        (candidate) => candidate.id === proposalId,
      );
      if (!proposal) continue;
      parked.resolve({
        content: memoryDispositionMessage(
          proposal.mutation,
          "cancelled",
        ),
        isReadOnly: false,
        disposition: "cancelled",
      });
    }
    this.pendingMemories.clear();
    for (let index = this.memoryProposals.length - 1; index >= 0; index--) {
      if (cancelledIds.has(this.memoryProposals[index].id)) {
        this.memoryProposals.splice(index, 1);
      }
    }
    this.remountMemories();
  }

  // --- Live approval (RFC-0012) ------------------------------------------

  /**
   * Offer one parked decision in the composer drawer. Returns `false` only when the
   * lane refused it, in which case the caller must unpark and refuse its own call with
   * {@link approvalLaneBusyFailure}; nothing was shown and nothing was written.
   *
   * With no coordinator wired, the decision simply stays parked, which is what happened
   * before the drawer existed.
   */
  private requestApproval(
    request: ApprovalRequest,
    decide: (decision: ApprovalDecision) => void,
    isLive: () => boolean,
  ): boolean {
    if (!this.approvals) return true;
    return this.approvals.request(request, decide, isLive);
  }

  /**
   * Perform one drawer decision on whichever channel raised it.
   *
   * `approve-session` performs the approval *first* and enters auto-apply after, so the
   * change the user was looking at is applied by the choice they made rather than by the
   * posture that choice installs. The posture flip is unconditional: a tool that then
   * failed does not undo the session decision the user made.
   */
  private applyDecision(
    decision: ApprovalDecision,
    approve: () => Promise<void>,
    decline: (guidance: string) => void,
  ): void {
    if (decision.kind === "decline") {
      decline(decision.guidance);
      return;
    }
    void (async () => {
      try {
        await approve();
      } catch (error) {
        console.error("[chat] An approved change could not be applied.", error);
      }
      if (decision.kind === "approve-session") this.enterAutoApply();
    })();
  }

  /**
   * Flip the session to auto-apply (D1). Our own posture moves first, so the next round
   * of *this* turn stops gating; the callback then moves the composer's posture pill to
   * match.
   *
   * The accepted cost: under `auto`, `resolveGate` returns `auto` unconditionally, so
   * from here to the end of the turn the per-class `deny`, the `scopes` restriction, and
   * the `maxAutoOps` circuit breaker are all overridden. The drawer's copy says so, and
   * the posture pill is reversible at any time.
   */
  private enterAutoApply(): void {
    this.posture = "auto";
    this.onEnterAutoApply?.();
  }

  /**
   * The vault channel's apply owner. This ran inside `VaultReviewTimelineView.applyOps`
   * until the decision moved to the drawer; it lives here now, so one owner serves both
   * surfaces and the view can be a record rather than an actor.
   */
  async approveOp(opId: string): Promise<void> {
    const op = this.decidableOp(opId);
    if (!op) return;

    const result = await this.applyOne(op);
    if (!result.ok) {
      // D2: a failed apply is terminal on the live surface. A decision the user made is
      // not undone by a tool that then failed, so it is reported as a failure (the same
      // shape `applyAuto` already produces) and the retry moves to the durable ledger,
      // where `foldEvent` already marks an `apply_failed` vault op retry-eligible.
      op.status = "failed";
      this.remount();
      this.settleParked(opId, { disposition: "failed", reason: result.reason });
      return;
    }

    op.status = "applied";
    // Merge before remounting: the fresh view reads `existingRecord` for the Undo footer
    // and for an overwrite preview's "before", so remounting first loses both.
    this.mergeRecord(result.applied);
    this.remount();
    this.handleResolved(opId, "applied");
  }

  /** The vault channel's decline owner, carrying the drawer's optional guidance. */
  declineOp(opId: string, guidance?: string): void {
    const op = this.decidableOp(opId);
    if (!op) return;
    op.status = "rejected";
    this.remount();
    this.handleResolved(opId, "declined", guidance);
  }

  /**
   * The op a decision may still act on, or null.
   *
   * On the timeline a settled op simply stops rendering its buttons, so the repaint
   * enforced this. The drawer is not repainted from proposal state, so the guard has to
   * be written down: without it a decision that beats another settlement path here
   * (decline propagation, cancellation, the in-note overlay) would write to disk again.
   */
  private decidableOp(opId: string): ReviewableVaultOp | null {
    const op = this.proposal.ops.find((candidate) => candidate.id === opId);
    if (!op) return null;
    return op.status === "pending" || op.status === "accepted" ? op : null;
  }

  /**
   * Apply one approved op through the batch orchestrator (ADR-0006), so its pre-flight,
   * ordering, and drift-guarded undo all still hold. A throw is folded into the same
   * failure shape a refused batch produces, so the model always reads an honest outcome
   * rather than the turn hanging on an unresolved promise.
   */
  private async applyOne(
    op: ReviewableVaultOp,
  ): Promise<
    | { ok: true; applied: Array<{ opId: string; inverse: VaultOperation }> }
    | { ok: false; reason: string }
  > {
    try {
      const result = await applyVaultOpBatch(this.app, [
        { id: op.id, op: op.op },
      ]);
      if (result.ok) return { ok: true, applied: result.applied };
      return {
        ok: false,
        reason: result.conflicts[0]?.reason ?? result.error ?? "operation failed",
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "operation failed",
      };
    }
  }

  /** The edit channel's approve owner; the controller that owns the file applies it. */
  private async approveEdit(filePath: string, hunkId: string): Promise<void> {
    if (!this.pending.has(hunkId)) return;
    await this.editControllers.get(filePath)?.accept(hunkId);
  }

  /**
   * The edit channel's decline owner. The guidance is parked alongside, because the
   * resolution arrives later through the controller's subscription.
   */
  private declineEdit(filePath: string, hunkId: string, guidance: string): void {
    if (!this.pending.has(hunkId)) return;
    if (guidance !== "") this.declineGuidance.set(hunkId, guidance);
    this.editControllers.get(filePath)?.reject(hunkId);
  }

  // -----------------------------------------------------------------------

  private async resolveMemoryCall(call: ToolCall): Promise<ToolResult> {
    const deps = this.memoryDeps;
    if (!deps) {
      return toolFailure({
        kind: "unavailable",
        what: "memory review context unavailable",
        recovery: "retry the memory proposal in a new message",
        isReadOnly: false,
      });
    }

    const prepared = prepareMemoryMutation(call, deps.getMemories());
    if (!prepared.ok) return prepared.result;
    const gate = resolveMemoryGate(this.policy, this.posture);
    if (gate === "deny") {
      return toolFailure({
        kind: "denied",
        what: `${call.name} is denied by the memory permission`,
        recovery: "do not retry it unless the user changes the memory permission",
        isReadOnly: false,
      });
    }

    const proposal: ReviewableMemoryProposal = {
      id: generateId(),
      sourceToolCallId: call.id,
      call,
      mutation: prepared.mutation,
      status: "pending",
    };

    if (gate === "auto") {
      this.memoryProposals.push(proposal);
      const before = memoryBeforeMutation(
        proposal.mutation,
        deps.getMemories(),
      );
      const result = await applyApprovedMemoryMutation(
        call,
        deps,
        "auto-applied",
      );
      proposal.status = result.isError ? "failed" : "applied";
      if (result.isError) proposal.error = result.content;
      else {
        proposal.effect = {
          before,
          after: memoryAfterMutation(proposal.mutation),
          appliedAt: Date.now(),
        };
      }
      this.remountMemories();
      return result;
    }

    // Raise the decision before the proposal joins the review, so a refused call leaves
    // no orphan row for a mutation that will never be offered.
    const parked = this.parkMemory(proposal.id);
    const offered = this.requestApproval(
      memoryApprovalRequest({
        approvalId: proposal.id,
        toolCallId: call.id,
        mutation: proposal.mutation,
      }),
      (decision) =>
        this.applyDecision(
          decision,
          () => this.approveMemory(proposal.id),
          (guidance) => this.declineMemory(proposal.id, guidance),
        ),
      () => this.pendingMemories.has(proposal.id),
    );
    if (!offered) {
      this.pendingMemories.delete(proposal.id);
      return approvalLaneBusyFailure(call.name);
    }

    this.memoryProposals.push(proposal);
    this.remountMemories();
    return parked.promise;
  }

  private parkMemory(proposalId: string): PendingMemoryResolution {
    let resolve!: PendingMemoryResolution["resolve"];
    const promise = new Promise<ToolResult>((resolver) => {
      resolve = resolver;
    });
    const parked = { resolve, promise };
    this.pendingMemories.set(proposalId, parked);
    return parked;
  }

  private async approveMemory(proposalId: string): Promise<void> {
    const deps = this.memoryDeps;
    const proposal = this.memoryProposals.find(
      (candidate) => candidate.id === proposalId,
    );
    const parked = this.pendingMemories.get(proposalId);
    if (!deps || !proposal || !parked || proposal.status !== "pending") return;

    this.pendingMemories.delete(proposalId);
    const before = memoryBeforeMutation(
      proposal.mutation,
      deps.getMemories(),
    );
    const result = await applyApprovedMemoryMutation(
      proposal.call,
      deps,
      "applied",
    );
    proposal.status = result.isError ? "failed" : "applied";
    if (result.isError) proposal.error = result.content;
    else {
      proposal.effect = {
        before,
        after: memoryAfterMutation(proposal.mutation),
        appliedAt: Date.now(),
      };
    }
    parked.resolve(result);
    this.remountMemories();
  }

  private declineMemory(proposalId: string, guidance?: string): void {
    const proposal = this.memoryProposals.find(
      (candidate) => candidate.id === proposalId,
    );
    const parked = this.pendingMemories.get(proposalId);
    if (!proposal || !parked || proposal.status !== "pending") return;

    this.pendingMemories.delete(proposalId);
    proposal.status = "declined";
    parked.resolve({
      content: memoryDispositionMessage(
        proposal.mutation,
        "declined",
        undefined,
        guidance,
      ),
      isReadOnly: false,
      disposition: "declined",
    });
    this.remountMemories();
  }

  private remountMemories(): void {
    if (!this.memoryDeps) return;
    new MemoryReviewTimelineView({
      timelineEl: this.timelineEl,
      ...(this.findActionHostByToolCallId && {
        findActionHostByToolCallId: (toolCallId) =>
          this.resolveReviewHost(toolCallId),
      }),
      proposals: this.memoryProposals,
    });
    this.onReviewPlacementChanged?.();
  }

  /** Convert + gate a batch, append reviewable ops, and park `ask` resolutions. */
  private async register(calls: ToolCall[], stoppedForMaxTokens: boolean): Promise<Entry[]> {
    const overlay = buildPendingOverlay(this.app, this.accumulatedCalls);
    const resolve = makeResolver(overlay, (p) => diskState(this.app, p));

    // A trashed file's snapshot is what its inverse recreates on undo; pre-read so
    // conversion stays synchronous (shared with the finalize path). A replace's
    // per-file targets are scanned the same way.
    const snapshots = await preReadTrashSnapshots(this.app, calls);
    const replaceScans = await preScanReplacements(this.app, calls);

    const probes: ConversionProbes = {
      resolve,
      fingerprint: (p) => diskFingerprint(this.app, p),
      readContent: (p) => snapshots.get(normalizePath(p)) ?? null,
      configDir: this.app.vault.configDir,
      replaceTargets: (callId) => replaceScans.get(callId) ?? null,
    };

    const { ops, sources, satisfied, errors } = toVaultOperations(calls, probes, {
      stoppedForMaxTokens,
    });
    this.accumulatedCalls.push(...calls);

    const opByCall = new Map<string, { op: VaultOperation; satisfied: boolean }>();
    ops.forEach((op, i) => opByCall.set(sources[i], { op, satisfied: satisfied[i] }));
    const errByCall = new Map(errors.map((e) => [e.toolCallId, e.error]));

    const entries: Entry[] = [];
    for (const call of calls) {
      const found = opByCall.get(call.id);
      if (!found) {
        const conversionError = errByCall.get(call.id);
        // A `replace_in_vault` with valid arguments but no matches converts to no op AND
        // no error (the scan ran, the result set was empty), so it fell through to the
        // generic "could not convert operation" below, which misreads a clean zero-match
        // as malformed arguments. Report it honestly as a no-match instead, so the model
        // fixes the search (spelling / case / scope) rather than its (fine) arguments.
        // Only when validation passed (no recorded conversion error); a genuinely invalid
        // replace still reports its specific reason.
        if (call.name === "replace_in_vault" && conversionError === undefined) {
          entries.push({ call, kind: "error", result: replaceNoMatchResult(call) });
          continue;
        }
        const error = conversionError ?? "could not convert operation";
        entries.push({
          call,
          kind: "error",
          result: {
            // The validator message is already a self-correcting sentence (e.g. the
            // out-of-vault reason ends with "Use a vault-relative path"), so don't
            // stack a second generic recovery on top, that only made it heavier.
            content: `Error: invalid ${call.name} arguments, ${trimDot(error)}.`,
            isReadOnly: false,
            isError: true,
            failure: { kind: "invalid-args", recovery: defaultRecovery("invalid-args") },
          },
        });
        continue;
      }

      const { op, satisfied: isSatisfied } = found;
      const { gate, autoConsumed } = gateConvertedOp(op, isSatisfied, this.policy, this.autoSoFar, this.posture);
      if (gate === "deny") {
        // Denied tools are filtered upstream; guard anyway.
        const recovery = defaultRecovery("denied");
        entries.push({
          call,
          kind: "error",
          result: {
            content: `Error: ${call.name} is not permitted by the current policy. ${trimDot(recovery)}.`,
            isReadOnly: false,
            isError: true,
            failure: { kind: "denied", recovery },
          },
        });
        continue;
      }
      if (autoConsumed) this.autoSoFar++;

      const reviewable = buildReviewableOp(this.app, op, gate, isSatisfied, call.id);

      if (!isSatisfied && gate === "ask") {
        // Offer the decision *before* the op joins the proposal, so a refused call
        // leaves no orphan row on the timeline for a change nobody will ever be shown.
        this.park(reviewable.id);
        const offered = this.requestApproval(
          vaultOpApprovalRequest({
            approvalId: reviewable.id,
            toolCallId: call.id,
            op: reviewable.op,
          }),
          (decision) =>
            this.applyDecision(
              decision,
              () => this.approveOp(reviewable.id),
              (guidance) => this.declineOp(reviewable.id, guidance),
            ),
          () => this.pending.has(reviewable.id),
        );
        if (!offered) {
          this.pending.delete(reviewable.id);
          entries.push({
            call,
            kind: "error",
            result: approvalLaneBusyFailure(call.name),
          });
          continue;
        }
      }

      this.proposal.ops.push(reviewable);
      if (isSatisfied) {
        entries.push({ call, kind: "satisfied", reviewable });
      } else if (gate === "auto") {
        entries.push({ call, kind: "auto", reviewable });
      } else {
        entries.push({ call, kind: "ask", reviewable });
      }
    }
    return entries;
  }

  /** Apply auto-gated ops as one all-or-nothing batch and fill their results. */
  private async applyAuto(
    autoEntries: Array<Extract<Entry, { kind: "auto" }>>,
    results: Map<string, ToolResult>,
  ): Promise<void> {
    // SECURITY INVARIANT (first-class, defense in depth), auto-apply must NEVER
    // write outside the vault. An escaping path is already refused at conversion
    // (layer 1), pre-flight (layer 2), and the disk executor (layer 3); the
    // auto-apply orchestrator re-checks the boundary here in its own right, so a
    // future refactor of the conversion stage cannot open an auto-apply hole. A
    // single escaping op fails the *whole* auto batch, nothing reaches
    // applyVaultOpBatch or disk, the conservative all-or-nothing stance for a
    // safety violation. See ADR-0020.
    if (this.refuseEscapingAuto(autoEntries, results)) return;

    const batch = autoEntries.map((e) => ({ id: e.reviewable.id, op: e.reviewable.op }));
    const res = await applyVaultOpBatch(this.app, batch);
    if (res.ok) {
      for (const e of autoEntries) {
        e.reviewable.status = "applied";
        results.set(e.call.id, dispoResult(e.reviewable.op, "auto-applied"));
      }
      this.mergeRecord(res.applied);
    } else {
      const reason = res.conflicts[0]?.reason ?? res.error ?? "operation failed";
      for (const e of autoEntries) {
        e.reviewable.status = "failed";
        results.set(e.call.id, dispoResult(e.reviewable.op, "failed", reason));
      }
    }
  }

  /**
   * The auto-apply layer's own vault-boundary defense (see {@link applyAuto}).
   * If any auto op's path escapes the vault, fail the *entire* batch in place,
   * marking every op `failed` with an accurate, model-facing reason and returning
   * `true` so the caller short-circuits before {@link applyVaultOpBatch} (and thus
   * disk) is ever reached. The escaping op names its own out-of-vault path; the
   * rest name the sibling that aborted the batch, so each op reports why it failed.
   * Returns `false` (no escape) for the normal path.
   */
  private refuseEscapingAuto(
    autoEntries: Array<Extract<Entry, { kind: "auto" }>>,
    results: Map<string, ToolResult>,
  ): boolean {
    const offending = autoEntries.flatMap((e) => targetPaths(e.reviewable.op)).find(escapesVault);
    if (offending === undefined) return false;

    for (const e of autoEntries) {
      e.reviewable.status = "failed";
      const own = targetPaths(e.reviewable.op).find(escapesVault);
      const reason =
        own !== undefined
          ? outsideVaultMessage(own)
          : `auto-apply aborted: "${offending}" is outside the vault, so nothing in this batch was applied`;
      results.set(e.call.id, dispoResult(e.reviewable.op, "failed", reason));
    }
    return true;
  }

  /** Create the parked promise for an `ask` op, keyed by op id. */
  private park(opId: string): void {
    let resolve!: PendingResolution["resolve"];
    const promise = new Promise<{ disposition: VaultOpDisposition; reason?: string }>((r) => {
      resolve = r;
    });
    this.pending.set(opId, { resolve, promise });
  }

  /** Resolve one parked decision. The single place a `pending` entry is retired. */
  private settleParked(opId: string, outcome: ParkedOutcome): void {
    const parked = this.pending.get(opId);
    if (!parked) return;
    this.pending.delete(opId);
    parked.resolve(outcome);
  }

  /** A terminal user decision landed, resolve the parked promise. */
  private handleResolved(
    opId: string,
    disposition: "applied" | "declined",
    guidance?: string,
  ): void {
    if (!this.pending.has(opId)) return;
    this.settleParked(opId, {
      disposition,
      ...(guidance !== undefined && { guidance }),
    });
    // A declined folder (or one already stranded) leaves nowhere for the ops that
    // were going to write inside it, fail those before they can be approved.
    if (disposition === "declined") this.propagateDeclines();
  }

  /**
   * Strand the dependents of a declined/failed `create_directory`
   * (ask-ops-resolve-as-batch-not-sequential). Any still-awaiting `ask` op whose
   * destination would live inside a folder that will not be created this turn is
   * failed in place, with a reason naming the missing prerequisite, so the model
   * reads an honest `failed` (not a silent landing elsewhere) and can self-correct.
   *
   * Forward, transitive pass: a failed nested `create_directory` is itself added to
   * the missing set, so a declined `A/` also strands `A/B/` and anything under it.
   * Only fires under serial resolution, where the prerequisite is always decided
   * before its dependents are offered, so this never overrides a user approval.
   */
  private propagateDeclines(): void {
    const missingDirs = new Set(
      this.proposal.ops
        .filter(
          (o) => o.op.kind === "createDir" && (o.status === "rejected" || o.status === "failed"),
        )
        .map((o) => normalizePath((o.op as Extract<VaultOperation, { kind: "createDir" }>).path)),
    );
    if (missingDirs.size === 0) return;

    let changed = false;
    for (const o of this.proposal.ops) {
      if (o.gate !== "ask" || (o.status !== "pending" && o.status !== "accepted")) continue;
      if (o.op.kind === "trash") continue;
      const dest = destinationPath(o.op);
      const blocker = [...missingDirs].find((dir) => isWithinDir(dest, dir));
      if (!blocker) continue;

      const reason = `the folder "${blocker}" was declined, so there is nowhere to put "${dest}"`;
      o.status = "failed";
      this.settleParked(o.id, { disposition: "failed", reason });
      if (o.op.kind === "createDir") missingDirs.add(normalizePath(o.op.path));
      changed = true;
    }
    if (changed) this.remount();
  }

  // --- Edit channel helpers ----------------------------------------------

  /**
   * The {@link EditReviewController} for a given file, the apply owner for that file,
   * created on its first resolved hunk (so a file with only no-matches mounts nothing).
   * One per edited path (ADR-0010); the panel re-renders over all of them each round,
   * and each file's snapshot/record stay isolated to its own controller.
   */
  private ensureEditController(targetPath: string, docText: string): EditReviewController {
    const existing = this.editControllers.get(targetPath);
    if (existing) return existing;
    const proposal: EditProposal = {
      id: generateId(),
      targetFilePath: targetPath,
      documentSnapshot: docText,
      snapshotTimestamp: Date.now(),
      hunks: [],
      prose: "",
    };
    const controller = new EditReviewController(this.app, proposal, {
      onHunksChanged: () => {
        /* statuses mutate in place; persistence happens at finalization. */
      },
      onApplied: (record) => {
        this.editAppliedRecords.set(targetPath, record);
      },
      onUndone: () => {
        this.editAppliedRecords.delete(targetPath);
      },
    });
    controller.subscribe((change) => this.handleEditResolved(change.hunkId, change.status));
    this.editControllers.set(targetPath, controller);
    return controller;
  }

  /** Populate a structural block (frontmatter) against its target file; pass others through. */
  private async resolveStructural(block: EditBlock, filePath: string): Promise<EditBlock> {
    if (!block.toolName) return block;
    const [resolved] = await resolveStructuralEditBlocks([block], { app: this.app, filePath });
    return resolved ?? block;
  }

  /**
   * Re-render the live edit review on the timeline over every file's controller and
   * refresh each in-note overlay. One composite {@link EditReviewTimelineView} spans
   * all controllers (one card per file, ADR-0010); the inline overlay attaches each so
   * whichever file is open shows its diff.
   */
  private renderEditPanel(): void {
    const deps = this.editDeps;
    const controllers = [...this.editControllers.values()];
    if (!deps || controllers.length === 0) return;
    this.editTimelineView?.destroy();
    this.editTimelineView = new EditReviewTimelineView({
      timelineEl: this.timelineEl,
      ...(this.findActionHostByToolCallId && {
        findActionHostByToolCallId: (toolCallId) =>
          this.resolveReviewHost(toolCallId),
      }),
      app: this.app,
      controllers,
      live: true,
    });
    this.onReviewPlacementChanged?.();
    for (const controller of controllers) deps.inlineDiff.attach(controller);
  }

  /** A hunk reached a terminal status in either renderer, resolve its parked promise. */
  private handleEditResolved(hunkId: string, status: EditStatus): void {
    if (!this.pending.has(hunkId)) return;
    if (status === "accepted") {
      this.declineGuidance.delete(hunkId);
      this.settleParked(hunkId, { disposition: "applied" });
    } else if (status === "rejected") {
      // A drawer decline parked its guidance here on the way in; a rejection from the
      // in-note overlay simply has none.
      const guidance = this.declineGuidance.get(hunkId);
      this.declineGuidance.delete(hunkId);
      this.settleParked(hunkId, {
        disposition: "declined",
        ...(guidance !== undefined && { guidance }),
      });
    }
    // "pending" (a mid-loop undo) leaves the op parked, rare and intentionally ignored.
  }

  /** Re-mount the review over the current proposal. Idempotent (cleanPriorDecorations). */
  private remount(): void {
    const callbacks: VaultReviewCallbacks = {
      onOpsChanged: () => {
        /* proposal mutated in place; persistence happens at finalization. */
      },
      onUndone: () => {
        this.appliedRecord = null;
      },
    };
    new VaultReviewTimelineView({
      timelineEl: this.timelineEl,
      ...(this.findActionHostByToolCallId && {
        findActionHostByToolCallId: (toolCallId) =>
          this.resolveReviewHost(toolCallId),
      }),
      app: this.app,
      proposal: this.proposal,
      callbacks,
      existingRecord: this.appliedRecord ?? undefined,
      // Live mount serializes ask approval: one op decided at a time, so the rest read
      // "waiting for the previous step" and the timeline still shows queue depth now
      // that the decision itself is in the drawer.
      serial: true,
    });
    this.onReviewPlacementChanged?.();
  }

  private resolveReviewHost(toolCallId: string): HTMLElement | null {
    return (
      this.findActionHostByToolCallId?.(toolCallId) ??
      this.getProvisionalActionHost?.() ??
      null
    );
  }

  private mergeRecord(applied: Array<{ opId: string; inverse: VaultOperation }>): void {
    if (!this.appliedRecord) {
      this.appliedRecord = {
        proposalId: this.proposal.id,
        applied: [...applied],
        appliedAt: Date.now(),
      };
    } else {
      this.appliedRecord.applied = [...this.appliedRecord.applied, ...applied];
      this.appliedRecord.appliedAt = Date.now();
    }
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function dispoResult(
  op: VaultOperation,
  disposition: VaultOpDisposition,
  reason?: string,
  guidance?: string,
): ToolResult {
  return {
    content: dispositionMessage(op, disposition, reason, guidance),
    isReadOnly: false,
    isError: disposition === "failed",
    failure: disposition === "failed" ? { kind: "failed", recovery: reason } : undefined,
    // Carry the real outcome to the tool-result choke points so a step persists it,
    // a decline resolves isError:false and is otherwise indistinguishable from an
    // applied op (ADR-0016).
    disposition,
  };
}

/**
 * The refusal for an approval raised while the drawer already holds one (RFC-0012).
 *
 * The lane is single-slot and refuses *before* the channel parks, so nothing is
 * awaiting, nothing was shown, and nothing was written; the model simply re-issues the
 * call, which is the established idiom for every other contention case here
 * (`askSkippedSiblingFailure`, `effectBoundaryRefusal`, `toolNotAllowedFailure`).
 *
 * Reachable only from concurrent Claude Code callbacks: `capRoundToMutation` truncates
 * every plugin-loop round at its first mutating call, so the direct path can never have
 * two approvals in flight at once.
 */
function approvalLaneBusyFailure(toolName: string): ToolResult {
  return toolFailure({
    kind: "precondition",
    what:
      `${toolName} was not proposed: another change is already waiting for the ` +
      "user's approval, and only one is offered at a time",
    recovery: "retry this call once the pending change has been decided",
    isReadOnly: false,
  });
}

/** A call with no result is a parked op cancelled before it decided. */
function cancelledFallback(call: ToolCall): ToolResult {
  return { content: `${call.name} review was interrupted; still pending.`, isReadOnly: false };
}

/**
 * A `replace_in_vault` whose search matched nothing: valid arguments, empty result set,
 * so conversion emits no op. Reported as an honest no-match (not the generic conversion
 * failure), so the model corrects the search rather than assuming its call was malformed.
 * Mirrors the edit channel's no-match contract: `isError` + a self-correcting recovery,
 * so the model self-corrects (its own errorGuidance: spelling / case / scope).
 */
function replaceNoMatchResult(call: ToolCall): ToolResult {
  const args = call.arguments;
  const search = typeof args.search === "string" ? args.search : "";
  const where =
    typeof args.path === "string" && args.path.trim() !== "" ? `"${args.path}"` : "the vault";
  const recovery =
    "check spelling and case, or widen the scope; the search is literal text, not a pattern";
  return {
    content: `No occurrences of "${search}" were found in ${where}, so there was nothing to replace. ${recovery}.`,
    isReadOnly: false,
    isError: true,
    failure: { kind: "no-match", recovery },
  };
}

/**
 * An invalid / denied edit call, surfaced as the call's error tool result. `what`
 * names the failure; `recovery` is the situated next step, defaulting per kind (via
 * the shared {@link defaultRecovery}) so every edit error carries one even when the
 * caller passes none. "Error:" prefix + uniform punctuation match the read channel.
 */
function editError(
  call: ToolCall,
  what: string,
  kind: ErrorKind = "invalid-args",
  recovery?: string,
): ToolResult {
  const step = recovery ?? defaultRecovery(kind);
  return {
    content: `Error: ${call.name} could not run: ${trimDot(what)}. ${trimDot(step)}.`,
    isReadOnly: false,
    isError: true,
    failure: { kind, recovery: step },
  };
}

/** A parked edit cancelled before the user decided (abort / new turn). */
function editCancelled(kind: EditOpKind, path: string): ToolResult {
  return { content: editDispositionMessage(kind, path, "cancelled"), isReadOnly: false };
}

/** The vault path an edit call names, for the defensive cancelled fallback message. */
function pathArg(call: ToolCall): string {
  const p = call.arguments.path;
  return typeof p === "string" ? p : "";
}

/** Map an edit tool name to the disposition kind that shapes its model-facing wording. */
function editKind(toolName: string): EditOpKind {
  if (toolName === "update_frontmatter") return "frontmatter";
  if (toolName === "insert_into_note") return "insert";
  return "edit";
}

/**
 * The vault path an op writes to, the location that must live under an existing
 * folder for the op to make sense. `trash` has no created destination, so it never
 * depends on a freshly-created folder (callers exclude it before asking).
 */
function destinationPath(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
    case "overwrite":
    case "createDir":
      return op.path;
    case "move":
    case "moveFolder":
      return op.to;
    case "trash":
    case "trashFolder":
      return op.path;
    case "replaceInVault":
      // A replace's targets already exist on disk, so it never depends on a folder
      // created this turn; "" is under no directory, so decline-propagation skips it.
      return "";
  }
}

/** True when `path` lies strictly inside directory `dir` (a child, not the dir itself). */
function isWithinDir(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  return p !== d && p.startsWith(`${d}/`);
}
