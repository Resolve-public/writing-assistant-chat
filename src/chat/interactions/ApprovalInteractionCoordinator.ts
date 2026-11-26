import { generateId } from "../../utils";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequester,
} from "./approvalTypes";
import type { ComposerInteractionHostPort } from "./ComposerInteractionHost";

interface PendingApproval {
  interactionId: string;
  approvalId: string;
  decide: (decision: ApprovalDecision) => void;
  abortListener: () => void;
}

/**
 * Owns the drawer's approval lane for one generation (RFC-0012).
 *
 * Deliberately the same shape as {@link AskInteractionCoordinator}: generation-scoped
 * over the composer host and the generation's abort signal, one-shot, and knowing
 * nothing about vault ops, edits, or memories. It reports a decision; the channel that
 * raised the request performs it and resolves its own parked promise. So the tool result
 * still cannot assert an outcome the timeline does not already hold.
 *
 * Two things it deliberately does not do:
 *
 *   - **It never resolves a parked promise.** `LiveVaultReview.cancelPending()` already
 *     owns resolving every outstanding decision as `cancelled`, and it is already bound
 *     to this same signal. Two owners for one settlement is how double-resolve bugs
 *     start, so abort here only clears the drawer.
 *   - **It never queues.** The host is single-slot; a second request while one is active
 *     is refused *before its channel parks*, so nothing is awaiting, nothing is shown,
 *     and nothing is written. The caller turns the refusal into a retryable failure,
 *     which is what every other contention case in this codebase already does.
 */
export class ApprovalInteractionCoordinator implements ApprovalRequester {
  private pending: PendingApproval | null = null;
  private destroyed = false;

  constructor(
    private readonly host: ComposerInteractionHostPort,
    private readonly signal: AbortSignal,
  ) {}

  /**
   * Offer one approval for decision. Returns `false`, having mounted nothing and called
   * nothing, when this coordinator is finished, the generation is aborting, the request
   * is no longer live, or the lane is occupied.
   *
   * `isLive` is checked immediately before mounting and answers "is the caller's promise
   * still parked?". Several paths settle a parked promise without a drawer decision
   * (decline propagation, the in-note overlay, cancellation), and unlike the timeline
   * the drawer is not repainted from proposal state, so a settled request would
   * otherwise linger on screen.
   */
  request(
    request: ApprovalRequest,
    decide: (decision: ApprovalDecision) => void,
    isLive: () => boolean,
  ): boolean {
    if (this.destroyed || this.signal.aborted) return false;
    if (this.pending) return false;
    if (!isLive()) return false;

    const interactionId = `approval-${generateId()}`;
    const abortListener = (): void => {
      this.clear(interactionId);
    };
    this.pending = {
      interactionId,
      approvalId: request.approvalId,
      decide,
      abortListener,
    };
    this.signal.addEventListener("abort", abortListener, { once: true });

    let mounted = false;
    try {
      mounted = this.host.mount({
        kind: "approval",
        interactionId,
        request,
        onSubmit: (decision) => {
          this.submit(interactionId, decision);
        },
        onCancel: () => {
          this.clear(interactionId);
        },
      });
    } catch (error) {
      // A form that cannot render is a decision that cannot be shown, which is the same
      // outcome for the caller as a busy lane: nothing parked, nothing written, retry.
      // Reported as a boolean rather than thrown so `false` stays the only failure a
      // channel has to handle, and logged because a render throw is a genuine defect.
      console.error("[chat] The approval drawer could not be mounted.", error);
      mounted = false;
    }
    if (!mounted) {
      this.clear(interactionId);
      return false;
    }
    return true;
  }

  release(approvalId: string): void {
    const pending = this.pending;
    if (pending?.approvalId === approvalId) this.clear(pending.interactionId);
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const interactionId = this.pending?.interactionId;
    if (interactionId) this.clear(interactionId);
  }

  /**
   * Settlement is unconditional: the lane is released before `decide` runs, so a channel
   * whose apply throws cannot wedge the drawer for the other two. The coordinator never
   * learns whether the apply succeeded, and it does not need to: a failure is reported
   * to the model on the tool result, and the retry lives on the durable ledger.
   */
  private submit(interactionId: string, decision: ApprovalDecision): void {
    const pending = this.pending;
    if (!pending || pending.interactionId !== interactionId) return;
    this.clear(interactionId);
    pending.decide(decision);
  }

  private clear(interactionId: string): void {
    const pending = this.pending;
    if (!pending || pending.interactionId !== interactionId) return;
    this.pending = null;
    this.signal.removeEventListener("abort", pending.abortListener);
    this.host.clearIfOwner(interactionId);
  }
}
